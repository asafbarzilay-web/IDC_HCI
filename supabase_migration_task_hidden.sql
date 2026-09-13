-- ======================================================================
-- Retire a task without destroying what it collected.
--
-- Deleting was the only destructive action in the dashboard: task_responses
-- cascades, so removing a task you had finished with also removed every
-- answer anyone had given it. That is a bad trade for tidiness — the
-- answers are the study, and the task is just the question that produced
-- them.
--
-- Hiding takes it out of the way and keeps all of it.
--
-- Run this once in the Supabase SQL Editor. Safe to re-run.
-- ======================================================================

alter table public.tasks add column if not exists hidden boolean not null default false;

-- The dashboard's default list and the participant's battery both read
-- this, so it is worth an index even at this size.
create index if not exists tasks_hidden_idx on public.tasks (hidden) where not hidden;
