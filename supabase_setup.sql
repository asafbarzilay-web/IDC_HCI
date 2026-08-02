-- Run this once in the Supabase SQL Editor (Database > SQL Editor > New query)

create table if not exists public.events (
  id bigint generated always as identity primary key,
  session_id text not null,
  event_type text not null check (event_type in ('select_number','select_letter','select_shape','complete','restart')),
  value text,
  created_at timestamptz not null default now()
);

alter table public.events enable row level security;

-- Public (publishable-key) clients may log new events...
create policy "Allow public insert" on public.events
  for insert
  to anon
  with check (true);

-- ---------------------------------------------------------------------
-- Update (tightened): only a logged-in Supabase Auth user may read the
-- raw event log — not anyone holding the publishable key. Run the two
-- statements below if you already created the table + old read policy.
-- ---------------------------------------------------------------------
drop policy if exists "Allow public read" on public.events;

create policy "Allow authenticated read" on public.events
  for select
  to authenticated
  using (true);

-- ---------------------------------------------------------------------
-- Update: track a persistent (per-browser) user id separate from the
-- per-attempt session id, plus which platform they used, so the
-- dashboard can report unique users and filter by device type.
-- ---------------------------------------------------------------------
alter table public.events add column if not exists user_id text;
alter table public.events add column if not exists platform text check (platform in ('mobile','desktop'));

-- ---------------------------------------------------------------------
-- Update: per-stage completion time, plus raw click positions (normalized
-- 0-1 within the app's content area) for heatmaps. 'click' is logged on
-- every click anywhere in the app so heatmaps reflect real usage; it's
-- added to the event_type allow-list alongside the existing values.
-- ---------------------------------------------------------------------
alter table public.events add column if not exists duration_ms integer;
alter table public.events add column if not exists step text;
alter table public.events add column if not exists click_x double precision;
alter table public.events add column if not exists click_y double precision;

alter table public.events drop constraint if exists events_event_type_check;
alter table public.events add constraint events_event_type_check
  check (event_type in ('select_number','select_letter','select_shape','complete','restart','click'));

-- ---------------------------------------------------------------------
-- Update (bug fix): the original insert policy covered only `anon`, so a
-- browser that had logged into the dashboard (same origin) sent inserts
-- as `authenticated` and had every event silently rejected. The app now
-- uses a never-authenticated client, and this policy makes logged-in
-- browsers work too.
-- ---------------------------------------------------------------------
create policy "Allow authenticated insert" on public.events
  for insert
  to authenticated
  with check (true);
