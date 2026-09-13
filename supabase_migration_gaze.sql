-- ======================================================================
-- Webcam gaze tracking. Run once in the Supabase SQL Editor.
--
-- Safe to re-run: every statement is guarded.
--
-- What is and isn't stored: the webcam frames never leave the
-- participant's browser. WebGazer runs entirely client-side and only the
-- estimated gaze point is uploaded — two numbers and a timestamp. There
-- is no column here that could hold an image, and that is deliberate.
-- ======================================================================

-- ----------------------------------------------------------------------
-- Why gaze consent lives on the session rather than being inferred from
-- the presence of gaze rows: "no rows" is ambiguous. It could mean the
-- participant said no, or that they said yes and the tracker never got a
-- usable fix, or that they were on a phone and were never asked. Those
-- are different findings, so the session records which one happened.
-- ----------------------------------------------------------------------
alter table public.sessions add column if not exists gaze_state text;

alter table public.sessions drop constraint if exists sessions_gaze_state_check;
alter table public.sessions add constraint sessions_gaze_state_check
  check (gaze_state is null or gaze_state in
    ('unsupported',   -- no camera, insecure context, or a phone: never asked
     'declined',      -- asked, said no (or dismissed the browser prompt)
     'calibrating',   -- consented, started calibration, never finished it
     'tracking'));    -- calibrated and streaming

-- ----------------------------------------------------------------------
-- One row per gaze sample. Same shape and same coordinate convention as
-- `clicks` — normalized to the app's content column (.wrap), so a gaze
-- point and a click point mean the same thing and can be drawn on the
-- same preview. Values outside 0-1 are margins, not errors.
--
-- High volume and disposable like clicks: cascade on delete, and
-- clearing the table can never touch study data.
-- ----------------------------------------------------------------------
create table if not exists public.gaze (
  id          bigint generated always as identity primary key,
  session_id  uuid not null references public.sessions(session_id) on delete cascade,
  step        text not null check (step in ('number','letter','shape','success')),
  x           double precision not null,
  y           double precision not null,
  -- Milliseconds since the participant entered this step. Lets the
  -- dashboard order samples into a scanpath without trusting either the
  -- insert order or clock skew between browser and database.
  t_ms        integer not null check (t_ms >= 0),
  created_at  timestamptz not null default now()
);

create index if not exists gaze_session_idx on public.gaze (session_id);
create index if not exists gaze_step_idx    on public.gaze (step);

-- ----------------------------------------------------------------------
-- Same posture as the other tables: visitors append, only a logged-in
-- dashboard user reads.
-- ----------------------------------------------------------------------
alter table public.gaze enable row level security;

drop policy if exists "insert gaze" on public.gaze;
create policy "insert gaze" on public.gaze
  for insert to anon, authenticated with check (true);

drop policy if exists "read gaze" on public.gaze;
create policy "read gaze" on public.gaze
  for select to authenticated using (true);

-- ======================================================================
-- Update: store fixations, not raw samples.
--
-- Ten samples a second is roughly 450 rows per participant, against ~15
-- for their clicks and selections combined — a write cost far out of
-- proportion to a heatmap that blurs everything at 46px anyway. The app
-- now clusters samples into fixations in the browser and uploads only
-- the settled ones, which is 15-25 rows per participant instead.
--
-- Nothing here needs a backfill: every row already in this table was
-- written as a single sample, which is a fixation of one.
-- ======================================================================

-- How long the look lasted. A row is now "they rested here for this
-- long" rather than "the estimator returned this point once", so every
-- weighting in the dashboard reads this rather than counting rows.
alter table public.gaze add column if not exists dur_ms integer not null default 100;

-- The default exists only to fill the column for rows written before it.
-- Dropping it makes the client state the duration explicitly: a fixation
-- that silently defaulted to 100ms would look like a glance nobody had.
alter table public.gaze alter column dur_ms drop default;

alter table public.gaze drop constraint if exists gaze_dur_ms_check;
alter table public.gaze add constraint gaze_dur_ms_check check (dur_ms > 0);

-- ======================================================================
-- Update: distinguish the ways gaze can fail to start, and let a
-- participant stop tracking mid-run.
-- ======================================================================

-- 'declined' previously meant three different things — the participant
-- said no, the browser refused the camera, or the library never loaded.
-- Collapsing them made a setup fault indistinguishable from a choice,
-- which is exactly the distinction you need when someone reports that
-- "the camera thing didn't work".
alter table public.sessions drop constraint if exists sessions_gaze_state_check;
alter table public.sessions add constraint sessions_gaze_state_check
  check (gaze_state is null or gaze_state in
    ('unsupported',   -- no camera, insecure context, or a phone: never asked
     'declined',      -- asked, and the participant said no
     'blocked',       -- said yes, but the browser or OS refused the camera
     'unavailable',   -- said yes, camera fine, but the library or model failed
     'calibrating',   -- consented, started calibration, never finished it
     'tracking',      -- calibrated and streaming
     'stopped'));     -- was tracking, then the participant turned it off

-- ----------------------------------------------------------------------
-- Stopping happens long after the session row is written, so it is the
-- one thing here that cannot be an insert. Rather than open the table to
-- updates, the grant restricts anon to a single column and the policy
-- restricts it to a single transition: tracking -> stopped. Nothing else
-- about a session can be changed after the fact, including by us.
-- ----------------------------------------------------------------------
grant update (gaze_state) on public.sessions to anon, authenticated;

drop policy if exists "stop gaze" on public.sessions;
create policy "stop gaze" on public.sessions
  for update to anon, authenticated
  using (gaze_state = 'tracking')
  with check (gaze_state = 'stopped');

-- ======================================================================
-- Correction: the update policy above cannot actually work from the app.
--
-- Postgres applies SELECT policies to an UPDATE that carries a WHERE
-- clause. Reads here are restricted to authenticated users, so an anon
-- client cannot see the row it is trying to change: the WHERE matches
-- nothing, zero rows update, and PostgREST still answers 204. The stop
-- looked like it worked from every angle except the data.
--
-- Widening the read policy to fix that would expose every session to
-- anyone holding the publishable key. A security definer function is the
-- narrow alternative: it runs as owner, so it can find the row, while the
-- only thing it will ever do is the one transition, and it reports how
-- many rows it actually changed — which is what was missing.
-- ======================================================================

drop policy if exists "stop gaze" on public.sessions;
revoke update (gaze_state) on public.sessions from anon, authenticated;

create or replace function public.stop_gaze(sid uuid)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  n integer;
begin
  update public.sessions
     set gaze_state = 'stopped'
   where session_id = sid
     and gaze_state = 'tracking';   -- the only transition permitted
  get diagnostics n = row_count;
  return n;
end;
$$;

revoke all on function public.stop_gaze(uuid) from public;
grant execute on function public.stop_gaze(uuid) to anon, authenticated;
