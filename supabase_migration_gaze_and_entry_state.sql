-- ======================================================================
-- Eye tracking per task and for free exploration; entry-point state for
-- route tasks; and a repair for task clicks photo and Shvil filed as free.
--
-- Run this once in the Supabase SQL Editor. Safe to re-run.
-- ======================================================================


-- ----------------------------------------------------------------------
-- 1. Eye tracking is switched on where it is wanted, and off everywhere
--    else by default.
--
-- It used to be the shapes app's alone, and always offered. Now every app
-- has it through study-core.js, and the dashboard turns it on per route
-- task and separately for free exploration. A participant is asked for
-- the camera once, up front, only if something they will do wants it.
--
-- Defaults are false, so nothing existing starts asking for a camera.
-- That includes the shapes app, which asked everyone before this.
-- ----------------------------------------------------------------------
alter table public.tasks
  add column if not exists gaze boolean not null default false;

alter table public.study_settings
  add column if not exists gaze_free boolean not null default false;


-- ----------------------------------------------------------------------
-- 2. What the app looked like when a route task's entry step was reached.
--
-- entry_step lets a task start partway in, but it restored the screen and
-- nothing else: a task starting at Shvil's checkout got walker #1, today,
-- 16:00 rather than whatever the author picked on the way. This holds the
-- app's own snapshot from that step during the demonstration, and the app
-- restores it. The shape is the app's business (like `config`), so jsonb.
-- NULL means defaults, which is what every task saved before this gets.
-- ----------------------------------------------------------------------
alter table public.tasks
  add column if not exists entry_state jsonb;


-- ----------------------------------------------------------------------
-- 3. Repair: photo and Shvil clicks made during a task, saved without it.
--
-- Both apps passed study-core.js a `taskId` hook that always returned
-- null, so every click they recorded during a task was stamped as free
-- play: missing from that task's heatmap and counted under Free style.
-- Their selections were stamped correctly (the core did that itself), and
-- the core now stamps clicks too, so this only repairs rows already saved.
--
-- A click belongs to the first task answered at or after it — but only
-- if the task had already begun. "Begun" is:
--   - after the previous task's answer, for every task but the first
--   - for the first task: always in 'tasks' mode (no free play exists);
--     in 'free_then_tasks', from that session's first task-stamped
--     selection, because clicks before it were free exploration.
-- Approximate at one edge: in free_then_tasks, clicks in the first task
-- before its first choice stay in Free style. Better than all of them.
--
-- Rows after the last answer stay null on purpose: "All done" belongs to
-- no task. Only fills nulls, so it is safe to re-run.
-- ----------------------------------------------------------------------
update public.clicks c
set task_id = (select tr.task_id from public.task_responses tr
               where tr.session_id = c.session_id and tr.created_at >= c.created_at
               order by tr.created_at asc limit 1)
from public.sessions s
where s.session_id = c.session_id
  and s.app in ('photo', 'shvil')
  and c.task_id is null
  and exists (select 1 from public.task_responses tr
              where tr.session_id = c.session_id and tr.created_at >= c.created_at)
  and (
    exists (select 1 from public.task_responses p
            where p.session_id = c.session_id and p.created_at < c.created_at)
    or s.study_mode = 'tasks'
    or c.created_at >= (select min(sel.created_at) from public.selections sel
                        where sel.session_id = c.session_id and sel.task_id is not null)
  );


-- ======================================================================
-- Verify.
--   - tasks: every row has gaze = false; route tasks have entry_state null
--   - study_settings: one row per app, gaze_free = false
--   - the last query: photo/shvil clicks now carrying a task, per app
-- ======================================================================
select app, kind, count(*) as tasks, count(*) filter (where gaze) as with_gaze,
       count(entry_state) as with_entry_state
from public.tasks group by app, kind order by app, kind;

select app, mode, gaze_free from public.study_settings order by app;

select s.app, count(*) filter (where c.task_id is not null) as task_clicks,
       count(*) filter (where c.task_id is null) as free_clicks
from public.clicks c join public.sessions s using (session_id)
where s.app in ('photo', 'shvil')
group by s.app order by s.app;
