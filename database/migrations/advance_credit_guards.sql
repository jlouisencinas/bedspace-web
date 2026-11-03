-- Advance-credit guards (G1, G2, G3). Idempotent, hand-applied (do NOT run all of init.sql).
-- Mirrored in database/init.sql right after idx_advance_credits_tenant. Requirements §5 "Advance already credited".
--
-- The guards only reject NEW inserts/updates; existing rows are untouched. Open Cutoff's recordAdvanceCredits runs
-- inside G1, so deploy the frontend filters (HELD receipts only, skip tenants with a FINAL bill) together with it.
--
-- ===== AUDIT: read-only, run these FIRST. 1, 2 and 4 must return 0 rows before the guards are applied. =====
-- 1) over-credited receipts (stored allocations above the receipt amount)
--    select d.id, d.tenant_id, d.amount, sum((x->>'amount')::numeric) used
--      from tenant_deposits d, advance_credits c, jsonb_array_elements(coalesce(c.allocations,'[]'::jsonb)) x
--     where (x->>'deposit_id')::int = d.id group by d.id having sum((x->>'amount')::numeric) > d.amount;
-- 2) credit rows whose allocations do not add up to the amount
--    select c.id, c.tenant_id, c.amount from advance_credits c
--     where c.amount <> (select coalesce(sum((x->>'amount')::numeric),0) from jsonb_array_elements(coalesce(c.allocations,'[]'::jsonb)) x);
-- 3) orphans: a credit stored for the same cutoff as (or after) the tenant's own final bill. Informational: the app
--    ignores these (rule R1: a credit counts only if its cutoff window ends on or before the move-out date) and G2
--    does the same, so they do not block anything; list them so staff know which final bills replaced a statement.
--    select c.id, c.tenant_id, cc.name credit_cutoff, fc.name final_cutoff from advance_credits c
--      join final_bills fb on fb.tenant_id = c.tenant_id and fb.status = 'FINAL'
--      join cutoffs cc on cc.id = c.cutoff_id join cutoffs fc on fc.id = fb.cutoff_id where cc.water_start >= fc.water_start;
-- 4) allocations pointing at non-ADVANCE or missing receipts
--    select c.id, x->>'deposit_id' from advance_credits c, jsonb_array_elements(coalesce(c.allocations,'[]'::jsonb)) x
--      left join tenant_deposits d on d.id = (x->>'deposit_id')::int where d.id is null or d.kind <> 'ADVANCE';

-- G1: a credit row can never over-credit a receipt or be recorded after a final bill.
create or replace function public.advance_credits_guard() returns trigger
language plpgsql security definer set search_path = public as $$
declare a jsonb; v_id int; v_amt numeric; v_sum numeric := 0; v_rec numeric; v_used numeric; v_seen int[] := '{}';
begin
  if new.amount > 0 and (new.allocations is null or jsonb_typeof(new.allocations) <> 'array' or jsonb_array_length(new.allocations) = 0) then
    raise exception 'advance_credits: a credit of % needs its receipt allocations.', new.amount;
  end if;
  if exists (select 1 from public.final_bills where tenant_id = new.tenant_id and status = 'FINAL') then
    raise exception 'advance_credits: tenant % already has a final bill; the advance can no longer be credited on a statement.', new.tenant_id;
  end if;
  for a in select * from jsonb_array_elements(coalesce(new.allocations, '[]'::jsonb)) loop
    v_id := (a->>'deposit_id')::int; v_amt := (a->>'amount')::numeric;
    if v_id = any(v_seen) then raise exception 'advance_credits: receipt % appears twice.', v_id; end if;
    v_seen := v_seen || v_id;
    if v_amt is null or v_amt <= 0 then raise exception 'advance_credits: allocation for receipt % must be above 0.', v_id; end if;
    select amount into v_rec from public.tenant_deposits where id = v_id and kind = 'ADVANCE' for update;
    if not found then raise exception 'advance_credits: receipt % is not an ADVANCE receipt.', v_id; end if;
    if exists (select 1 from public.final_bills fb, jsonb_array_elements(fb.lines) l
               where fb.status = 'FINAL' and l->>'kind' in ('credit','forfeit') and (l->'deposit_ids') @> to_jsonb(v_id)) then
      raise exception 'advance_credits: receipt % was already settled on a final bill.', v_id;
    end if;
    select coalesce(sum((x->>'amount')::numeric), 0) into v_used
      from public.advance_credits c, jsonb_array_elements(coalesce(c.allocations, '[]'::jsonb)) x
     where (x->>'deposit_id')::int = v_id;
    if v_used + v_amt > v_rec then
      raise exception 'advance_credits: receipt % is P%, P% already credited, P% more would exceed it.', v_id, v_rec, v_used, v_amt;
    end if;
    v_sum := v_sum + v_amt;
  end loop;
  if v_sum <> new.amount then raise exception 'advance_credits: allocations total P% but the credit is P%.', v_sum, new.amount; end if;
  return new;
