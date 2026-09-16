-- ======================================================================
-- Two apps, one study database.
--
-- Almost nothing here was ever about shapes. Sessions, clicks,
-- selections, gaze, the task battery, the six question types, the study
-- modes and the scoring rules are all app-agnostic. The only thing in
-- the entire schema that actually said "shapes" was
--
--     check (step in ('number','letter','shape','success'))
--
-- repeated across three tables. This migration removes that, and adds
-- the one column that stops two apps' data being read as one cohort.
--
-- The alternative was a second set of tables and a second dashboard.
-- That avoids adding one column, at the cost of maintaining two copies
-- of every query, filter and scoring rule -- and fixing every bug twice.
--
-- Run this once in the Supabase SQL Editor. Safe to re-run.
-- ======================================================================


-- ----------------------------------------------------------------------
-- 1. Which app a session belongs to.
--
-- The default exists to fill the rows already in the table, all of which
-- are the shapes selector. It is deliberately LEFT IN PLACE rather than
-- dropped the way `gaze.dur_ms` was: dropping it would make every insert
-- from the live shapes app fail until new code shipped, and that
-- ordering is not worth the protection. See the optional block at the
-- bottom of this file for how to tighten it once both apps are live.
-- ----------------------------------------------------------------------
alter table public.sessions add column if not exists app text not null default 'shapes';

-- A CHECK rather than a lookup table. The failure this guards against is
-- a typo in the slug -- 'photos' instead of 'photo' -- which a free-text
-- column accepts silently, creating a third cohort that no dashboard
-- filter displays. The sessions would not be wrong, they would be
-- invisible, which is worse. Adding a third app later is one line here.
alter table public.sessions drop constraint if exists sessions_app_check;
alter table public.sessions add constraint sessions_app_check
  check (app in ('shapes', 'photo'));


-- ----------------------------------------------------------------------
-- 2. The screen list stops being the database's business.
--
-- Each app declares its own screens; the database only insists the value
-- is not empty, because '' would collapse every screen of an app into a
-- single heatmap without ever raising an error.
-- ----------------------------------------------------------------------
alter table public.selections drop constraint if exists selections_step_check;
alter table public.clicks     drop constraint if exists clicks_step_check;
alter table public.gaze       drop constraint if exists gaze_step_check;

alter table public.selections add constraint selections_step_check check (length(step) > 0);
alter table public.clicks     add constraint clicks_step_check     check (length(step) > 0);
alter table public.gaze       add constraint gaze_step_check       check (length(step) > 0);


-- ----------------------------------------------------------------------
-- 3. Overlays.
--
-- An overlay is not a screen you navigate to, it is a layer drawn on top
-- of one. `Photo open` sits over Discover; `Search keyboard` sits over
-- Search. Without this column, a tap on the opened photo carries
-- coordinates that the dashboard would paint onto the grid underneath --
-- two different things smeared into one heatmap, with nothing in the
-- data to show it had happened.
--
-- Not added to `selections`. An overlay a participant opened is itself a
-- choice, already recorded as an ordinary {step, value} pair; a column
-- there would create two ways to say the same thing and eventually two
-- answers to "did they open the photo".
-- ----------------------------------------------------------------------
alter table public.clicks add column if not exists overlay text;
alter table public.gaze   add column if not exists overlay text;

alter table public.clicks drop constraint if exists clicks_overlay_check;
alter table public.gaze   drop constraint if exists gaze_overlay_check;
alter table public.clicks add constraint clicks_overlay_check check (overlay is null or length(overlay) > 0);
alter table public.gaze   add constraint gaze_overlay_check   check (overlay is null or length(overlay) > 0);


-- ----------------------------------------------------------------------
-- 4. The task battery is per-app.
--
-- A route through the photo app is meaningless in the shapes selector,
-- so `position` has to be scoped or the two batteries interleave into
-- one nonsensical sequence.
-- ----------------------------------------------------------------------
alter table public.tasks add column if not exists app text not null default 'shapes';

alter table public.tasks drop constraint if exists tasks_app_check;
alter table public.tasks add constraint tasks_app_check
  check (app in ('shapes', 'photo'));


-- ----------------------------------------------------------------------
-- 5. Study mode is per-app too.
--
-- `study_settings` was one row, enforced by `id smallint check (id = 1)`
-- -- the right call when there was one study. Two apps need two answers,
-- so the app slug becomes the key and the surrogate id goes away rather
-- than lingering as a column that means nothing.
-- ----------------------------------------------------------------------
alter table public.study_settings add column if not exists app text;
update public.study_settings set app = 'shapes' where app is null;

-- Dropping `id` takes the primary key and the `id = 1` check with it.
alter table public.study_settings drop column if exists id;
alter table public.study_settings alter column app set not null;

alter table public.study_settings drop constraint if exists study_settings_pkey;
alter table public.study_settings add constraint study_settings_pkey primary key (app);

alter table public.study_settings drop constraint if exists study_settings_app_check;
alter table public.study_settings add constraint study_settings_app_check
  check (app in ('shapes', 'photo'));

-- `on conflict do nothing` matters: the shapes row already exists and
-- holds whichever mode is currently in force. This must not reset it.
--
-- photo starts in 'free' rather than the 'tasks' default, because it has
-- no battery authored yet and 'tasks' with an empty sequence shows a
-- participant nothing at all.
insert into public.study_settings (app, mode) values
  ('shapes', 'tasks'),
  ('photo',  'free')
on conflict (app) do nothing;


-- ----------------------------------------------------------------------
-- 6. Indexes for the way the dashboard now reads.
--
-- Every cohort query becomes app-scoped, so `app` leads both of these:
-- a date range within one app is the shape of nearly every read.
-- ----------------------------------------------------------------------
create index if not exists sessions_app_started_idx on public.sessions (app, started_at);
create index if not exists tasks_app_position_idx   on public.tasks (app, position) where position is not null;


-- ======================================================================
-- Verify. This returns rows rather than "Success. No rows returned", so
-- you can see it worked instead of inferring it from the absence of an
-- error. Expect the shapes counts to match what was there before, a
-- photo settings row, and zero photo sessions.
-- ======================================================================
select 'sessions'  as table_name, app, count(*) as rows from public.sessions       group by app
union all
select 'tasks',           app, count(*) from public.tasks          group by app
union all
select 'study_settings',  app, count(*) from public.study_settings group by app
order by table_name, app;


-- ======================================================================
-- OPTIONAL, and only AFTER both apps are deployed and writing `app`
-- explicitly. Removing the default turns "the app forgot to say which
-- app it is" from a row silently filed under shapes into a failed
-- insert. Running it before the code ships breaks the live shapes app.
--
--   alter table public.sessions alter column app drop default;
--   alter table public.tasks    alter column app drop default;
-- ======================================================================
