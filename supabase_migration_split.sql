-- ======================================================================
-- Split the single `events` table into three purpose-built tables.
-- Run this once in the Supabase SQL Editor.
--
-- The old `events` table is NOT touched or dropped — it stays as an
-- archive until you're satisfied the new setup works. Drop it later with:
--     drop table public.events;
-- ======================================================================

-- ----------------------------------------------------------------------
-- One row per attempt. Created when the app loads (and again on restart),
-- so a session exists before anything references it.
-- ----------------------------------------------------------------------
create table if not exists public.sessions (
  session_id  uuid primary key,
  user_id     uuid not null,
  platform    text not null check (platform in ('mobile','desktop')),
  is_restart  boolean not null default false,
  started_at  timestamptz not null default now()
);

-- ----------------------------------------------------------------------
-- One row per pick. duration_ms is unambiguous here: time spent on that
-- step before choosing. A session with a 'shape' row is a completed run,
-- and total time is simply the sum of its three durations — so there is
-- no separate 'complete' record and nothing ever needs UPDATE.
-- ----------------------------------------------------------------------
create table if not exists public.selections (
  id          bigint generated always as identity primary key,
  session_id  uuid not null references public.sessions(session_id) on delete cascade,
  step        text not null check (step in ('number','letter','shape')),
  value       text not null,
  duration_ms integer not null check (duration_ms >= 0),
  created_at  timestamptz not null default now(),
  unique (session_id, step)
);

-- ----------------------------------------------------------------------
-- One row per click. High volume and disposable: clearing it can never
-- touch study data, and `on delete cascade` keeps it tidy.
-- Coordinates are relative to the app's content column.
-- ----------------------------------------------------------------------
create table if not exists public.clicks (
  id          bigint generated always as identity primary key,
  session_id  uuid not null references public.sessions(session_id) on delete cascade,
  step        text not null check (step in ('number','letter','shape','success')),
  x           double precision not null,
  y           double precision not null,
  created_at  timestamptz not null default now()
);

-- ----------------------------------------------------------------------
-- Indexes for the columns the dashboard actually filters and joins on.
-- ----------------------------------------------------------------------
create index if not exists sessions_started_at_idx on public.sessions (started_at);
create index if not exists sessions_platform_idx   on public.sessions (platform);
create index if not exists sessions_user_id_idx    on public.sessions (user_id);
create index if not exists selections_session_idx  on public.selections (session_id);
create index if not exists selections_step_idx     on public.selections (step);
create index if not exists clicks_session_idx      on public.clicks (session_id);
create index if not exists clicks_step_idx         on public.clicks (step);

-- ----------------------------------------------------------------------
-- Row level security: visitors may only append; only a logged-in
-- dashboard user may read. Same posture as before, applied per table.
-- ----------------------------------------------------------------------
alter table public.sessions   enable row level security;
alter table public.selections enable row level security;
alter table public.clicks     enable row level security;

create policy "insert sessions"   on public.sessions   for insert to anon, authenticated with check (true);
create policy "insert selections" on public.selections for insert to anon, authenticated with check (true);
create policy "insert clicks"     on public.clicks     for insert to anon, authenticated with check (true);

create policy "read sessions"   on public.sessions   for select to authenticated using (true);
create policy "read selections" on public.selections for select to authenticated using (true);
create policy "read clicks"     on public.clicks     for select to authenticated using (true);

-- ----------------------------------------------------------------------
-- Convenience view: one row per attempt with its picks and timings
-- already assembled. Handy for eyeballing results in the SQL editor.
-- ----------------------------------------------------------------------
create or replace view public.v_runs as
select
  s.session_id,
  s.user_id,
  s.platform,
  s.is_restart,
  s.started_at,
  max(case when sel.step = 'number' then sel.value end) as number_choice,
  max(case when sel.step = 'letter' then sel.value end) as letter_choice,
  max(case when sel.step = 'shape'  then sel.value end) as shape_choice,
  count(sel.id)                                          as steps_done,
  (count(sel.id) = 3)                                    as completed,
  sum(sel.duration_ms)                                   as total_duration_ms
from public.sessions s
left join public.selections sel on sel.session_id = s.session_id
group by s.session_id;
