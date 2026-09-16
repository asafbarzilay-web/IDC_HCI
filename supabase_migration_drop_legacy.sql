-- ======================================================================
-- Drop what the schema outgrew.
--
-- Two things survived their own replacement and nothing has read either
-- for a long time.
--
-- `events` was the original single wide table — every kind of record in
-- one row shape. It was replaced by sessions / selections / clicks and
-- deliberately left in place as an archive until the split had proven
-- itself. It has.
--
-- `sessions.task_id` dates from when a session attempted exactly one
-- task. Batteries made that wrong: a session now works through several,
-- so attribution lives on task_responses and on the task_id carried by
-- each behavioural row. Nothing has written this column since.
--
-- Check what you are discarding before running the first statement —
-- `events` holds the earliest study data and has no equivalent in the
-- current schema:
--
--     select count(*), min(created_at), max(created_at) from public.events;
--
-- Dropping the column takes its foreign key and sessions_task_idx with it.
-- ======================================================================

drop table if exists public.events;

alter table public.sessions drop column if exists task_id;
