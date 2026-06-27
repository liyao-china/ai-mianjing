-- 每周自动搜集外部面经：定时任务配置（pg_cron + pg_net）
-- 在 Supabase SQL Editor 执行。执行前请替换下面三个占位符：
--   __PROJECT_REF__  你的项目 ref（Dashboard URL 里的那串，如 skxpfgqylfpavoiurfhr）
--   __CRON_SECRET__  与 `supabase secrets set CRON_SECRET=...` 设置的值完全一致
-- 说明：
--   - 函数需以 --no-verify-jwt 部署（见函数头注释），定时任务靠 x-cron-secret 鉴权。
--   - 每天 02:00(UTC) 触发一次；函数内部只处理「开启每周自动搜集且距上次≥6天」的用户，
--     单次最多 10 人，因此对每个用户实际约为每周一次，多余用户顺延到后续每天补齐。

create extension if not exists pg_cron;
create extension if not exists pg_net;

-- 若已存在同名任务，先移除避免重复
select cron.unschedule('weekly-external-collect')
where exists (select 1 from cron.job where jobname = 'weekly-external-collect');

select cron.schedule(
  'weekly-external-collect',
  '0 2 * * *',
  $$
  select net.http_post(
    url     := 'https://__PROJECT_REF__.supabase.co/functions/v1/collect-external-knowledge',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'x-cron-secret', '__CRON_SECRET__'
    ),
    body    := '{}'::jsonb,
    timeout_milliseconds := 600000
  );
  $$
);

-- 查看已注册任务： select * from cron.job;
-- 查看最近执行记录： select * from cron.job_run_details order by start_time desc limit 20;
-- 手动测试一次（不等定时）： 直接执行上面的 net.http_post(...) 语句即可。
