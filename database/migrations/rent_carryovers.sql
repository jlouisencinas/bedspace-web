-- Advance window: rent of a second-to-last statement carried to the final bill (docs/requirements.md §5 "Advance window").
-- Additive and idempotent, hand-applied (do NOT run all of init.sql). Mirrored in database/init.sql after the advance_credits
-- guards (table + trigger) and in the RLS section (policies).
-- Apply BEFORE the frontend that reads it is deployed, and before anyone opens the next cutoff with that frontend.
-- The frontend tolerates the table being missing (reads as no rows), but Open Cutoff then refuses to open when a leaver
-- needs a row, so the migration must be in place before the Nov 2026 cutoff is opened.
--
-- One row per (tenant, cutoff), written by Open Cutoff (recordAdvanceCredits -> saveRentCarryovers) for the cutoff being
-- closed. The 1-month advance of a non-month-end leaver covers the month ending on the move-out date: window_start =
-- addMonths(move_out_date, -1) + 1 day. The statement bills month_rent - carry_amount (days before window_start); the
-- final bill bills carry_amount (window_start .. cutoff end) + month_rent - carry_amount (the rest of the advance month)
-- and credits the whole advance. Rows are immutable (no UPDATE / DELETE policy).
--
-- ===== AUDIT: read-only, run FIRST (nothing to back up: new table, no existing row changes) =====
-- select to_regclass('public.rent_carryovers');                 -- expect null before the first apply
-- select id, name, is_active, water_start, water_end from cutoffs order by water_start desc limit 3;

create table if not exists public.rent_carryovers (
  id            serial primary key,
  tenant_id     int not null references public.tenants(id),
  cutoff_id     int not null references public.cutoffs(id),
  move_out_date date not null,
  window_start  date not null,
  cutoff_days   int  not null check (cutoff_days > 0),
  carry_days    int  not null check (carry_days > 0),
  month_rent    numeric(10,2) not null check (month_rent > 0),
  carry_amount  numeric(10,2) not null check (carry_amount > 0 and carry_amount < month_rent),
  created_at    timestamptz default now(),
  unique (tenant_id, cutoff_id),
  check (carry_days < cutoff_days)
);
create index if not exists idx_rent_carryovers_tenant on public.rent_carryovers(tenant_id);

-- No window once the tenant has a FINAL bill (like G1), and the row must match its cutoff's rent/water window.
create or replace function public.rent_carryovers_guard() returns trigger
language plpgsql security definer set search_path = public as $$
declare v_start date; v_end date;
begin
  if exists (select 1 from public.final_bills where tenant_id = new.tenant_id and status = 'FINAL') then
    raise exception 'rent_carryovers: tenant % already has a final bill.', new.tenant_id;
  end if;
  select water_start, water_end into v_start, v_end from public.cutoffs where id = new.cutoff_id;
  if v_start is null or v_end is null then
    raise exception 'rent_carryovers: cutoff % has no rent/water window.', new.cutoff_id;
  end if;
  if new.cutoff_days <> (v_end - v_start) or new.window_start + new.carry_days <> v_end or new.move_out_date < v_end then
    raise exception 'rent_carryovers: the window (% + % days, % days, out %) does not match cutoff % (% - %).',
      new.window_start, new.carry_days, new.cutoff_days, new.move_out_date, new.cutoff_id, v_start, v_end;
  end if;
  return new;
end $$;
drop trigger if exists trg_rent_carryovers_guard on public.rent_carryovers;
create trigger trg_rent_carryovers_guard before insert on public.rent_carryovers
  for each row execute function public.rent_carryovers_guard();

-- RLS: read admin + user (as advance_credits; viewer and guard excluded), insert admin only, no update / delete.
alter table public.rent_carryovers enable row level security;
drop policy if exists rent_carryovers_select on public.rent_carryovers;
create policy rent_carryovers_select on public.rent_carryovers
  for select to authenticated
  using (exists (select 1 from public.profiles where id = auth.uid() and role in ('admin','user')));
drop policy if exists rent_carryovers_insert on public.rent_carryovers;
create policy rent_carryovers_insert on public.rent_carryovers
  for insert to authenticated
  with check (exists (select 1 from public.profiles where id = auth.uid() and role = 'admin'));
-- No UPDATE / DELETE policies on purpose: a recorded window is immutable.
drop policy if exists rent_carryovers_update on public.rent_carryovers;
drop policy if exists rent_carryovers_delete on public.rent_carryovers;

-- ===== VERIFY (after apply) =====
-- select relrowsecurity from pg_class where oid = 'public.rent_carryovers'::regclass;          -- true
-- select policyname, cmd from pg_policies where tablename = 'rent_carryovers';                -- select + insert only
-- select tgname from pg_trigger where tgrelid = 'public.rent_carryovers'::regclass and not tgisinternal;
-- Per role, inside begin; ... rollback;: admin insert of a valid row passes, a row for a final-billed tenant or a
-- mismatched window is refused; user/viewer/guard insert refused; viewer/guard select returns 0 rows.
