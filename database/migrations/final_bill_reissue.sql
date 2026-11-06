-- Void & re-issue of a final bill (admin), in one transaction. Additive and idempotent; hand-applied (do NOT run all of init.sql).
-- Mirrored in database/init.sql (next to final_bills and correct_receipt_ref). Requirements section 5 "Void & re-issue".
-- Apply BEFORE deploying the frontend that uses it; the deployed frontend does not read the new columns and keeps working.
--
-- New columns: final_bills.voided_by (who voided it), replaces_bill_id / replaced_by_bill_id (the link between the old and the new bill).
-- reissue_final_bill(p_old_id, p_reason, p_bill): admin only. Locks the old bill; refuses unless it is FINAL, its refund is not PAID, the
-- tenant is inactive, the bill is not part of a several-beds group, the new bill has the same tenant and move-out date and its totals are the exact cent sums of its lines. Then: old
-- bill -> VOID (reason, voided_at, voided_by), the receipts it settled -> HELD, the new FINAL bill inserted (trigger G2 checks its credits
-- against those HELD receipts), both bills linked, the receipts the new bill credits/forfeits settled (same settled_note text as the
-- app's settleNote()), two activity rows. Any error rolls back everything. No RLS change: the columns fall under the final_bills policies.
--
-- §0 audit (read-only): the bill to re-issue and the receipts it settled.
--   select id, tenant_id, status, refund_status, net_amount, covered_cutoffs from public.final_bills where id = <bill id>;
--   select id, kind, amount, status, settled_note from public.tenant_deposits where settled_note like 'Final bill #<bill id>:%';

alter table public.final_bills add column if not exists voided_by uuid;
alter table public.final_bills add column if not exists replaces_bill_id int references public.final_bills(id);
alter table public.final_bills add column if not exists replaced_by_bill_id int references public.final_bills(id);
create unique index if not exists uq_final_bills_replaces on public.final_bills(replaces_bill_id) where replaces_bill_id is not null;

create or replace function public.reissue_final_bill(p_old_id int, p_reason text, p_bill jsonb)
returns int
language plpgsql security definer set search_path = public as $$
declare
  o public.final_bills; t public.tenants;
  v_reason text := btrim(coalesce(p_reason, ''));
  v_lines jsonb; v_covered jsonb; v_details jsonb; l jsonb;
  v_amt numeric; v_c bigint; v_charges bigint := 0; v_credits bigint := 0; v_net bigint := 0;
  v_waived boolean; v_new int; v_ids int[]; v_status text; v_note text; v_n int; v_bal numeric;
  v_room text; v_bed text;
begin
  if coalesce(public.app_role(), '') <> 'admin' then raise exception 'Only an admin can re-issue a final bill.'; end if;
  if v_reason = '' then raise exception 'A reason is required to re-issue a final bill.'; end if;
  if p_bill is null or jsonb_typeof(p_bill) <> 'object' then raise exception 'The new bill is missing.'; end if;

  select * into o from public.final_bills where id = p_old_id for update;
  if not found then raise exception 'Final bill #% not found.', p_old_id; end if;
  if o.status <> 'FINAL' then raise exception 'Final bill #% is %: only a FINAL bill can be re-issued.', o.id, o.status; end if;
  if o.refund_status = 'PAID' then raise exception 'The refund of final bill #% is already paid: it cannot be re-issued.', o.id; end if;
  if jsonb_typeof(o.details->'stay'->'group'->'tenant_ids') = 'array' and jsonb_array_length(o.details->'stay'->'group'->'tenant_ids') > 1 then
    raise exception 'Final bill #% is part of a bill for several beds: re-issue is per bed and not supported yet.', o.id; end if;
  select * into t from public.tenants where id = o.tenant_id for update;
  if not found then raise exception 'The tenant of final bill #% was not found.', o.id; end if;
  if t.is_active then raise exception 'The tenant of final bill #% is active: only a moved-out tenant''s bill can be re-issued.', o.id; end if;
  if (p_bill->>'tenant_id') is null or (p_bill->>'tenant_id')::int <> o.tenant_id then
    raise exception 'The new bill is for another tenant than final bill #%.', o.id; end if;
  if (p_bill->>'move_out_date') is null or (p_bill->>'move_out_date')::date <> o.move_out_date then
    raise exception 'The new bill has another move-out date than final bill #% (%).', o.id, o.move_out_date; end if;

  v_lines := p_bill->'lines';
  if v_lines is null or jsonb_typeof(v_lines) <> 'array' or jsonb_array_length(v_lines) = 0 then
    raise exception 'The new bill has no lines.'; end if;
  v_covered := coalesce(nullif(p_bill->'covered_cutoffs', 'null'::jsonb), '[]'::jsonb);
  if jsonb_typeof(v_covered) <> 'array' then raise exception 'The covered periods of the new bill are invalid.'; end if;
  v_details := case when jsonb_typeof(p_bill->'details') = 'object' then p_bill->'details' else '{}'::jsonb end;
  v_waived := coalesce((p_bill->>'forfeit_waived')::boolean, false);
  if v_waived and btrim(coalesce(p_bill->>'waived_reason', '')) = '' then
    raise exception 'A reason is required to waive the forfeiture.'; end if;

  -- Totals are the exact cent sums of the lines (finalBill.computeTotals): credit + payment -> credits, forfeit -> neither, the rest -> charges.
  for l in select * from jsonb_array_elements(v_lines) loop
    if jsonb_typeof(l) <> 'object' or btrim(coalesce(l->>'label', '')) = '' then raise exception 'Every line of the new bill needs a label.'; end if;
    if jsonb_typeof(l->'amount') is distinct from 'number' then raise exception 'Line "%" has no valid amount.', l->>'label'; end if;
    v_amt := (l->>'amount')::numeric;
    if v_amt * 100 <> trunc(v_amt * 100) then raise exception 'Line "%" (%) is not a whole number of centavos.', l->>'label', v_amt; end if;
    v_c := (v_amt * 100)::bigint;
    v_net := v_net + v_c;
    if l->>'kind' in ('credit', 'payment') then v_credits := v_credits - v_c;
    elsif (l->>'kind') is distinct from 'forfeit' then v_charges := v_charges + v_c; end if;
  end loop;
  if jsonb_typeof(p_bill->'total_charges') is distinct from 'number' or jsonb_typeof(p_bill->'total_credits') is distinct from 'number'
     or jsonb_typeof(p_bill->'net_amount') is distinct from 'number'
     or (p_bill->>'total_charges')::numeric * 100 <> v_charges or (p_bill->>'total_credits')::numeric * 100 <> v_credits
     or (p_bill->>'net_amount')::numeric * 100 <> v_net then
    raise exception 'The totals of the new bill do not match its lines (charges %, credits %, net %).', v_charges / 100.0, v_credits / 100.0, v_net / 100.0;
  end if;

  -- 1. Void the old bill and put back the receipts it settled.
  update public.final_bills
     set status = 'VOID', void_reason = 'Re-issued: ' || v_reason, voided_at = now(), voided_by = auth.uid()
   where id = o.id;
  update public.tenant_deposits
     set status = 'HELD', settled_note = format('Final bill #%s voided (re-issued): %s', o.id, v_reason)
   where tenant_id = o.tenant_id and status in ('APPLIED', 'FORFEITED') and settled_note like format('Final bill #%s:%%', o.id);

  -- 2. The new bill (trigger G2 checks its credit / forfeit lines against the HELD receipts).
  insert into public.final_bills (
    tenant_id, cutoff_id, covered_cutoffs, status, move_out_date, early_termination, forfeit_waived, waived_reason,
    lines, details, total_charges, total_credits, net_amount, refund_status, prepared_by, created_by, replaces_bill_id)
  values (
    o.tenant_id, nullif(p_bill->>'cutoff_id', '')::int, v_covered, 'FINAL', o.move_out_date,
    coalesce((p_bill->>'early_termination')::boolean, false), v_waived,
    case when v_waived then btrim(p_bill->>'waived_reason') end,
    v_lines,
    v_details || jsonb_build_object('reissue', coalesce(nullif(v_details->'reissue', 'null'::jsonb), '{}'::jsonb)
      || jsonb_build_object('of', o.id, 'reason', v_reason, 'at', now(), 'by', auth.uid())),
    round(v_charges / 100.0, 2), round(v_credits / 100.0, 2), round(v_net / 100.0, 2),
    case when v_net < 0 then 'PENDING' else 'NONE' end,
    nullif(btrim(coalesce(p_bill->>'prepared_by', '')), ''), auth.uid(), o.id)
  returning id into v_new;
  update public.final_bills set replaced_by_bill_id = v_new where id = o.id;

  -- 3. Settle the receipts the new bill credits / forfeits (text as supabase.js settleNote()).
  for l in select * from jsonb_array_elements(v_lines) loop
    continue when coalesce(l->>'kind', '') not in ('credit', 'forfeit') or jsonb_typeof(l->'deposit_ids') is distinct from 'array'
               or jsonb_array_length(l->'deposit_ids') = 0;
    select array_agg(x::int) into v_ids from jsonb_array_elements_text(l->'deposit_ids') x;
    v_status := case when l->>'kind' = 'forfeit' then 'FORFEITED' else 'APPLIED' end;
    if l->>'kind' = 'forfeit' then
      v_note := format('Final bill #%s: forfeited (early termination)', v_new);
    elsif l->>'source' = 'ADVANCE' and nullif(l->>'prior_cutoff', '') is not null then
      v_bal := -(l->>'amount')::numeric;
      v_note := format('Final bill #%s: credited on the bill of cutoff %s', v_new, l->>'prior_cutoff')
        || case when v_bal > 0 then '; balance ₱' || to_char(v_bal, 'FM999,999,999,990.00') || ' applied on final bill' else '' end;
    else
      v_note := format('Final bill #%s: applied on final bill', v_new);
    end if;
    update public.tenant_deposits set status = v_status, settled_note = v_note
     where id = any(v_ids) and tenant_id = o.tenant_id and status = 'HELD';
    get diagnostics v_n = row_count;
    if v_n <> cardinality(v_ids) then
      raise exception 'Only % of % receipts of "%" could be set to % (the others are not this tenant''s HELD receipts). Nothing was changed.',
        v_n, cardinality(v_ids), l->>'label', v_status;
    end if;
  end loop;

  -- 4. Activity log.
  select r.room_no, bd.bed_letter into v_room, v_bed
    from public.beds bd left join public.rooms r on r.id = bd.room_id where bd.id = t.bed_id;
  insert into public.activity_log (activity_type, actor_id, tenant_id, tenant_name, room_no, bed_letter, entity_type, entity_id, notes, metadata)
  values
    ('Final Bill Voided', auth.uid(), t.id, t.name, v_room, v_bed, 'TENANT', t.id,
     format('Final bill #%s voided, replaced by #%s. Reason: %s', o.id, v_new, v_reason),
     jsonb_build_object('final_bill_id', o.id, 'replaced_by_bill_id', v_new, 'net_amount', o.net_amount, 'reason', v_reason)),
    ('Final Bill Reissued', auth.uid(), t.id, t.name, v_room, v_bed, 'TENANT', t.id,
     format('Final bill #%s re-issued as #%s: %s (was %s). Reason: %s', o.id, v_new,
            case when v_net < 0 then 'refund due ₱' || to_char(-v_net / 100.0, 'FM999,999,999,990.00') else 'amount due ₱' || to_char(v_net / 100.0, 'FM999,999,999,990.00') end,
            case when o.net_amount < 0 then 'refund ₱' || to_char(-o.net_amount, 'FM999,999,999,990.00') else 'due ₱' || to_char(o.net_amount, 'FM999,999,999,990.00') end,
            v_reason),
     jsonb_build_object('old_id', o.id, 'new_id', v_new, 'old_net', o.net_amount, 'new_net', round(v_net / 100.0, 2), 'reason', v_reason));

  return v_new;
end $$;
revoke all on function public.reissue_final_bill(int, text, jsonb) from public, anon;
grant execute on function public.reissue_final_bill(int, text, jsonb) to authenticated;
