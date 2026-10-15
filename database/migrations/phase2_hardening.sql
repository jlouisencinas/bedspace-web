-- Phase 2 hardening (QA fixes). Idempotent. Apply AFTER advance_deposit.sql and final_bills.sql.
-- Apply ONLY this file against the live DB (never all of database/init.sql: its seed truncates data).
--
-- 1. One non-void FINAL bill per tenant (blocks a duplicate move-out bill).
-- 2. advance_credits: the second-to-last-bill advance credit, recorded automatically when the
--    cutoff it belongs to is closed (opening the next cutoff). A stored row is immutable and makes
--    the advance "consumed": later date changes / lease extensions can neither drop nor repeat it.
--    `allocations` = [{deposit_id, amount}]: which receipts (incl. whole-room sibling beds) it used.
-- 3. RLS: final_bills insert is admin-only; tenant_deposits insert by non-admins only as HELD.

create unique index if not exists uq_final_bills_one_final on final_bills(tenant_id) where status = 'FINAL';

create table if not exists advance_credits (
  id          serial primary key,
  tenant_id   int not null references tenants(id),
  cutoff_id   int not null references cutoffs(id),
  amount      numeric(10,2) not null check (amount >= 0),
  ref_text    text,
  allocations jsonb,
  created_at  timestamptz default now(),
  unique (tenant_id, cutoff_id)
);
create index if not exists idx_advance_credits_tenant on advance_credits(tenant_id);

alter table public.advance_credits enable row level security;
drop policy if exists advance_credits_select on public.advance_credits;
create policy advance_credits_select on public.advance_credits
  for select to authenticated
  using (exists (select 1 from public.profiles where id = auth.uid() and role in ('admin','user')));
drop policy if exists advance_credits_insert on public.advance_credits;
create policy advance_credits_insert on public.advance_credits
  for insert to authenticated
  with check (exists (select 1 from public.profiles where id = auth.uid() and role = 'admin'));
-- No UPDATE / DELETE policies on purpose: a recorded credit is immutable.
drop policy if exists advance_credits_update on public.advance_credits;
drop policy if exists advance_credits_delete on public.advance_credits;

drop policy if exists final_bills_insert on public.final_bills;
create policy final_bills_insert on public.final_bills
  for insert to authenticated
  with check (exists (select 1 from public.profiles where id = auth.uid() and role = 'admin'));

drop policy if exists tenant_deposits_insert on public.tenant_deposits;
create policy tenant_deposits_insert on public.tenant_deposits
  for insert to authenticated
  with check (
    exists (select 1 from public.profiles where id = auth.uid() and role = 'admin')
    or (status = 'HELD' and exists (select 1 from public.profiles where id = auth.uid() and role = 'user'))
  );
