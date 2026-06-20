// @ts-nocheck
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
const CHAT_MODEL_FAST = "qwen-plus";       // 实时追问：优先速度与稳定性
const CHAT_MODEL_STRONG = "qwen3.7-plus";  // 最终报告：保留强模型
const VISION_MODEL = "qwen-vl-max";
const TTS_MODEL = "qwen3-tts-flash";
const ASR_MODEL = "qwen3-asr-flash";
const ASR_REALTIME_MODEL = "paraformer-realtime-v2";
const ASR_WS_URL = "wss://dashscope.aliyuncs.com/api-ws/v1/inference";
const TTS_VOICES = ["Cherry", "Serena", "Ethan", "Chelsie"];

// 额度：按"单位"计，约一场标准面试 = 8题 × (出题1 + 语音1 + 转写1) + 报告2 ≈ 26 单位
const COSTS: Record<string, number> = { chat: 1, vision: 2, tts: 1, asr: 1, asr_stream: 1 };
const DAILY_LIMIT_ANON = 35;   // 匿名（按IP）：约 1 场/天
const DAILY_LIMIT_USER = 105;  // 登录用户：约 3 场/天

const DEFAULT_ORIGIN = "https://liyao-china.github.io";
// 允许：线上站点 + 任意端口的本地预览（localhost / 127.0.0.1）+ file:// 调试
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
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...headers, "Content-Type": "application/json" },
  });
}

async function identifyCaller(req: Request, admin: any, tokenOverride = "") {
  let identity = "";
  let isUser = false;
  const token = (tokenOverride || (req.headers.get("authorization") ?? "").replace(/^Bearer\s+/i, "")).trim();
  let claimsAuthenticated = false;
  try {
    const claims = JSON.parse(atob(token.split(".")[1]));
    if (claims?.sub && claims?.role === "authenticated") claimsAuthenticated = true;
  } catch { /* 非 JWT / anon / 匿名 */ }
  if (claimsAuthenticated) {
    try {
      const { data, error } = await admin.auth.getUser(token);
      if (!error && data?.user?.id) {
        identity = `user:${data.user.id}`;
        isUser = true;
      }
    } catch { /* 验签失败 → 当作匿名处理 */ }
  }
  if (!identity) {
    const ip = (req.headers.get("x-forwarded-for") ?? "unknown").split(",")[0].trim();
    identity = `ip:${ip}`;
  }
  return { identity, isUser };
}

