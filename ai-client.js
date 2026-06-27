/**
 * AI 服务统一客户端：所有模型调用经过 Supabase Edge Function 代理。
 * 前端不再包含任何模型 API Key（下方 ANON_KEY 是 Supabase 公开匿名密钥，可安全暴露，由 RLS 保护）。
 * 登录用户自动携带会话令牌（享更高每日额度），匿名用户按 IP 限额。
 */
window.AIProxy = (function () {
  // 优先用 supabase-config.js 提供的统一配置；保留字面量兜底，确保未加载 config 的页面也能工作
  const SB_URL = (typeof window !== "undefined" && window.SUPABASE_URL) || "https://skxpfgqylfpavoiurfhr.supabase.co";
  const FUNCTIONS_URL = SB_URL + "/functions/v1/ai-proxy";
  const ANON_KEY = (typeof window !== "undefined" && window.SUPABASE_KEY) || "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InNreHBmZ3F5bGZwYXZvaXVyZmhyIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODA0NjE5NTYsImV4cCI6MjA5NjAzNzk1Nn0._UcR6vWOppvwcqYaHFqIlKJrADRaRZDOpBDLIdPXncY";

  function getAccessToken() {
    try {
      for (const key of Object.keys(localStorage)) {
        if (key.startsWith("sb-") && key.endsWith("-auth-token")) {
          const session = JSON.parse(localStorage.getItem(key));
          const token = session?.access_token || session?.currentSession?.access_token;
          if (token) return token;
        }
      }
    } catch (e) { /* 匿名兜底 */ }
    return ANON_KEY;
  }

  // 各服务的前端超时（毫秒）。略高于服务端上游 90s，确保通常能拿到真实结果/错误；
  // 一旦网络挂起也能在有限时间内失败，避免界面无限停在"思考中"。
  const TIMEOUTS = { chat: 100000, vision: 100000, asr: 60000, tts: 45000, quota: 15000, embed: 30000 };

  async function call(service, payload) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUTS[service] || 60000);
    let res;
    try {
      res = await fetch(FUNCTIONS_URL, {
        method: "POST",
        headers: {
          Authorization: "Bearer " + getAccessToken(),
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ service, payload }),
        signal: controller.signal,
      });
    } catch (e) {
      if (e && e.name === "AbortError") {
        const err = new Error("AI 服务响应超时，请检查网络后重试");
        err.status = 0; err.timeout = true;
        throw err;
      }
      const err = new Error("网络连接失败，请检查网络后重试");
      err.status = 0; err.network = true;
      throw err;
    } finally {
      clearTimeout(timer);
    }
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      const err = new Error(data.error || "AI 服务请求失败(" + res.status + ")");
      err.status = res.status;
      throw err;
    }
    return data;
  }

  return {
    /** 对话/评分。messages: [{role, content}]，返回文本；opts.mode='fast' 用快模型做实时追问，默认保留强模型 */
    chat: (messages, opts) => call("chat", { messages, mode: opts && opts.mode }).then((d) => d.content),
    /** 图像理解（JD截图/镜头分析）。返回文本 */
    vision: (messages) => call("vision", { messages }).then((d) => d.content),
    /** 语音合成。返回音频 URL（24h有效） */
    tts: (text, voice) => call("tts", { text, voice }).then((d) => d.url),
    /** 录音转文字。audio: base64 Data URL；context: 可选热词/上下文（岗位/JD/简历/当前问题），提升专有名词与同音字准确率。返回识别文本 */
    asr: (audio, context) => call("asr", { audio, context }).then((d) => d.text),
    /** 实时 ASR WebSocket 地址：浏览器连 Supabase 代理，DashScope API Key 只留在 Edge Function */
    asrStreamUrl: () => FUNCTIONS_URL.replace(/^http/i, "ws") + "?stream=asr&token=" + encodeURIComponent(getAccessToken()),
    /** 流式 TTS WebSocket 地址：浏览器发送文本、逐块接收 PCM 音频；voice 可选（CosyVoice 音色） */
    ttsStreamUrl: (voice) => FUNCTIONS_URL.replace(/^http/i, "ws") + "?stream=tts&token=" + encodeURIComponent(getAccessToken()) + (voice ? "&voice=" + encodeURIComponent(voice) : ""),
    /** 查询今日额度 {used, limit} */
    quota: () => call("quota", {}),
    /** 文本向量化（私有知识库语义检索 RAG）。传单条字符串或字符串数组；返回 number[][]（与输入顺序一致） */
    embed: (texts) => call("embed", Array.isArray(texts) ? { texts } : { text: texts }).then((d) => d.embeddings),
  };
})();
