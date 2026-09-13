-- ======================================================================
-- Tie behaviour to the task it happened during.
--
-- Clicks and gaze were stored per screen, which was enough when the app
-- was one flow. A battery runs the selector once per route task, so two
-- tasks' clicks on the "shape" screen were landing in the same bucket and
-- their heatmaps were silently averaged together.
--
-- Null means free play, or a run recorded before tasks reached anyone —
-- both are real and neither should be dropped.
--
-- ON DELETE SET NULL, not CASCADE: removing a task must never take the
-- behavioural record of the session with it.
--
-- Run this once in the Supabase SQL Editor. Safe to re-run.
-- ======================================================================

alter table public.clicks add column if not exists task_id uuid
  references public.tasks(task_id) on delete set null;

alter table public.gaze add column if not exists task_id uuid
  references public.tasks(task_id) on delete set null;

create index if not exists clicks_task_idx on public.clicks (task_id) where task_id is not null;
create index if not exists gaze_task_idx    on public.gaze   (task_id) where task_id is not null;
