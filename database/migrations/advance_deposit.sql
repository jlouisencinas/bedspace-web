-- Advance & deposit tracking (Phase 1): one row per receipt.
--
-- Per policy a tenant pays, at move-in, 1 month ADVANCE (documented by a Sales
-- Invoice, S.I#) and 1 month DEPOSIT (documented by a Temporary Receipt, T.R#),
-- each equal to the tenant's monthly rate. ref_no is free text (may be blank; a
-- tenant can have several receipts). status tracks what later happened to the
-- money (HELD -> APPLIED / FORFEITED / REFUNDED) and is written by the later
-- move-out phases, not by Phase 1 app code.
--
-- Apply ONLY this file against the live DB (per CLAUDE.md: never run all of
-- database/init.sql — its seed section truncates live data). Part 1 (DDL) is
-- idempotent. Part 2 (BACKFILL) is a separate, deliberate data step; it is
-- re-runnable but run it exactly once after reviewing the active tenants.
-- The unused tenants.advance_rent / security_deposit / credit_balance columns
-- and the empty settlements table are intentionally not touched.

-- ═══ PART 1: DDL (tables + indexes + RLS) ═══════════════════════════════════

create table if not exists tenant_deposits (
  id            serial primary key,
  tenant_id     int not null references tenants(id),
  kind          text not null check (kind in ('ADVANCE','DEPOSIT')),
  amount        numeric(10,2) not null check (amount >= 0),
  ref_no        text,
  received_date date,
  status        text not null default 'HELD'
                check (status in ('HELD','APPLIED','FORFEITED','REFUNDED')),
  settled_note  text,
  notes         text,
  created_by    uuid,
  created_at    timestamptz default now()
);
create index if not exists idx_tenant_deposits_tenant on tenant_deposits(tenant_id);
create index if not exists idx_tenant_deposits_status on tenant_deposits(status);

-- select/insert = admin+user (viewers cannot see or forge receipts; move-in by a user inserts
-- the two receipts); update = admin only; nobody can delete. Status changes instead.
alter table public.tenant_deposits enable row level security;
drop policy if exists tenant_deposits_select on public.tenant_deposits;
create policy tenant_deposits_select on public.tenant_deposits
  for select to authenticated
  using (exists (select 1 from public.profiles where id = auth.uid() and role in ('admin','user')));
drop policy if exists tenant_deposits_insert on public.tenant_deposits;
create policy tenant_deposits_insert on public.tenant_deposits
  for insert to authenticated
  with check (exists (select 1 from public.profiles where id = auth.uid() and role in ('admin','user')));
drop policy if exists tenant_deposits_update on public.tenant_deposits;
create policy tenant_deposits_update on public.tenant_deposits
  for update to authenticated
  using (exists (select 1 from public.profiles where id = auth.uid() and role = 'admin'));
-- No DELETE policy on purpose: receipts are never deleted (void/settle via status for the audit trail).
drop policy if exists tenant_deposits_delete on public.tenant_deposits;

-- ═══ PART 2: BACKFILL (one-time data step — run separately, after Part 1) ═══
-- Creates one ADVANCE and one DEPOSIT row (amount = current rate, ref_no blank)
-- for every ACTIVE bed tenant. Staff then fill in the S.I#/T.R# from the tenant
-- profile (Advance & Deposit tab). Guarded by NOT EXISTS so a re-run never
-- duplicates. Review: tenants with a null/0 rate get 0.00 rows — correct the
-- amount in the UI afterward.

insert into tenant_deposits (tenant_id, kind, amount, ref_no, received_date, status, notes)
select t.id, 'ADVANCE', coalesce(t.rate, 0), null, t.move_in_date, 'HELD',
       'Backfilled: 1 month advance/deposit per policy; SI#/TR# to be filled in'
from tenants t
where t.is_active
  and t.bed_id is not null
  and t.category = 'BED'
  and not exists (select 1 from tenant_deposits d where d.tenant_id = t.id and d.kind = 'ADVANCE');

insert into tenant_deposits (tenant_id, kind, amount, ref_no, received_date, status, notes)
select t.id, 'DEPOSIT', coalesce(t.rate, 0), null, t.move_in_date, 'HELD',
       'Backfilled: 1 month advance/deposit per policy; SI#/TR# to be filled in'
from tenants t
where t.is_active
  and t.bed_id is not null
  and t.category = 'BED'
  and not exists (select 1 from tenant_deposits d where d.tenant_id = t.id and d.kind = 'DEPOSIT');
