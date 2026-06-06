-- ============================================================
-- Bedspace Manager — UTILITIES (Water + Electric) tracking
-- Run in: Supabase SQL Editor
--
-- Design goals (from requirements):
--   • Water and electric have SEPARATE cutoff date ranges
--       water:    1st of month  → 1st of next month
--       electric: 10th of month → 10th of next month
--   • Rates are fully customizable per cutoff (₱/cubic meter, ₱/kWh)
--   • Studios use a higher water rate (rate override by room type)
--   • Consumption & amount auto-compute — staff only type the new reading
--   • Each new cutoff's "previous" reading carries forward automatically
-- ============================================================

-- ── Cutoffs: one row per billing period ───────────────────────────────────────
create table if not exists cutoffs (
  id                serial primary key,
  name              text not null,            -- e.g. "May 2026"
  -- Separate windows per utility
  water_start       date,
  water_end         date,
  electric_start    date,
  electric_end      date,
  -- Customizable rates for THIS cutoff — TWO per utility:
  --   provider rate (cost reference) + bedspace rate (billed to tenant)
  water_maynilad_rate    numeric(12,6) not null default 0,   -- Water: ₱/m³ Maynilad charges
  water_bedspace_rate    numeric(12,6) not null default 0,   -- Water: ₱/m³ billed to tenant (used for amount)
  electric_meralco_rate  numeric(12,6) not null default 0,   -- Electric: ₱/kWh MERALCO charges
  electric_bedspace_rate numeric(12,6) not null default 0,   -- Electric: ₱/kWh billed to tenant (used for amount)
  is_active         boolean default false,    -- the cutoff currently being encoded
  created_at        timestamptz default now(),
  unique(name)
);

-- ── Meter readings: one row per room × cutoff × utility ───────────────────────
-- consumption and amount are GENERATED — never typed, never drift.
-- rate is snapshotted per reading (defaults from the cutoff, studio-aware,
-- but editable) so historical bills stay correct even if a rate is later changed.
create table if not exists meter_readings (
  id                serial primary key,
  cutoff_id         int references cutoffs(id) on delete cascade,
  room_id           int references rooms(id)   on delete cascade,
  utility           text not null check (utility in ('WATER','ELECTRIC')),
  previous_reading  numeric(12,2) default 0,
  current_reading   numeric(12,2) default 0,
  rate              numeric(12,6) default 0,
  -- Generated columns reference only base columns (not each other)
  consumption numeric(12,2)
    generated always as (current_reading - previous_reading) stored,
  amount      numeric(14,2)
    generated always as ((current_reading - previous_reading) * rate) stored,
  created_at        timestamptz default now(),
  unique(cutoff_id, room_id, utility)
);

create index if not exists idx_meter_room_util on meter_readings(room_id, utility);
create index if not exists idx_meter_cutoff    on meter_readings(cutoff_id);

alter table cutoffs        disable row level security;
alter table meter_readings disable row level security;

-- ── View: latest reading per room+utility (for carry-forward) ─────────────────
-- Uses water_start as the chronological anchor for ordering periods.
create or replace view v_latest_reading as
select distinct on (mr.room_id, mr.utility)
  mr.room_id,
  mr.utility,
  mr.current_reading,
  mr.cutoff_id,
  c.water_start as anchor
from meter_readings mr
join cutoffs c on c.id = mr.cutoff_id
order by mr.room_id, mr.utility, c.water_start desc, mr.cutoff_id desc;

-- ── View: per-cutoff billing sheet (mirrors the Google Sheet layout) ──────────
-- One row per room with water block + electric block + combined total.
create or replace view v_utility_bill as
select
  c.id                                   as cutoff_id,
  c.name                                 as cutoff_name,
  r.id                                   as room_id,
  r.room_no,
  r.room_type,
  -- Water
  w.previous_reading                     as water_prev,
  w.current_reading                      as water_curr,
  w.consumption                          as water_consumption,
  w.rate                                 as water_rate,
  w.amount                               as water_amount,
  -- Electric
  e.previous_reading                     as elec_prev,
  e.current_reading                      as elec_curr,
  e.consumption                          as elec_consumption,
  e.rate                                 as elec_rate,
  e.amount                               as elec_amount,
  -- Combined
  coalesce(w.amount,0) + coalesce(e.amount,0) as total_amount
