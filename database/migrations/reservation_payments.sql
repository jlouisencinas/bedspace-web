-- reservation_payments.sql  (idempotent; safe to run twice)
--
-- Reservation payments (money paid on a RESERVED bed before move-in, with its own T.R#) and split
-- (bank + cash) advance/deposit receipt lines. See docs/requirements.md section 5
-- "Reservation payments". Purely additive: changes no existing row.
-- Apply this BEFORE deploying the frontend that uses it (Move In calls record_move_in_receipts).
-- Move In can also type reservation payments (RESERVATION lines, T.R# + date required) for beds that
-- were never reserved/recorded; they are inserted HELD and applied as deposit in the same transaction.
-- Mirrored into database/init.sql (NOT in its truncate/seed section).

-- 1. tenant_deposits: payment mode + bank reference
alter table public.tenant_deposits add column if not exists payment_mode text;
alter table public.tenant_deposits drop constraint if exists tenant_deposits_payment_mode_check;
alter table public.tenant_deposits add constraint tenant_deposits_payment_mode_check
  check (payment_mode is null or payment_mode in ('BANK','CASH'));
alter table public.tenant_deposits add column if not exists bank_ref text;

-- 2. Reservation payments (pre-move-in money, keyed by bed)
create table if not exists public.bed_reservation_payments (
  id            serial primary key,
  bed_id        int  not null references public.beds(id),
  reserved_name text,                                   -- snapshot of beds.reserved_name (trigger-filled)
  amount        numeric(10,2) not null check (amount > 0),
  ref_no        text,                                   -- T.R#
  bank_ref      text,
  payment_mode  text not null check (payment_mode in ('BANK','CASH')),
  received_date date not null default current_date,
  status        text not null default 'HELD'
                check (status in ('HELD','APPLIED','FORFEITED','VOID')),
  tenant_id     int references public.tenants(id),      -- set when APPLIED
  settled_at    timestamptz,
  settled_note  text,                                   -- forfeit reason / void reason / applied note
  notes         text,
  created_by    uuid,
  created_at    timestamptz default now(),
  check (status <> 'APPLIED' or tenant_id is not null)
);
create index if not exists idx_brp_bed_status on public.bed_reservation_payments(bed_id, status);
create index if not exists idx_brp_tenant     on public.bed_reservation_payments(tenant_id);

-- 3. Link back from the carried deposit row (one deposit per reservation payment)
alter table public.tenant_deposits
  add column if not exists reservation_payment_id int references public.bed_reservation_payments(id);
create unique index if not exists uq_tenant_deposits_reservation_payment
  on public.tenant_deposits(reservation_payment_id) where reservation_payment_id is not null;

-- 4. RLS
alter table public.bed_reservation_payments enable row level security;
drop policy if exists brp_select on public.bed_reservation_payments;
create policy brp_select on public.bed_reservation_payments for select to authenticated
  using (exists (select 1 from public.profiles where id = auth.uid() and role in ('admin','user')));
drop policy if exists brp_insert on public.bed_reservation_payments;
create policy brp_insert on public.bed_reservation_payments for insert to authenticated
  with check (status = 'HELD' and tenant_id is null
              and exists (select 1 from public.profiles where id = auth.uid() and role in ('admin','user')));
drop policy if exists brp_update on public.bed_reservation_payments;
create policy brp_update on public.bed_reservation_payments for update to authenticated
  using (public.is_admin()) with check (public.is_admin());
drop policy if exists brp_delete on public.bed_reservation_payments;   -- no DELETE policy on purpose

-- clients may not forge a reservation link on a deposit (only the DEFINER functions below set it)
drop policy if exists tenant_deposits_insert on public.tenant_deposits;
create policy tenant_deposits_insert on public.tenant_deposits for insert to authenticated
  with check (
    reservation_payment_id is null and (
      exists (select 1 from public.profiles where id = auth.uid() and role = 'admin')
      or (status = 'HELD' and exists (select 1 from public.profiles where id = auth.uid() and role = 'user')))
  );

-- 5. Insert guard: bed must be RESERVED (snapshot the name server-side), except for the one bed
--    record_move_in_receipts is currently writing reservation lines for (bed-bound, transaction-local flag).
create or replace function public.brp_before_insert() returns trigger
language plpgsql security definer set search_path = public as $$
declare v_status text; v_name text;
begin
  select status, reserved_name into v_status, v_name from public.beds where id = new.bed_id;
  if coalesce(current_setting('app.brp_insert_bed', true), '') = new.bed_id::text then
    -- Only record_move_in_receipts sets this, bound to the bed of the tenant being moved in
    -- (the bed is already LEASED at that point). Keep the payer name it supplied.
    new.reserved_name := coalesce(nullif(trim(new.reserved_name), ''), v_name);
  else
    if v_status is distinct from 'RESERVED' then
      raise exception 'A reservation payment can only be recorded on a RESERVED bed.';
    end if;
    new.reserved_name := v_name;
  end if;
  new.created_by := auth.uid();
  return new;
end $$;
drop trigger if exists trg_brp_before_insert on public.bed_reservation_payments;
create trigger trg_brp_before_insert before insert on public.bed_reservation_payments
  for each row execute function public.brp_before_insert();

-- 6. Update guard: only HELD rows change; direct updates may only edit fields or VOID (with reason)
create or replace function public.brp_guard_update() returns trigger
language plpgsql as $$
declare v_sys boolean := coalesce(current_setting('app.brp_system', true), '') = '1';
begin
  if old.status <> 'HELD' then
    raise exception 'This reservation payment is % and can no longer be changed.', old.status;
  end if;
  if new.bed_id <> old.bed_id then
    raise exception 'A reservation payment cannot be moved to another bed.';
  end if;
  if not v_sys then
    if new.status not in ('HELD','VOID') then
      raise exception 'Apply and forfeit happen automatically (Move In / Remove Reservation).';
    end if;
    if new.tenant_id is distinct from old.tenant_id then
      raise exception 'tenant_id cannot be set directly.';
    end if;
  end if;
  if new.status = 'VOID' then
    if length(trim(coalesce(new.settled_note, ''))) = 0 then
      raise exception 'A reason is required to void a reservation payment.';
    end if;
    new.settled_at := now();
  end if;
  return new;
end $$;
drop trigger if exists trg_brp_guard_update on public.bed_reservation_payments;
create trigger trg_brp_guard_update before update on public.bed_reservation_payments
  for each row execute function public.brp_guard_update();

-- 7. A deposit carried from a reservation keeps its amount/date/kind/tenant (documentation fields stay editable)
create or replace function public.td_guard_reservation_rows() returns trigger
language plpgsql as $$
begin
  if old.reservation_payment_id is null and new.reservation_payment_id is not null then
    raise exception 'A reservation link cannot be set on an existing deposit.';
  end if;
  if old.reservation_payment_id is not null and (
       new.reservation_payment_id is distinct from old.reservation_payment_id
    or new.amount <> old.amount or new.received_date is distinct from old.received_date
    or new.kind <> old.kind or new.tenant_id <> old.tenant_id) then
    raise exception 'A deposit that came from a reservation payment cannot change amount, date, type or tenant.';
  end if;
  return new;
end $$;
drop trigger if exists trg_td_guard_reservation_rows on public.tenant_deposits;
create trigger trg_td_guard_reservation_rows before update on public.tenant_deposits
  for each row execute function public.td_guard_reservation_rows();

-- 8. Automatic forfeiture when a reservation ends (covers BedMap, retire_room, reconfigure_room, approvals)
create or replace function public.beds_reservation_sync() returns trigger
language plpgsql security definer set search_path = public as $$
declare r record; v_room text; v_note text;
begin
  if new.status is not distinct from old.status then return new; end if;
  if old.status = 'RESERVED' and new.status <> 'LEASED' then
    v_note := format('Reservation ended: bed %s -> %s', old.status, new.status);
  elsif new.status = 'RESERVED' then
    v_note := 'Leftover payment from an earlier reservation: bed was reserved again';
  else
    return new;
  end if;
  select room_no into v_room from public.rooms where id = new.room_id;
  perform set_config('app.brp_system', '1', true);
  for r in select * from public.bed_reservation_payments
           where bed_id = new.id and status = 'HELD' order by id for update loop
    update public.bed_reservation_payments
       set status = 'FORFEITED', settled_at = now(), settled_note = v_note where id = r.id;
    insert into public.activity_log (activity_type, actor_id, room_no, bed_letter, entity_type, entity_id, notes, metadata)
    values ('Reservation Payment Forfeited', auth.uid(), v_room, new.bed_letter, 'BED', new.id,
      format('Room %s Bed %s: reservation payment P%s%s (reserved for %s) forfeited. %s',
             v_room, new.bed_letter, to_char(r.amount, 'FM999,999,990.00'),
             coalesce(' TR# ' || r.ref_no, ''), coalesce(r.reserved_name, '?'), v_note),
      jsonb_build_object('reservation_payment_id', r.id, 'amount', r.amount, 'ref_no', r.ref_no,
                         'reserved_name', r.reserved_name, 'reason', v_note));
  end loop;
  return new;
end $$;
drop trigger if exists trg_beds_reservation_sync on public.beds;
create trigger trg_beds_reservation_sync after update of status on public.beds
  for each row execute function public.beds_reservation_sync();

-- 9. Carry HELD reservation payments into tenant_deposits (also used for recovery from the profile)
create or replace function public.apply_reservation_payments(p_tenant_id int)
returns setof public.tenant_deposits
language plpgsql security definer set search_path = public as $$
declare v_role text; v_bed int; v_active boolean; r record; d public.tenant_deposits;
begin
  select role into v_role from public.profiles where id = auth.uid();
  if v_role is null or v_role not in ('admin','user') then raise exception 'Not allowed.'; end if;
  select bed_id, is_active into v_bed, v_active from public.tenants where id = p_tenant_id for update;
  if not found or not v_active or v_bed is null then
    raise exception 'Tenant % is not an active bed tenant.', p_tenant_id;
  end if;
  perform set_config('app.brp_system', '1', true);
  for r in select * from public.bed_reservation_payments
           where bed_id = v_bed and status = 'HELD' order by id for update loop
    insert into public.tenant_deposits
      (tenant_id, kind, amount, ref_no, bank_ref, payment_mode, received_date, status, notes, created_by, reservation_payment_id)
    values (p_tenant_id, 'DEPOSIT', r.amount, r.ref_no, r.bank_ref, r.payment_mode, r.received_date, 'HELD',
            trim('Reservation payment' || coalesce(' from ' || r.reserved_name, '') || coalesce('. ' || r.notes, '')),
            auth.uid(), r.id)
    returning * into d;
    update public.bed_reservation_payments
       set status = 'APPLIED', tenant_id = p_tenant_id, settled_at = now(),
           settled_note = format('Applied as deposit receipt #%s (tenant #%s)', d.id, p_tenant_id)
     where id = r.id;
    insert into public.activity_log (activity_type, actor_id, tenant_id, tenant_name, entity_type, entity_id, notes, metadata)
    select 'Reservation Payment Applied', auth.uid(), p_tenant_id, t.name, 'TENANT', p_tenant_id,
           format('Reservation payment P%s%s applied as deposit', to_char(r.amount, 'FM999,999,990.00'), coalesce(' TR# ' || r.ref_no, '')),
           jsonb_build_object('reservation_payment_id', r.id, 'deposit_id', d.id, 'amount', r.amount, 'ref_no', r.ref_no)
      from public.tenants t where t.id = p_tenant_id;
    return next d;
  end loop;
  return;
end $$;

-- 10. Atomic Move In receipts.
-- p_lines = [{kind: ADVANCE|DEPOSIT|RESERVATION, amount, payment_mode, ref_no, bank_ref, received_date, notes}]
-- RESERVATION lines are reservation payments entered at Move In (bed never reserved/recorded): inserted as HELD
-- rows of the tenant bed (a T.R# and a received date are required), then applied as deposit together with any
-- HELD rows already on the bed.
-- p_expected_reservation = HELD total already on the bed when the screen loaded (excludes RESERVATION lines).
create or replace function public.record_move_in_receipts(
  p_tenant_id int, p_advance_due numeric, p_deposit_due numeric,
  p_expected_reservation numeric, p_lines jsonb)
returns setof public.tenant_deposits
language plpgsql security definer set search_path = public as $$
declare
  v_role text; v_bed int; v_active boolean; v_name text;
  v_res numeric := 0; v_newres numeric := 0; v_adv numeric; v_dep numeric; v_short numeric;
  v_room text; v_letter text;
  x jsonb; d public.tenant_deposits; br public.bed_reservation_payments;
begin
  select role into v_role from public.profiles where id = auth.uid();
  if v_role is null or v_role not in ('admin','user') then raise exception 'Not allowed.'; end if;
  select bed_id, is_active, name into v_bed, v_active, v_name from public.tenants where id = p_tenant_id for update;
  if not found or not v_active or v_bed is null then
    raise exception 'Tenant % is not an active bed tenant.', p_tenant_id;
  end if;
  if exists (select 1 from public.tenant_deposits where tenant_id = p_tenant_id) then
    raise exception 'This tenant already has advance/deposit receipts; nothing was recorded.';
  end if;
  if p_advance_due is null or p_deposit_due is null
     or p_advance_due < 0 or p_deposit_due < 0
     or p_advance_due <> round(p_advance_due, 2) or p_deposit_due <> round(p_deposit_due, 2) then
    raise exception 'Advance/deposit due must be 0 or more with at most 2 decimals.';
  end if;

  select coalesce(sum(amount), 0) into v_res from public.bed_reservation_payments
   where bed_id = v_bed and status = 'HELD';
  if v_res <> coalesce(p_expected_reservation, 0) then
    raise exception 'Reservation payments on this bed changed (now %, screen showed %). Reopen Move In.', v_res, coalesce(p_expected_reservation, 0);
  end if;

  for x in select value from jsonb_array_elements(coalesce(p_lines, '[]'::jsonb)) loop
    if x->>'kind' is null or x->>'kind' not in ('ADVANCE','DEPOSIT','RESERVATION') then raise exception 'Invalid receipt type.'; end if;
    if x->>'payment_mode' is null or x->>'payment_mode' not in ('BANK','CASH') then raise exception 'Every receipt line needs a mode (BANK or CASH).'; end if;
    if x->>'amount' is null or (x->>'amount')::numeric <= 0 or (x->>'amount')::numeric <> round((x->>'amount')::numeric, 2) then
      raise exception 'Receipt line amounts must be greater than 0 with at most 2 decimals.';
    end if;
    if x->>'kind' = 'RESERVATION' and nullif(trim(coalesce(x->>'received_date', '')), '') is null then
      raise exception 'Every reservation payment line needs the date it was received.';
    end if;
    if x->>'kind' = 'RESERVATION' and nullif(trim(coalesce(x->>'ref_no', '')), '') is null then
      raise exception 'Every reservation payment line needs its T.R# (reference).';
    end if;
  end loop;

  select coalesce(sum((e->>'amount')::numeric) filter (where e->>'kind' = 'ADVANCE'), 0),
         coalesce(sum((e->>'amount')::numeric) filter (where e->>'kind' = 'DEPOSIT'), 0),
         coalesce(sum((e->>'amount')::numeric) filter (where e->>'kind' = 'RESERVATION'), 0)
    into v_adv, v_dep, v_newres from jsonb_array_elements(coalesce(p_lines, '[]'::jsonb)) e;
  v_short := greatest(p_deposit_due - (v_res + v_newres), 0);
  if v_adv <> p_advance_due then
    raise exception 'Advance lines total % but the advance due is %.', v_adv, p_advance_due;
  end if;
  if v_dep <> v_short then
    raise exception 'Deposit lines total % but % is still due (deposit due % less reservation payments %).', v_dep, v_short, p_deposit_due, v_res + v_newres;
  end if;

  -- backstop duplicate-TR# checks (the client also normalizes TR# 121 / 121)
  if exists (
    select 1 from jsonb_array_elements(coalesce(p_lines, '[]'::jsonb)) a,
                  jsonb_array_elements(coalesce(p_lines, '[]'::jsonb)) b
     where a->>'kind' = 'RESERVATION' and b->>'kind' in ('ADVANCE','DEPOSIT')
       and nullif(lower(trim(a->>'ref_no')), '') = lower(trim(b->>'ref_no'))) then
    raise exception 'A reservation payment reference was also used on an advance or deposit line. Enter each receipt once.';
  end if;
  if exists (
    select 1 from public.bed_reservation_payments p, jsonb_array_elements(coalesce(p_lines, '[]'::jsonb)) a
     where p.bed_id = v_bed and p.status = 'HELD' and a->>'kind' = 'RESERVATION'
       and nullif(lower(trim(a->>'ref_no')), '') = lower(trim(p.ref_no))) then
    raise exception 'A reservation payment with that reference is already recorded on this bed.';
  end if;

  -- 1. reservation payments entered at Move In -> HELD rows of the bed of this tenant
  select r.room_no, b.bed_letter into v_room, v_letter
    from public.beds b join public.rooms r on r.id = b.room_id where b.id = v_bed;
  perform set_config('app.brp_insert_bed', v_bed::text, true);   -- bed-bound, transaction-local
  for x in select value from jsonb_array_elements(coalesce(p_lines, '[]'::jsonb)) where value->>'kind' = 'RESERVATION' loop
    insert into public.bed_reservation_payments
      (bed_id, reserved_name, amount, ref_no, bank_ref, payment_mode, received_date, notes)
    values (v_bed, v_name, (x->>'amount')::numeric, nullif(trim(x->>'ref_no'), ''), nullif(trim(x->>'bank_ref'), ''),
            x->>'payment_mode', (x->>'received_date')::date,
            coalesce(nullif(trim(x->>'notes'), ''), 'Recorded at Move In'))
    returning * into br;
    insert into public.activity_log (activity_type, actor_id, tenant_id, tenant_name, room_no, bed_letter, entity_type, entity_id, notes, metadata)
    values ('Reservation Payment Recorded', auth.uid(), p_tenant_id, v_name, v_room, v_letter, 'BED', v_bed,
            format('Reservation payment P%s%s recorded at Move In for %s (%s)', to_char(br.amount, 'FM999,999,990.00'),
                   coalesce(' TR# ' || br.ref_no, ''), v_name, br.payment_mode),
            jsonb_build_object('reservation_payment_id', br.id, 'amount', br.amount, 'ref_no', br.ref_no,
                               'payment_mode', br.payment_mode, 'received_date', br.received_date, 'source', 'MOVE_IN'));
  end loop;
  perform set_config('app.brp_insert_bed', '', true);

  -- 2. advance + deposit lines
  for x in select value from jsonb_array_elements(coalesce(p_lines, '[]'::jsonb)) where value->>'kind' in ('ADVANCE','DEPOSIT') loop
    insert into public.tenant_deposits
      (tenant_id, kind, amount, ref_no, bank_ref, payment_mode, received_date, notes, created_by)
    values (p_tenant_id, x->>'kind', (x->>'amount')::numeric, nullif(trim(x->>'ref_no'), ''),
            nullif(trim(x->>'bank_ref'), ''), x->>'payment_mode',
            nullif(x->>'received_date', '')::date, nullif(trim(x->>'notes'), ''), auth.uid())
    returning * into d;
    insert into public.activity_log (activity_type, actor_id, tenant_id, tenant_name, entity_type, entity_id, notes, metadata)
    values ('Advance/Deposit Recorded', auth.uid(), p_tenant_id, v_name, 'TENANT', p_tenant_id,
            format('%s P%s recorded (%s)%s', initcap(d.kind), to_char(d.amount, 'FM999,999,990.00'), d.payment_mode,
                   coalesce(' ref ' || d.ref_no, '')),
            jsonb_build_object('deposit_id', d.id, 'kind', d.kind, 'amount', d.amount, 'ref_no', d.ref_no,
                               'payment_mode', d.payment_mode, 'received_date', d.received_date));
    return next d;
  end loop;

  -- 3. every HELD reservation row of the bed (earlier Bed Map ones + the ones just inserted) -> DEPOSIT rows
  return query select * from public.apply_reservation_payments(p_tenant_id);
end $$;

revoke execute on function public.apply_reservation_payments(int) from public, anon;
revoke execute on function public.record_move_in_receipts(int, numeric, numeric, numeric, jsonb) from public, anon;
grant  execute on function public.apply_reservation_payments(int) to authenticated;
grant  execute on function public.record_move_in_receipts(int, numeric, numeric, numeric, jsonb) to authenticated;
