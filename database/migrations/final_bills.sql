-- Final bills (move-out settlement) + advance-application tracking (Phase 2).
--
-- final_bills: one row per issued final bill for a moving-out tenant. Lines are a jsonb array of
-- { label, mid, amount, kind: 'charge'|'unsettled'|'credit'|'forfeit', source?, ref?, rate?, original? }.
-- Credits are stored as NEGATIVE amounts; net_amount = sum(lines). net_amount > 0 = tenant owes,
-- net_amount < 0 = refund due to the tenant. Rows are never deleted: a wrong bill is voided
-- (status VOID + void_reason), see voidFinalBill() in src/lib/supabase.js.
--
-- ORDER: apply advance_deposit.sql, then THIS file, then phase2_hardening.sql. The hardening file
-- tightens the policies below (final_bills insert becomes admin-only; tenant_deposits insert is limited to
-- HELD for non-admins), adds the one-FINAL-bill-per-tenant unique index and creates advance_credits, which
-- stores the second-to-last-bill advance credit once its cutoff is closed (live detection from the
-- move-out date, see billPosition() in src/lib/finalBill.js, applies while a cutoff is still active).
-- tenant_deposits.status only changes when the final bill is confirmed (HELD -> APPLIED / FORFEITED).
--
-- Apply ONLY this file against the live DB (per CLAUDE.md: never run all of database/init.sql).
-- Requires database/migrations/advance_deposit.sql (tenant_deposits) to be applied first.
-- Everything here is idempotent.

create table if not exists final_bills (
  id                serial primary key,
  tenant_id         int not null references tenants(id),
  cutoff_id         int references cutoffs(id),
  status            text not null default 'FINAL' check (status in ('FINAL','VOID')),
  move_out_date     date not null,
  early_termination boolean default false,
  forfeit_waived    boolean default false,
  waived_reason     text,
  lines             jsonb not null,
  details           jsonb,
  total_charges     numeric(12,2),
  total_credits     numeric(12,2),
  net_amount        numeric(12,2),
  refund_status     text not null default 'NONE' check (refund_status in ('NONE','PENDING','PAID')),
  refund_paid_date  date,
  refund_ref        text,
  prepared_by       text,
  void_reason       text,
  voided_at         timestamptz,
  created_by        uuid,
  created_at        timestamptz default now()
);
create index if not exists idx_final_bills_tenant on final_bills(tenant_id);

-- select/insert = admin+user; update = admin only (void / refund tracking); nobody can delete.
alter table public.final_bills enable row level security;
drop policy if exists final_bills_select on public.final_bills;
create policy final_bills_select on public.final_bills
  for select to authenticated
  using (exists (select 1 from public.profiles where id = auth.uid() and role in ('admin','user')));
drop policy if exists final_bills_insert on public.final_bills;
create policy final_bills_insert on public.final_bills
  for insert to authenticated
  with check (exists (select 1 from public.profiles where id = auth.uid() and role in ('admin','user')));
drop policy if exists final_bills_update on public.final_bills;
create policy final_bills_update on public.final_bills
  for update to authenticated
  using (exists (select 1 from public.profiles where id = auth.uid() and role = 'admin'));
-- No DELETE policy on purpose: bills are never deleted (void via status for the audit trail).
drop policy if exists final_bills_delete on public.final_bills;
