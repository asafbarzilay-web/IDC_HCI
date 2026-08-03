-- ======================================================================
-- Records what each click actually landed on, so "mis-clicks" (clicks
-- that did nothing at all) can be counted exactly rather than inferred.
--
-- Inferring it from counts would be wrong: a click on Back or Start over
-- does something useful but isn't a selection, so subtracting selections
-- from total clicks would misreport those as mis-clicks.
--
--   option  — chose 1/2/3, A–D, or a shape (advanced the flow)
--   back    — pressed Back
--   restart — pressed Start over
--   none    — hit nothing interactive; this is a mis-click
--
-- Run this once in the Supabase SQL Editor.
-- ======================================================================

alter table public.clicks add column if not exists hit text
  check (hit in ('option', 'back', 'restart', 'none'));

create index if not exists clicks_hit_idx on public.clicks (hit);
