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

-- ...and read events back, so the dashboard can render without a server.
-- This data has no personal info (just picks + a random session id), so a public
-- read policy is a reasonable tradeoff for a quick prototype. Tighten later if needed.
create policy "Allow public read" on public.events
  for select
  to anon
  using (true);
