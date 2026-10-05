-- ======================================================================
-- Mark test runs so they stay out of the results.
--
-- A participant who has finished a battery is not offered it again in the
-- same browser. The author still needs to take it as often as they like,
-- so the dashboard hands out a test link (?retake=1) that skips that check.
-- Runs from it are recorded with is_test = true, and every dashboard view
-- leaves them out.
--
-- The app only sends is_test when it is true, so ordinary participants
-- keep recording even before this has been run. The dashboard filters on
-- it, so run this BEFORE the new dashboard goes live.
--
-- Run this once in the Supabase SQL Editor. Safe to re-run.
-- ======================================================================

alter table public.sessions
  add column if not exists is_test boolean not null default false;

-- ======================================================================
-- Verify: every existing session is a real one.
-- ======================================================================
select app, is_test, count(*) from public.sessions group by app, is_test order by app;