end $$;
drop trigger if exists trg_advance_credits_guard on public.advance_credits;
create trigger trg_advance_credits_guard before insert on public.advance_credits
  for each row execute function public.advance_credits_guard();

-- G2: a FINAL bill can never credit or forfeit more advance (or deposit) than the receipts hold.
-- An advance credit stored for a cutoff whose window ends AFTER the bill's move-out date is an orphan (the final bill
-- replaces that statement) and is not counted as used, mirroring the app rule R1.
create or replace function public.final_bills_advance_guard() returns trigger
language plpgsql security definer set search_path = public as $$
declare l jsonb; ids int[]; seen int[] := '{}'; v_src text; v_pool numeric; v_free numeric; v_claim numeric;
begin
  if new.status is distinct from 'FINAL' then return new; end if;
  for l in select * from jsonb_array_elements(new.lines) loop
    continue when l->>'kind' not in ('credit','forfeit')
               or l->'deposit_ids' is null or jsonb_array_length(l->'deposit_ids') = 0;
    v_src := l->>'source';
    select array_agg(x::int) into ids from jsonb_array_elements_text(l->'deposit_ids') x;
    if ids && seen then raise exception 'final bill: a receipt is referenced by two lines.'; end if;
    seen := seen || ids;
    perform 1 from public.tenant_deposits where id = any(ids) for update;
    if (select count(*) from public.tenant_deposits d
         where d.id = any(ids) and d.tenant_id = new.tenant_id and d.kind = v_src and d.status = 'HELD') <> cardinality(ids) then
      raise exception 'final bill: line % references receipts that are not this tenant HELD % receipts.', l->>'label', v_src;
    end if;
    select coalesce(sum(amount), 0) into v_pool from public.tenant_deposits where id = any(ids);
    if l->>'kind' = 'forfeit' then
      v_claim := coalesce((l->>'original')::numeric, 0);
      if v_claim > v_pool then raise exception 'final bill: % forfeits P% but the receipts hold P%.', l->>'label', v_claim, v_pool; end if;
    else
      v_claim := -(l->>'amount')::numeric;
      if v_claim < 0 then raise exception 'final bill: credit line % has a positive amount.', l->>'label'; end if;
      v_free := v_pool;
      if v_src = 'ADVANCE' then
        select coalesce(sum(greatest(d.amount - coalesce((
                 select sum((x->>'amount')::numeric)
                   from public.advance_credits c
                   join public.cutoffs cc on cc.id = c.cutoff_id,
                        jsonb_array_elements(coalesce(c.allocations, '[]'::jsonb)) x
                  where (x->>'deposit_id')::int = d.id
                    and not (cc.water_end is not null and cc.water_end > new.move_out_date)), 0), 0)), 0)
          into v_free from public.tenant_deposits d where d.id = any(ids);
      end if;
      if v_claim > v_free then
        raise exception 'final bill: % credits P% but only P% of those receipts is left (the rest was credited on an earlier bill).', l->>'label', v_claim, v_free;
      end if;
    end if;
  end loop;
  return new;
end $$;
drop trigger if exists trg_final_bills_advance_guard on public.final_bills;
create trigger trg_final_bills_advance_guard before insert on public.final_bills
  for each row execute function public.final_bills_advance_guard();

-- G3: an ADVANCE receipt cannot be edited below what a statement already credited from it.
create or replace function public.td_guard_credited_advance() returns trigger
language plpgsql security definer set search_path = public as $$
declare v_used numeric;
begin
  if old.kind <> 'ADVANCE' then return new; end if;
  select coalesce(sum((x->>'amount')::numeric), 0) into v_used
    from public.advance_credits c, jsonb_array_elements(coalesce(c.allocations, '[]'::jsonb)) x
   where (x->>'deposit_id')::int = old.id;
  if v_used > 0 and ((new.amount is distinct from old.amount and new.amount < v_used) or new.kind <> old.kind or new.tenant_id <> old.tenant_id) then
    raise exception 'This advance receipt was already credited P% on an earlier statement: its amount cannot go below that, and its type/tenant cannot change.', v_used;
  end if;
  return new;
end $$;
drop trigger if exists trg_td_guard_credited_advance on public.tenant_deposits;
create trigger trg_td_guard_credited_advance before update on public.tenant_deposits
  for each row execute function public.td_guard_credited_advance();
