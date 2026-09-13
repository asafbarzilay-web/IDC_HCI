-- ======================================================================
-- Tasks gain a type, and answers get somewhere to live.
--
-- A battery mixes two quite different things: "do this in the app" and
-- "answer this question". They share ordering, they share being asked of
-- a participant, and they share needing an answer recorded — so they stay
-- one table with a `kind` discriminator rather than becoming several
-- tables that the sequence would then have to be stitched across.
--
-- Everything type-specific lives in `config`. A column per field would
-- mean a migration per question type and a table mostly full of nulls;
-- the shapes here are read only by the code that wrote them.
--
-- Run this once in the Supabase SQL Editor. Safe to re-run.
-- ======================================================================

alter table public.tasks add column if not exists kind text not null default 'app_route';
alter table public.tasks add column if not exists config jsonb not null default '{}'::jsonb;

alter table public.tasks drop constraint if exists tasks_kind_check;
alter table public.tasks add constraint tasks_kind_check check (kind in (
  'app_route',        -- the demonstrated route through the selector
  'multiple_choice',
  'opinion_scale',
  'yes_no',
  'matrix',
  'simple_input'
));

-- Only an app_route task has a demonstrated path, so these stop being
-- required. The check keeps the pairing honest: a route task without a
-- route is not a task, it is a bug that would score every attempt.
alter table public.tasks alter column path    drop not null;
alter table public.tasks alter column binding drop not null;

alter table public.tasks drop constraint if exists tasks_route_needs_path;
alter table public.tasks add constraint tasks_route_needs_path check (
  kind <> 'app_route' or (path is not null and binding is not null)
);

-- ----------------------------------------------------------------------
-- One row per answer given.
--
-- Deliberately NOT unique on (session_id, task_id). A participant who
-- answers, goes back and changes their mind has told you something real,
-- and a unique constraint would either reject the second answer or
-- overwrite the first — either way hiding the reconsideration that is
-- often the finding. Later rows win; earlier ones are the evidence.
-- ----------------------------------------------------------------------
create table if not exists public.task_responses (
  id           bigint generated always as identity primary key,
  session_id   uuid not null references public.sessions(session_id) on delete cascade,
  task_id      uuid not null references public.tasks(task_id) on delete cascade,
  -- Copied from the task at answer time. A task edited afterwards must not
  -- silently change how answers already collected are read.
  kind         text not null,
  answer       jsonb not null,
  duration_ms  integer not null check (duration_ms >= 0),
  created_at   timestamptz not null default now()
);

create index if not exists task_responses_session_idx on public.task_responses (session_id);
create index if not exists task_responses_task_idx    on public.task_responses (task_id);

alter table public.task_responses enable row level security;

drop policy if exists "insert task_responses" on public.task_responses;
create policy "insert task_responses" on public.task_responses
  for insert to anon, authenticated with check (true);

drop policy if exists "read task_responses" on public.task_responses;
create policy "read task_responses" on public.task_responses
  for select to authenticated using (true);
