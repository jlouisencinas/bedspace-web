-- reservation_target_date_enforce.sql
-- Task 20261105-reservation-target-date-move-in (branch feat/reservation-target-date-move-in)
--
-- Makes the reservation target move-in date required. NOT backward compatible with the old frontend (it reserves
-- without a date): apply only AFTER the new frontend is live on Vercel, and after reservation_target_date.sql.
-- Entering RESERVED without a date, or clearing the date of a RESERVED bed, fails. Legacy RESERVED beds with a null
-- date stay updatable (moved in, removed, given a date). INSERT is not enforced (init.sql seed inserts RESERVED rows).
-- No data rewrite, no backup needed. Idempotent.
--
-- §0 audit (read-only, run first): the column and trigger from reservation_target_date.sql must exist.
--   select column_name from information_schema.columns where table_schema = 'public' and table_name = 'beds' and column_name = 'reserved_move_in_date';
--   select tgname from pg_trigger where tgrelid = 'public.beds'::regclass and tgname = 'trg_beds_reservation_date';
--   select count(*) filter (where reserved_move_in_date is null) as reserved_without_date, count(*) as reserved
--     from public.beds where status = 'RESERVED';

create or replace function public.beds_reservation_date() returns trigger
language plpgsql as $$
begin
  if new.status is distinct from 'RESERVED' then
    new.reserved_move_in_date := null;
    return new;
  end if;
  if tg_op = 'UPDATE' and new.reserved_move_in_date is null
     and (old.status is distinct from 'RESERVED' or old.reserved_move_in_date is not null) then
    raise exception 'A reservation needs a target move-in date.';
  end if;
  return new;
end $$;
