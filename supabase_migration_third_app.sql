-- ======================================================================
-- A third app: Shvil, the dog-walker matchmaking study.
--
-- Everything that made the second app (photo) possible was already
-- app-agnostic -- see supabase_migration_multi_app.sql, which said
-- "adding a third app later is one line here" about each of these three
-- CHECK constraints. This migration is that line, three times, plus the
-- study_settings row every app needs to exist at all.
--
-- Run this once in the Supabase SQL Editor. Safe to re-run.
-- ======================================================================

alter table public.sessions drop constraint if exists sessions_app_check;
alter table public.sessions add constraint sessions_app_check
  check (app in ('shapes', 'photo', 'shvil'));

alter table public.tasks drop constraint if exists tasks_app_check;
alter table public.tasks add constraint tasks_app_check
  check (app in ('shapes', 'photo', 'shvil'));

alter table public.study_settings drop constraint if exists study_settings_app_check;
alter table public.study_settings add constraint study_settings_app_check
  check (app in ('shapes', 'photo', 'shvil'));

-- Shvil starts in 'free', the same call made for photo: no task battery
-- has been authored yet, and 'tasks' with an empty sequence shows a
-- participant nothing at all.
insert into public.study_settings (app, mode) values ('shvil', 'free')
on conflict (app) do nothing;

-- ======================================================================
-- Verify. Expect the shapes and photo counts to be unchanged, a shvil
-- settings row, and zero shvil sessions.
-- ======================================================================
select 'sessions'  as table_name, app, count(*) as rows from public.sessions       group by app
union all
select 'tasks',           app, count(*) from public.tasks          group by app
union all
select 'study_settings',  app, count(*) from public.study_settings group by app
order by table_name, app;
