-- Final bill catch-up: every cutoff a final bill covers, plus the move-in reading column. Idempotent, additive, hand-applied
-- (do NOT run all of init.sql). Mirrored in database/init.sql. Requirements section 5 "Final bill: catch-up, one-month stays".
--
-- Deploy order: run this BEFORE deploying the frontend. fetchTenants falls back to cutoff_id when covered_cutoffs is missing,
-- but saveFinalBill writes covered_cutoffs and will fail until the column exists.
--
-- ===== AUDIT: read-only, run these FIRST (nothing here is changed by the migration) =====
-- 1) active tenants whose planned stay is exactly one month. They stop appearing on regular statements and are billed on
--    the final bill only (rent = one flat monthly rate).
--    select id, name, move_in_date, move_out_date from tenants
--     where is_active and move_out_date = (move_in_date + interval '1 month')::date;
-- 2) interim readings dated on the first day of a window (billing.js now counts them as a segment boundary instead of
--    ignoring them)
--    select i.id, i.room_id, i.utility, i.reading_date, c.name from interim_readings i join cutoffs c on c.id = i.cutoff_id
--     where (i.utility = 'WATER' and i.reading_date = c.water_start) or (i.utility = 'ELECTRIC' and i.reading_date = c.electric_start);

-- Every cutoff the bill covers (ids). A covered cutoff makes the leaver a non-billed participant of that cutoff's utility
-- split, exactly like the bill's own cutoff_id always did. Old bills keep '[]' and behave as before.
alter table public.final_bills add column if not exists covered_cutoffs jsonb not null default '[]'::jsonb;

do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'final_bills_covered_cutoffs_array') then
    alter table public.final_bills add constraint final_bills_covered_cutoffs_array check (jsonb_typeof(covered_cutoffs) = 'array');
  end if;
end $$;

-- Move-in meter reading (start of a stay-anchored utility split). Already present on the live database; nothing writes it yet.
alter table public.interim_readings add column if not exists moving_in_tenant_id int references public.tenants(id);

create index if not exists idx_interim_room_util_date on public.interim_readings(room_id, utility, reading_date);
create index if not exists idx_interim_moving_in on public.interim_readings(moving_in_tenant_id) where moving_in_tenant_id is not null;
