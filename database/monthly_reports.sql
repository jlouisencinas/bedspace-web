-- ============================================================
-- Monthly report snapshots (Property Summary + P&L + Collections).
-- One row per cutoff (month). Upserted on close so re-closing overrides.
-- Quarterly view consolidates 3 months on screen.
--
-- Run in Supabase SQL Editor.
-- ============================================================

create table if not exists monthly_reports (
  id          serial primary key,
  cutoff_id   int references cutoffs(id) on delete cascade unique,
  period_name text,
  period_date date,                       -- month start (for quarter grouping/sort)

  -- Property summary
  total_beds     int,
  sellable       int,
  occupied_beds  int,
  active_tenants int,
  occupied_rooms int,
  total_rooms    int,
  occupancy_pct  numeric(6,2),

  -- Collections (from billing)
  col_rent     numeric(14,2),
  col_water    numeric(14,2),
  col_electric numeric(14,2),
  col_addons   numeric(14,2),
  col_total    numeric(14,2),

  -- Utility P&L
  water_cost           numeric(14,2),
  water_collections    numeric(14,2),
  water_variance       numeric(14,2),
  electric_cost        numeric(14,2),
  electric_collections numeric(14,2),
  electric_variance    numeric(14,2),
  total_variance       numeric(14,2),

  snapshot_at  timestamptz default now()
);

alter table monthly_reports disable row level security;
