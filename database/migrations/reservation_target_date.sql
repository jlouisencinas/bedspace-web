-- reservation_target_date.sql
-- Task 20261105-reservation-target-date-move-in (branch feat/reservation-target-date-move-in)
--
-- Adds the target move-in date of a Bed Map reservation (beds.reserved_move_in_date).
-- Additive and backward compatible: apply BEFORE the PR is merged. The deployed frontend reserves without a date
-- (column is nullable here); the "date required" rule is reservation_target_date_enforce.sql, applied AFTER deploy.
-- No data rewrite, no backup needed. Idempotent.
--
-- §0 audit (read-only, run first)
--   select column_name from information_schema.columns where table_schema = 'public' and table_name = 'beds' order by ordinal_position;
--   select tgname from pg_trigger where tgrelid = 'public.beds'::regclass and not tgisinternal order by tgname;
--   select status, count(*) from public.beds group by status order by status;

alter table public.beds add column if not exists reserved_move_in_date date;
comment on column public.beds.reserved_move_in_date is
  'Target move-in date of the current reservation. Only set while status = RESERVED; cleared by trigger otherwise.';

-- staff may change status, reserved_name and the target date (rate etc. stay admin-only)
create or replace function public.guard_beds_protected_fields()
returns trigger language plpgsql as $$
declare v_role text;
begin
  select role into v_role from public.profiles where id = auth.uid();
  if v_role = 'admin' then return new; end if;
  if (to_jsonb(new) - 'status' - 'reserved_name' - 'reserved_move_in_date')
     is distinct from (to_jsonb(old) - 'status' - 'reserved_name' - 'reserved_move_in_date') then
    raise exception 'Only admin can change bed rate or other protected fields directly. Submit via the approval workflow.';
  end if;
  if new.status = 'REMOVED' or old.status = 'REMOVED' then
    raise exception 'Bed removal/restoration requires admin approval.';
  end if;
  return new;
end $$;

-- the date only lives while the bed is RESERVED (covers Bed Map, addTenant, transfer, retire_room, reconfigure_room)
create or replace function public.beds_reservation_date() returns trigger
language plpgsql as $$
begin
  if new.status is distinct from 'RESERVED' then
    new.reserved_move_in_date := null;
  end if;
  return new;
end $$;
drop trigger if exists trg_beds_reservation_date on public.beds;
create trigger trg_beds_reservation_date before insert or update on public.beds
  for each row execute function public.beds_reservation_date();