from cutoffs c
cross join rooms r
left join meter_readings w on w.cutoff_id = c.id and w.room_id = r.id and w.utility = 'WATER'
left join meter_readings e on e.cutoff_id = c.id and e.room_id = r.id and e.utility = 'ELECTRIC'
order by c.id, (r.room_no)::int;

-- ── View: totals per cutoff per utility ───────────────────────────────────────
create or replace view v_cutoff_summary as
select
  c.id   as cutoff_id,
  c.name as cutoff_name,
  mr.utility,
  count(*)               as rooms_billed,
  sum(mr.consumption)    as total_consumption,
  sum(mr.amount)         as total_amount
from cutoffs c
join meter_readings mr on mr.cutoff_id = c.id
group by c.id, c.name, mr.utility;

-- ── Function: open a new cutoff and carry forward previous readings ───────────
-- Creates the cutoff, then seeds one WATER + one ELECTRIC reading per room
-- with previous_reading = each room's latest current_reading, and the correct
-- studio-aware rate. Staff then just fill in current_reading.
create or replace function open_cutoff(
  p_name                   text,
  p_water_start            date,
  p_water_end              date,
  p_electric_start         date,
  p_electric_end           date,
  p_water_maynilad_rate    numeric,
  p_water_bedspace_rate    numeric,
  p_electric_meralco_rate  numeric,
  p_electric_bedspace_rate numeric
) returns int as $$
declare
  v_cutoff_id int;
begin
  insert into cutoffs(name, water_start, water_end, electric_start, electric_end,
                      water_maynilad_rate, water_bedspace_rate,
                      electric_meralco_rate, electric_bedspace_rate, is_active)
  values (p_name, p_water_start, p_water_end, p_electric_start, p_electric_end,
          p_water_maynilad_rate, p_water_bedspace_rate,
          p_electric_meralco_rate, p_electric_bedspace_rate, true)
  returning id into v_cutoff_id;

  -- Only one active cutoff at a time
  update cutoffs set is_active = false where id <> v_cutoff_id;

  -- Seed WATER readings — rate snapshot = bedspace (billed) rate
  insert into meter_readings(cutoff_id, room_id, utility, previous_reading, current_reading, rate)
  select v_cutoff_id, r.id, 'WATER',
         coalesce(lr.current_reading, 0),
         coalesce(lr.current_reading, 0),   -- current starts = previous until edited
         p_water_bedspace_rate
  from rooms r
  left join v_latest_reading lr on lr.room_id = r.id and lr.utility = 'WATER'
  on conflict (cutoff_id, room_id, utility) do nothing;

  -- Seed ELECTRIC readings — rate snapshot = bedspace (billed) rate
  insert into meter_readings(cutoff_id, room_id, utility, previous_reading, current_reading, rate)
  select v_cutoff_id, r.id, 'ELECTRIC',
         coalesce(lr.current_reading, 0),
         coalesce(lr.current_reading, 0),
         p_electric_bedspace_rate
  from rooms r
  left join v_latest_reading lr on lr.room_id = r.id and lr.utility = 'ELECTRIC'
  on conflict (cutoff_id, room_id, utility) do nothing;

  return v_cutoff_id;
end;
$$ language plpgsql;

-- ── Seed the first (May 2026) cutoff with the current rates ───────────────────
-- Water: May 1 → Jun 1.  Electric: May 10 → Jun 10.  Rates editable anytime.
-- Provider (Maynilad/MERALCO) rates left 0 to fill in; bedspace = billed rate.
insert into cutoffs(name, water_start, water_end, electric_start, electric_end,
                    water_maynilad_rate, water_bedspace_rate,
                    electric_meralco_rate, electric_bedspace_rate, is_active)
values ('May 2026', '2026-05-01','2026-06-01', '2026-05-10','2026-06-10',
        0, 140.62, 0, 14.47, true)
on conflict (name) do nothing;
