-- ======================================================================
-- Tasks: a goal given to the participant, authored by demonstration.
--
-- One shape covers both kinds of task, because "follow this exact path"
-- is just "reach this goal" with every step binding:
--
--   path      the demonstrated route, e.g. [{"step":"number","value":"2"},
--             {"step":"letter","value":"D"},{"step":"shape","value":"triangle"}]
--   binding   which of those steps must actually match to count as success
--               all three  -> exact-path task
--               ['shape']  -> "reach the Triangle", any route
--               a subset   -> "the Triangle, under D, any number"
--
-- Scoring reads only the binding steps. Wandering through free steps is
-- not an error — it shows up as extra time and clicks instead.
--
-- Run this once in the Supabase SQL Editor.
-- ======================================================================

create table if not exists public.tasks (
  task_id     uuid primary key,
  name        text not null,                -- short label for the dashboard
  goal_text   text not null,                -- what the participant reads
  path        jsonb not null,               -- the demonstrated route, in order
  binding     text[] not null,              -- steps that must match
  is_active   boolean not null default false,
  created_at  timestamptz not null default now()
);

-- Which task a run was attempting. Null for free-play sessions recorded
-- before tasks existed, so old rows stay valid.
alter table public.sessions add column if not exists task_id uuid references public.tasks(task_id);

create index if not exists tasks_active_idx    on public.tasks (is_active) where is_active;
create index if not exists sessions_task_idx   on public.sessions (task_id);

-- ----------------------------------------------------------------------
-- Participants must READ the active task; only a signed-in author may
-- create or change one. Without the authenticated-only write rule, anyone
-- with the publishable key could rewrite the study's tasks.
-- ----------------------------------------------------------------------
alter table public.tasks enable row level security;

create policy "read tasks"   on public.tasks for select to anon, authenticated using (true);
create policy "insert tasks" on public.tasks for insert to authenticated with check (true);
create policy "update tasks" on public.tasks for update to authenticated using (true) with check (true);
create policy "delete tasks" on public.tasks for delete to authenticated using (true);

-- Only one task active at a time: activating one stands the others down.
create or replace function public.only_one_active_task() returns trigger as $$
begin
  if new.is_active then
    update public.tasks set is_active = false
      where task_id <> new.task_id and is_active;
  end if;
  return new;
end;
$$ language plpgsql;

drop trigger if exists tasks_single_active on public.tasks;
create trigger tasks_single_active
  after insert or update of is_active on public.tasks
  for each row when (new.is_active)
  execute function public.only_one_active_task();
