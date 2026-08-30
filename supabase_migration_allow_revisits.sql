-- ======================================================================
-- Allow a participant to answer the same step more than once.
--
-- The old `unique (session_id, step)` was a sound integrity rule for a
-- strictly linear flow, but the app has a Back button: going back and
-- re-choosing produced a second insert that the database rejected. The
-- correction was silently lost and the dashboard kept reporting the
-- first pick as final.
--
-- That revisit is exactly the behaviour the task work needs to measure —
-- it's what separates an indirect success (got there, but changed their
-- mind) from a direct one. So the rule has to go.
--
-- Reading rule from here on: a step's answer is its LATEST row, and a run
-- is complete when it has a row for every DISTINCT step.
--
-- Run this once in the Supabase SQL Editor.
-- ======================================================================

alter table public.selections
  drop constraint if exists selections_session_id_step_key;

-- Ordering within a step is now meaningful, so make "latest per step" cheap.
create index if not exists selections_session_step_time_idx
  on public.selections (session_id, step, created_at desc);
