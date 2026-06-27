// @ts-nocheck
// 外部面经情报自动搜集 Edge Function（第二层知识库）
// 流程：读 user_profiles(target_role/target_companies/keywords) → 生成搜索词 → Tavily 联网搜索
//      → LLM 清洗去重摘要 → 生成 embedding → 写入 knowledge_items(source='external')
// 部署：supabase functions deploy collect-external-knowledge --no-verify-jwt
// 密钥：supabase secrets set TAVILY_API_KEY=tvly-xxx
//      supabase secrets set CRON_SECRET=<自定义随机串>   # 供每周定时任务调用
//      （已有 DASHSCOPE_API_KEY / SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY）
// 两种调用模式：
//   1) 用户手动：浏览器带用户 JWT 调用 → 给当前用户搜集（有冷却限流）
//   2) 定时任务：请求头带 x-cron-secret=CRON_SECRET → 批量给开启「每周自动搜集」且到期的用户搜集

import { createClient } from "npm:@supabase/supabase-js@2";

const DASHSCOPE_KEY = Deno.env.get("DASHSCOPE_API_KEY") ?? "";
const TAVILY_KEY = Deno.env.get("TAVILY_API_KEY") ?? "";
const SUPABASE_URL = Deno.env.get("SUPABASE_URL") ?? "";
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
const CRON_SECRET = Deno.env.get("CRON_SECRET") ?? "";

const CHAT_URL = "https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions";
const EMBED_URL = "https://dashscope.aliyuncs.com/compatible-mode/v1/embeddings";
const CHAT_MODEL = "qwen-plus";
const EMBED_MODEL = "text-embedding-v3";
const EMBED_DIM = 1024;
const TAVILY_URL = "https://api.tavily.com/search";

const MAX_QUERIES = 4;          // 每次最多生成 4 个搜索词
const RESULTS_PER_QUERY = 4;    // 每个搜索词取 4 条
const MAX_NEW_ITEMS = 10;       // 每次最多入库 10 条新面经（控制成本）
const COOLDOWN_MINUTES = 30;    // 手动搜集冷却：30 分钟内不可重复触发
const WEEKLY_DUE_DAYS = 6;      // 定时任务里「到期」判定：距上次搜集 ≥6 天
const CRON_MAX_USERS = 10;      // 单次定时任务最多处理 10 个用户（控制函数时长）

const DEFAULT_ORIGIN = "https://liyao-china.github.io";
function isAllowedOrigin(origin: string): boolean {
  if (!origin || origin === "null") return true;
  if (origin === DEFAULT_ORIGIN) return true;
  return /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin);
}
function corsHeaders(origin: string): Record<string, string> {
  return {
    "Access-Control-Allow-Origin": isAllowedOrigin(origin) ? (origin || DEFAULT_ORIGIN) : DEFAULT_ORIGIN,
    "Access-Control-Allow-Headers": "authorization, content-type",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Vary": "Origin",
  };
}
function json(body: unknown, status: number, headers: Record<string, string>) {
  return new Response(JSON.stringify(body), { status, headers: { ...headers, "Content-Type": "application/json" } });
}

