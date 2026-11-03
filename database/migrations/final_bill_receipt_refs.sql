-- Real S.I# / T.R# numbers on the final bill: admin-only correction of a settled receipt's number after move-out. Idempotent,
-- hand-applied (do NOT run all of init.sql). Mirrored in database/init.sql. Requirements section 5 "Receipt numbers on the final bill".
-- No table or column changes. The Move Out / Approvals flow does not depend on this file (it writes HELD receipts through the
-- existing admin UPDATE policy); only the "Fix S.I#/T.R#" action on /print/final-bill and the tenant profile does.
--
-- correct_receipt_ref(): sets tenant_deposits.ref_no of an APPLIED/FORFEITED receipt and, in the same transaction, the text of the
-- FINAL bill that credits/forfeits it (line `mid`, details.advance_check text/receipts[].ref) as built by the client. It refuses any
-- other change to the bill (amounts, kinds, receipt ids, every other detail), a reservation-carried T.R#, and non-admin callers.
-- Every correction is appended to final_bills.details.ref_corrections and logged as 'Receipt Number Corrected'.
create or replace function public.correct_receipt_ref(
  p_deposit_id int, p_ref_no text, p_bill_id int default null, p_lines jsonb default null, p_details jsonb default null)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  d public.tenant_deposits; b public.final_bills; v_new text; v_old text; v_lbl text; i int;
  o jsonb; n jsonb; oc jsonb; nc jsonb; v_name text; v_room text; v_bed text;