async function bumpUsageOrThrow(admin: any, identity: string, isUser: boolean, service: keyof typeof COSTS) {
  const limit = isUser ? DAILY_LIMIT_USER : DAILY_LIMIT_ANON;
  const { data: units, error } = await admin.rpc("bump_ai_usage", {
    p_identity: identity,
    p_cost: COSTS[service],
  });
  if (error) throw new Error("额度服务异常，请稍后再试");
  if ((units as number) > limit) {
    throw new Error(isUser ? "今日额度已用完，明天再来吧" : "今日免费额度已用完，登录后可获得更多额度");
  }
  return { units, limit };
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

  if (req.headers.get("upgrade")?.toLowerCase() === "websocket") {
    return handleAsrStream(req, headers);
  }

  if (req.method === "OPTIONS") return new Response("ok", { headers });
  if (req.method !== "POST") return json({ error: "method not allowed" }, 405, headers);
  if (!DASHSCOPE_KEY) return json({ error: "服务端未配置模型密钥" }, 500, headers);

  let body: any;
  try { body = await req.json(); } catch { return json({ error: "请求格式错误" }, 400, headers); }
  const { service, payload } = body ?? {};
  if (service !== "quota" && !COSTS[service]) return json({ error: "未知服务类型" }, 400, headers);

  const admin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);

  // ---- 识别调用者：登录用户按 user_id，匿名按 IP ----
  const { identity, isUser } = await identifyCaller(req, admin);
  const limit = isUser ? DAILY_LIMIT_USER : DAILY_LIMIT_ANON;

  // ---- 查询额度（不扣费）----
  if (service === "quota") {
    const { data } = await admin.rpc("get_ai_usage", { p_identity: identity });
    return json({ used: data ?? 0, limit }, 200, headers);
  }

  // ---- 扣减额度（原子操作，超限拒绝）----
  try {
    await bumpUsageOrThrow(admin, identity, isUser, service);
  } catch (usageErr) {
    console.error("usage rpc error", usageErr);
    const msg = (usageErr as Error).message || "额度服务异常，请稍后再试";
    return json({ error: msg }, msg.includes("额度已用完") ? 429 : 500, headers);
  }

  // ---- 分发到具体模型服务 ----
  try {
    if (service === "chat") {
      const messages = payload?.messages;
      if (!Array.isArray(messages) || !messages.length) return json({ error: "messages 不能为空" }, 400, headers);
      if (JSON.stringify(messages).length > 200_000) return json({ error: "对话内容过长" }, 400, headers);
      const model = payload?.mode === "fast" ? CHAT_MODEL_FAST : CHAT_MODEL_STRONG;
      const data = await callDashScope(CHAT_URL, { model, enable_thinking: false, messages });
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
      const rawUrl = data.output?.audio?.url;
      if (!rawUrl) throw new Error("TTS 未返回音频");
      // 阿里云返回 http:// 地址，HTTPS 前端会被混合内容策略拦截，统一升级为 https://
      const url = String(rawUrl).replace(/^http:\/\//i, "https://");
      return json({ url }, 200, headers);
    }

    if (service === "asr") {
      const audio = String(payload?.audio ?? "");
      if (!audio.startsWith("data:audio/") && !audio.startsWith("data:video/")) {
        return json({ error: "audio 需为 base64 Data URL" }, 400, headers);
      }
      if (audio.length > 13_000_000) return json({ error: "录音过大（限10MB）" }, 400, headers);
      // system 文本作为识别上下文/热词，提升对面试与技术术语的准确率
      const asrContext = String(payload?.context ?? "").slice(0, 800) ||
        "这是一段中文求职面试的口语回答，可能中英混说，常见词汇：产品经理、运营、算法、工程师、大模型、提示词、RAG、Agent、智能体、多模态、微调、向量数据库、用户增长、数据驱动、需求分析、项目复盘、KPI、ROI、A/B测试、Python、SQL、API、ffmpeg、字节跳动、阿里、腾讯、实习、校招。";
      const data = await callDashScope(NATIVE_URL, {
        model: ASR_MODEL,
        input: {
          messages: [
            { role: "system", content: [{ text: asrContext }] },
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

function handleAsrStream(req: Request, headers: Record<string, string>) {
  if (!DASHSCOPE_KEY) return json({ error: "服务端未配置模型密钥" }, 500, headers);
  if (!isAllowedOrigin(req.headers.get("origin") ?? "")) return json({ error: "origin not allowed" }, 403, headers);

  const { socket, response } = Deno.upgradeWebSocket(req);
  const url = new URL(req.url);
  const clientToken = url.searchParams.get("token") ?? "";
  const admin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);
  const taskId = crypto.randomUUID();
  let upstream: WebSocket | null = null;
  let upstreamReady = false;
  const audioQueue: Array<ArrayBuffer | Blob> = [];
  let resolveClosed: () => void = () => {};
  const closed = new Promise<void>((resolve) => { resolveClosed = resolve; });
  EdgeRuntime.waitUntil(closed);

  function sendClient(body: unknown) {
    try { if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(body)); } catch { /* ignore */ }
  }
  function closeBoth(code = 1000, reason = "") {
    try { if (upstream && upstream.readyState === WebSocket.OPEN) upstream.close(); } catch { /* ignore */ }
    try { if (socket.readyState === WebSocket.OPEN) socket.close(code, reason); } catch { /* ignore */ }
    resolveClosed();
  }
  function sendFinishTask() {
    if (!upstream || upstream.readyState !== WebSocket.OPEN) return;
    upstream.send(JSON.stringify({
      header: { action: "finish-task", task_id: taskId, streaming: "duplex" },
      payload: { input: {} },
    }));
  }

  socket.onopen = async () => {
    try {
      const { identity, isUser } = await identifyCaller(req, admin, clientToken);
      await bumpUsageOrThrow(admin, identity, isUser, "asr_stream");
      upstream = new WebSocket(ASR_WS_URL, {
        headers: { Authorization: `Bearer ${DASHSCOPE_KEY}`, "user-agent": "ai-mianjing-edge-asr" },
      } as any);
      upstream.binaryType = "arraybuffer";
      upstream.onopen = () => {
        upstream!.send(JSON.stringify({
          header: { action: "run-task", task_id: taskId, streaming: "duplex" },
          payload: {
            task_group: "audio",
            task: "asr",
            function: "recognition",
            model: ASR_REALTIME_MODEL,
            parameters: { format: "pcm", sample_rate: 16000, disfluency_removal_enabled: false },
            input: {},
          },
        }));
      };
      upstream.onmessage = (event) => {
        let msg: any = null;
        try { msg = JSON.parse(String(event.data)); } catch { return; }
        const ev = msg?.header?.event;
        if (ev === "task-started") {
          upstreamReady = true;
          sendClient({ type: "ready" });
          while (audioQueue.length && upstream?.readyState === WebSocket.OPEN) upstream.send(audioQueue.shift()!);
          return;
        }
        if (ev === "result-generated") {
          const sentence = msg?.payload?.output?.sentence ?? {};
          const text = String(sentence?.text ?? "").trim();
          if (text) {
            sendClient({
              type: "result",
              text,
              isFinal: sentence?.sentence_end === true || sentence?.end_time != null,
              raw: sentence,
            });
          }
          return;
        }
        if (ev === "task-finished") {
          sendClient({ type: "done" });
          closeBoth();
          return;
        }
        if (ev === "task-failed") {
          sendClient({ type: "error", error: msg?.header?.error_message || "实时转写失败" });
          closeBoth(1011, "upstream failed");
        }
      };
      upstream.onerror = () => { sendClient({ type: "error", error: "实时转写连接失败" }); closeBoth(1011, "upstream error"); };
      upstream.onclose = () => { if (socket.readyState === WebSocket.OPEN) sendClient({ type: "done" }); resolveClosed(); };
    } catch (err) {
      sendClient({ type: "error", error: (err as Error).message || "实时转写初始化失败" });
      closeBoth(1011, "init failed");
    }
  };

  socket.onmessage = (event) => {
    if (typeof event.data === "string") {
      let msg: any = {};
      try { msg = JSON.parse(event.data); } catch { /* ignore */ }
      if (msg?.type === "finish") sendFinishTask();
      return;
    }
    if (upstreamReady && upstream?.readyState === WebSocket.OPEN) upstream.send(event.data);
    else audioQueue.push(event.data);
  };
  socket.onerror = () => closeBoth(1011, "client error");
  socket.onclose = () => { closeBoth(); };

  return response;
}
