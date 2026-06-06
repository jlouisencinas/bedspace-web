-- ============================================================
-- Utilities P&L: provider master-line readings, markup-based
-- bedspace rate, common-area readings, and earnings/loss tracking.
--
-- Run in Supabase SQL Editor (safe to re-run).
-- ============================================================

-- 1. Provider master-line + markup columns on cutoffs
alter table cutoffs
  add column if not exists water_main_prev          numeric(14,2),
  add column if not exists water_main_curr          numeric(14,2),
  add column if not exists water_main_consumption   numeric(14,2),   -- entered (meter may have a multiplier)
  add column if not exists water_main_amount        numeric(14,2),   -- the Maynilad bill
  add column if not exists water_markup_pct         numeric(6,2) default 10,
  add column if not exists water_rate_override       boolean default false,
  add column if not exists electric_main_prev        numeric(14,2),
  add column if not exists electric_main_curr        numeric(14,2),
  add column if not exists electric_main_consumption numeric(14,2),
  add column if not exists electric_main_amount      numeric(14,2),  -- the MERALCO bill
  add column if not exists electric_markup_pct       numeric(6,2) default 10,
  add column if not exists electric_rate_override     boolean default false;

-- 2. Common-area readings (Lobby, Second Floor, Roof Deck, Commercial)
--    rate_type STANDARD = overhead (cost rate) · BEDSPACE = charged rate
create table if not exists area_readings (
  id               serial primary key,
  cutoff_id        int references cutoffs(id) on delete cascade,
  area_name        text not null,
  utility          text not null check (utility in ('WATER','ELECTRIC')),
  previous_reading numeric(14,2) default 0,
  current_reading  numeric(14,2) default 0,
  consumption      numeric(14,2) generated always as (current_reading - previous_reading) stored,
  rate_type        text not null default 'STANDARD' check (rate_type in ('STANDARD','BEDSPACE')),
  created_at       timestamptz default now(),
  unique(cutoff_id, area_name, utility)
);
alter table area_readings disable row level security;

-- 3. Backfill May 2026 provider line from the sheet, recompute rates
update cutoffs set
  water_main_prev = 3414, water_main_curr = 3809,
  water_main_consumption = 395, water_main_amount = 55649.11,
  water_markup_pct = 10, water_rate_override = false,
  electric_main_prev = 2163, electric_main_curr = 2184,
  electric_main_consumption = 7680, electric_main_amount = 111147.98,
  electric_markup_pct = 10, electric_rate_override = false,
  -- standard = bill / consumption ; bedspace = standard × (1 + markup)
  water_maynilad_rate    = 55649.11 / 395,
  water_bedspace_rate    = (55649.11 / 395) * 1.10,
  electric_meralco_rate  = 111147.98 / 7680,
  electric_bedspace_rate = (111147.98 / 7680) * 1.10
where name = 'May 2026';

-- 4. Re-apply the new bedspace rate to May's room meter readings
update meter_readings mr set rate = c.water_bedspace_rate
from cutoffs c
where mr.cutoff_id = c.id and c.name = 'May 2026' and mr.utility = 'WATER';

update meter_readings mr set rate = c.electric_bedspace_rate
from cutoffs c
where mr.cutoff_id = c.id and c.name = 'May 2026' and mr.utility = 'ELECTRIC';
