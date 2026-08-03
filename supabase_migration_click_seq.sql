-- ======================================================================
-- Adds a per-step click ordinal so the dashboard can filter to "1st
-- click", "2nd click", etc.
--
-- Why a stored column rather than ordering by id/created_at: those
-- reflect the order inserts *arrived* at the database, and clicks are
-- written asynchronously, so two rapid clicks can land out of order.
-- seq is assigned in the browser at click time, so it is always the
-- true order the participant clicked in.
--
-- Run this once in the Supabase SQL Editor.
-- ======================================================================

alter table public.clicks add column if not exists seq integer;

-- Ordering within a step is the common lookup for the heatmap filter.
create index if not exists clicks_step_seq_idx on public.clicks (step, seq);
