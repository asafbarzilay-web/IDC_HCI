-- ======================================================================
-- Let a route task start partway into the app, not always at screen one.
--
-- Every app_route task used to force a fresh attempt back to the app's
-- true first screen (study-core.js's resetApp(), called unconditionally).
-- A task about messaging a walker still made a participant click through
-- signup and dog setup first, even though neither was bound and neither
-- was what the task was testing.
--
-- entry_step names one of the steps already in `path` -- the one the
-- author marked "start here" while demonstrating. NULL means what it
-- always meant: start at the beginning. No CHECK constraint, for the same
-- reason `path`/`binding` values were never constrained -- the step
-- vocabulary belongs to the app, not the database, and it's validated at
-- authoring time by demonstrating in the real app.
--
-- Run this once in the Supabase SQL Editor. Safe to re-run.
-- ======================================================================

alter table public.tasks add column if not exists entry_step text;

-- ======================================================================
-- Verify. Existing tasks should all show a null entry_step -- they start
-- at the beginning, same as before this migration.
-- ======================================================================
select task_id, app, name, entry_step from public.tasks where kind = 'app_route';
