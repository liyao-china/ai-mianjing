/**
 * Supabase 前端公开配置（唯一来源）。
 * 这里的 anon key 是 Supabase 公开匿名密钥，可安全暴露，由数据库 RLS 保护。
 * 各页面统一引用 window.SUPABASE_URL / window.SUPABASE_KEY，避免在多个 HTML 里重复硬编码。
 * 轮换密钥或切换项目时只改这一个文件即可。
 */
window.SUPABASE_URL = "https://skxpfgqylfpavoiurfhr.supabase.co";
window.SUPABASE_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InNreHBmZ3F5bGZwYXZvaXVyZmhyIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODA0NjE5NTYsImV4cCI6MjA5NjAzNzk1Nn0._UcR6vWOppvwcqYaHFqIlKJrADRaRZDOpBDLIdPXncY";
