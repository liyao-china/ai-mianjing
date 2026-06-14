// AI 代理 Edge Function
// 作用：1) 模型 API Key 只存在服务端环境变量，前端零密钥
//      2) 按"登录用户/匿名IP"做每日额度限制，防止盗刷
// 部署：supabase functions deploy ai-proxy
// 密钥：supabase secrets set DASHSCOPE_API_KEY=sk-xxx（轮换后的新 Key）

import { createClient } from "npm:@supabase/supabase-js@2";

const DASHSCOPE_KEY = Deno.env.get("DASHSCOPE_API_KEY") ?? "";
const SUPABASE_URL = Deno.env.get("SUPABASE_URL") ?? "";
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";

const CHAT_URL = "https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions";
const NATIVE_URL = "https://dashscope.aliyuncs.com/api/v1/services/aigc/multimodal-generation/generation";

// 模型在服务端写死，客户端无法指定任意模型
const CHAT_MODEL = "qwen3.7-plus";
const VISION_MODEL = "qwen-vl-max";
const TTS_MODEL = "qwen3-tts-flash";
const ASR_MODEL = "qwen3-asr-flash";
const TTS_VOICES = ["Cherry", "Serena", "Ethan", "Chelsie"];

// 额度：按"单位"计，约一场标准面试 = 8题 × (出题1 + 语音1 + 转写1) + 报告2 ≈ 26 单位
const COSTS: Record<string, number> = { chat: 1, vision: 2, tts: 1, asr: 1 };
const DAILY_LIMIT_ANON = 35;   // 匿名（按IP）：约 1 场/天
const DAILY_LIMIT_USER = 105;  // 登录用户：约 3 场/天

const ALLOWED_ORIGINS = [
  "https://liyao-china.github.io",
  "http://localhost:8000",
  "http://127.0.0.1:8000",
  "null", // 本地 file:// 调试
];

function corsHeaders(origin: string): Record<string, string> {
  return {
    "Access-Control-Allow-Origin": ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0],
    "Access-Control-Allow-Headers": "authorization, content-type",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Vary": "Origin",
  };
}

function json(body: unknown, status: number, headers: Record<string, string>) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...headers, "Content-Type": "application/json" },
  });
}

async function callDashScope(url: string, body: unknown): Promise<any> {
  const res = await fetch(url, {
    method: "POST",
    headers: { Authorization: `Bearer ${DASHSCOPE_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(90_000),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || data.error || data.code) {
    const msg = data?.error?.message || data?.message || `上游服务异常(${res.status})`;
    throw new Error(msg);
  }
  return data;
}

Deno.serve(async (req) => {
  const origin = req.headers.get("origin") ?? "";
  const headers = corsHeaders(origin);

  if (req.method === "OPTIONS") return new Response("ok", { headers });
  if (req.method !== "POST") return json({ error: "method not allowed" }, 405, headers);
  if (!DASHSCOPE_KEY) return json({ error: "服务端未配置模型密钥" }, 500, headers);

  let body: any;
  try { body = await req.json(); } catch { return json({ error: "请求格式错误" }, 400, headers); }
  const { service, payload } = body ?? {};
  if (service !== "quota" && !COSTS[service]) return json({ error: "未知服务类型" }, 400, headers);

  // ---- 识别调用者：登录用户按 user_id，匿名按 IP ----
  let identity = "";
  let isUser = false;
  const token = (req.headers.get("authorization") ?? "").replace(/^Bearer\s+/i, "");
  try {
    const claims = JSON.parse(atob(token.split(".")[1]));
    if (claims?.sub && claims?.role === "authenticated") {
      identity = `user:${claims.sub}`;
      isUser = true;
    }
  } catch { /* 匿名 */ }
  if (!identity) {
    const ip = (req.headers.get("x-forwarded-for") ?? "unknown").split(",")[0].trim();
    identity = `ip:${ip}`;
  }
  const limit = isUser ? DAILY_LIMIT_USER : DAILY_LIMIT_ANON;

  const admin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);

  // ---- 查询额度（不扣费）----
  if (service === "quota") {
    const { data } = await admin.rpc("get_ai_usage", { p_identity: identity });
    return json({ used: data ?? 0, limit }, 200, headers);
  }

  // ---- 扣减额度（原子操作，超限拒绝）----
  const { data: units, error: usageErr } = await admin.rpc("bump_ai_usage", {
    p_identity: identity,
    p_cost: COSTS[service],
  });
  if (usageErr) {
    console.error("usage rpc error", usageErr);
    return json({ error: "额度服务异常，请稍后再试" }, 500, headers);
  }
  if ((units as number) > limit) {
    return json({ error: isUser ? "今日额度已用完，明天再来吧" : "今日免费额度已用完，登录后可获得更多额度" }, 429, headers);
  }

  // ---- 分发到具体模型服务 ----
  try {
    if (service === "chat") {
      const messages = payload?.messages;
      if (!Array.isArray(messages) || !messages.length) return json({ error: "messages 不能为空" }, 400, headers);
      if (JSON.stringify(messages).length > 200_000) return json({ error: "对话内容过长" }, 400, headers);
      const data = await callDashScope(CHAT_URL, { model: CHAT_MODEL, enable_thinking: false, messages });
      return json({ content: data.choices?.[0]?.message?.content ?? "" }, 200, headers);
    }

    if (service === "vision") {
      const messages = payload?.messages;
      if (!Array.isArray(messages) || !messages.length) return json({ error: "messages 不能为空" }, 400, headers);
      if (JSON.stringify(messages).length > 15_000_000) return json({ error: "图片内容过大" }, 400, headers);
      const data = await callDashScope(CHAT_URL, { model: VISION_MODEL, messages });
      return json({ content: data.choices?.[0]?.message?.content ?? "" }, 200, headers);
    }

    if (service === "tts") {
      const text = String(payload?.text ?? "").slice(0, 600);
      if (!text.trim()) return json({ error: "text 不能为空" }, 400, headers);
      const voice = TTS_VOICES.includes(payload?.voice) ? payload.voice : TTS_VOICES[0];
      const data = await callDashScope(NATIVE_URL, {
        model: TTS_MODEL,
        input: { text, voice, language_type: "Chinese" },
      });
      const url = data.output?.audio?.url;
      if (!url) throw new Error("TTS 未返回音频");
      return json({ url }, 200, headers);
    }

    if (service === "asr") {
      const audio = String(payload?.audio ?? "");
      if (!audio.startsWith("data:audio/") && !audio.startsWith("data:video/")) {
        return json({ error: "audio 需为 base64 Data URL" }, 400, headers);
      }
      if (audio.length > 13_000_000) return json({ error: "录音过大（限10MB）" }, 400, headers);
      const data = await callDashScope(NATIVE_URL, {
        model: ASR_MODEL,
        input: {
          messages: [
            { role: "system", content: [{ text: "" }] },
            { role: "user", content: [{ audio }] },
          ],
        },
        parameters: { asr_options: { language: "zh", enable_itn: true } },
      });
      const content = data.output?.choices?.[0]?.message?.content;
      const text = Array.isArray(content) ? (content.find((c: any) => c.text)?.text ?? "") : "";
      return json({ text }, 200, headers);
    }

    return json({ error: "未知服务类型" }, 400, headers);
  } catch (err) {
    console.error(`[${service}] upstream error:`, err);
    return json({ error: (err as Error).message || "AI 服务暂时不可用" }, 502, headers);
  }
});
