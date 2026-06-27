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
-- 兼容旧表结构：确保录像引用列存在（缺列会导致带 video_url 的写入整条失败 → 历史看不到记录/录像）
alter table public.interview_records add column if not exists video_url text;

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

-- 放宽单文件大小上限到 500MB，支撑长面试录像的 TUS 断点续传分片上传。
-- 注意：若项目「全局上传大小限制」(Project Settings → Storage → Global file size limit) 比这里小，
--       仍以全局值为准，需要在控制台同步调大。
update storage.buckets set file_size_limit = 524288000 where id = 'interview-videos';

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

-- ---------- 4. 私有化 RAG 知识库 MVP ----------
-- user_profiles：个人背景与目标岗位；knowledge_items：三层知识库条目
create table if not exists public.user_profiles (
  user_id uuid primary key references auth.users(id) on delete cascade,
  target_role text,
  target_companies text,
  background text,
  keywords text,
  weekly_collect_enabled boolean not null default false,
  updated_at timestamptz not null default now()
);

alter table public.user_profiles
  add column if not exists target_companies text,
  add column if not exists weekly_collect_enabled boolean not null default false,
  add column if not exists last_external_collect_at timestamptz,
  add column if not exists last_external_collect_count int not null default 0;

alter table public.user_profiles enable row level security;

drop policy if exists "own profile select" on public.user_profiles;
drop policy if exists "own profile insert" on public.user_profiles;
drop policy if exists "own profile update" on public.user_profiles;

create policy "own profile select" on public.user_profiles
  for select using (auth.uid() = user_id);

create policy "own profile insert" on public.user_profiles
  for insert with check (auth.uid() = user_id);

create policy "own profile update" on public.user_profiles
  for update using (auth.uid() = user_id) with check (auth.uid() = user_id);

create table if not exists public.knowledge_items (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  source text not null check (source in ('external','manual','report')),
  source_ref text not null,
  title text not null,
  summary text,
  content text,
  company text,
  role text,
  round text,
  tags text[] not null default '{}',
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (user_id, source, source_ref)
);

create index if not exists knowledge_items_user_created_idx
  on public.knowledge_items (user_id, created_at desc);

create index if not exists knowledge_items_user_source_idx
  on public.knowledge_items (user_id, source);

-- external 情报层的稳定落点：
-- metadata.url / metadata.query / metadata.collected_at / metadata.provider / metadata.hash
-- 同一用户同一外部内容 hash 只保留一条，避免每周搜集重复入库。
create unique index if not exists knowledge_items_external_hash_uidx
  on public.knowledge_items (user_id, (metadata->>'hash'))
  where source = 'external' and metadata ? 'hash';

-- 报告弱项闭环的稳定落点：
-- metadata.weakness_tags / metadata.improvement_goals / metadata.next_probe_suggestions / metadata.historical_progress
create index if not exists knowledge_items_report_metadata_idx
  on public.knowledge_items using gin (metadata)
  where source = 'report';

alter table public.knowledge_items enable row level security;

drop policy if exists "own knowledge select" on public.knowledge_items;
drop policy if exists "own knowledge insert" on public.knowledge_items;
drop policy if exists "own knowledge update" on public.knowledge_items;
drop policy if exists "own knowledge delete" on public.knowledge_items;

create policy "own knowledge select" on public.knowledge_items
  for select using (auth.uid() = user_id);

create policy "own knowledge insert" on public.knowledge_items
  for insert with check (auth.uid() = user_id);

create policy "own knowledge update" on public.knowledge_items
  for update using (auth.uid() = user_id) with check (auth.uid() = user_id);

create policy "own knowledge delete" on public.knowledge_items
  for delete using (auth.uid() = user_id);

-- ---------- 5. 向量检索（pgvector）：私有知识库语义 RAG ----------
-- 维度需与 ai-proxy 的 EMBED_DIM(text-embedding-v3=1024) 保持一致
create extension if not exists vector;

alter table public.knowledge_items
  add column if not exists embedding vector(1024);

-- 余弦距离近邻索引（数据量增大后显著加速；少量数据时顺序扫描也可用）
create index if not exists knowledge_items_embedding_idx
  on public.knowledge_items using hnsw (embedding vector_cosine_ops);

-- 语义检索 RPC：只返回当前登录用户、且已生成向量的条目（security invoker，RLS 同样生效）
create or replace function public.match_knowledge_items(
  query_embedding vector(1024),
  match_count int default 8
)
returns table (
  id uuid,
  source text,
  source_ref text,
  title text,
  summary text,
  content text,
  created_at timestamptz,
  similarity float
)
language sql
stable
as $$
  select ki.id, ki.source, ki.source_ref, ki.title, ki.summary, ki.content, ki.created_at,
         1 - (ki.embedding <=> query_embedding) as similarity
  from public.knowledge_items ki
  where ki.user_id = auth.uid()
    and ki.embedding is not null
  order by ki.embedding <=> query_embedding
  limit greatest(1, least(match_count, 50));
$$;
