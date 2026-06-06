-- ============================================================
-- Utilities rate model v2 — two rates per utility:
--   Water:    Maynilad rate (provider) + Bedspace rate (billed to tenant)
--   Electric: MERALCO rate (provider)  + Bedspace rate (billed to tenant)
--
-- The BEDSPACE rate is what computes each tenant's amount.
-- The provider rate is tracked for cost reference.
--
-- Run this in Supabase SQL Editor (safe to re-run).
-- ============================================================

-- 1. Add the new rate columns
alter table cutoffs
  add column if not exists water_maynilad_rate    numeric(12,6) not null default 0,
  add column if not exists water_bedspace_rate    numeric(12,6) not null default 0,
  add column if not exists electric_meralco_rate  numeric(12,6) not null default 0,
  add column if not exists electric_bedspace_rate numeric(12,6) not null default 0;

-- 2. Migrate old values → the old single rate becomes the bedspace (billed) rate
do $$
begin
  if exists (select 1 from information_schema.columns
             where table_name='cutoffs' and column_name='water_rate') then
    update cutoffs
      set water_bedspace_rate    = case when water_bedspace_rate    = 0 then coalesce(water_rate, 0)    else water_bedspace_rate    end,
          electric_bedspace_rate = case when electric_bedspace_rate = 0 then coalesce(electric_rate, 0) else electric_bedspace_rate end;
  end if;
end $$;

-- 3. Replace open_cutoff() with the 4-rate signature
drop function if exists open_cutoff(text, date, date, date, date, numeric, numeric, numeric);

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

  update cutoffs set is_active = false where id <> v_cutoff_id;

  -- WATER readings — rate snapshot = bedspace (billed) rate
  insert into meter_readings(cutoff_id, room_id, utility, previous_reading, current_reading, rate)
  select v_cutoff_id, r.id, 'WATER',
         coalesce(lr.current_reading, 0), coalesce(lr.current_reading, 0),
         p_water_bedspace_rate
  from rooms r
  left join v_latest_reading lr on lr.room_id = r.id and lr.utility = 'WATER'
  on conflict (cutoff_id, room_id, utility) do nothing;

  -- ELECTRIC readings — rate snapshot = bedspace (billed) rate
  insert into meter_readings(cutoff_id, room_id, utility, previous_reading, current_reading, rate)
  select v_cutoff_id, r.id, 'ELECTRIC',
         coalesce(lr.current_reading, 0), coalesce(lr.current_reading, 0),
         p_electric_bedspace_rate
  from rooms r
  left join v_latest_reading lr on lr.room_id = r.id and lr.utility = 'ELECTRIC'
  on conflict (cutoff_id, room_id, utility) do nothing;

  return v_cutoff_id;
end;
$$ language plpgsql;

-- 4. (Optional) drop the old columns once you've confirmed the migration
-- alter table cutoffs
--   drop column if exists water_rate,
--   drop column if exists water_rate_studio,
--   drop column if exists electric_rate;
