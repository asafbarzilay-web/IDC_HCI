-- ======================================================================
-- How the app behaves for whoever opens the link.
--
-- Until now this was implicit: any task in the sequence meant every
-- visitor got the battery. That conflated "a task exists" with "the study
-- is running it", and left no way to collect free-play behaviour once a
-- battery had been written.
--
--   free             the selector, no tasks, as it always was
--   tasks            the battery, straight away
--   free_then_tasks  free play, with the tasks available when they choose
--
-- Run this once in the Supabase SQL Editor. Safe to re-run.
-- ======================================================================

create table if not exists public.study_settings (
  -- One row, enforced: a study has one mode, and a second row would be a
  -- silent disagreement about which one is in force.
  id          smallint primary key default 1 check (id = 1),
  mode        text not null default 'tasks'
              check (mode in ('free', 'tasks', 'free_then_tasks')),
  updated_at  timestamptz not null default now()
);

insert into public.study_settings (id, mode) values (1, 'tasks')
  on conflict (id) do nothing;

alter table public.study_settings enable row level security;

-- Participants must read it — it decides what the app does — but only a
-- signed-in author may change how the study runs.
drop policy if exists "read study_settings" on public.study_settings;
create policy "read study_settings" on public.study_settings
  for select to anon, authenticated using (true);

drop policy if exists "write study_settings" on public.study_settings;
create policy "write study_settings" on public.study_settings
  for update to authenticated using (true) with check (true);

-- ----------------------------------------------------------------------
-- Which mode a session ran under. Recorded per session rather than read
-- back from the settings table, because the mode can change between one
-- participant and the next and the old runs must keep their own meaning.
-- ----------------------------------------------------------------------
alter table public.sessions add column if not exists study_mode text;

-- ----------------------------------------------------------------------
-- Selections gain the task stamp that clicks and gaze already carry.
-- In free_then_tasks one session holds both free play and task work, and
-- without this there is no way to tell which picks belong to which.
-- ----------------------------------------------------------------------
alter table public.selections add column if not exists task_id uuid
  references public.tasks(task_id) on delete set null;

create index if not exists selections_task_idx
  on public.selections (task_id) where task_id is not null;
