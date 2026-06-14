/**
 * AI 服务统一客户端：所有模型调用经过 Supabase Edge Function 代理。
 * 前端不再包含任何模型 API Key（下方 ANON_KEY 是 Supabase 公开匿名密钥，可安全暴露，由 RLS 保护）。
 * 登录用户自动携带会话令牌（享更高每日额度），匿名用户按 IP 限额。
 */
window.AIProxy = (function () {
  const FUNCTIONS_URL = "https://skxpfgqylfpavoiurfhr.supabase.co/functions/v1/ai-proxy";
  const ANON_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InNreHBmZ3F5bGZwYXZvaXVyZmhyIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODA0NjE5NTYsImV4cCI6MjA5NjAzNzk1Nn0._UcR6vWOppvwcqYaHFqIlKJrADRaRZDOpBDLIdPXncY";

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

  async function call(service, payload) {
    const res = await fetch(FUNCTIONS_URL, {
      method: "POST",
      headers: {
        Authorization: "Bearer " + getAccessToken(),
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ service, payload }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      const err = new Error(data.error || "AI 服务请求失败(" + res.status + ")");
      err.status = res.status;
      throw err;
    }
    return data;
  }

  return {
    /** 对话出题/评分。messages: [{role, content}]，返回文本 */
    chat: (messages) => call("chat", { messages }).then((d) => d.content),
    /** 图像理解（JD截图/镜头分析）。返回文本 */
    vision: (messages) => call("vision", { messages }).then((d) => d.content),
    /** 语音合成。返回音频 URL（24h有效） */
    tts: (text, voice) => call("tts", { text, voice }).then((d) => d.url),
    /** 录音转文字。audio: base64 Data URL，返回识别文本 */
    asr: (audio) => call("asr", { audio }).then((d) => d.text),
    /** 查询今日额度 {used, limit} */
    quota: () => call("quota", {}),
  };
})();
