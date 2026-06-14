-- ============================================================
-- AI面镜 P0 安全改造 SQL
-- 在 Supabase 控制台 → SQL Editor 中整段执行一次即可（可重复执行）
-- ============================================================

-- ---------- 1. 每日额度表 + 原子计数函数（配合 ai-proxy 函数使用） ----------
create table if not exists public.ai_usage (
  identity text not null,
  day date not null default (now() at time zone 'Asia/Shanghai')::date,
  units integer not null default 0,
  updated_at timestamptz not null default now(),
  primary key (identity, day)
);

-- 只允许服务端（service_role）读写，前端不可见
alter table public.ai_usage enable row level security;

-- 原子累加并返回当日累计用量
create or replace function public.bump_ai_usage(p_identity text, p_cost integer)
returns integer
language plpgsql
security definer set search_path = public
as $$
declare v_units integer;
begin
  insert into ai_usage (identity, day, units)
  values (p_identity, (now() at time zone 'Asia/Shanghai')::date, p_cost)
  on conflict (identity, day)
  do update set units = ai_usage.units + p_cost, updated_at = now()
  returning units into v_units;
  return v_units;
end;
$$;

create or replace function public.get_ai_usage(p_identity text)
returns integer
language sql
security definer set search_path = public
as $$
  select coalesce(
    (select units from ai_usage
     where identity = p_identity
       and day = (now() at time zone 'Asia/Shanghai')::date),
    0);
$$;

-- 仅允许 service_role 调用（撤销公共执行权限）
revoke execute on function public.bump_ai_usage(text, integer) from public, anon, authenticated;
revoke execute on function public.get_ai_usage(text) from public, anon, authenticated;

-- ---------- 2. 面试记录表：强制用户隔离（P0-4） ----------
alter table public.interview_records enable row level security;

drop policy if exists "own records select" on public.interview_records;
drop policy if exists "own records insert" on public.interview_records;
drop policy if exists "own records update" on public.interview_records;
drop policy if exists "own records delete" on public.interview_records;

create policy "own records select" on public.interview_records
  for select using (auth.uid() = user_id);

create policy "own records insert" on public.interview_records
  for insert with check (auth.uid() = user_id);

-- 用于删除录像后清空记录中的 video_url 引用
create policy "own records update" on public.interview_records
  for update using (auth.uid() = user_id) with check (auth.uid() = user_id);

create policy "own records delete" on public.interview_records
  for delete using (auth.uid() = user_id);

-- ---------- 3. 面试录像桶：私有化（P0-3） ----------
-- 注意：还需在 控制台 → Storage → interview-videos → 设置 中把 Public 开关关掉！
update storage.buckets set public = false where id = 'interview-videos';

drop policy if exists "own videos read" on storage.objects;
drop policy if exists "own videos insert" on storage.objects;
drop policy if exists "own videos delete" on storage.objects;

-- 路径约定：{user_id}/{timestamp}.webm，只有本人能读写自己目录
create policy "own videos read" on storage.objects
  for select using (
    bucket_id = 'interview-videos'
    and auth.uid()::text = (storage.foldername(name))[1]
  );

create policy "own videos insert" on storage.objects
  for insert with check (
    bucket_id = 'interview-videos'
    and auth.uid()::text = (storage.foldername(name))[1]
  );

create policy "own videos delete" on storage.objects
  for delete using (
    bucket_id = 'interview-videos'
    and auth.uid()::text = (storage.foldername(name))[1]
  );
