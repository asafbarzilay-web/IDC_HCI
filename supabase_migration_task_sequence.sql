-- ======================================================================
-- Tasks become an ordered battery rather than one-at-a-time.
--
-- A single active task couldn't express "do these three, in order", which
-- is the usual shape of a usability study. `position` replaces `is_active`
-- and carries both facts at once:
--
--   position IS NULL   the task exists but isn't being asked
--   position = 1,2,3   its place in the sequence participants work through
--
-- Deliberately NOT unique. A unique index would make reordering a
-- transactional puzzle (swapping two rows collides mid-update) for no real
-- benefit — ties break on created_at, and renumbering keeps them distinct.
--
-- Run this once in the Supabase SQL Editor.
-- ======================================================================

alter table public.tasks add column if not exists position integer;

-- Carry over whatever was active so nothing silently drops out of the study.
update public.tasks set position = 1 where is_active and position is null;

-- The single-active rule and its trigger no longer apply.
drop trigger  if exists tasks_single_active on public.tasks;
drop function if exists public.only_one_active_task();
alter table public.tasks drop column if exists is_active;

create index if not exists tasks_position_idx
  on public.tasks (position) where position is not null;
