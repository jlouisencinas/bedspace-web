-- Day-weighted occupancy reporting: monthly_reports column type migration.
--
-- occupied_beds / active_tenants / occupied_rooms move from point-in-time
-- integer counts to day-weighted averages (fractional) — see
-- supabase/functions/_shared/occupancy.ts (computeOccupancySnapshot) and
-- docs/requirements.md §9 for the formula this feeds.
--
-- total_beds / sellable / total_rooms are UNCHANGED (current-inventory counts,
-- property structure, not tenancy-driven — day-weighting doesn't apply to them).
-- occupancy_pct is already numeric(6,2) — no change needed there either.
--
-- Apply ONLY this block against the live DB (per CLAUDE.md: never run all of
-- database/init.sql — its seed section truncates live data).
--
-- NOTE: the originally-planned pg_cron/pg_net scheduled snapshot Edge Function
-- was cancelled by the owner (2026-09-22) in favor of an embedded snapshot
-- capture on cutoff-open (src/pages/Utilities.jsx, via buildAndSaveSnapshot).
-- No cron schedule, no pg_cron/pg_net extension requirement — nothing else in
-- this file needs database-admin's extension-availability check.

alter table public.monthly_reports
  alter column occupied_beds  type numeric(6,2) using occupied_beds::numeric,
  alter column active_tenants type numeric(6,2) using active_tenants::numeric,
  alter column occupied_rooms type numeric(6,2) using occupied_rooms::numeric;
