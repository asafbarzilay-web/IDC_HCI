-- ======================================================================
-- One-time backfill: attribute legacy behaviour to the task it happened in.
--
-- task_id reached clicks and gaze in one migration and selections in a
-- later one, so runs recorded between them are half-tagged. The effect was
-- visible rather than theoretical: Free style showed a participant who had
-- chosen something without clicking anything, because its clicks were
-- stripped as tasked while its selections looked untasked and stayed.
--
-- Attribution is by the first answer recorded at or after the row. That is
-- the task that was in progress — nearest-in-time would sometimes pick the
-- previous task for a row early in the next one.
--
-- Rows after the last answer stay null on purpose: they happened on the
-- "All done" screen and belong to no task.
--
-- Approximate by nature — it reconstructs from timestamps what was never
-- recorded. Better than leaving task runs sitting in Free style, but not
-- the same as data captured properly. Runs recorded after the study_mode
-- migration need none of this.
--
-- Safe to re-run: it only ever fills nulls.
-- ======================================================================

update public.selections x
set task_id = (select tr.task_id from public.task_responses tr
               where tr.session_id = x.session_id and tr.created_at >= x.created_at
               order by tr.created_at asc limit 1)
where x.task_id is null
  and exists (select 1 from public.task_responses tr where tr.session_id = x.session_id);

update public.clicks x
set task_id = (select tr.task_id from public.task_responses tr
               where tr.session_id = x.session_id and tr.created_at >= x.created_at
               order by tr.created_at asc limit 1)
where x.task_id is null
  and exists (select 1 from public.task_responses tr where tr.session_id = x.session_id);

update public.gaze x
set task_id = (select tr.task_id from public.task_responses tr
               where tr.session_id = x.session_id and tr.created_at >= x.created_at
               order by tr.created_at asc limit 1)
where x.task_id is null
  and exists (select 1 from public.task_responses tr where tr.session_id = x.session_id);
