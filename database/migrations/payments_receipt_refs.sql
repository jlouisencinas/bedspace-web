-- S.I# (service invoice) / T.R# (temporary receipt) numbers on Collections payments. Idempotent, additive, hand-applied
-- (do NOT run all of init.sql). Mirrored in database/init.sql. Requirements section 12 "S.I# / T.R# per payment".
-- Apply BEFORE the frontend that writes payments.si_no / tr_no (the batch insert sends both columns).
--
-- payments keeps NO UPDATE/DELETE policy for any role (section 14). The numbers are corrected only through the
-- SECURITY DEFINER RPC set_payment_receipt_refs(): staff (user) may fill an empty number, only an admin may change or
-- clear one. The BEFORE UPDATE trigger refuses any update that touches a column other than si_no / tr_no, so even the
-- definer path can never alter an amount, date, category, cutoff or void link.
-- The live columns payments.method / payments.reference_no (not in init.sql, unused by the app) are left alone.

-- §0 audit (expect 0 rows: the new columns do not exist yet, so nothing can violate the check)
-- select count(*) from public.payments;

alter table public.payments add column if not exists si_no text;
alter table public.payments add column if not exists tr_no text;
alter table public.payments drop constraint if exists payments_ref_format_check;
alter table public.payments add constraint payments_ref_format_check check (
  (si_no is null or (char_length(si_no) <= 30 and si_no ~ '[0-9]' and si_no !~ '[[:cntrl:]]' and position(chr(183) in si_no) = 0 and si_no = btrim(si_no)))
  and (tr_no is null or (char_length(tr_no) <= 30 and tr_no ~ '[0-9]' and tr_no !~ '[[:cntrl:]]' and position(chr(183) in tr_no) = 0 and tr_no = btrim(tr_no))));

create or replace function public.payments_refs_only_update() returns trigger
language plpgsql set search_path = public as $$
begin
  if (to_jsonb(new) - 'si_no' - 'tr_no') is distinct from (to_jsonb(old) - 'si_no' - 'tr_no') then
    raise exception 'Payments cannot be changed (void with a new row instead); only the S.I#/T.R# numbers can be corrected.';
  end if;
  return new;
end $$;
drop trigger if exists trg_payments_refs_only_update on public.payments;
create trigger trg_payments_refs_only_update before update on public.payments
  for each row execute function public.payments_refs_only_update();

create or replace function public.set_payment_receipt_refs(
  p_payment_id int, p_expected_si text, p_expected_tr text, p_si text, p_tr text)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  p public.payments; v_si text; v_tr text; v_name text; v_room text; v_bed text; v_lbl text; v_raw text; i int;
begin
  if coalesce(public.app_role(), '') not in ('admin', 'user') then
    raise exception 'Only staff or an admin can set S.I#/T.R# numbers.'; end if;

  for i in 1 .. 2 loop
    v_lbl := case i when 1 then 'S.I#' else 'T.R#' end;
    v_raw := case i when 1 then p_si else p_tr end;
    v_raw := nullif(btrim(regexp_replace(coalesce(v_raw, ''), '\s+', ' ', 'g')), '');
    if v_raw is not null and (char_length(v_raw) > 30 or v_raw !~ '[0-9]' or v_raw ~ '[[:cntrl:]]'
       or position(chr(183) in v_raw) > 0
       or v_raw ~* '^(#|(s\s*\.?\s*i|t\s*\.?\s*r)\s*\.?\s*(#|no\M))') then
      raise exception 'Invalid % "%": enter the number only (max 30 characters, at least one digit, no S.I#/T.R# prefix).', v_lbl, v_raw;
    end if;
    if i = 1 then v_si := v_raw; else v_tr := v_raw; end if;
  end loop;

  select * into p from public.payments where id = p_payment_id for update;
  if not found then raise exception 'Payment % not found.', p_payment_id; end if;
  if p.voids_payment_id is not null then
    raise exception 'Payment % is an undo (void) row; it has no S.I#/T.R#.', p.id; end if;
  if exists (select 1 from public.payments v where v.voids_payment_id = p.id) then
    raise exception 'Payment % was undone (voided); its numbers cannot be changed.', p.id; end if;
  if coalesce(p.amount, 0) <= 0 then
    raise exception 'Payment % has no positive amount; it cannot carry S.I#/T.R# numbers.', p.id; end if;
  if p.si_no is distinct from p_expected_si or p.tr_no is distinct from p_expected_tr then
    raise exception 'The numbers of payment % were changed by someone else. Reload the page and try again.', p.id; end if;

  if p.si_no is not distinct from v_si and p.tr_no is not distinct from v_tr then
    return jsonb_build_object('changed', false, 'payment_id', p.id); end if;
  if not public.is_admin() and ((p.si_no is not null and p.si_no is distinct from v_si)
                               or (p.tr_no is not null and p.tr_no is distinct from v_tr)) then
    raise exception 'Only an admin can change or clear an S.I#/T.R# number that is already recorded.'; end if;

  update public.payments set si_no = v_si, tr_no = v_tr where id = p.id;

  select t.name, r.room_no, bd.bed_letter into v_name, v_room, v_bed
    from public.tenants t left join public.beds bd on bd.id = t.bed_id left join public.rooms r on r.id = bd.room_id
   where t.id = p.tenant_id;
  insert into public.activity_log (activity_type, actor_id, tenant_id, tenant_name, room_no, bed_letter, entity_type, entity_id, notes, metadata)
  values ('Payment Ref Corrected', auth.uid(), p.tenant_id, v_name, v_room, v_bed, 'PAYMENT', p.id,
    format('Payment #%s: S.I# %s -> %s · T.R# %s -> %s', p.id,
           coalesce(p.si_no, 'none'), coalesce(v_si, 'none'), coalesce(p.tr_no, 'none'), coalesce(v_tr, 'none')),
    jsonb_build_object('old', jsonb_build_object('si', p.si_no, 'tr', p.tr_no), 'new', jsonb_build_object('si', v_si, 'tr', v_tr)));
  return jsonb_build_object('changed', true, 'payment_id', p.id, 'si_no', v_si, 'tr_no', v_tr);
end $$;
revoke execute on function public.set_payment_receipt_refs(int, text, text, text, text) from public, anon;
grant execute on function public.set_payment_receipt_refs(int, text, text, text, text) to authenticated;
