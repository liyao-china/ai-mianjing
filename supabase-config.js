/**
 * Supabase 前端公开配置（唯一来源）。
 * 这里的 anon key 是 Supabase 公开匿名密钥，可安全暴露，由数据库 RLS 保护。
 * 各页面统一引用 window.SUPABASE_URL / window.SUPABASE_KEY，避免在多个 HTML 里重复硬编码。
 * 轮换密钥或切换项目时只改这一个文件即可。
 */
window.SUPABASE_URL = "https://skxpfgqylfpavoiurfhr.supabase.co";
window.SUPABASE_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InNreHBmZ3F5bGZwYXZvaXVyZmhyIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODA0NjE5NTYsImV4cCI6MjA5NjAzNzk1Nn0._UcR6vWOppvwcqYaHFqIlKJrADRaRZDOpBDLIdPXncY";

// 功能开关：镜头表现分析（规划中的会员专属能力，默认关闭）。
// 上线时把这里改为 true 即可——面试页会采样关键帧、报告页会生成镜头分析，无需再分别改两处。
window.ENABLE_VIDEO_ANALYSIS = false;