begin
  if not public.is_admin() then raise exception 'Only an admin can correct an S.I#/T.R# number.'; end if;
  v_new := btrim(regexp_replace(coalesce(p_ref_no, ''), '\s+', ' ', 'g'));
  if v_new = '' or char_length(v_new) > 30 or v_new !~ '[0-9]' or v_new ~ '[[:cntrl:]]'
     or position(chr(183) in v_new) > 0
     or v_new ~* '^(#|(s\s*\.?\s*i|t\s*\.?\s*r)\s*\.?\s*(#|no\M))' then
    raise exception 'Invalid receipt number "%": enter the number only (max 30 characters, at least one digit, no S.I#/T.R# prefix).', p_ref_no;
  end if;
  select * into d from public.tenant_deposits where id = p_deposit_id for update;
  if not found then raise exception 'Receipt % not found.', p_deposit_id; end if;
  if d.status not in ('APPLIED','FORFEITED') then
    raise exception 'Receipt % is %: edit a HELD receipt from the tenant profile.', d.id, d.status; end if;
  if d.reservation_payment_id is not null and nullif(btrim(d.ref_no), '') is not null then
    raise exception 'This T.R# came from a reservation payment and cannot be changed here.'; end if;
  v_lbl := case d.kind when 'ADVANCE' then 'S.I#' else 'T.R#' end;
  v_old := d.ref_no;
  if v_old is not distinct from v_new then
    return jsonb_build_object('changed', false, 'deposit_id', d.id); end if;

  select fb.* into b from public.final_bills fb
   where fb.tenant_id = d.tenant_id and fb.status = 'FINAL'
     and exists (select 1 from jsonb_array_elements(fb.lines) l
                  where l->>'kind' in ('credit','forfeit') and coalesce(l->'deposit_ids','[]'::jsonb) @> to_jsonb(d.id))
   for update;
  if found then
    if p_bill_id is distinct from b.id or p_lines is null then
      raise exception 'Receipt % is on final bill #%. Reload the page and try again.', d.id, b.id; end if;
    if jsonb_typeof(p_lines) <> 'array' then
      raise exception 'Final bill #%: the lines changed. Reload the page and try again.', b.id; end if;
    if jsonb_array_length(p_lines) <> jsonb_array_length(b.lines) then
      raise exception 'Final bill #%: the lines changed. Reload the page and try again.', b.id; end if;
    for i in 0 .. jsonb_array_length(b.lines) - 1 loop
      o := b.lines->i; n := p_lines->i;
      if (o - 'mid') is distinct from (n - 'mid') then
        raise exception 'Final bill #%: only the details text may change (line %).', b.id, i + 1; end if;
      if (o->'mid') is distinct from (n->'mid')
         and not (o->>'kind' in ('credit','forfeit') and coalesce(o->'deposit_ids','[]'::jsonb) @> to_jsonb(d.id)) then
        raise exception 'Final bill #%: line % does not belong to receipt %.', b.id, i + 1, d.id; end if;
    end loop;
    if (coalesce(p_details,'{}'::jsonb) - 'advance_check' - 'ref_corrections')
       is distinct from (coalesce(b.details,'{}'::jsonb) - 'advance_check' - 'ref_corrections') then
      raise exception 'Final bill #%: only the receipt number may change.', b.id; end if;
    oc := nullif(b.details->'advance_check', 'null'::jsonb); nc := nullif(p_details->'advance_check', 'null'::jsonb);
    if (oc is null) <> (nc is null) then raise exception 'Final bill #%: the advance check changed.', b.id; end if;
    if oc is not null then
      if (oc - 'text' - 'receipts') is distinct from (nc - 'text' - 'receipts')
         or jsonb_array_length(coalesce(oc->'receipts','[]'::jsonb)) <> jsonb_array_length(coalesce(nc->'receipts','[]'::jsonb)) then
        raise exception 'Final bill #%: the advance check figures cannot change.', b.id; end if;
      for i in 0 .. jsonb_array_length(coalesce(oc->'receipts','[]'::jsonb)) - 1 loop
        if ((oc->'receipts'->i) - 'ref') is distinct from ((nc->'receipts'->i) - 'ref')
           or ((oc->'receipts'->i->'ref') is distinct from (nc->'receipts'->i->'ref') and (oc->'receipts'->i->>'deposit_id')::int <> d.id) then
          raise exception 'Final bill #%: the advance check figures cannot change.', b.id; end if;
      end loop;
      if (oc->>'text') is distinct from (nc->>'text') and d.kind <> 'ADVANCE' then
        raise exception 'Final bill #%: a deposit number does not change the advance check.', b.id; end if;
    end if;
    update public.final_bills
       set lines = p_lines,
           details = coalesce(p_details, '{}'::jsonb) || jsonb_build_object('ref_corrections',
             coalesce(b.details->'ref_corrections', '[]'::jsonb) || jsonb_build_array(jsonb_build_object(
               'deposit_id', d.id, 'kind', d.kind, 'old', v_old, 'new', v_new, 'by', auth.uid(), 'at', now())))
     where id = b.id;
  elsif p_bill_id is not null then
    raise exception 'Receipt % is not on final bill #%.', d.id, p_bill_id;
  end if;

  update public.tenant_deposits set ref_no = v_new where id = d.id;
  select t.name, r.room_no, bd.bed_letter into v_name, v_room, v_bed
    from public.tenants t left join public.beds bd on bd.id = t.bed_id left join public.rooms r on r.id = bd.room_id
   where t.id = d.tenant_id;
  insert into public.activity_log (activity_type, actor_id, tenant_id, tenant_name, room_no, bed_letter, entity_type, entity_id, notes, metadata)
  values ('Receipt Number Corrected', auth.uid(), d.tenant_id, v_name, v_room, v_bed, 'TENANT', d.tenant_id,
    format('%s receipt #%s: %s -> %s%s', initcap(d.kind), d.id, coalesce(v_lbl || ' ' || nullif(btrim(v_old), ''), 'no number'),
           v_lbl || ' ' || v_new, case when b.id is not null then format(' (final bill #%s updated)', b.id) else '' end),
    jsonb_build_object('deposit_id', d.id, 'kind', d.kind, 'old', v_old, 'new', v_new, 'final_bill_id', b.id));
  return jsonb_build_object('changed', true, 'deposit_id', d.id, 'old', v_old, 'new', v_new, 'final_bill_id', b.id);
end $$;
revoke execute on function public.correct_receipt_ref(int, text, int, jsonb, jsonb) from public, anon;
grant execute on function public.correct_receipt_ref(int, text, int, jsonb, jsonb) to authenticated;