async function sha256Hex(text: string): Promise<string> {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function splitList(value: string): string[] {
  return String(value || "").split(/[,，、\s]+/).map((s) => s.trim()).filter(Boolean);
}

function buildQueries(profile: any): string[] {
  const role = String(profile.target_role || "").trim();
  const companies = splitList(profile.target_companies || "");
  const keywords = splitList(profile.keywords || "");
  const queries: string[] = [];
  if (companies[0] && role) queries.push(`${companies[0]} ${role} 面经`);
  if (role) queries.push(`${role} 面试 高频问题`);
  if (role) queries.push(`${role} 面试经验 复盘`);
  if (keywords[0] && role) queries.push(`${role} ${keywords[0]} 面试题`);
  if (companies[1] && role) queries.push(`${companies[1]} ${role} 面试流程`);
  if (!role && keywords[0]) queries.push(`${keywords[0]} 面试 高频问题`);
  return [...new Set(queries.filter((q) => q.trim()))].slice(0, MAX_QUERIES);
}

async function tavilySearch(query: string): Promise<any[]> {
  const res = await fetch(TAVILY_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${TAVILY_KEY}` },
    body: JSON.stringify({ api_key: TAVILY_KEY, query, search_depth: "basic", max_results: RESULTS_PER_QUERY, include_answer: false }),
    signal: AbortSignal.timeout(20_000),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data?.error || data?.detail || `搜索失败(${res.status})`);
  return Array.isArray(data.results) ? data.results : [];
}

async function callDashScopeChat(messages: any[]): Promise<string> {
  const res = await fetch(CHAT_URL, {
    method: "POST",
    headers: { Authorization: `Bearer ${DASHSCOPE_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify({ model: CHAT_MODEL, enable_thinking: false, messages }),
    signal: AbortSignal.timeout(60_000),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || data.error) throw new Error(data?.error?.message || `清洗失败(${res.status})`);
  return data.choices?.[0]?.message?.content ?? "";
}

async function embedTexts(texts: string[]): Promise<number[][]> {
  const res = await fetch(EMBED_URL, {
    method: "POST",
    headers: { Authorization: `Bearer ${DASHSCOPE_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify({ model: EMBED_MODEL, input: texts, dimensions: EMBED_DIM, encoding_format: "float" }),
    signal: AbortSignal.timeout(30_000),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || data.error) throw new Error(data?.error?.message || `向量失败(${res.status})`);
  return (data.data ?? []).slice().sort((a: any, b: any) => (a.index ?? 0) - (b.index ?? 0)).map((d: any) => d.embedding);
}

// 为单个用户搜集；返回 { inserted, scanned, queries, message? }
async function collectForUser(admin: any, userId: string, opts: { isCron?: boolean } = {}) {
  const { data: profile, error: pErr } = await admin.from("user_profiles").select("*").eq("user_id", userId).maybeSingle();
  if (pErr) throw new Error("读取用户画像失败");
  if (!profile || (!profile.target_role && !profile.keywords && !profile.target_companies)) {
    return { ok: false, inserted: 0, error: "请先在『简历管理』填写目标岗位 / 目标公司 / 核心技能" };
  }

  // 手动调用限流：距上次搜集不足冷却时间则拒绝（定时任务不受此限制）
  if (!opts.isCron && profile.last_external_collect_at) {
    const elapsedMs = Date.now() - new Date(profile.last_external_collect_at).getTime();
    const remainMin = Math.ceil((COOLDOWN_MINUTES * 60_000 - elapsedMs) / 60_000);
    if (remainMin > 0) {
      return { ok: false, inserted: 0, error: `刚刚搜集过啦，请约 ${remainMin} 分钟后再试` };
    }
  }

  const queries = buildQueries(profile);
  if (!queries.length) return { ok: false, inserted: 0, error: "无法生成搜索词，请完善目标岗位" };

  const raw: any[] = [];
  for (const q of queries) {
    try {
      const results = await tavilySearch(q);
      results.forEach((r) => raw.push({ query: q, ...r }));
    } catch (e) {
      console.warn("tavily query failed:", q, (e as Error).message);
    }
  }
  if (!raw.length) return { ok: true, inserted: 0, scanned: 0, queries, message: "未搜到结果，稍后再试" };

  // URL 去重 + 与历史 hash 去重
  const seen = new Set<string>();
  const deduped: any[] = [];
  for (const r of raw) {
    const url = String(r.url || "").trim();
    if (!url) continue;
    const hash = await sha256Hex(url);
    if (seen.has(hash)) continue;
    seen.add(hash);
    deduped.push({ ...r, hash });
  }
  const { data: existing } = await admin.from("knowledge_items").select("metadata").eq("user_id", userId).eq("source", "external").limit(1000);
  const existingHashes = new Set((existing || []).map((x: any) => x?.metadata?.hash).filter(Boolean));
  const fresh = deduped.filter((r) => !existingHashes.has(r.hash)).slice(0, MAX_NEW_ITEMS * 2);

  const now = new Date().toISOString();
  if (!fresh.length) {
    await admin.from("user_profiles").update({ last_external_collect_at: now, last_external_collect_count: 0 }).eq("user_id", userId);
    return { ok: true, inserted: 0, scanned: raw.length, queries, message: "没有新的面经（都已收集过）" };
  }

  // LLM 清洗：保留相关项 + 生成标题/摘要/标签
  const role = profile.target_role || "目标岗位";
  const listText = fresh.map((r, i) => `[${i}] 标题:${r.title || ""}\n链接:${r.url}\n摘要:${String(r.content || "").slice(0, 500)}`).join("\n\n");
  const prompt = `你在为应聘「${role}」的候选人筛选并整理面试情报。下面是联网搜索到的网页结果。请：
1) 只保留与「${role}」面试/求职/面经/高频题/岗位要求真正相关的条目，丢弃广告、招聘列表、培训售卖、无关内容；
2) 为保留的每条生成：简洁中文标题、120字内摘要（提炼对面试有用的要点：常考题、考点、面试流程、易踩的坑）、3-6个标签。
严格只返回 JSON，不要任何多余文字或 markdown：
{"items":[{"index":数字,"title":"...","summary":"...","tags":["..."]}]}
index 必须是上面方括号里的编号；不相关的条目不要返回。`;

  let cleaned: any[] = [];
  try {
    const content = await callDashScopeChat([
      { role: "system", content: "你是严谨的面试情报整理助手，只返回JSON。" },
      { role: "user", content: listText + "\n\n" + prompt },
    ]);
    const s = content.indexOf("{"), e = content.lastIndexOf("}");
    if (s >= 0 && e > s) {
      const parsed = JSON.parse(content.slice(s, e + 1));
      cleaned = Array.isArray(parsed.items) ? parsed.items : [];
    }
  } catch (e) {
    console.warn("LLM 清洗失败，回退使用原始结果：", (e as Error).message);
  }

  let chosen: any[] = [];
  if (cleaned.length) {
    for (const c of cleaned) {
      const src = fresh[Number(c.index)];
      if (!src) continue;
      chosen.push({
        src,
        title: String(c.title || src.title || "外部面经").slice(0, 200),
        summary: String(c.summary || "").slice(0, 400),
        tags: Array.isArray(c.tags) ? c.tags.map(String).slice(0, 6) : [],
      });
    }
  } else {
    chosen = fresh.slice(0, MAX_NEW_ITEMS).map((src) => ({
      src,
      title: String(src.title || "外部面经").slice(0, 200),
      summary: String(src.content || "").slice(0, 300),
      tags: [],
    }));
  }
  chosen = chosen.slice(0, MAX_NEW_ITEMS);
  if (!chosen.length) {
    await admin.from("user_profiles").update({ last_external_collect_at: now, last_external_collect_count: 0 }).eq("user_id", userId);
    return { ok: true, inserted: 0, scanned: raw.length, queries, message: "筛选后没有相关面经" };
  }

  // 生成 embedding（失败不阻塞入库，只是检索时退化为按时间）
  let vectors: number[][] = [];
  try {
    vectors = await embedTexts(chosen.map((c) => `${c.title}\n${c.summary}`.slice(0, 2000)));
  } catch (e) {
    console.warn("外部面经向量生成失败：", (e as Error).message);
  }

  const rows = chosen.map((c, i) => ({
    user_id: userId,
    source: "external",
    source_ref: c.src.hash,
    title: c.title,
    summary: c.summary,
    content: `${c.summary}\n\n来源：${c.src.url}`,
    company: "",
    role: profile.target_role || "",
    round: "",
    tags: [...new Set([...(c.tags || []), "外部面经", "情报"])].slice(0, 12),
    metadata: { url: c.src.url, query: c.src.query, provider: "tavily", collected_at: now, hash: c.src.hash },
    embedding: vectors[i] || null,
  }));

  let inserted = 0;
  for (const row of rows) {
    const { error } = await admin.from("knowledge_items").insert(row);
    if (!error) inserted++;
    else if (!/duplicate key|23505/i.test(error.message || "")) console.warn("外部面经入库失败：", error.message);
  }
  await admin.from("user_profiles").update({ last_external_collect_at: now, last_external_collect_count: inserted }).eq("user_id", userId);
  return { ok: true, inserted, scanned: raw.length, queries };
}

Deno.serve(async (req) => {
  const origin = req.headers.get("origin") ?? "";
  const headers = corsHeaders(origin);

  if (req.method === "OPTIONS") return new Response("ok", { headers });
  if (req.method !== "POST") return json({ ok: false, error: "method not allowed" }, 405, headers);
  if (!DASHSCOPE_KEY) return json({ ok: false, error: "服务端未配置模型密钥 DASHSCOPE_API_KEY" }, 200, headers);
  if (!TAVILY_KEY) return json({ ok: false, error: "服务端未配置搜索密钥 TAVILY_API_KEY" }, 200, headers);

  const admin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);

  // 模式 1：定时任务批量搜集（请求头带 x-cron-secret）
  const cronSecret = (req.headers.get("x-cron-secret") ?? "").trim();
  if (cronSecret) {
    if (!CRON_SECRET || cronSecret !== CRON_SECRET) {
      return json({ ok: false, error: "cron secret 无效" }, 401, headers);
    }
    try {
      const result = await runCron(admin);
      return json(result, 200, headers);
    } catch (err) {
      console.error("collect-external-knowledge cron error:", err);
      return json({ ok: false, error: (err as Error).message || "定时搜集失败" }, 200, headers);
    }
  }

  // 模式 2：用户手动搜集（带用户 JWT）
  const token = (req.headers.get("authorization") ?? "").replace(/^Bearer\s+/i, "").trim();
  let userId: string | null = null;
  try {
    const { data, error } = await admin.auth.getUser(token);
    if (!error && data?.user?.id) userId = data.user.id;
  } catch { /* 无效 token → 未登录 */ }
  if (!userId) return json({ ok: false, error: "请先登录后再搜集外部面经" }, 200, headers);

  try {
    const result = await collectForUser(admin, userId, { isCron: false });
    return json(result, 200, headers);
  } catch (err) {
    console.error("collect-external-knowledge error:", err);
    return json({ ok: false, error: (err as Error).message || "外部搜集暂时不可用" }, 200, headers);
  }
});

// 定时任务：批量给「开启每周自动搜集」且到期的用户搜集
async function runCron(admin: any) {
  const dueBefore = new Date(Date.now() - WEEKLY_DUE_DAYS * 86_400_000).toISOString();
  const { data: users, error } = await admin
    .from("user_profiles")
    .select("user_id,last_external_collect_at")
    .eq("weekly_collect_enabled", true)
    .or(`last_external_collect_at.is.null,last_external_collect_at.lt.${dueBefore}`)
    .order("last_external_collect_at", { ascending: true, nullsFirst: true })
    .limit(CRON_MAX_USERS);
  if (error) throw new Error("读取待处理用户失败：" + error.message);

  const list = users || [];
  let processed = 0;
  let totalInserted = 0;
  const details: any[] = [];
  for (const u of list) {
    try {
      const r = await collectForUser(admin, u.user_id, { isCron: true });
      processed++;
      totalInserted += r?.inserted || 0;
      details.push({ user_id: u.user_id, inserted: r?.inserted || 0, ok: r?.ok !== false });
    } catch (e) {
      details.push({ user_id: u.user_id, ok: false, error: (e as Error).message });
    }
  }
  return { ok: true, mode: "cron", processed, totalInserted, due: list.length, details };
}
