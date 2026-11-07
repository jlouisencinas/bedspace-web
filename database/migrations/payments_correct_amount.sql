-- Correct the amount of a recorded Collections payment line (requirements section 12 "Correct a payment amount").
-- Idempotent, additive (one function, no table/column/trigger change), hand-applied (do NOT run all of init.sql).
-- Mirrored in database/init.sql (function 14). Apply BEFORE the frontend that calls correct_payment_amount().
--
-- payments keeps NO UPDATE/DELETE policy and trg_payments_refs_only_update still refuses any amount change (section 14).
-- A correction is a void + re-record in ONE transaction: a compensating negative row for the original
-- (voids_payment_id = original, pay_type 'VOID') plus a new positive row with the corrected amount (same tenant,
-- category, cutoff, payment_date, pay_type, S.I#/T.R#), plus an activity_log row. A correction to 0 voids the whole line:
-- only the negative void row is written, no replacement. Nothing is updated or deleted, so every SUM(amount) consumer nets
-- to the corrected amount. The unique index idx_payments_voids_unique makes a second
-- correction/undo of the same row fail (23505).

-- §0 inspect (read-only)
-- select count(*) from public.payments;
-- select proname from pg_proc where proname = 'correct_payment_amount';

create or replace function public.correct_payment_amount(
  p_payment_id int, p_expected_amount numeric, p_new_amount numeric, p_reason text)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  p public.payments; v_reason text; v_void int; v_new int; v_name text; v_room text; v_bed text;
begin
  if coalesce(public.app_role(), '') not in ('admin', 'user') then
    raise exception 'Only staff or an admin can correct a payment amount.'; end if;

  if p_new_amount is null or p_new_amount < 0 then
    raise exception 'The corrected amount cannot be empty or negative (0 voids the whole payment line).'; end if;
  if round(p_new_amount, 2) <> p_new_amount then
    raise exception 'The corrected amount can have at most 2 decimals (it is never rounded).'; end if;
  if p_new_amount > 99999999.99 then
    raise exception 'The corrected amount is too large.'; end if;
  v_reason := btrim(coalesce(p_reason, ''));
  if v_reason = '' then raise exception 'Enter the reason for the correction.'; end if;
  if char_length(v_reason) > 200 then raise exception 'The reason is too long (max 200 characters).'; end if;

  select * into p from public.payments where id = p_payment_id for update;
  if not found then raise exception 'Payment % not found.', p_payment_id; end if;
  if p.voids_payment_id is not null then
    raise exception 'Payment % is an undo (void) row; its amount cannot be corrected.', p.id; end if;
  if exists (select 1 from public.payments v where v.voids_payment_id = p.id) then
    raise exception 'Payment % was already undone or corrected. Reload the page and try again.', p.id; end if;
  if coalesce(p.amount, 0) <= 0 then
    raise exception 'Payment % has no positive amount; it cannot be corrected.', p.id; end if;
  if p.category is null or p.category not in ('RENT_WATER', 'ELECTRICITY') then
    raise exception 'Payment % is not a Rent + Water or Electricity payment; it cannot be corrected here.', p.id; end if;
  if p_expected_amount is null or p.amount <> p_expected_amount then
    raise exception 'Payment % was changed by someone else. Reload the page and try again.', p.id; end if;

  if p_new_amount = p.amount then
    return jsonb_build_object('changed', false, 'payment_id', p.id); end if;

  insert into public.payments (tenant_id, payment_date, amount, category, cutoff_id, pay_type, notes, voids_payment_id)
  values (p.tenant_id, current_date, -p.amount, p.category, p.cutoff_id, 'VOID',
          case when p_new_amount = 0 then format('Amount corrected to 0: payment #%s voided', p.id)
               else format('Amount corrected: undo of payment #%s', p.id) end, p.id)
  returning id into v_void;

  if p_new_amount > 0 then
    insert into public.payments (tenant_id, payment_date, amount, category, cutoff_id, pay_type, si_no, tr_no, notes)
    values (p.tenant_id, p.payment_date, p_new_amount, p.category, p.cutoff_id, p.pay_type, p.si_no, p.tr_no,
            coalesce(nullif(btrim(p.notes), '') || ' · ', '') || format('Corrects payment #%s (was ₱%s)', p.id, to_char(p.amount, 'FM999,999,999,990.00')))
    returning id into v_new;
  end if;

  select t.name, r.room_no, bd.bed_letter into v_name, v_room, v_bed
    from public.tenants t left join public.beds bd on bd.id = t.bed_id left join public.rooms r on r.id = bd.room_id
   where t.id = p.tenant_id;
  insert into public.activity_log (activity_type, actor_id, tenant_id, tenant_name, room_no, bed_letter, amount_paid, entity_type, entity_id, notes, metadata)
  values ('Payment Amount Corrected', auth.uid(), p.tenant_id, v_name, v_room, v_bed, p_new_amount - p.amount, 'PAYMENT', coalesce(v_new, p.id),
    format('Payment #%s: ₱%s -> ₱%s%s · %s', p.id,
           to_char(p.amount, 'FM999,999,999,990.00'), to_char(p_new_amount, 'FM999,999,999,990.00'),
           case when p_new_amount = 0 then ' (line voided)' else '' end, v_reason),
    jsonb_build_object('old_payment_id', p.id, 'new_payment_id', v_new, 'void_payment_id', v_void,
                       'voided', p_new_amount = 0, 'category', p.category, 'cutoff_id', p.cutoff_id,
                       'old', p.amount, 'new', p_new_amount, 'delta', p_new_amount - p.amount, 'reason', v_reason));

  return jsonb_build_object('changed', true, 'voided', p_new_amount = 0, 'old_payment_id', p.id, 'new_payment_id', v_new, 'void_payment_id', v_void);
end $$;
revoke execute on function public.correct_payment_amount(int, numeric, numeric, text) from public, anon;
grant execute on function public.correct_payment_amount(int, numeric, numeric, text) to authenticated;
