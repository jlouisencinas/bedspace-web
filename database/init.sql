-- ================================================================
-- Bedspace Manager — init.sql
-- Single-file setup: tables · views · functions · RLS · seed data
-- Run once on a fresh Supabase project (SQL Editor → Run).
-- Safe to re-run: uses IF NOT EXISTS / DROP IF EXISTS guards.
-- ================================================================

-- ── EXTENSIONS ───────────────────────────────────────────────────
create extension if not exists pgcrypto;

-- ════════════════════════════════════════════════════════════════
-- 1. PROFILES & AUTH
-- ════════════════════════════════════════════════════════════════

create table if not exists public.profiles (
  id         uuid primary key references auth.users(id) on delete cascade,
  email      text,
  role       text not null default 'viewer'
             check (role in ('admin','user','viewer','guard')),
  created_at timestamptz default now()
);

-- Fix schema drift from older migrations:
-- 'owner' was a legacy role that has been removed.
-- Promote any existing 'owner' profiles to 'admin', then lock down
-- the column default and check constraint to the current definition.
update public.profiles set role = 'admin' where role = 'owner';
alter table public.profiles alter column role set default 'viewer';
alter table public.profiles drop constraint if exists profiles_role_check;
alter table public.profiles add constraint profiles_role_check
  check (role in ('admin','user','viewer','guard'));

-- Auto-create a profile row whenever a new auth user is added.
-- New accounts default to 'viewer'. Promote manually via:
--   update public.profiles set role = 'admin' where email = 'you@email.com';
create or replace function public.handle_new_user()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  insert into public.profiles (id, email, role)
  values (new.id, new.email, 'viewer')
  on conflict (id) do nothing;
  return new;
end $$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- Backfill profiles for any existing auth users.
insert into public.profiles (id, email)
select id, email from auth.users
on conflict (id) do nothing;

-- ════════════════════════════════════════════════════════════════
-- 2. CORE TABLES
-- ════════════════════════════════════════════════════════════════

create table if not exists rooms (
  id                 serial primary key,
  room_no            text not null unique,
  room_type          text,
  floor              int,
  has_ongoing_repair boolean not null default false,
  created_at         timestamptz default now()
);

create table if not exists beds (
  id            serial primary key,
  room_id       int references rooms(id) on delete cascade,
  bed_letter    text not null,
  bed_location  text,
  default_rate  numeric(10,2),
  status        text default 'VACANT'
                check (status in ('VACANT','LEASED','RESERVED','OUT OF ORDER')),
  reserved_name text,
  created_at    timestamptz default now(),
  unique(room_id, bed_letter)
);

-- ── Schema migrations (safe to re-run) ───────────────────────────────────────

-- Rooms: property management columns
alter table rooms add column if not exists original_bed_count int;
alter table rooms add column if not exists room_status        text not null default 'ACTIVE'
  check (room_status in ('ACTIVE','CONVERTED','MAINTENANCE','RESERVED'));
alter table rooms add column if not exists is_management      boolean not null default false;

-- Beds: target move-in date of the current reservation (reservation_target_date.sql)
alter table public.beds add column if not exists reserved_move_in_date date;
comment on column public.beds.reserved_move_in_date is
  'Target move-in date of the current reservation. Only set while status = RESERVED; cleared by trigger otherwise.';

-- Beds: soft-delete support (idempotent: only replaces if REMOVED is not already there)
do $$
declare c text;
begin
  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.beds'::regclass and contype = 'c'
      and pg_get_constraintdef(oid) ilike '%REMOVED%'
  ) then
    select conname into c from pg_constraint
    where conrelid = 'public.beds'::regclass and contype = 'c'
      and pg_get_constraintdef(oid) ilike '%VACANT%'
    limit 1;
    if c is not null then
      execute format('alter table beds drop constraint %I', c);
    end if;
    alter table beds add constraint beds_status_check
      check (status in ('VACANT','LEASED','RESERVED','OUT OF ORDER','REMOVED'));
  end if;
end $$;

-- Add-on type catalog
create table if not exists addon_types (
  id             serial primary key,
  label          text not null unique,
  category       text not null default 'RENT_WATER'
                 check (category in ('RENT_WATER','ELECTRIC')),
  bill_on        text not null default 'RENT_WATER'
                 check (bill_on in ('RENT_WATER','ELECTRIC')),
  default_amount numeric(10,2),
  is_active      boolean not null default true,
  created_at     timestamptz default now()
);

alter table addon_types add column if not exists default_amount numeric(10,2);

-- Seed default add-on types
insert into addon_types (label, category, bill_on, default_amount) values
  ('Parking',          'RENT_WATER', 'RENT_WATER', 500),
  ('Aircon Surcharge', 'ELECTRIC',   'ELECTRIC',   300),
  ('Laundry',          'RENT_WATER', 'RENT_WATER', 150),
  ('Extra Bed',        'RENT_WATER', 'RENT_WATER', 800),
  ('Pet Fee',          'RENT_WATER', 'RENT_WATER', 200),
  ('Key Deposit',      'RENT_WATER', 'RENT_WATER', 500)
on conflict (label) do nothing;

create table if not exists tenants (
  id                     serial primary key,
  bed_id                 int references beds(id),   -- nullable: commercial/parking tenants have no bed
  tenant_no              text,
  name                   text not null,
  gender                 text,
  rate                   numeric(10,2),
  duration               text,
  move_in_date           date,
  move_out_date          date,
  actual_move_out_date   date,
  last_pay_10th          date,
  last_pay_eom           date,
  contact_no             text,
  email                  text,
  location_of_work       text,
  work_schedule          text,
  govt_id1               text,
  govt_id2               text,
  contract               text,
  emergency_contact_name text,
  emergency_contact_no   text,
  comments               text,
  permanent_address      text,
  occupation             text,
  employer               text,
  employer_address       text,
  employer_contact_no    text,
  source                 text check (source is null or source in
                           ('REFERRAL','FACEBOOK','TIKTOK','INSTAGRAM','WALK_IN')),
  category               text not null default 'BED'
                         check (category in ('BED','COMMERCIAL','PARKING_ONLY','OTHER')),
  unit_label             text,
  previous_bed_id        int references beds(id),
  previous_room_id       int references rooms(id),
  transfer_date          date,
  is_active              boolean default true,
  created_at             timestamptz default now()
);

-- One active tenant per bed. Matches the live DB definition
-- (see database/migrations/uniq_active_tenant_per_bed.sql). Rows with bed_id null are not constrained.
create unique index if not exists uniq_active_tenant_per_bed on tenants(bed_id) where (is_active and bed_id is not null);

create table if not exists payments (
  id           serial primary key,
  tenant_id    int references tenants(id),
  payment_date date not null,
  amount       numeric(10,2),
  pay_type     text,
  notes        text,
  created_at   timestamptz default now()
);

create table if not exists activity_log (
  id                   serial primary key,
  tenant_name          text,
  room_no              text,
  bed_letter           text,
  rate                 numeric(10,2),
  move_in_date         date,
  move_out_date        date,
  actual_move_out_date date,
  amount_paid          numeric(10,2),
  activity_type        text,
  actor_id             uuid,
  tenant_id            int references tenants(id),
  entity_type          text,
  entity_id            int,
  metadata             jsonb,
  notes                text,
  recorded_at          timestamptz default now()
);

-- ════════════════════════════════════════════════════════════════
-- 3. UTILITY TABLES
-- ════════════════════════════════════════════════════════════════

create table if not exists cutoffs (
  id                        serial primary key,
  name                      text not null unique,
  water_start               date,
  water_end                 date,
  electric_start            date,
  electric_end              date,
  -- Provider rates (cost reference)
  water_maynilad_rate       numeric(12,6) not null default 0,
  electric_meralco_rate     numeric(12,6) not null default 0,
  -- Bedspace rates (billed to tenant — drives amount computation)
  water_bedspace_rate       numeric(12,6) not null default 0,
  electric_bedspace_rate    numeric(12,6) not null default 0,
  -- Provider master-line readings (P&L tracking)
  water_main_prev           numeric(14,2),
  water_main_curr           numeric(14,2),
  water_main_consumption    numeric(14,2),
  water_main_amount         numeric(14,2),
  water_markup_pct          numeric(6,2) default 10,
  water_rate_override       boolean default false,
  electric_main_prev        numeric(14,2),
  electric_main_curr        numeric(14,2),
  electric_main_consumption numeric(14,2),
  electric_main_amount      numeric(14,2),
  electric_markup_pct       numeric(6,2) default 10,
  electric_rate_override    boolean default false,
  is_active                 boolean default false,
  created_at                timestamptz default now()
);

-- Payments: category + cutoff scoping (already read/written by recordPayment()/
-- fetchPaymentsForCutoff() in src/lib/supabase.js — bringing schema back in sync).
-- Placed here (after cutoffs) since cutoff_id references cutoffs(id).
alter table public.payments add column if not exists category text;
alter table public.payments add column if not exists cutoff_id int references cutoffs(id) on delete set null;
alter table public.payments drop constraint if exists payments_category_check;
alter table public.payments add constraint payments_category_check
  check (category is null or category in ('RENT_WATER','ELECTRICITY','OTHER'));

create index if not exists idx_payments_cutoff on payments(cutoff_id);
create index if not exists idx_payments_tenant on payments(tenant_id);

-- Payments: undo/void support (Collections §12). Compensating-row model —
-- payments has no UPDATE/DELETE policy for any role, by design, so "undo"
-- cannot be an UPDATE. A void is a NEW payments row with a negated amount,
-- linked back to the original via voids_payment_id. sum(payments.amount)
-- per tenant/category/cutoff nets back to the pre-payment balance
-- automatically — no change needed to buildPaymentMonitoring()/
-- summarizeCollections() or any other SUM()-based reconciliation logic.
alter table public.payments add column if not exists voids_payment_id int references payments(id);
create index if not exists idx_payments_voids on payments(voids_payment_id);
create unique index if not exists idx_payments_voids_unique
  on payments(voids_payment_id) where voids_payment_id is not null;

-- Payments: S.I# / T.R# numbers (Collections §12). Bare numbers, optional. Migration:
-- database/migrations/payments_receipt_refs.sql. Edited only via set_payment_receipt_refs() (function 13 below).
alter table public.payments add column if not exists si_no text;
alter table public.payments add column if not exists tr_no text;
alter table public.payments drop constraint if exists payments_ref_format_check;
alter table public.payments add constraint payments_ref_format_check check (
  (si_no is null or (char_length(si_no) <= 30 and si_no ~ '[0-9]' and si_no !~ '[[:cntrl:]]' and position(chr(183) in si_no) = 0 and si_no = btrim(si_no)))
  and (tr_no is null or (char_length(tr_no) <= 30 and tr_no ~ '[0-9]' and tr_no !~ '[[:cntrl:]]' and position(chr(183) in tr_no) = 0 and tr_no = btrim(tr_no))));

create table if not exists meter_readings (
  id               serial primary key,
  cutoff_id        int references cutoffs(id) on delete cascade,
  room_id          int references rooms(id)   on delete cascade,
  utility          text not null check (utility in ('WATER','ELECTRIC')),
  previous_reading numeric(12,2) default 0,
  current_reading  numeric(12,2) default 0,
  rate             numeric(12,6) default 0,
  consumption      numeric(12,2) generated always as (current_reading - previous_reading) stored,
  amount           numeric(14,2) generated always as ((current_reading - previous_reading) * rate) stored,
  created_at       timestamptz default now(),
  unique(cutoff_id, room_id, utility)
);

create index if not exists idx_meter_room_util on meter_readings(room_id, utility);
create index if not exists idx_meter_cutoff    on meter_readings(cutoff_id);

create table if not exists interim_readings (
  id                   serial primary key,
  cutoff_id            int references cutoffs(id) on delete cascade,
  room_id              int references rooms(id)   on delete cascade,
  utility              text not null check (utility in ('WATER','ELECTRIC')),
  reading_date         date not null,
  reading_value        numeric(12,2) not null,
  moving_out_tenant_id int references tenants(id),
  note                 text,
  created_at           timestamptz default now()
);

create index if not exists idx_interim_cutoff_room on interim_readings(cutoff_id, room_id, utility);

-- Move-in meter reading (start of a stay-anchored utility split; database/migrations/final_bill_covered_cutoffs.sql).
alter table public.interim_readings add column if not exists moving_in_tenant_id int references public.tenants(id);
create index if not exists idx_interim_room_util_date on public.interim_readings(room_id, utility, reading_date);
create index if not exists idx_interim_moving_in on public.interim_readings(moving_in_tenant_id) where moving_in_tenant_id is not null;

create table if not exists area_readings (
  id               serial primary key,
  cutoff_id        int references cutoffs(id) on delete cascade,
  area_name        text not null,
  utility          text not null check (utility in ('WATER','ELECTRIC')),
  previous_reading numeric(14,2) default 0,
  current_reading  numeric(14,2) default 0,
  consumption      numeric(14,2) generated always as (current_reading - previous_reading) stored,
  rate_type        text not null default 'STANDARD' check (rate_type in ('STANDARD','BEDSPACE')),
  tenant_id        int references tenants(id),
  created_at       timestamptz default now(),
  unique(cutoff_id, area_name, utility)
);

-- ════════════════════════════════════════════════════════════════
-- 4. OPERATIONAL TABLES
-- ════════════════════════════════════════════════════════════════

create table if not exists tenant_splits (
  id         serial primary key,
  cutoff_id  int references cutoffs(id)  on delete cascade,
  room_id    int references rooms(id)    on delete cascade,
  tenant_id  int references tenants(id)  on delete cascade,
  utility    text not null check (utility in ('WATER','ELECTRIC')),
  weight_pct numeric(6,2) not null default 0,
  created_at timestamptz default now(),
  unique(cutoff_id, room_id, tenant_id, utility)
);

create index if not exists idx_splits_cutoff_room on tenant_splits(cutoff_id, room_id, utility);

create table if not exists addons (
  id         serial primary key,
  tenant_id  int references tenants(id) on delete cascade,
  cutoff_id  int references cutoffs(id) on delete cascade,  -- NULL = recurring every cutoff
  label      text not null,
  category   text default 'OTHER'
             check (category in ('PARKING_CAR','PARKING_MC','AIRCON','OTHER')),
  bill_on    text not null default 'RENT_WATER'
             check (bill_on in ('RENT_WATER','ELECTRIC')),
  amount     numeric(12,2) not null default 0,
  hours      numeric(10,2),
  rate       numeric(12,4),
  recurring  boolean not null default false,
  created_at timestamptz default now()
);

create index if not exists idx_addons_tenant on addons(tenant_id);

create table if not exists monthly_reports (
  id          serial primary key,
  cutoff_id   int references cutoffs(id) on delete cascade unique,
  period_name text,
  period_date date,
  total_beds     int,
  sellable       int,
  occupied_beds  numeric(6,2),
  active_tenants numeric(6,2),
  occupied_rooms numeric(6,2),
  total_rooms    int,
  occupancy_pct  numeric(6,2),
  col_rent       numeric(14,2),
  col_water      numeric(14,2),
  col_electric   numeric(14,2),
  col_addons     numeric(14,2),
  col_total      numeric(14,2),
  water_cost           numeric(14,2),
  water_collections    numeric(14,2),
  water_variance       numeric(14,2),
  electric_cost        numeric(14,2),
  electric_collections numeric(14,2),
  electric_variance    numeric(14,2),
  total_variance       numeric(14,2),
  manual      boolean default false,
  snapshot_at timestamptz default now()
);

create table if not exists tenant_transfers (
  id                  serial primary key,
  tenant_id           int  not null references tenants(id),
  from_room_id        int  not null references rooms(id),
  from_bed_id         int  references beds(id),
  to_room_id          int  not null references rooms(id),
  to_bed_id           int  not null references beds(id),
  transfer_date       date not null,
  old_rate            numeric(10,2),
  new_rate            numeric(10,2),
  water_reading       numeric(10,4),
  electric_reading    numeric(10,4),
  to_water_reading    numeric(10,4),
  to_electric_reading numeric(10,4),
  notes               text,
  status              text default 'COMPLETED'
                      check (status in ('PENDING_APPROVAL','COMPLETED','REJECTED')),
  processed_by        uuid,
  created_at          timestamptz default now()
);

create table if not exists room_logs (
  id          serial primary key,
  room_id     int  not null references rooms(id) on delete cascade,
  event_type  text not null check (event_type in ('REPAIR','CONFIG_CHANGE','STATUS_CHANGE')),
  description text not null,
  created_by  uuid references auth.users(id),
  created_at  timestamptz default now()
);

create index if not exists room_logs_room_idx on room_logs(room_id, created_at desc);

create table if not exists maintenance_tickets (
  id               serial primary key,
  room_id          int  references rooms(id),
  location         text,
  tenant_id        int  references tenants(id),
  concern          text not null,
  remarks          text,
  status           text not null default 'PENDING'
                   check (status in ('PENDING','RESOLVED')),
  raised_at        timestamptz default now(),
  resolution_notes text,
  resolved_by      uuid references auth.users(id),
  resolved_at      timestamptz,
  created_at       timestamptz default now(),
  constraint maintenance_tickets_location_check
    check (location is null or location in
      ('LOBBY','FLOOR_2','FLOOR_3','FLOOR_4','FLOOR_5','FLOOR_6','FLOOR_7','KITCHEN','ROOF_DECK')),
  constraint maintenance_tickets_room_xor_location
    check ((room_id is not null) <> (location is not null))
);

create index if not exists tickets_room_status_idx   on maintenance_tickets(room_id, status);
create index if not exists tickets_tenant_idx        on maintenance_tickets(tenant_id);
create index if not exists tickets_status_raised_idx on maintenance_tickets(status, raised_at desc);

-- Common-area tickets (migrations/maintenance_common_areas.sql): converge an existing table.
-- The location codes mirror supabase/functions/_shared/maintenance-locations.ts.
alter table maintenance_tickets add column if not exists location text;
alter table maintenance_tickets alter column room_id drop not null;
do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'maintenance_tickets_location_check') then
    alter table maintenance_tickets
      add constraint maintenance_tickets_location_check
      check (location is null or location in
        ('LOBBY','FLOOR_2','FLOOR_3','FLOOR_4','FLOOR_5','FLOOR_6','FLOOR_7','KITCHEN','ROOF_DECK'));
  end if;
  if not exists (select 1 from pg_constraint where conname = 'maintenance_tickets_room_xor_location') then
    alter table maintenance_tickets
      add constraint maintenance_tickets_room_xor_location
      check ((room_id is not null) <> (location is not null));
  end if;
end $$;
create index if not exists tickets_location_status_idx
  on maintenance_tickets(location, status) where location is not null;
comment on column maintenance_tickets.location is
  'Common-area code (fixed list in supabase/functions/_shared/maintenance-locations.ts). Exactly one of room_id / location is set.';

create table if not exists approval_requests (
  id                uuid primary key default gen_random_uuid(),
  requester_id      uuid not null references auth.users(id),
  requester_email   text,
  entity_type       text not null
                    check (entity_type in ('TENANT','TENANT_STAY','BED','ROOM','PAYMENT')),
  entity_id         text not null,
  field_name        text not null,
  old_value         jsonb,
  new_value         jsonb not null,
  reason            text not null,
  status            text not null default 'PENDING'
                    check (status in ('PENDING','APPROVED','REJECTED')),
  decision_maker_id uuid references auth.users(id),
  decision_notes    text,
  created_at        timestamptz default now(),
  decided_at        timestamptz
);

create index if not exists approval_requests_status_idx on approval_requests(status, created_at desc);
create index if not exists approval_requests_entity_idx on approval_requests(entity_type, entity_id);

alter table public.approval_requests drop constraint if exists approval_requests_entity_type_check;
alter table public.approval_requests add constraint approval_requests_entity_type_check
  check (entity_type in ('TENANT','TENANT_STAY','BED','ROOM','PAYMENT','INTERIM_READING','VISITOR_LOG'));
-- One pending overnight request per visit (Visitor Log, section 8c).
create unique index if not exists uq_approval_pending_overnight on public.approval_requests(entity_id)
  where entity_type = 'VISITOR_LOG' and field_name = 'overnight_visitor' and status = 'PENDING';

-- ════════════════════════════════════════════════════════════════
-- 5. EXTENDED TABLES (invoicing, documents, tenant history)
-- ════════════════════════════════════════════════════════════════

-- Tenant document attachments (Google Drive links)
create table if not exists documents (
  id            serial primary key,
  tenant_id     int references tenants(id) on delete cascade,
  doc_type      text not null default 'OTHER'
                check (doc_type in ('GOVT_ID_1','GOVT_ID_2','CONTRACT','OTHER')),
  label         text,
  drive_file_id text,
  drive_link    text,
  is_required   boolean not null default false,
  uploaded_by   text,
  uploaded_at   timestamptz default now()
);
create index if not exists idx_documents_tenant on documents(tenant_id);

-- Per-tenant billing invoices per cutoff
create table if not exists invoices (
  id            serial primary key,
  tenant_id     int references tenants(id) on delete cascade,
  cutoff_id     int references cutoffs(id) on delete cascade,
  bill_type     text not null check (bill_type in ('RENT_WATER','ELECTRIC')),
  period_label  text,
  rent          numeric(12,2) not null default 0,
  water         numeric(12,2) not null default 0,
  electric      numeric(12,2) not null default 0,
  addons_total  numeric(12,2) not null default 0,
  credits_total numeric(12,2) not null default 0,
  total_due     numeric(14,2) generated always as
                  ((rent + water + electric + addons_total) - credits_total) stored,
  total_paid    numeric(14,2) not null default 0,
  status        text not null default 'UNPAID'
                check (status in ('UNPAID','PARTIAL','PAID','WAIVED','REFUND')),
  due_date      date,
  created_at    timestamptz default now(),
  unique(tenant_id, cutoff_id, bill_type)
);
create index if not exists idx_invoices_tenant  on invoices(tenant_id);
create index if not exists idx_invoices_cutoff  on invoices(cutoff_id);
create index if not exists idx_invoices_status  on invoices(status);

-- Links a payment to one or more invoices (partial payment support)
create table if not exists payment_allocations (
  id         serial primary key,
  payment_id int references payments(id)  on delete cascade,
  invoice_id int references invoices(id)  on delete cascade,
  amount     numeric(12,2) not null default 0,
  created_at timestamptz default now()
);
create index if not exists idx_alloc_payment on payment_allocations(payment_id);
create index if not exists idx_alloc_invoice on payment_allocations(invoice_id);

-- Final move-out settlement (deposit/advance/refund resolution)
create table if not exists settlements (
  id                  serial primary key,
  tenant_id           int references tenants(id) on delete cascade,
  cutoff_id           int references cutoffs(id) on delete set null,
  rent_final          numeric(12,2) not null default 0,
  utilities_final     numeric(12,2) not null default 0,
  adjustments         numeric(12,2) not null default 0,
  applied_advance     numeric(12,2) not null default 0,
  applied_deposit     numeric(12,2) not null default 0,
  applied_overpayment numeric(12,2) not null default 0,
  net_amount          numeric(14,2) not null default 0,
  refund_status       text not null default 'NONE'
                      check (refund_status in ('NONE','PENDING','PAID')),
  refund_paid_date    date,
  refund_method       text,
  finalized           boolean not null default false,
  created_at          timestamptz default now()
);
create index if not exists idx_settlements_tenant on settlements(tenant_id);

-- Multiple phone numbers per tenant
create table if not exists tenant_contacts (
  id         bigint generated always as identity primary key,
  tenant_id  bigint not null references tenants(id) on delete cascade,
  value      text not null,
  label      text,
  is_primary boolean not null default false,
  created_at timestamptz not null default now()
);

-- Tenant uploaded documents (Google Drive)
create table if not exists tenant_documents (
  id            bigint generated always as identity primary key,
  tenant_id     bigint not null references tenants(id) on delete cascade,
  doc_type      text not null
                check (doc_type in ('GOVT_ID','SIGNED_CONTRACT','OTHER')),
  filename      text not null,
  drive_file_id text not null,
  drive_url     text not null,
  size_bytes    bigint,
  uploaded_at   timestamptz not null default now()
);

-- Multiple email addresses per tenant
create table if not exists tenant_emails (
  id         bigint generated always as identity primary key,
  tenant_id  bigint not null references tenants(id) on delete cascade,
  value      text not null,
  label      text,
  is_primary boolean not null default false,
  created_at timestamptz not null default now()
);

-- Advance (S.I#) / deposit (T.R#) receipts, 1 month each at move-in.
-- Backfill for existing tenants lives in database/migrations/advance_deposit.sql.
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

-- Reservation payments (money paid on a RESERVED bed before move-in, own T.R#) + split receipt lines.
-- Migration: database/migrations/reservation_payments.sql. Becomes a DEPOSIT row in tenant_deposits at Move In.
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

-- Final bill issued when a tenant moves out. lines = jsonb array of
-- {label, mid, amount, kind: 'charge'|'unsettled'|'credit'|'forfeit'}; credits are negative amounts;
-- net_amount > 0 tenant owes, < 0 refund due. Never deleted: void via status.
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
-- One non-void FINAL bill per tenant.
create unique index if not exists uq_final_bills_one_final on final_bills(tenant_id) where status = 'FINAL';

-- Every cutoff the bill covers (ids; see database/migrations/final_bill_covered_cutoffs.sql). Old bills keep '[]'.
alter table public.final_bills add column if not exists covered_cutoffs jsonb not null default '[]'::jsonb;
do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'final_bills_covered_cutoffs_array') then
    alter table public.final_bills add constraint final_bills_covered_cutoffs_array check (jsonb_typeof(covered_cutoffs) = 'array');
  end if;
end $$;
-- Void & re-issue (database/migrations/final_bill_reissue.sql): who voided a bill and the link between a voided bill and its replacement.
alter table public.final_bills add column if not exists voided_by uuid;
alter table public.final_bills add column if not exists replaces_bill_id int references public.final_bills(id);
alter table public.final_bills add column if not exists replaced_by_bill_id int references public.final_bills(id);
create unique index if not exists uq_final_bills_replaces on public.final_bills(replaces_bill_id) where replaces_bill_id is not null;

-- Second-to-last-bill advance credit, recorded automatically when its cutoff is closed (opening the next
-- one). Immutable; allocations = [{deposit_id, amount}] (receipts used, incl. whole-room sibling beds).
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
-- Advance-credit guards G1-G3 (database/migrations/advance_credit_guards.sql has the audit queries to run first).
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

-- Advance window (database/migrations/rent_carryovers.sql; name historical): the second-to-last advance window, frozen at
-- Open Cutoff. Immutable; carry_amount = the cutoff part credited on the statement, the final bill bills month_rent - carry_amount.
create table if not exists public.rent_carryovers (
  id            serial primary key,
  tenant_id     int not null references public.tenants(id),
  cutoff_id     int not null references public.cutoffs(id),
  move_out_date date not null,
  window_start  date not null,
  cutoff_days   int  not null check (cutoff_days > 0),
  carry_days    int  not null check (carry_days > 0),
  month_rent    numeric(10,2) not null check (month_rent > 0),
  carry_amount  numeric(10,2) not null check (carry_amount > 0 and carry_amount < month_rent),
  created_at    timestamptz default now(),
  unique (tenant_id, cutoff_id),
  check (carry_days < cutoff_days)
);
create index if not exists idx_rent_carryovers_tenant on public.rent_carryovers(tenant_id);

-- No window once the tenant has a FINAL bill (like G1), and the row must match its cutoff's rent/water window.
create or replace function public.rent_carryovers_guard() returns trigger
language plpgsql security definer set search_path = public as $$
declare v_start date; v_end date;
begin
  if exists (select 1 from public.final_bills where tenant_id = new.tenant_id and status = 'FINAL') then
    raise exception 'rent_carryovers: tenant % already has a final bill.', new.tenant_id;
  end if;
  select water_start, water_end into v_start, v_end from public.cutoffs where id = new.cutoff_id;
  if v_start is null or v_end is null then
    raise exception 'rent_carryovers: cutoff % has no rent/water window.', new.cutoff_id;
  end if;
  if new.cutoff_days <> (v_end - v_start) or new.window_start + new.carry_days <> v_end or new.move_out_date < v_end then
    raise exception 'rent_carryovers: the window (% + % days, % days, out %) does not match cutoff % (% - %).',
      new.window_start, new.carry_days, new.cutoff_days, new.move_out_date, new.cutoff_id, v_start, v_end;
  end if;
  return new;
end $$;
drop trigger if exists trg_rent_carryovers_guard on public.rent_carryovers;
create trigger trg_rent_carryovers_guard before insert on public.rent_carryovers
  for each row execute function public.rent_carryovers_guard();

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
-- G4 (database/migrations/final_bill_shape_guard.sql): a NEW FINAL bill must carry the shape the current app writes (a cutoff when
-- the move-out date has one, details.advance_check, details.vacated unless a re-issue). BEFORE INSERT only; bills 7 and 26 predate it.
create or replace function public.final_bills_shape_guard() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if new.status is distinct from 'FINAL' then return new; end if;
  if new.cutoff_id is null and (
       exists (select 1 from public.cutoffs c
                where c.water_start is not null and c.water_end is not null
                  and c.water_start <= new.move_out_date and new.move_out_date < c.water_end)
       or (not exists (select 1 from public.cutoffs c where c.water_start > new.move_out_date)
           and new.move_out_date >= (select c.water_end from public.cutoffs c where c.water_start is not null
                                      order by c.water_start desc, c.id desc limit 1))) then
    raise exception 'final bill: no cutoff is set on this bill. The app in this browser is out of date: reload the page and issue the bill again. Nothing was changed.';
  end if;
  if jsonb_typeof(new.details->'advance_check') is distinct from 'object' then
    raise exception 'final bill: the advance check is missing. The app in this browser is out of date: reload the page and issue the bill again. Nothing was changed.';
  end if;
  if new.replaces_bill_id is null and jsonb_typeof(new.details->'vacated') is distinct from 'object' then
    raise exception 'final bill: the vacated confirmation is missing. The app in this browser is out of date: reload the page and issue the bill again. Nothing was changed.';
  end if;
  return new;
end $$;
drop trigger if exists trg_final_bills_shape_guard on public.final_bills;
create trigger trg_final_bills_shape_guard before insert on public.final_bills
  for each row execute function public.final_bills_shape_guard();

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


-- History of a tenant's room/bed assignments over time
create table if not exists tenant_stays (
  id         serial primary key,
  tenant_id  int references tenants(id) on delete cascade,
  room_id    int references rooms(id),
  bed_id     int references beds(id),
  rate       numeric(12,2),
  start_date date not null,
  end_date   date,
  reason_end text check (reason_end in ('MOVE_OUT','TRANSFER')),
  created_at timestamptz default now()
);
create index if not exists idx_stays_tenant on tenant_stays(tenant_id);
create index if not exists idx_stays_open   on tenant_stays(tenant_id) where (end_date is null);

-- General-purpose ticketing (repairs, complaints, transfer requests, queries)
create table if not exists tickets (
  id               serial primary key,
  type             text not null default 'OTHER'
                   check (type in ('TRANSFER_REQUEST','COMPLAINT','REPAIR','QUERY','OTHER')),
  tenant_id        int references tenants(id) on delete set null,
  room_id          int references rooms(id)   on delete set null,
  bed_id           int references beds(id)    on delete set null,
  title            text not null,
  description      text,
  priority         text not null default 'MED'
                   check (priority in ('LOW','MED','HIGH')),
  status           text not null default 'OPEN'
                   check (status in ('OPEN','IN_PROGRESS','RESOLVED','CANCELLED')),
  assignee         text,
  cost             numeric(12,2),
  resolution_notes text,
  created_by       text,
  created_at       timestamptz default now(),
  resolved_at      timestamptz
);
create index if not exists idx_tickets_tenant on tickets(tenant_id);
create index if not exists idx_tickets_room   on tickets(room_id);
create index if not exists idx_tickets_status on tickets(status);

-- ════════════════════════════════════════════════════════════════
-- 6. VIEWS
-- ════════════════════════════════════════════════════════════════

create or replace view beds_with_tenant as
select
  b.id as bed_id, b.bed_letter, b.bed_location, b.default_rate, b.status,
  r.id as room_id, r.room_no, r.room_type, r.floor,
  t.id as tenant_id, t.tenant_no, t.name as tenant_name, t.gender, t.rate,
  t.duration, t.move_in_date, t.move_out_date,
  t.last_pay_10th, t.last_pay_eom, t.contact_no, t.email,
  t.location_of_work, t.work_schedule, t.govt_id1, t.govt_id2,
  t.contract, t.emergency_contact_name, t.emergency_contact_no, t.comments
from beds b
join  rooms   r on r.id = b.room_id
left join tenants t on t.bed_id = b.id and t.is_active = true;

create or replace view occupancy_summary as
select
  r.room_no, r.room_type,
  count(b.id)                                                  as total_beds,
  count(b.id) filter (where b.status = 'LEASED')              as leased,
  count(b.id) filter (where b.status = 'VACANT')              as vacant,
  count(b.id) filter (where b.status = 'RESERVED')            as reserved,
  coalesce(sum(t.rate) filter (where b.status = 'LEASED'), 0) as monthly_revenue
from rooms r
join  beds    b on b.room_id = r.id
left join tenants t on t.bed_id = b.id and t.is_active = true
group by r.id, r.room_no, r.room_type
order by r.room_no;

create or replace view v_latest_reading as
select distinct on (mr.room_id, mr.utility)
  mr.room_id, mr.utility, mr.current_reading, mr.cutoff_id,
  c.water_start as anchor
from meter_readings mr
join cutoffs c on c.id = mr.cutoff_id
order by mr.room_id, mr.utility, c.water_start desc, mr.cutoff_id desc;

create or replace view v_utility_bill as
select
  c.id   as cutoff_id,
  c.name as cutoff_name,
  r.id   as room_id,
  r.room_no,
  r.room_type,
  w.previous_reading as water_prev,
  w.current_reading  as water_curr,
  w.consumption      as water_consumption,
  w.rate             as water_rate,
  w.amount           as water_amount,
  e.previous_reading as elec_prev,
  e.current_reading  as elec_curr,
  e.consumption      as elec_consumption,
  e.rate             as elec_rate,
  e.amount           as elec_amount,
  coalesce(w.amount,0) + coalesce(e.amount,0) as total_amount
from cutoffs c
cross join rooms r
left join meter_readings w on w.cutoff_id = c.id and w.room_id = r.id and w.utility = 'WATER'
left join meter_readings e on e.cutoff_id = c.id and e.room_id = r.id and e.utility = 'ELECTRIC'
order by c.id, (r.room_no)::int;

create or replace view v_cutoff_summary as
select
  c.id   as cutoff_id,
  c.name as cutoff_name,
  mr.utility,
  count(*)            as rooms_billed,
  sum(mr.consumption) as total_consumption,
  sum(mr.amount)      as total_amount
from cutoffs c
join meter_readings mr on mr.cutoff_id = c.id
group by c.id, c.name, mr.utility;

-- Views inherit RLS from the querying user (not definer).
alter view beds_with_tenant  set (security_invoker = on);
alter view occupancy_summary set (security_invoker = on);
alter view v_latest_reading  set (security_invoker = on);
alter view v_utility_bill    set (security_invoker = on);
alter view v_cutoff_summary  set (security_invoker = on);

-- ════════════════════════════════════════════════════════════════
-- 7. FUNCTIONS
-- ════════════════════════════════════════════════════════════════

-- open_cutoff(): open a new billing period and carry forward the
-- latest room readings as the new period's starting values.
create or replace function open_cutoff(
  p_name                   text,
  p_water_start            date,
  p_water_end              date,
  p_electric_start         date,
  p_electric_end           date,
  p_water_maynilad_rate    numeric,
  p_water_bedspace_rate    numeric,
  p_electric_meralco_rate  numeric,
  p_electric_bedspace_rate numeric
) returns int as $$
declare v_cutoff_id int;
begin
  insert into cutoffs (
    name, water_start, water_end, electric_start, electric_end,
    water_maynilad_rate, water_bedspace_rate,
    electric_meralco_rate, electric_bedspace_rate, is_active
  ) values (
    p_name, p_water_start, p_water_end, p_electric_start, p_electric_end,
    p_water_maynilad_rate, p_water_bedspace_rate,
    p_electric_meralco_rate, p_electric_bedspace_rate, true
  ) returning id into v_cutoff_id;

  update cutoffs set is_active = false where id <> v_cutoff_id;

  insert into meter_readings (cutoff_id, room_id, utility, previous_reading, current_reading, rate)
  select v_cutoff_id, r.id, 'WATER',
         coalesce(lr.current_reading, 0), coalesce(lr.current_reading, 0),
         p_water_bedspace_rate
  from rooms r
  left join v_latest_reading lr on lr.room_id = r.id and lr.utility = 'WATER'
  on conflict (cutoff_id, room_id, utility) do nothing;

  insert into meter_readings (cutoff_id, room_id, utility, previous_reading, current_reading, rate)
  select v_cutoff_id, r.id, 'ELECTRIC',
         coalesce(lr.current_reading, 0), coalesce(lr.current_reading, 0),
         p_electric_bedspace_rate
  from rooms r
  left join v_latest_reading lr on lr.room_id = r.id and lr.utility = 'ELECTRIC'
  on conflict (cutoff_id, room_id, utility) do nothing;

  return v_cutoff_id;
end;
$$ language plpgsql;

-- reconfigure_room(): structural room reconfiguration — add/remove beds and
-- adjust rates/room type as one operation. SECURITY INVOKER (default): nested
-- beds/rooms writes run under the calling user's session, so they're still
-- independently enforced by beds_insert/rooms_update RLS (admin-only) and
-- trg_guard_beds (blocks non-admin from touching default_rate or REMOVED).
create or replace function reconfigure_room(
  p_room_id        int,
  p_room_type      text,
  p_add_beds       jsonb,
  p_remove_bed_ids int[],
  p_rate_updates   jsonb
) returns void
language plpgsql
as $$
declare
  v_bed             record;
  v_spec            jsonb;
  v_existing_id     int;
  v_existing_status text;
  v_letter          text;
  v_rate            numeric;
begin
  if not exists (select 1 from rooms where id = p_room_id) then
    raise exception 'Room % not found.', p_room_id;
  end if;

  -- 1. Removals — hard-block LEASED beds (this is what satisfies the
  --    "no orphaned active tenant" non-negotiable; a LEASED bed can
  --    never structurally appear in a successful removal).
  if p_remove_bed_ids is not null then
    for v_bed in
      select id, status, bed_letter from beds
      where id = any(p_remove_bed_ids) and room_id = p_room_id
    loop
      if v_bed.status = 'LEASED' then
        raise exception 'Cannot remove Bed % — it is currently LEASED. Move out or transfer the tenant first.', v_bed.bed_letter;
      end if;
    end loop;
    update beds set status = 'REMOVED'
      where id = any(p_remove_bed_ids) and room_id = p_room_id and status <> 'LEASED';
  end if;

  -- 2. Rate updates on beds being kept
  if p_rate_updates is not null then
    for v_spec in select * from jsonb_array_elements(p_rate_updates) loop
      v_rate := (v_spec->>'default_rate')::numeric;
      if v_rate is null or v_rate < 0 then
        raise exception 'Invalid rate for bed %.', v_spec->>'bed_id';
      end if;
      update beds set default_rate = v_rate
        where id = (v_spec->>'bed_id')::int and room_id = p_room_id and status <> 'REMOVED';
    end loop;
  end if;

  -- 3. Additions — reuse a same-letter REMOVED row if one exists
  --    (unique(room_id, bed_letter) doesn't exclude REMOVED rows, so a
  --    brand-new insert with a reused letter would fail); otherwise
  --    insert fresh, VACANT, no reserved_name.
  if p_add_beds is not null then
    for v_spec in select * from jsonb_array_elements(p_add_beds) loop
      v_letter := upper(trim(v_spec->>'bed_letter'));
      v_rate   := (v_spec->>'default_rate')::numeric;
      if v_letter is null or v_letter = '' then
        raise exception 'Bed letter is required for every added bed.';
      end if;
      if v_rate is null or v_rate < 0 then
        raise exception 'Invalid rate for new Bed %.', v_letter;
      end if;

      select id, status into v_existing_id, v_existing_status
        from beds where room_id = p_room_id and bed_letter = v_letter;

      if v_existing_id is not null and v_existing_status <> 'REMOVED' then
        raise exception 'Bed letter "%" is already active in this room. Choose a different letter.', v_letter;
      elsif v_existing_id is not null then
        update beds set status = 'VACANT', reserved_name = null,
               bed_location = coalesce(v_spec->>'bed_location', bed_location),
               default_rate = v_rate
          where id = v_existing_id;
      else
        insert into beds (room_id, bed_letter, bed_location, default_rate, status)
        values (p_room_id, v_letter, v_spec->>'bed_location', v_rate, 'VACANT');
      end if;
    end loop;
  end if;

  -- 4. Room type label (advisory only — confirmed via grep that no code
  --    anywhere derives expected bed count from this string; it's pure
  --    display text on BedMap/MoveInModal/TransferModal/Billing/etc.)
  update rooms set room_type = p_room_type where id = p_room_id;
end;
$$;

-- create_room(): admin-only, creates one room with its initial beds atomically.
-- SECURITY INVOKER (default) — mirrors reconfigure_room's pattern: relies on
-- rooms_insert / beds_insert RLS (both already admin-only) rather than a
-- redundant SECURITY DEFINER + is_admin() check. The only client entry point
-- (Property.jsx) is already isAdmin-gated; a non-admin calling the RPC
-- directly gets RLS's standard "new row violates row-level security policy".
create or replace function create_room(
  p_room_no   text,
  p_room_type text,
  p_floor     int,
  p_beds      jsonb   -- [{bed_letter, bed_location?, default_rate}, ...]
) returns int
language plpgsql
as $$
declare
  v_room_id     int;
  v_spec        jsonb;
  v_letter      text;
  v_rate        numeric;
  v_seen        text[] := '{}';
  v_bed_count   int;
begin
  if p_room_no is null or trim(p_room_no) = '' then
    raise exception 'Room number is required.';
  end if;
  if exists (select 1 from rooms where room_no = trim(p_room_no)) then
    raise exception 'Room "%" already exists.', trim(p_room_no);
  end if;

  v_bed_count := coalesce(jsonb_array_length(p_beds), 0);
  if v_bed_count = 0 then
    raise exception 'A new room must have at least one bed.';
  end if;

  for v_spec in select * from jsonb_array_elements(p_beds) loop
    v_letter := upper(trim(v_spec->>'bed_letter'));
    v_rate   := (v_spec->>'default_rate')::numeric;
    if v_letter is null or v_letter = '' then
      raise exception 'Bed letter is required for every bed.';
    end if;
    if v_rate is null or v_rate < 0 then
      raise exception 'Invalid rate for Bed %.', v_letter;
    end if;
    if v_letter = any(v_seen) then
      raise exception 'Duplicate bed letter "%" in the new room.', v_letter;
    end if;
    v_seen := array_append(v_seen, v_letter);
  end loop;

  insert into rooms (room_no, room_type, floor, room_status, original_bed_count)
  values (trim(p_room_no), nullif(trim(p_room_type), ''), p_floor, 'ACTIVE', v_bed_count)
  returning id into v_room_id;

  insert into beds (room_id, bed_letter, bed_location, default_rate, status)
  select v_room_id, upper(trim(b->>'bed_letter')), nullif(b->>'bed_location', ''),
         (b->>'default_rate')::numeric, 'VACANT'
  from jsonb_array_elements(p_beds) b;

  return v_room_id;
end;
$$;

revoke execute on function create_room(text, text, int, jsonb) from public, anon;
grant execute on function create_room(text, text, int, jsonb) to authenticated;

-- retire_room(): admin-only, marks every non-REMOVED bed in a room REMOVED
-- and the room CONVERTED (or p_new_status), atomically. SECURITY INVOKER —
-- same rationale as create_room. Hard-blocks any LEASED bed (mirrors
-- reconfigure_room's identical removal guard) — a room can never be retired
-- out from under an active tenant.
create or replace function retire_room(
  p_room_id    int,
  p_new_status text default 'CONVERTED'
) returns void
language plpgsql
as $$
declare
  v_bed record;
begin
  if not exists (select 1 from rooms where id = p_room_id) then
    raise exception 'Room % not found.', p_room_id;
  end if;
  if p_new_status not in ('ACTIVE','CONVERTED','MAINTENANCE','RESERVED') then
    raise exception 'Invalid room status "%".', p_new_status;
  end if;

  for v_bed in
    select id, status, bed_letter from beds
    where room_id = p_room_id and status <> 'REMOVED'
  loop
    if v_bed.status = 'LEASED' then
      raise exception 'Cannot retire room — Bed % is currently LEASED. Move out or transfer the tenant first.', v_bed.bed_letter;
    end if;
  end loop;

  update beds set status = 'REMOVED'
    where room_id = p_room_id and status <> 'REMOVED';

  update rooms set room_status = p_new_status where id = p_room_id;
end;
$$;

revoke execute on function retire_room(int, text) from public, anon;
grant execute on function retire_room(int, text) to authenticated;

-- ── Reservation payments: triggers + atomic Move In receipts ──────────────
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

-- 11. Correct the S.I#/T.R# of a settled receipt after move-out (admin; updates the final bill text in the same transaction).
-- Migration: database/migrations/final_bill_receipt_refs.sql. Requirements section 5 "Receipt numbers on the final bill".
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

-- 12. Void & re-issue a final bill in one transaction (admin). Migration: database/migrations/final_bill_reissue.sql.
-- Requirements section 5 "Void & re-issue". Columns voided_by / replaces_bill_id / replaced_by_bill_id are next to final_bills above.
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

-- 13. S.I# / T.R# of a Collections payment: staff fill an empty number, admin changes/clears; the trigger refuses any
-- other column change on payments (no UPDATE policy exists). Migration: database/migrations/payments_receipt_refs.sql.
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

-- 14. Correct a Collections payment amount: void + re-record in one transaction (never an UPDATE), admin/user, reason
-- required, compare-and-set on the amount shown. Migration: database/migrations/payments_correct_amount.sql.
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

-- ════════════════════════════════════════════════════════════════
-- 8. ROW LEVEL SECURITY
-- ════════════════════════════════════════════════════════════════

-- Drop stale policies left by incremental migration scripts so that
-- new targeted policies (e.g. admin-only tenants update/delete) work correctly.
do $$
declare tbl text;
begin
  foreach tbl in array array['activity_log','beds','payments','rooms','tenants','tenant_transfers'] loop
    execute format('drop policy if exists authenticated_full_access on public.%I', tbl);
  end loop;
end $$;
drop policy if exists app_authenticated_all  on public.tenants;
drop policy if exists room_logs_insert       on public.room_logs;
drop policy if exists room_logs_select       on public.room_logs;
-- tenant_contacts / tenant_documents / tenant_emails used 'auth_all' in prior migration
drop policy if exists auth_all on public.tenant_contacts;
drop policy if exists auth_all on public.tenant_documents;
drop policy if exists auth_all on public.tenant_emails;

-- profiles: self, or admin can read/manage all (Users page).
--
-- A policy on `profiles` cannot query `profiles` again directly to check the
-- caller's role — Postgres re-applies the same policy to that inner query,
-- which recurses (42P17 infinite recursion; empirically confirmed live: it
-- broke ALL reads of `profiles`, including self-reads used by login/role
-- resolution, for every role). is_admin() sidesteps this: SECURITY DEFINER
-- makes it run as the function owner (the table owner, which bypasses RLS
-- on this table), so its internal SELECT never re-triggers profiles_select.
create or replace function public.is_admin(uid uuid default auth.uid())
returns boolean
language sql
security definer
set search_path = public
stable
as $$
  select exists (select 1 from public.profiles where id = uid and role = 'admin');
$$;

-- Functions grant EXECUTE to PUBLIC by default — without this, anyone,
-- including an unauthenticated `anon` request, could call
-- /rest/v1/rpc/is_admin?uid=<guessed-uuid> directly to probe whether a given
-- account is an admin. It only returns a boolean and UUIDs aren't
-- guessable, but there's no reason to expose it outside the RLS policies
-- above (which evaluate it internally as `authenticated`, not via RPC).
revoke execute on function public.is_admin(uuid) from public;
grant execute on function public.is_admin(uuid) to authenticated;
-- This project's `ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA
-- public` auto-grants EXECUTE on every new function to anon/authenticated/
-- service_role independently of the PUBLIC grant above, so anon retained
-- its own explicit grant even after the revoke from public — confirmed live
-- by database-admin. This narrow, explicit revoke closes that for just this
-- one function; it does not touch the project-wide default-privilege rule
-- itself (a separate, broader decision) or service_role (server-side use).
revoke execute on function public.is_admin(uuid) from anon;

-- Visitor Log (section 8c): the guard role is locked out of every existing table by
-- `not (select public.is_guard())` on the any-signed-in-user policies below. Same SECURITY DEFINER
-- pattern as is_admin() (a policy must not query profiles under its own RLS).
create or replace function public.is_guard() returns boolean
language sql security definer set search_path = public stable as $$
  select exists (select 1 from public.profiles where id = auth.uid() and role = 'guard');
$$;
create or replace function public.app_role() returns text
language sql security definer set search_path = public stable as $$
  select role from public.profiles where id = auth.uid();
$$;
revoke execute on function public.is_guard() from public, anon;  grant execute on function public.is_guard() to authenticated;
revoke execute on function public.app_role() from public, anon;  grant execute on function public.app_role() to authenticated;

alter table public.profiles enable row level security;
drop policy if exists profiles_self_select on public.profiles;
drop policy if exists profiles_select on public.profiles;
create policy profiles_select on public.profiles
  for select to authenticated
  using (id = auth.uid() or public.is_admin());

drop policy if exists profiles_update on public.profiles;
create policy profiles_update on public.profiles
  for update to authenticated
  using (public.is_admin())
  with check (public.is_admin());

-- Remove the blanket policy from all 23 tables it was applied to.
-- MUST run before creating the replacement policies below — RLS policies
-- are OR'd together, so leaving app_authenticated_all in place would make
-- every new restrictive policy a no-op.
do $$
declare t text;
begin
  foreach t in array array[
    'rooms','beds','payments','activity_log',
    'cutoffs','meter_readings','interim_readings','area_readings',
    'tenant_splits','addons','monthly_reports',
    'tenant_transfers','room_logs',
    'documents','invoices','payment_allocations','settlements',
    'tenant_contacts','tenant_documents','tenant_emails',
    'tenant_stays','tickets','addon_types'
  ] loop
    execute format('drop policy if exists app_authenticated_all on public.%I', t);
  end loop;
end $$;

-- ── rooms ─────────────────────────────────────────────────────────────────
alter table public.rooms enable row level security;
drop policy if exists rooms_select on public.rooms;
create policy rooms_select on public.rooms for select to authenticated using (not (select public.is_guard()));
drop policy if exists rooms_insert on public.rooms;
create policy rooms_insert on public.rooms for insert to authenticated
  with check (exists (select 1 from public.profiles where id = auth.uid() and role = 'admin'));
drop policy if exists rooms_update on public.rooms;
create policy rooms_update on public.rooms for update to authenticated
  using (exists (select 1 from public.profiles where id = auth.uid() and role = 'admin'));
drop policy if exists rooms_delete on public.rooms;
create policy rooms_delete on public.rooms for delete to authenticated
  using (exists (select 1 from public.profiles where id = auth.uid() and role = 'admin'));

-- ── beds ──────────────────────────────────────────────────────────────────
-- UPDATE granted to admin+user at row level for non-approval-gated status
-- flips (move-in, VACANT/RESERVED/OUT OF ORDER). Bed rate and REMOVED
-- transitions are approval-gated per requirements §7 — RLS can't express
-- "this column but not that one" for the same row, so a trigger enforces
-- the column-level split.
alter table public.beds enable row level security;
drop policy if exists beds_select on public.beds;
create policy beds_select on public.beds for select to authenticated using (not (select public.is_guard()));
drop policy if exists beds_insert on public.beds;
create policy beds_insert on public.beds for insert to authenticated
  with check (exists (select 1 from public.profiles where id = auth.uid() and role = 'admin'));
drop policy if exists beds_update on public.beds;
create policy beds_update on public.beds for update to authenticated
  using (exists (select 1 from public.profiles where id = auth.uid() and role in ('admin','user')));
drop policy if exists beds_delete on public.beds;
create policy beds_delete on public.beds for delete to authenticated
  using (exists (select 1 from public.profiles where id = auth.uid() and role = 'admin'));

create or replace function public.guard_beds_protected_fields()
returns trigger language plpgsql as $$
declare v_role text;
begin
  select role into v_role from public.profiles where id = auth.uid();
  if v_role = 'admin' then
    return new;
  end if;
  -- staff may change status, reserved_name and the reservation target date (rate etc. stay admin-only)
  if (to_jsonb(new) - 'status' - 'reserved_name' - 'reserved_move_in_date')
     is distinct from (to_jsonb(old) - 'status' - 'reserved_name' - 'reserved_move_in_date') then
    raise exception 'Only admin can change bed rate or other protected fields directly. Submit via the approval workflow.';
  end if;
  if new.status = 'REMOVED' or old.status = 'REMOVED' then
    raise exception 'Bed removal/restoration requires admin approval.';
  end if;
  return new;
end $$;

drop trigger if exists trg_guard_beds on public.beds;
create trigger trg_guard_beds
  before update on public.beds
  for each row execute function public.guard_beds_protected_fields();

-- The target move-in date only lives while the bed is RESERVED (cleared on move-in, transfer, retire, reconfigure,
-- Remove Reservation). Entering RESERVED without a date, or clearing it on a RESERVED bed, fails; legacy RESERVED
-- rows with a null date stay updatable. INSERT is not enforced (the seed below inserts RESERVED rows).
-- reservation_target_date.sql + reservation_target_date_enforce.sql
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
drop trigger if exists trg_beds_reservation_date on public.beds;
create trigger trg_beds_reservation_date before insert or update on public.beds
  for each row execute function public.beds_reservation_date();

-- ── payments ──────────────────────────────────────────────────────────────
-- Non-negotiable: never delete/alter billing records. No UPDATE/DELETE
-- policy for ANY role, including admin — intentional.
alter table public.payments enable row level security;
drop policy if exists payments_select on public.payments;
create policy payments_select on public.payments for select to authenticated
  using (exists (select 1 from public.profiles where id = auth.uid() and role in ('admin','user')));
drop policy if exists payments_insert on public.payments;
create policy payments_insert on public.payments for insert to authenticated
  with check (exists (select 1 from public.profiles where id = auth.uid() and role in ('admin','user')));

-- ── activity_log ──────────────────────────────────────────────────────────
alter table public.activity_log enable row level security;
drop policy if exists activity_log_select on public.activity_log;
create policy activity_log_select on public.activity_log for select to authenticated
  using (not (select public.is_guard()) and (entity_type is distinct from 'VISITOR_LOG' or exists (select 1 from public.profiles where id = auth.uid() and role in ('admin','user'))));
drop policy if exists activity_log_insert on public.activity_log;
create policy activity_log_insert on public.activity_log for insert to authenticated
  with check (exists (select 1 from public.profiles where id = auth.uid() and role in ('admin','user')));

-- ── cutoffs ───────────────────────────────────────────────────────────────
alter table public.cutoffs enable row level security;
drop policy if exists cutoffs_select on public.cutoffs;
create policy cutoffs_select on public.cutoffs for select to authenticated using (not (select public.is_guard()));
drop policy if exists cutoffs_insert on public.cutoffs;
create policy cutoffs_insert on public.cutoffs for insert to authenticated
  with check (exists (select 1 from public.profiles where id = auth.uid() and role in ('admin','user')));
drop policy if exists cutoffs_update on public.cutoffs;
create policy cutoffs_update on public.cutoffs for update to authenticated
  using (exists (select 1 from public.profiles where id = auth.uid() and role in ('admin','user')));
drop policy if exists cutoffs_delete on public.cutoffs;
create policy cutoffs_delete on public.cutoffs for delete to authenticated
  using (exists (select 1 from public.profiles where id = auth.uid() and role in ('admin','user')));

-- ── meter_readings / interim_readings / area_readings / tenant_splits ──────
-- DELETE granted to admin+user on all four (not just ones with a direct UI
-- delete button) because each has cutoff_id ... on delete cascade, and
-- Postgres RLS applies to cascade-deleted rows using the invoking role's
-- policies — needed to keep deleteCutoff() (unrestricted for user) working.
alter table public.meter_readings enable row level security;
drop policy if exists meter_readings_select on public.meter_readings;
create policy meter_readings_select on public.meter_readings for select to authenticated using (not (select public.is_guard()));
drop policy if exists meter_readings_insert on public.meter_readings;
create policy meter_readings_insert on public.meter_readings for insert to authenticated
  with check (exists (select 1 from public.profiles where id = auth.uid() and role in ('admin','user')));
drop policy if exists meter_readings_update on public.meter_readings;
create policy meter_readings_update on public.meter_readings for update to authenticated
  using (exists (select 1 from public.profiles where id = auth.uid() and role in ('admin','user')));
drop policy if exists meter_readings_delete on public.meter_readings;
create policy meter_readings_delete on public.meter_readings for delete to authenticated
  using (exists (select 1 from public.profiles where id = auth.uid() and role in ('admin','user')));

alter table public.interim_readings enable row level security;
drop policy if exists interim_readings_select on public.interim_readings;
create policy interim_readings_select on public.interim_readings for select to authenticated
  using (exists (select 1 from public.profiles where id = auth.uid() and role in ('admin','user')));
drop policy if exists interim_readings_insert on public.interim_readings;
create policy interim_readings_insert on public.interim_readings for insert to authenticated
  with check (exists (select 1 from public.profiles where id = auth.uid() and role in ('admin','user')));
drop policy if exists interim_readings_delete on public.interim_readings;
create policy interim_readings_delete on public.interim_readings for delete to authenticated
  using (exists (select 1 from public.profiles where id = auth.uid() and role in ('admin','user')));

-- DB-layer guard — non-admin cannot directly DELETE a single interim_readings
-- row; deleteCutoff()'s cascade (user-permitted) still works via
-- pg_trigger_depth(). Mirrors guard_tenants_protected_fields()'s admin-bypass
-- pattern. The interim_readings_delete RLS policy itself stays admin+user
-- (unchanged) — tightening it directly would break deleteCutoff()'s cascade
-- delete for the user role.
-- pg_trigger_depth() is already 1 while THIS trigger's own body is running
-- for a plain top-level DELETE — "inside a trigger" starts counting from
-- this trigger itself, not from 0 (empirically confirmed live: `> 0` never
-- blocked anything). A cascade via deleteCutoff() (DELETE FROM cutoffs -->
-- FK ON DELETE CASCADE --> this trigger) runs one level deeper, inside the
-- cascade's own internal RI trigger PLUS this one, so depth is 2 there.
-- `> 1` is therefore the correct cutoff: allow only the cascade case.
create or replace function public.guard_interim_readings_delete()
returns trigger language plpgsql
set search_path = public
as $$
declare v_role text;
begin
  if pg_trigger_depth() > 1 then
    return old;
  end if;
  select role into v_role from public.profiles where id = auth.uid();
  if v_role is distinct from 'admin' then
    raise exception 'Only admin can delete an interim reading directly. Submit the deletion for approval.';
  end if;
  return old;
end $$;

drop trigger if exists trg_guard_interim_readings_delete on public.interim_readings;
create trigger trg_guard_interim_readings_delete
  before delete on public.interim_readings
  for each row execute function public.guard_interim_readings_delete();

alter table public.area_readings enable row level security;
drop policy if exists area_readings_select on public.area_readings;
create policy area_readings_select on public.area_readings for select to authenticated
  using (exists (select 1 from public.profiles where id = auth.uid() and role in ('admin','user')));
drop policy if exists area_readings_insert on public.area_readings;
create policy area_readings_insert on public.area_readings for insert to authenticated
  with check (exists (select 1 from public.profiles where id = auth.uid() and role in ('admin','user')));
drop policy if exists area_readings_update on public.area_readings;
create policy area_readings_update on public.area_readings for update to authenticated
  using (exists (select 1 from public.profiles where id = auth.uid() and role in ('admin','user')));
drop policy if exists area_readings_delete on public.area_readings;
create policy area_readings_delete on public.area_readings for delete to authenticated
  using (exists (select 1 from public.profiles where id = auth.uid() and role in ('admin','user')));

alter table public.tenant_splits enable row level security;
drop policy if exists tenant_splits_select on public.tenant_splits;
create policy tenant_splits_select on public.tenant_splits for select to authenticated
  using (exists (select 1 from public.profiles where id = auth.uid() and role in ('admin','user')));
drop policy if exists tenant_splits_insert on public.tenant_splits;
create policy tenant_splits_insert on public.tenant_splits for insert to authenticated
  with check (exists (select 1 from public.profiles where id = auth.uid() and role in ('admin','user')));
drop policy if exists tenant_splits_delete on public.tenant_splits;
create policy tenant_splits_delete on public.tenant_splits for delete to authenticated
  using (exists (select 1 from public.profiles where id = auth.uid() and role in ('admin','user')));

-- ── addons ────────────────────────────────────────────────────────────────
alter table public.addons enable row level security;
drop policy if exists addons_select on public.addons;
create policy addons_select on public.addons for select to authenticated
  using (exists (select 1 from public.profiles where id = auth.uid() and role in ('admin','user')));
drop policy if exists addons_insert on public.addons;
create policy addons_insert on public.addons for insert to authenticated
  with check (exists (select 1 from public.profiles where id = auth.uid() and role in ('admin','user')));
drop policy if exists addons_update on public.addons;
create policy addons_update on public.addons for update to authenticated
  using (exists (select 1 from public.profiles where id = auth.uid() and role in ('admin','user')));
drop policy if exists addons_delete on public.addons;
create policy addons_delete on public.addons for delete to authenticated
  using (exists (select 1 from public.profiles where id = auth.uid() and role in ('admin','user')));

-- ── monthly_reports ───────────────────────────────────────────────────────
alter table public.monthly_reports enable row level security;
drop policy if exists monthly_reports_select on public.monthly_reports;
create policy monthly_reports_select on public.monthly_reports for select to authenticated using (not (select public.is_guard()));
drop policy if exists monthly_reports_insert on public.monthly_reports;
create policy monthly_reports_insert on public.monthly_reports for insert to authenticated
  with check (exists (select 1 from public.profiles where id = auth.uid() and role in ('admin','user')));
drop policy if exists monthly_reports_update on public.monthly_reports;
create policy monthly_reports_update on public.monthly_reports for update to authenticated
  using (exists (select 1 from public.profiles where id = auth.uid() and role in ('admin','user')));
drop policy if exists monthly_reports_delete on public.monthly_reports;
create policy monthly_reports_delete on public.monthly_reports for delete to authenticated
  using (exists (select 1 from public.profiles where id = auth.uid() and role in ('admin','user')));

-- ── tenant_transfers ──────────────────────────────────────────────────────
-- INSERT admin-only (processTransfer() only ever called from admin-gated
-- UI paths). No UPDATE/DELETE anywhere in the app.
alter table public.tenant_transfers enable row level security;
drop policy if exists tenant_transfers_select on public.tenant_transfers;
create policy tenant_transfers_select on public.tenant_transfers for select to authenticated
  using (exists (select 1 from public.profiles where id = auth.uid() and role in ('admin','user')));
drop policy if exists tenant_transfers_insert on public.tenant_transfers;
create policy tenant_transfers_insert on public.tenant_transfers for insert to authenticated
  with check (exists (select 1 from public.profiles where id = auth.uid() and role = 'admin'));

-- ── room_logs ─────────────────────────────────────────────────────────────
alter table public.room_logs enable row level security;
drop policy if exists room_logs_select on public.room_logs;
create policy room_logs_select on public.room_logs for select to authenticated
  using (exists (select 1 from public.profiles where id = auth.uid() and role in ('admin','user')));
drop policy if exists room_logs_insert on public.room_logs;
create policy room_logs_insert on public.room_logs for insert to authenticated
  with check (exists (select 1 from public.profiles where id = auth.uid() and role in ('admin','user')));

-- ── tenant_documents ──────────────────────────────────────────────────────
do $$
declare t text;
begin
  foreach t in array array['tenant_documents'] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('drop policy if exists %I_select on public.%I', t, t);
    execute format(
      'create policy %I_select on public.%I for select to authenticated '
      'using (exists (select 1 from public.profiles where id = auth.uid() and role in (''admin'',''user'')))', t, t);
    execute format('drop policy if exists %I_insert on public.%I', t, t);
    execute format(
      'create policy %I_insert on public.%I for insert to authenticated '
      'with check (exists (select 1 from public.profiles where id = auth.uid() and role in (''admin'',''user'')))', t, t);
    execute format('drop policy if exists %I_update on public.%I', t, t);
    execute format(
      'create policy %I_update on public.%I for update to authenticated '
      'using (exists (select 1 from public.profiles where id = auth.uid() and role in (''admin'',''user'')))', t, t);
    execute format('drop policy if exists %I_delete on public.%I', t, t);
    execute format(
      'create policy %I_delete on public.%I for delete to authenticated '
      'using (exists (select 1 from public.profiles where id = auth.uid() and role in (''admin'',''user'')))', t, t);
  end loop;
end $$;

-- ── tenant_contacts / tenant_emails ──────────────────────────────────────
-- select/insert = admin+user (move-in by a user inserts the new tenant's
-- contacts/emails). update/delete = admin only: non-admin edits to existing
-- entries go through the Edit Tenant Profile approval request and are applied
-- by an admin session.
do $$
declare t text;
begin
  foreach t in array array['tenant_contacts','tenant_emails'] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('drop policy if exists %I_select on public.%I', t, t);
    execute format(
      'create policy %I_select on public.%I for select to authenticated '
      'using (exists (select 1 from public.profiles where id = auth.uid() and role in (''admin'',''user'')))', t, t);
    execute format('drop policy if exists %I_insert on public.%I', t, t);
    execute format(
      'create policy %I_insert on public.%I for insert to authenticated '
      'with check (exists (select 1 from public.profiles where id = auth.uid() and role in (''admin'',''user'')))', t, t);
    execute format('drop policy if exists %I_update on public.%I', t, t);
    execute format(
      'create policy %I_update on public.%I for update to authenticated '
      'using (exists (select 1 from public.profiles where id = auth.uid() and role = ''admin''))', t, t);
    execute format('drop policy if exists %I_delete on public.%I', t, t);
    execute format(
      'create policy %I_delete on public.%I for delete to authenticated '
      'using (exists (select 1 from public.profiles where id = auth.uid() and role = ''admin''))', t, t);
  end loop;
end $$;

-- ── tenant_deposits ───────────────────────────────────────────────────────
-- select/insert = admin+user (viewers cannot see or forge receipts; move-in by a user inserts
-- the receipt lines); update = admin only; nobody deletes. Status moves
-- HELD -> APPLIED/FORFEITED/REFUNDED. A client can never set reservation_payment_id: only the
-- SECURITY DEFINER functions apply_reservation_payments / record_move_in_receipts do.
alter table public.tenant_deposits enable row level security;
drop policy if exists tenant_deposits_select on public.tenant_deposits;
create policy tenant_deposits_select on public.tenant_deposits
  for select to authenticated
  using (exists (select 1 from public.profiles where id = auth.uid() and role in ('admin','user')));
drop policy if exists tenant_deposits_insert on public.tenant_deposits;
create policy tenant_deposits_insert on public.tenant_deposits for insert to authenticated
  with check (
    reservation_payment_id is null and (
      exists (select 1 from public.profiles where id = auth.uid() and role = 'admin')
      or (status = 'HELD' and exists (select 1 from public.profiles where id = auth.uid() and role = 'user')))
  );
drop policy if exists tenant_deposits_update on public.tenant_deposits;
create policy tenant_deposits_update on public.tenant_deposits
  for update to authenticated
  using (exists (select 1 from public.profiles where id = auth.uid() and role = 'admin'));
-- No DELETE policy on purpose: receipts are never deleted (void/settle via status for the audit trail).
drop policy if exists tenant_deposits_delete on public.tenant_deposits;

-- ── bed_reservation_payments ──────────────────────────────────────────────
-- select/insert (HELD only) = admin+user; update (edit HELD / void with reason) = admin only; nobody deletes.
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


-- ── final_bills ───────────────────────────────────────────────────────────
-- select = admin+user; insert/update = admin only (void / refund tracking); nobody deletes.
alter table public.final_bills enable row level security;
drop policy if exists final_bills_select on public.final_bills;
create policy final_bills_select on public.final_bills
  for select to authenticated
  using (exists (select 1 from public.profiles where id = auth.uid() and role in ('admin','user')));
drop policy if exists final_bills_insert on public.final_bills;
create policy final_bills_insert on public.final_bills
  for insert to authenticated
  with check (exists (select 1 from public.profiles where id = auth.uid() and role = 'admin'));
drop policy if exists final_bills_update on public.final_bills;
create policy final_bills_update on public.final_bills
  for update to authenticated
  using (exists (select 1 from public.profiles where id = auth.uid() and role = 'admin'));
-- No DELETE policy on purpose: bills are never deleted (void via status for the audit trail).
drop policy if exists final_bills_delete on public.final_bills;

-- ── advance_credits ───────────────────────────────────────────────────────
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

-- ── rent_carryovers ───────────────────────────────────────────────────────
alter table public.rent_carryovers enable row level security;
drop policy if exists rent_carryovers_select on public.rent_carryovers;
create policy rent_carryovers_select on public.rent_carryovers
  for select to authenticated
  using (exists (select 1 from public.profiles where id = auth.uid() and role in ('admin','user')));
drop policy if exists rent_carryovers_insert on public.rent_carryovers;
create policy rent_carryovers_insert on public.rent_carryovers
  for insert to authenticated
  with check (exists (select 1 from public.profiles where id = auth.uid() and role = 'admin'));
-- No UPDATE / DELETE policies on purpose: a recorded window is immutable.
drop policy if exists rent_carryovers_update on public.rent_carryovers;
drop policy if exists rent_carryovers_delete on public.rent_carryovers;

-- ── addon_types ───────────────────────────────────────────────────────────
alter table public.addon_types enable row level security;
drop policy if exists addon_types_select on public.addon_types;
create policy addon_types_select on public.addon_types for select to authenticated
  using (exists (select 1 from public.profiles where id = auth.uid() and role in ('admin','user')));
drop policy if exists addon_types_insert on public.addon_types;
create policy addon_types_insert on public.addon_types for insert to authenticated
  with check (exists (select 1 from public.profiles where id = auth.uid() and role = 'admin'));
drop policy if exists addon_types_update on public.addon_types;
create policy addon_types_update on public.addon_types for update to authenticated
  using (exists (select 1 from public.profiles where id = auth.uid() and role = 'admin'));

-- ── documents / invoices / payment_allocations / settlements /
--    tenant_stays / tickets ──────────────────────────────────────────────
-- Zero live rows, zero code references today — locked to admin-only
-- writes as a conservative default until each feature is designed.
do $$
declare t text;
begin
  foreach t in array array[
    'documents','invoices','payment_allocations','settlements','tenant_stays','tickets'
  ] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('drop policy if exists %I_select on public.%I', t, t);
    execute format(
      'create policy %I_select on public.%I for select to authenticated '
      'using (exists (select 1 from public.profiles where id = auth.uid() and role in (''admin'',''user'')))', t, t);
    execute format('drop policy if exists %I_insert on public.%I', t, t);
    execute format(
      'create policy %I_insert on public.%I for insert to authenticated '
      'with check (exists (select 1 from public.profiles where id = auth.uid() and role = ''admin''))', t, t);
    execute format('drop policy if exists %I_update on public.%I', t, t);
    execute format(
      'create policy %I_update on public.%I for update to authenticated '
      'using (exists (select 1 from public.profiles where id = auth.uid() and role = ''admin''))', t, t);
    execute format('drop policy if exists %I_delete on public.%I', t, t);
    execute format(
      'create policy %I_delete on public.%I for delete to authenticated '
      'using (exists (select 1 from public.profiles where id = auth.uid() and role = ''admin''))', t, t);
  end loop;
end $$;

-- tenants: select/insert = any authenticated except the guard role; delete = admin only. update =
-- admin+user at row level, with a trigger restricting non-admin updates to
-- last_pay_10th/last_pay_eom (payment-date bookkeeping) only (see
-- guard_tenants_protected_fields() below).
alter table public.tenants enable row level security;

drop policy if exists tenants_select on public.tenants;
create policy tenants_select on public.tenants
  for select to authenticated using (not (select public.is_guard()));

drop policy if exists tenants_insert on public.tenants;
create policy tenants_insert on public.tenants
  for insert to authenticated with check (not (select public.is_guard()));

drop policy if exists tenants_update on public.tenants;
create policy tenants_update on public.tenants
  for update to authenticated
  using (exists (
    select 1 from public.profiles where id = auth.uid() and role in ('admin','user')
  ));

-- Non-admin (user) UPDATE is limited to payment-date bookkeeping
-- (last_pay_10th/last_pay_eom, written by recordPayment()). Every other
-- column — including personal details edited on the Edit Tenant Profile page
-- (requirements §3) — changes only by admin: non-admin edits are submitted
-- as an approval request and applied by an admin session once approved.
create or replace function public.guard_tenants_protected_fields()
returns trigger language plpgsql as $$
declare
  v_role   text;
  v_exempt text[] := array['last_pay_10th','last_pay_eom'];
begin
  select role into v_role from public.profiles where id = auth.uid();
  if v_role = 'admin' then
    return new;
  end if;
  if (to_jsonb(new) - v_exempt) is distinct from (to_jsonb(old) - v_exempt) then
    raise exception 'Only admin can change tenant details directly. Submit the change for approval.';
  end if;
  return new;
end $$;

drop trigger if exists trg_guard_tenants on public.tenants;
create trigger trg_guard_tenants
  before update on public.tenants
  for each row execute function public.guard_tenants_protected_fields();

drop policy if exists tenants_delete on public.tenants;
create policy tenants_delete on public.tenants
  for delete to authenticated
  using (exists (
    select 1 from public.profiles where id = auth.uid() and role = 'admin'
  ));

-- maintenance_tickets: insert/update restricted to admin + user roles.
alter table public.maintenance_tickets enable row level security;

drop policy if exists tickets_select on public.maintenance_tickets;
create policy tickets_select on public.maintenance_tickets
  for select to authenticated using (not (select public.is_guard()));

drop policy if exists tickets_insert on public.maintenance_tickets;
create policy tickets_insert on public.maintenance_tickets
  for insert to authenticated
  with check (exists (
    select 1 from public.profiles where id = auth.uid() and role in ('admin','user')
  ));

drop policy if exists tickets_update on public.maintenance_tickets;
create policy tickets_update on public.maintenance_tickets
  for update to authenticated
  using (exists (
    select 1 from public.profiles where id = auth.uid() and role in ('admin','user')
  ));

-- approval_requests: insert = own requests only; update = admin only.
alter table public.approval_requests enable row level security;

drop policy if exists approval_requests_select on public.approval_requests;
create policy approval_requests_select on public.approval_requests
  for select to authenticated using (not (select public.is_guard()) and (entity_type is distinct from 'VISITOR_LOG' or exists (select 1 from public.profiles where id = auth.uid() and role in ('admin','user'))));

drop policy if exists approval_requests_insert on public.approval_requests;
create policy approval_requests_insert on public.approval_requests
  for insert to authenticated
  with check (requester_id = auth.uid() and not (select public.is_guard()) and entity_type <> 'VISITOR_LOG');

drop policy if exists approval_requests_update on public.approval_requests;
create policy approval_requests_update on public.approval_requests
  for update to authenticated
  using (exists (
    select 1 from public.profiles where id = auth.uid() and role = 'admin'
  ));

-- ════════════════════════════════════════════════════════════════
-- Notification recipients + subscriptions + delivery log
-- Recipients are not tied to public.profiles / app accounts — any inbox is valid.
-- ════════════════════════════════════════════════════════════════
create table if not exists public.notification_recipients (
  id                  serial primary key,
  email               text not null,
  created_at          timestamptz not null default now(),
  created_by          uuid references public.profiles(id)
);

alter table public.notification_recipients
  drop constraint if exists notification_recipients_email_format_chk;
alter table public.notification_recipients
  add constraint notification_recipients_email_format_chk
  check (email ~* '^[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}$');

create unique index if not exists notification_recipients_email_lower_idx
  on public.notification_recipients (lower(email));

alter table public.notification_recipients enable row level security;

-- Admin-only for every operation — pure config, not user-visible data.
-- Reuses is_admin() (SECURITY DEFINER), the established pattern from the
-- profiles-RLS fix earlier this project (a self-referential inline
-- subquery on profiles caused a real production recursion incident —
-- is_admin() is how that class of bug is avoided going forward).
drop policy if exists notification_recipients_select on public.notification_recipients;
create policy notification_recipients_select on public.notification_recipients
  for select to authenticated using (public.is_admin());

drop policy if exists notification_recipients_insert on public.notification_recipients;
create policy notification_recipients_insert on public.notification_recipients
  for insert to authenticated with check (public.is_admin());

drop policy if exists notification_recipients_update on public.notification_recipients;
create policy notification_recipients_update on public.notification_recipients
  for update to authenticated using (public.is_admin()) with check (public.is_admin());

drop policy if exists notification_recipients_delete on public.notification_recipients;
create policy notification_recipients_delete on public.notification_recipients
  for delete to authenticated using (public.is_admin());

-- Which event types each recipient receives. event_type is an id from the code
-- registry (supabase/functions/_shared/notification-types.ts). Deliberately NOT
-- a CHECK against a fixed list: adding a type must not need a migration. The
-- app ignores unknown/retired ids; only the id *format* is constrained here.
create table if not exists public.notification_subscriptions (
  recipient_id integer     not null references public.notification_recipients(id) on delete cascade,
  event_type   text        not null,
  created_at   timestamptz not null default now(),
  primary key (recipient_id, event_type),
  constraint notification_subscriptions_event_type_fmt_chk
    check (event_type ~ '^[a-z][a-z0-9_]{0,63}$')
);
create index if not exists notification_subscriptions_event_idx
  on public.notification_subscriptions (event_type);

alter table public.notification_subscriptions enable row level security;

drop policy if exists notification_subscriptions_select on public.notification_subscriptions;
create policy notification_subscriptions_select on public.notification_subscriptions
  for select to authenticated using (public.is_admin());
drop policy if exists notification_subscriptions_insert on public.notification_subscriptions;
create policy notification_subscriptions_insert on public.notification_subscriptions
  for insert to authenticated with check (public.is_admin());
drop policy if exists notification_subscriptions_update on public.notification_subscriptions;
create policy notification_subscriptions_update on public.notification_subscriptions
  for update to authenticated using (public.is_admin()) with check (public.is_admin());
drop policy if exists notification_subscriptions_delete on public.notification_subscriptions;
create policy notification_subscriptions_delete on public.notification_subscriptions
  for delete to authenticated using (public.is_admin());

-- One-time carry-over of the old boolean columns, then drop them.
-- Dynamic SQL so re-runs (columns already gone) never fail.
do $$
begin
  if exists (select 1 from information_schema.columns
             where table_schema='public' and table_name='notification_recipients'
               and column_name='notify_on_approval') then
    execute $q$insert into public.notification_subscriptions (recipient_id, event_type)
               select id, 'approval_request' from public.notification_recipients
               where notify_on_approval on conflict do nothing$q$;
  end if;
  if exists (select 1 from information_schema.columns
             where table_schema='public' and table_name='notification_recipients'
               and column_name='notify_on_ticket') then
    execute $q$insert into public.notification_subscriptions (recipient_id, event_type)
               select id, 'maintenance_ticket' from public.notification_recipients
               where notify_on_ticket on conflict do nothing$q$;
  end if;
end $$;
alter table public.notification_recipients drop column if exists notify_on_approval;
alter table public.notification_recipients drop column if exists notify_on_ticket;

-- Once-per-record guard + delivery audit. Written ONLY by the Edge Function
-- (service role bypasses RLS). No insert/update/delete policies => denied to
-- every client role. Admins may read it for diagnostics.
create table if not exists public.notification_log (
  id              bigserial primary key,
  event_type      text        not null,
  record_key      text        not null,   -- ticket id / approval request uuid, as text
  status          text        not null default 'sending'
                  check (status in ('sending','sent','failed')),
  recipient_count integer,
  error           text,                   -- short code only, never secrets/URL
  created_at      timestamptz not null default now(),
  unique (event_type, record_key)
);
alter table public.notification_log enable row level security;
drop policy if exists notification_log_select on public.notification_log;
create policy notification_log_select on public.notification_log
  for select to authenticated using (public.is_admin());

-- ════════════════════════════════════════════════════════════════
-- 8c. VISITOR LOG (mirrors database/migrations/visitor_log.sql §3-§9; the role check, is_guard()/app_role(),
-- the approval_requests entity_type check + pending index and the guard lock-out policy edits live in place above).
-- Guard role = Visitor Log only. Every write goes through the visitor_* SECURITY DEFINER RPCs.
-- ════════════════════════════════════════════════════════════════

-- ════════════════════════════════════════════════════════════════
-- §3 TABLES
-- ════════════════════════════════════════════════════════════════
create table if not exists public.visitor_logs (
  id                    bigint generated always as identity primary key,
  visit_kind            text not null check (visit_kind in ('TENANT','OFFICE')),
  tenant_id             int  references public.tenants(id),          -- null for OFFICE
  tenant_name           text,                                         -- snapshot at check-in
  room_id               int  references public.rooms(id),            -- snapshot
  room_no               text,                                         -- snapshot
  bed_letters           text,                                         -- snapshot, e.g. 'A/B'
  purpose               text,                                         -- required for OFFICE
  visitor_name          text not null check (char_length(visitor_name) between 2 and 100),
  contact_no            text not null check (char_length(contact_no) between 7 and 30),   -- as entered (trimmed)
  contact_key           text not null check (contact_key ~ '^[0-9]{7,15}$'),              -- normalized digits
  email                 text,
  no_email              boolean not null default false,
  id_type               text not null check (id_type in ('PHILSYS','DRIVERS_LICENSE','PASSPORT','UMID_SSS','PRC','POSTAL','VOTERS','COMPANY','SCHOOL','OTHER')),
  id_type_other         text,
  id_number             text check (id_number is null or char_length(id_number) between 3 and 40),  -- optional; added later by admin/user
  id_photo_path         text not null check (id_photo_path ~ '^[0-9]{4}/[0-9]{2}/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.jpg$'),
  id_photo_uploaded_at  timestamptz not null,                         -- storage.objects.created_at, copied at link time
  id_photo_purged_at    timestamptz,                                  -- set once the object is removed (90-day retention)
  check_in_at           timestamptz not null default now(),          -- forced to now() by trigger
  check_in_by           uuid not null references auth.users(id),
  check_in_guard_name   text not null check (char_length(check_in_guard_name) between 2 and 254),
  check_out_at          timestamptz,
  check_out_by          uuid references auth.users(id),
  check_out_guard_name  text,
  overnight_status      text not null default 'NONE' check (overnight_status in ('NONE','PENDING','APPROVED','REJECTED')), -- latest request
  overnight_request_id  uuid references public.approval_requests(id),
  overnight_night       date,
  overnight_approved_nights date[] not null default '{}',
  voided_at             timestamptz,
  voided_by             uuid references auth.users(id),
  void_reason           text,
  created_at            timestamptz not null default now(),
  updated_at            timestamptz,
  constraint visitor_logs_target_chk check (
       (visit_kind = 'TENANT' and tenant_id is not null and tenant_name is not null and room_no is not null)
    or (visit_kind = 'OFFICE' and tenant_id is null and char_length(btrim(coalesce(purpose,''))) between 3 and 200)),
  constraint visitor_logs_email_chk check (           -- to make email strictly required later: drop the first branch
       (no_email and email is null)
    or (not no_email and email is not null and email ~* '^[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}$')),
  constraint visitor_logs_id_other_chk check (id_type <> 'OTHER' or char_length(btrim(coalesce(id_type_other,''))) between 2 and 40),
  constraint visitor_logs_photo_purge_chk check (id_photo_purged_at is null or id_photo_purged_at >= id_photo_uploaded_at),
  constraint visitor_logs_checkout_chk check (
       (check_out_at is null and check_out_by is null and check_out_guard_name is null)
    or (check_out_at is not null and check_out_at >= check_in_at and check_out_by is not null and check_out_guard_name is not null)),
  constraint visitor_logs_void_chk check (
       (voided_at is null and voided_by is null and void_reason is null)
    or (voided_at is not null and voided_by is not null and char_length(btrim(void_reason)) >= 3)),
  constraint visitor_logs_overnight_chk check (
       (overnight_status = 'NONE' and overnight_request_id is null and overnight_night is null)
    or (overnight_status <> 'NONE' and overnight_request_id is not null and overnight_night is not null))
);
create index if not exists idx_visitor_logs_check_in on public.visitor_logs(check_in_at desc);
create index if not exists idx_visitor_logs_open     on public.visitor_logs(check_in_at) where check_out_at is null and voided_at is null;
create index if not exists idx_visitor_logs_contact  on public.visitor_logs(contact_key, check_in_at desc);
create index if not exists idx_visitor_logs_tenant   on public.visitor_logs(tenant_id);
create index if not exists idx_visitor_logs_photo_due on public.visitor_logs(id_photo_uploaded_at) where id_photo_purged_at is null;
create unique index if not exists uq_visitor_logs_photo on public.visitor_logs(id_photo_path);   -- one photo, one visit
-- The same person (same number + same name) can't be inside twice; a shared number with different names is allowed.
create unique index if not exists uq_visitor_logs_open_person on public.visitor_logs(contact_key, lower(visitor_name))
  where check_out_at is null and voided_at is null;

create table if not exists public.visitor_log_edits (      -- audit of admin/user corrections and voids
  id              bigint generated always as identity primary key,
  visit_id        bigint not null references public.visitor_logs(id),
  action          text not null check (action in ('CORRECT','VOID')),
  changes         jsonb not null,                           -- {field: {old, new}}
  reason          text not null check (char_length(btrim(reason)) >= 3),
  edited_by       uuid not null references auth.users(id),
  edited_by_email text,
  edited_at       timestamptz not null default now()
);
create index if not exists idx_visitor_log_edits_visit on public.visitor_log_edits(visit_id, edited_at desc);

-- ════════════════════════════════════════════════════════════════
-- §4 STORAGE BUCKET AND POLICIES
-- ════════════════════════════════════════════════════════════════
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('visitor-ids', 'visitor-ids', false, 1048576, array['image/jpeg'])
on conflict (id) do update set public = false, file_size_limit = 1048576, allowed_mime_types = array['image/jpeg'];

drop policy if exists visitor_ids_insert on storage.objects;
create policy visitor_ids_insert on storage.objects for insert to authenticated
  with check (bucket_id = 'visitor-ids'
    and (select public.app_role()) in ('guard','admin','user')
    and name ~ '^[0-9]{4}/[0-9]{2}/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.jpg$');
drop policy if exists visitor_ids_select_admin on storage.objects;
create policy visitor_ids_select_admin on storage.objects for select to authenticated
  using (bucket_id = 'visitor-ids' and (select public.is_admin()));
drop policy if exists visitor_ids_delete_admin on storage.objects;
create policy visitor_ids_delete_admin on storage.objects for delete to authenticated
  using (bucket_id = 'visitor-ids' and (select public.is_admin()));
-- No UPDATE policy for anyone; no SELECT/DELETE for guard, user or viewer.
-- So no overwriting or upsert, no list, no download, no signed URL. Only admin can createSignedUrl / remove().
-- Objects are deleted only through the Storage API remove(), never by SQL deletes on storage.objects.

-- ════════════════════════════════════════════════════════════════
-- §5 PURE TIME HELPERS (Asia/Manila is a fixed +08:00, no daylight saving)
-- Log day / "night" N runs 06:00 on N to 05:59 on N+1; the curfew of night N is 22:00 on N.
-- ════════════════════════════════════════════════════════════════
create or replace function public.visitor_contact_key(p text) returns text
language sql immutable set search_path = public as $$
  select case
           when d ~ '^639[0-9]{9}$' then '0' || substr(d, 3)
           when d ~ '^9[0-9]{9}$'   then '0' || d
           else d
         end
  from (select regexp_replace(coalesce(p, ''), '[^0-9]', '', 'g') as d) s;
$$;

create or replace function public.visitor_log_day(ts timestamptz) returns date
language sql stable set search_path = public as $$
  select ((ts at time zone 'Asia/Manila') - interval '6 hours')::date;
$$;

create or replace function public.visitor_curfew(n date) returns timestamptz
language sql stable set search_path = public as $$
  select (n + time '22:00') at time zone 'Asia/Manila';
$$;

-- A check-in from 22:00 to 05:59 is overnight immediately: its first curfew is the check-in instant itself.
create or replace function public.visitor_first_curfew(check_in timestamptz) returns timestamptz
language sql stable set search_path = public as $$
  select greatest(check_in, public.visitor_curfew(public.visitor_log_day(check_in)));
$$;

-- Latest night N whose 22:00 is at or before p_at.
create or replace function public.visitor_last_passed_night(p_at timestamptz) returns date
language sql stable set search_path = public as $$
  select case when (p_at at time zone 'Asia/Manila')::time >= time '22:00'
              then (p_at at time zone 'Asia/Manila')::date
              else (p_at at time zone 'Asia/Manila')::date - 1 end;
$$;

-- Precedence: VOID > OUT > RED > PENDING > APPROVED > DUE_SOON > OK.
-- An approval for night N clears RED through the next day; it turns RED again at 22:00 on N+1.
create or replace function public.visitor_state(p_in timestamptz, p_out timestamptz, p_void timestamptz,
  p_status text, p_approved date[], p_at timestamptz) returns text
language sql stable set search_path = public as $$
  select case
    when p_void is not null then 'VOID'
    when p_out  is not null then 'OUT'
    when p_at >= public.visitor_first_curfew(p_in)
         and not exists (select 1 from unnest(coalesce(p_approved, '{}'::date[])) a
                          where a >= public.visitor_last_passed_night(p_at)) then 'RED'
    when p_status = 'PENDING' then 'PENDING'
    when public.visitor_log_day(p_at) = any(coalesce(p_approved, '{}'::date[])) then 'APPROVED'
    when p_at >= public.visitor_curfew(public.visitor_log_day(p_at)) - interval '1 hour'
         and p_at < public.visitor_curfew(public.visitor_log_day(p_at)) then 'DUE_SOON'
    else 'OK'
  end;
$$;

-- History flag: some night the visitor was inside after its 22:00 is not approved.
create or replace function public.visitor_overstay_unapproved(p_in timestamptz, p_out timestamptz,
  p_void timestamptz, p_approved date[], p_at timestamptz) returns boolean
language sql stable set search_path = public as $$
  select p_void is null
     and coalesce(p_out, p_at) > public.visitor_first_curfew(p_in)
     and exists (
       select 1
         from generate_series(public.visitor_log_day(p_in)::timestamp,
                              public.visitor_last_passed_night(coalesce(p_out, p_at))::timestamp,
                              interval '1 day') g
        where not (g::date = any(coalesce(p_approved, '{}'::date[]))));
$$;

create or replace function public.visitor_mask_tail(p text, n int) returns text
language sql immutable set search_path = public as $$
  select case when p is null or char_length(p) < n then '••••' else '••••' || right(p, n) end;
$$;

revoke execute on function public.visitor_contact_key(text) from public, anon;
revoke execute on function public.visitor_log_day(timestamptz) from public, anon;
revoke execute on function public.visitor_curfew(date) from public, anon;
revoke execute on function public.visitor_first_curfew(timestamptz) from public, anon;
revoke execute on function public.visitor_last_passed_night(timestamptz) from public, anon;
revoke execute on function public.visitor_state(timestamptz, timestamptz, timestamptz, text, date[], timestamptz) from public, anon;
revoke execute on function public.visitor_overstay_unapproved(timestamptz, timestamptz, timestamptz, date[], timestamptz) from public, anon;
revoke execute on function public.visitor_mask_tail(text, int) from public, anon;
grant execute on function public.visitor_contact_key(text) to authenticated;
grant execute on function public.visitor_log_day(timestamptz) to authenticated;
grant execute on function public.visitor_curfew(date) to authenticated;
grant execute on function public.visitor_first_curfew(timestamptz) to authenticated;
grant execute on function public.visitor_last_passed_night(timestamptz) to authenticated;
grant execute on function public.visitor_state(timestamptz, timestamptz, timestamptz, text, date[], timestamptz) to authenticated;
grant execute on function public.visitor_overstay_unapproved(timestamptz, timestamptz, timestamptz, date[], timestamptz) to authenticated;
grant execute on function public.visitor_mask_tail(text, int) to authenticated;

-- ════════════════════════════════════════════════════════════════
-- §6 VIEW
-- ════════════════════════════════════════════════════════════════
create or replace view public.visitor_logs_v with (security_invoker = on) as
select l.*,
  public.visitor_first_curfew(l.check_in_at) as first_curfew_at,
  public.visitor_state(l.check_in_at, l.check_out_at, l.voided_at, l.overnight_status, l.overnight_approved_nights, now()) as state,
  public.visitor_overstay_unapproved(l.check_in_at, l.check_out_at, l.voided_at, l.overnight_approved_nights, now()) as overstay_unapproved,
  public.visitor_log_day(now()) as target_night,
  (l.check_out_at is null and l.voided_at is null and l.overnight_status <> 'PENDING'
     and not (public.visitor_log_day(now()) = any(l.overnight_approved_nights))) as can_request_overnight,
  case when l.id_photo_purged_at is null then 'ON_FILE' else 'PURGED' end as photo_status,
  now() as server_now
from public.visitor_logs l;

-- ════════════════════════════════════════════════════════════════
-- §7 TRIGGERS
-- ════════════════════════════════════════════════════════════════
create or replace function public.visitor_logs_guard() returns trigger
language plpgsql set search_path = public as $$
begin
  if tg_op = 'DELETE' then
    raise exception 'Visitor log entries are never deleted. Void the entry instead.';
  end if;
  if coalesce(current_setting('app.visitor_rpc', true), '') <> '1' then
    raise exception 'Visitor log entries change only through the Visitor Log functions.';
  end if;
  if tg_op = 'INSERT' then
    new.check_in_at := now();
    new.created_at  := now();
    new.updated_at  := null;
    return new;
  end if;
  if new.check_in_at is distinct from old.check_in_at
     or new.check_in_by is distinct from old.check_in_by
     or new.check_in_guard_name is distinct from old.check_in_guard_name
     or new.created_at is distinct from old.created_at
     or new.id_photo_path is distinct from old.id_photo_path
     or new.id_photo_uploaded_at is distinct from old.id_photo_uploaded_at then
    raise exception 'Check-in time, recorder and ID photo of a visit cannot be changed.';
  end if;
  if old.id_photo_purged_at is not null and new.id_photo_purged_at is distinct from old.id_photo_purged_at then
    raise exception 'The ID photo deletion mark cannot be changed.';
  end if;
  if old.voided_at is not null
     and (to_jsonb(new) - 'id_photo_purged_at' - 'updated_at') is distinct from (to_jsonb(old) - 'id_photo_purged_at' - 'updated_at') then
    raise exception 'This entry was voided and cannot be changed.';
  end if;
  if old.check_out_at is not null and new.check_out_at is null then
    raise exception 'A check-out cannot be cleared.';
  end if;
  if old.check_out_at is not null and new.check_out_at is distinct from old.check_out_at
     and coalesce(current_setting('app.visitor_correction', true), '') <> '1' then
    raise exception 'Check-out time changes only through Correct.';
  end if;
  new.updated_at := now();
  return new;
end $$;

drop trigger if exists trg_visitor_logs_guard on public.visitor_logs;
create trigger trg_visitor_logs_guard before insert or update or delete on public.visitor_logs
  for each row execute function public.visitor_logs_guard();

create or replace function public.visitor_log_edits_guard() returns trigger
language plpgsql set search_path = public as $$
begin
  raise exception 'Visitor log edit history is append-only.';
end $$;

drop trigger if exists trg_visitor_log_edits_guard on public.visitor_log_edits;
create trigger trg_visitor_log_edits_guard before update or delete on public.visitor_log_edits
  for each row execute function public.visitor_log_edits_guard();

-- Runs inside the admin's approve/reject UPDATE, so the decision and the visit change are atomic.
create or replace function public.visitor_overnight_sync() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  perform set_config('app.visitor_rpc', '1', true);
  update public.visitor_logs
     set overnight_status = case when overnight_request_id = new.id then new.status else overnight_status end,
         overnight_approved_nights = case
           when new.status = 'APPROVED' and not ((new.new_value->>'night')::date = any(overnight_approved_nights))
             then overnight_approved_nights || (new.new_value->>'night')::date
           else overnight_approved_nights end
   where id = new.entity_id::bigint and voided_at is null;
  perform set_config('app.visitor_rpc', '', true);
  return new;
end $$;

drop trigger if exists trg_approval_overnight_sync on public.approval_requests;
create trigger trg_approval_overnight_sync after update of status on public.approval_requests
  for each row
  when (new.entity_type = 'VISITOR_LOG' and new.field_name = 'overnight_visitor'
        and old.status = 'PENDING' and new.status in ('APPROVED','REJECTED'))
  execute function public.visitor_overnight_sync();

-- ════════════════════════════════════════════════════════════════
-- §8 RPCs
-- Every write goes through these SECURITY DEFINER functions (the tables have no write grants/policies).
-- Each checks the caller's role first and sets app.visitor_rpc around its writes.
-- ════════════════════════════════════════════════════════════════

-- Internal: front-desk name recorded with a check-in/check-out/request.
create or replace function public._visitor_guard_name(v_role text, p_guard_name text) returns text
language plpgsql stable set search_path = public as $$
declare v text := regexp_replace(btrim(coalesce(p_guard_name, '')), '\s+', ' ', 'g');
begin
  if v_role = 'guard' then
    if char_length(v) not between 2 and 60 then
      raise exception 'Start your shift (enter who is on duty) before recording visitors.';
    end if;
    return v;
  end if;
  return left(coalesce(nullif(v, ''), auth.jwt()->>'email', 'staff'), 254);
end $$;

-- Internal: Manila time, with the date when it is not today's log day ("2:14 PM" / "Nov 2, 3:10 PM").
create or replace function public._visitor_fmt_time(ts timestamptz) returns text
language sql stable set search_path = public as $$
  select case when public.visitor_log_day(ts) = public.visitor_log_day(now())
              then to_char(ts at time zone 'Asia/Manila', 'FMHH12:MI AM')
              else to_char(ts at time zone 'Asia/Manila', 'Mon FMDD, FMHH12:MI AM') end;
$$;

-- Internal: escape LIKE wildcards in user input.
create or replace function public._visitor_like_escape(p text) returns text
language sql immutable set search_path = public as $$
  select replace(replace(replace(coalesce(p, ''), '\', '\\'), '%', '\%'), '_', '\_');
$$;

revoke execute on function public._visitor_guard_name(text, text) from public, anon, authenticated;
revoke execute on function public._visitor_fmt_time(timestamptz) from public, anon, authenticated;
-- visitor_history (SECURITY INVOKER) calls it as the signed-in user.
revoke execute on function public._visitor_like_escape(text) from public, anon;
grant execute on function public._visitor_like_escape(text) to authenticated;

-- Tenant directory for the picker: active tenants only, one entry per person per room.
create or replace function public.visitor_tenant_search(p_query text default '')
returns table(tenant_id int, tenant_name text, room_id int, room_no text, bed_letters text)
language plpgsql security definer set search_path = public stable as $$
#variable_conflict use_column
declare
  v_role text := public.app_role();
  v_q text := public._visitor_like_escape(left(btrim(coalesce(p_query, '')), 60));
begin
  if v_role is null or v_role not in ('guard','admin','user') then raise exception 'Not allowed.'; end if;
  return query
    select min(t.id)::int,
           (array_agg(btrim(t.name) order by t.id))[1],
           r.id::int,
           r.room_no::text,
           string_agg(b.bed_letter, '/' order by b.bed_letter)
      from public.tenants t
      join public.beds  b on b.id = t.bed_id
      join public.rooms r on r.id = b.room_id
     where t.is_active and t.bed_id is not null
       and (v_q = '' or t.name ilike '%' || v_q || '%' or r.room_no ilike v_q || '%')
     group by lower(btrim(t.name)), r.id, r.room_no
     order by r.room_no, 2
     limit 300;
end $$;

-- Returning-visitor lookup. Never returns the ID number or the photo.
create or replace function public.visitor_lookup_contact(p_contact text)
returns table(visitor_name text, email text, no_email boolean, id_type text, id_type_other text, last_visit_at timestamptz)
language plpgsql security definer set search_path = public stable as $$
#variable_conflict use_column
declare
  v_role text := public.app_role();
  v_key text := public.visitor_contact_key(p_contact);
begin
  if v_role is null or v_role not in ('guard','admin','user') then raise exception 'Not allowed.'; end if;
  if v_key !~ '^[0-9]{7,15}$' then return; end if;
  return query
    select l.visitor_name, l.email, l.no_email, l.id_type, l.id_type_other, l.check_in_at
      from public.visitor_logs l
     where l.contact_key = v_key and l.voided_at is null
     order by l.check_in_at desc
     limit 1;
end $$;

-- Internal: raise an overnight request for tonight (the current log day). Caller holds no lock yet.
create or replace function public._visitor_raise_overnight(v_id bigint, v_reason text, v_name text, v_role text)
returns uuid
language plpgsql set search_path = public as $$
declare
  r public.visitor_logs;
  v_night date := public.visitor_log_day(now());
  v_reason_t text := btrim(coalesce(v_reason, ''));
  v_email text := auth.jwt()->>'email';
  v_req uuid;
begin
  select * into r from public.visitor_logs where id = v_id for update;
  if not found then raise exception 'Not found.'; end if;
  if r.voided_at is not null then raise exception 'This entry was voided.'; end if;
  if r.check_out_at is not null then raise exception 'This visitor has already checked out.'; end if;
  if r.overnight_status = 'PENDING' then raise exception 'A request is already waiting for admin.'; end if;
  if v_night = any(r.overnight_approved_nights) then raise exception 'Already approved for tonight.'; end if;
  if v_role = 'guard' and r.overnight_status = 'REJECTED' and r.overnight_night = v_night then
    raise exception 'Admin rejected tonight''s request. The visitor must leave.';
  end if;
  if char_length(v_reason_t) not between 3 and 300 then
    raise exception 'Enter the reason / relationship for the overnight stay (3 to 300 characters).';
  end if;

  begin
    insert into public.approval_requests
      (requester_id, requester_email, entity_type, entity_id, field_name, old_value, new_value, reason)
    values (auth.uid(), v_email, 'VISITOR_LOG', v_id::text, 'overnight_visitor',
            jsonb_build_object('overnight_status', r.overnight_status),
            jsonb_build_object(
              '_visit_id', v_id, '_tenant_name', r.tenant_name, '_room_no', r.room_no, '_bed_letter', r.bed_letters,
              'visitor_name', r.visitor_name, 'visit_kind', r.visit_kind, 'purpose', r.purpose,
              'night', v_night, 'check_in_at', r.check_in_at, 'guard_name', v_name),
            v_reason_t)
    returning id into v_req;
  exception when unique_violation then
    raise exception 'A request is already waiting for admin.';
  end;

  perform set_config('app.visitor_rpc', '1', true);
  update public.visitor_logs
     set overnight_status = 'PENDING', overnight_request_id = v_req, overnight_night = v_night
   where id = v_id;
  perform set_config('app.visitor_rpc', '', true);

  insert into public.activity_log (activity_type, actor_id, entity_type, entity_id, room_no, tenant_name, notes, metadata)
  values ('Approval Requested', auth.uid(), 'VISITOR_LOG', v_id::int, r.room_no, r.tenant_name,
          format('[overnight_visitor] submitted for approval by %s (front desk: %s). Visit #%s, night of %s. Reason: %s',
                 coalesce(v_email, 'unknown'), v_name, v_id, to_char(v_night, 'Mon FMDD, YYYY'), v_reason_t),
          jsonb_build_object('visit_id', v_id, 'request_id', v_req, 'night', v_night));
  return v_req;
end $$;
revoke execute on function public._visitor_raise_overnight(bigint, text, text, text) from public, anon, authenticated;

create or replace function public.visitor_check_in(
  p_visit_kind text, p_tenant_id int, p_purpose text, p_visitor_name text, p_contact_no text,
  p_email text, p_no_email boolean, p_id_type text, p_id_type_other text, p_id_photo_path text,
  p_guard_name text, p_overnight boolean default false, p_overnight_reason text default null)
returns table(visit_id bigint, request_id uuid, check_in_at timestamptz)
language plpgsql security definer set search_path = public as $$
#variable_conflict use_column
declare
  v_allow_no_email constant boolean := true;
  v_role text := public.app_role();
  v_name text;
  v_kind text := upper(btrim(coalesce(p_visit_kind, '')));
  v_vname text := regexp_replace(btrim(coalesce(p_visitor_name, '')), '\s+', ' ', 'g');
  v_contact text := btrim(coalesce(p_contact_no, ''));
  v_key text;
  v_no_email boolean := coalesce(p_no_email, false);
  v_email text := nullif(lower(btrim(coalesce(p_email, ''))), '');
  v_idt text := upper(btrim(coalesce(p_id_type, '')));
  v_idt_other text := nullif(btrim(coalesce(p_id_type_other, '')), '');
  v_purpose text := nullif(btrim(coalesce(p_purpose, '')), '');
  v_path text := btrim(coalesce(p_id_photo_path, ''));
  v_obj record;
  v_size bigint;
  v_tenant_id int; v_tenant_name text; v_room_id int; v_room_no text; v_beds text;
  v_open_at timestamptz;
  v_id bigint; v_in timestamptz; v_req uuid;
  v_con text;
begin
  if v_role is null or v_role not in ('guard','admin','user') then raise exception 'Not allowed.'; end if;
  v_name := public._visitor_guard_name(v_role, p_guard_name);

  if v_kind not in ('TENANT','OFFICE') then
    raise exception 'Choose the tenant being visited, or Office / delivery / repair.';
  end if;
  if char_length(v_vname) not between 2 and 100 then
    raise exception 'Enter the visitor''s full name (2 to 100 characters).';
  end if;
  v_key := public.visitor_contact_key(v_contact);
  if char_length(v_contact) not between 7 and 30 or v_key !~ '^[0-9]{7,15}$' then
    raise exception 'Enter a valid contact number (7 to 15 digits).';
  end if;
  if v_no_email then
    if not v_allow_no_email then raise exception 'The visitor''s email is required.'; end if;
    if v_email is not null then raise exception 'Clear the email or untick "No email".'; end if;
  else
    if v_email is null then raise exception 'Enter the visitor''s email, or tick "No email".'; end if;
    if char_length(v_email) > 254 or v_email !~* '^[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}$' then
      raise exception 'Enter a valid email address.';
    end if;
  end if;
  if v_idt not in ('PHILSYS','DRIVERS_LICENSE','PASSPORT','UMID_SSS','PRC','POSTAL','VOTERS','COMPANY','SCHOOL','OTHER') then
    raise exception 'Choose the ID type.';
  end if;
  if v_idt = 'OTHER' then
    if char_length(coalesce(v_idt_other, '')) not between 2 and 40 then
      raise exception 'Specify the ID type (2 to 40 characters).';
    end if;
  else
    v_idt_other := null;
  end if;

  -- Photo: uploaded by this account in the last 30 minutes, a JPEG of at most 1 MB, not linked yet.
  if v_path !~ '^[0-9]{4}/[0-9]{2}/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.jpg$' then
    raise exception 'ID photo not found, take it again.';
  end if;
  select o.created_at, o.owner_id, o.owner, o.metadata into v_obj
    from storage.objects o where o.bucket_id = 'visitor-ids' and o.name = v_path;
  if not found then raise exception 'ID photo not found, take it again.'; end if;
  if coalesce(v_obj.owner_id::text, v_obj.owner::text) is distinct from auth.uid()::text then
    raise exception 'This photo was not taken on this account. Take it again.';
  end if;
  if v_obj.created_at < now() - interval '30 minutes' then
    raise exception 'Photo is too old, take it again.';
  end if;
  v_size := case when (v_obj.metadata->>'size') ~ '^[0-9]{1,12}$' then (v_obj.metadata->>'size')::bigint end;
  if coalesce(v_obj.metadata->>'mimetype', '') <> 'image/jpeg' or v_size is null or v_size > 1048576 then
    raise exception 'The ID photo must be a JPEG of at most 1 MB. Take it again.';
  end if;
  if exists (select 1 from public.visitor_logs l where l.id_photo_path = v_path) then
    raise exception 'This photo is already used on another visit. Take a new one.';
  end if;

  if v_kind = 'TENANT' then
    if p_tenant_id is null then raise exception 'Choose the tenant being visited.'; end if;
    select t.id, btrim(t.name), b.room_id, r.room_no into v_tenant_id, v_tenant_name, v_room_id, v_room_no
      from public.tenants t
      join public.beds  b on b.id = t.bed_id
      join public.rooms r on r.id = b.room_id
     where t.id = p_tenant_id and t.is_active and t.bed_id is not null;
    if not found then raise exception 'This tenant is no longer active. Search again.'; end if;
    select string_agg(b.bed_letter, '/' order by b.bed_letter) into v_beds
      from public.tenants t join public.beds b on b.id = t.bed_id
     where t.is_active and b.room_id = v_room_id and lower(btrim(t.name)) = lower(v_tenant_name);
    v_purpose := null;
  else
    if char_length(coalesce(v_purpose, '')) not between 3 and 200 then
      raise exception 'Enter the purpose of the visit (3 to 200 characters).';
    end if;
  end if;

  select l.check_in_at into v_open_at from public.visitor_logs l
   where l.contact_key = v_key and lower(l.visitor_name) = lower(v_vname)
     and l.check_out_at is null and l.voided_at is null
   limit 1;
  if found then
    raise exception '% is already checked in since %. Check them out first.', v_vname, public._visitor_fmt_time(v_open_at);
  end if;

  perform set_config('app.visitor_rpc', '1', true);
  begin
    insert into public.visitor_logs
      (visit_kind, tenant_id, tenant_name, room_id, room_no, bed_letters, purpose,
       visitor_name, contact_no, contact_key, email, no_email, id_type, id_type_other, id_number,
       id_photo_path, id_photo_uploaded_at, check_in_by, check_in_guard_name)
    values
      (v_kind, v_tenant_id, v_tenant_name, v_room_id, v_room_no, v_beds, v_purpose,
       v_vname, v_contact, v_key, case when v_no_email then null else v_email end, v_no_email, v_idt, v_idt_other, null,
       v_path, v_obj.created_at, auth.uid(), v_name)
    returning id, check_in_at into v_id, v_in;
  exception when unique_violation then
    get stacked diagnostics v_con = constraint_name;
    if v_con = 'uq_visitor_logs_photo' then
      raise exception 'This photo is already used on another visit. Take a new one.';
    end if;
    raise exception '% is already checked in. Check them out first.', v_vname;
  end;
  perform set_config('app.visitor_rpc', '', true);

  if coalesce(p_overnight, false) then
    v_req := public._visitor_raise_overnight(v_id, p_overnight_reason, v_name, v_role);
  end if;

  return query select v_id, v_req, v_in;
end $$;

create or replace function public.visitor_check_out(p_visit_id bigint, p_guard_name text) returns timestamptz
language plpgsql security definer set search_path = public as $$
declare
  v_role text := public.app_role();
  v_name text;
  v_out timestamptz;
  r public.visitor_logs;
begin
  if v_role is null or v_role not in ('guard','admin','user') then raise exception 'Not allowed.'; end if;
  v_name := public._visitor_guard_name(v_role, p_guard_name);
  perform set_config('app.visitor_rpc', '1', true);
  update public.visitor_logs
     set check_out_at = now(), check_out_by = auth.uid(), check_out_guard_name = v_name
   where id = p_visit_id and check_out_at is null and voided_at is null
  returning check_out_at into v_out;
  perform set_config('app.visitor_rpc', '', true);
  if v_out is null then
    select * into r from public.visitor_logs where id = p_visit_id;
    if not found then raise exception 'Not found.'; end if;
    if r.voided_at is not null then raise exception 'This entry was voided.'; end if;
    raise exception 'Already checked out at %', public._visitor_fmt_time(r.check_out_at);
  end if;
  return v_out;
end $$;

create or replace function public.visitor_request_overnight(p_visit_id bigint, p_reason text, p_guard_name text) returns uuid
language plpgsql security definer set search_path = public as $$
declare
  v_role text := public.app_role();
  v_name text;
begin
  if v_role is null or v_role not in ('guard','admin','user') then raise exception 'Not allowed.'; end if;
  v_name := public._visitor_guard_name(v_role, p_guard_name);
  return public._visitor_raise_overnight(p_visit_id, p_reason, v_name, v_role);
end $$;

-- Guard's lists: every open visit (any day) plus visits checked in or out since 06:00 today.
-- Contact shows only the last 4 digits, email only the first letter + domain; no ID number, no photo.
create or replace function public.visitor_guard_list()
returns table(id bigint, visit_kind text, tenant_name text, room_no text, bed_letters text, purpose text,
  visitor_name text, contact_masked text, email_masked text, no_email boolean, id_type text, id_type_other text,
  check_in_at timestamptz, check_in_guard_name text, check_out_at timestamptz, check_out_guard_name text,
  overnight_status text, overnight_night date, overnight_decision_note text, state text,
  first_curfew_at timestamptz, can_request_overnight boolean, server_now timestamptz)
language plpgsql security definer set search_path = public stable as $$
#variable_conflict use_column
declare
  v_role text := public.app_role();
  v_today date := public.visitor_log_day(now());
  v_day_start timestamptz := (public.visitor_log_day(now()) + time '06:00') at time zone 'Asia/Manila';
begin
  if v_role is null or v_role not in ('guard','admin','user') then raise exception 'Not allowed.'; end if;
  return query
    select l.id, l.visit_kind, l.tenant_name, l.room_no, l.bed_letters, l.purpose,
           l.visitor_name,
           public.visitor_mask_tail(l.contact_key, 4),
           case when l.email is null then null
                else left(l.email, 1) || '•••' || substr(l.email, strpos(l.email, '@')) end,
           l.no_email, l.id_type, l.id_type_other,
           l.check_in_at, l.check_in_guard_name, l.check_out_at, l.check_out_guard_name,
           l.overnight_status, l.overnight_night, ar.decision_notes,
           public.visitor_state(l.check_in_at, l.check_out_at, l.voided_at, l.overnight_status, l.overnight_approved_nights, now()),
           public.visitor_first_curfew(l.check_in_at),
           (l.check_out_at is null and l.overnight_status <> 'PENDING'
              and not (v_today = any(l.overnight_approved_nights))
              and not (v_role = 'guard' and l.overnight_status = 'REJECTED' and l.overnight_night = v_today)),
           now()
      from public.visitor_logs l
      left join public.approval_requests ar on ar.id = l.overnight_request_id
     where l.voided_at is null
       and (l.check_out_at is null or l.check_in_at >= v_day_start or l.check_out_at >= v_day_start)
     order by l.check_in_at desc
     limit 500;
end $$;

create or replace function public.visitor_void(p_visit_id bigint, p_reason text) returns void
language plpgsql security definer set search_path = public as $$
declare
  v_role text := public.app_role();
  v_reason text := btrim(coalesce(p_reason, ''));
  v_email text := auth.jwt()->>'email';
  r public.visitor_logs;
begin
  if v_role is null or v_role not in ('admin','user') then raise exception 'Not allowed.'; end if;
  if char_length(v_reason) < 3 then raise exception 'Enter the reason for voiding (at least 3 characters).'; end if;
  select * into r from public.visitor_logs where id = p_visit_id for update;
  if not found then raise exception 'Not found.'; end if;
  if r.voided_at is not null then raise exception 'This entry is already voided.'; end if;

  perform set_config('app.visitor_rpc', '1', true);
  update public.visitor_logs set voided_at = now(), voided_by = auth.uid(), void_reason = v_reason where id = p_visit_id;
  perform set_config('app.visitor_rpc', '', true);

  insert into public.visitor_log_edits (visit_id, action, changes, reason, edited_by, edited_by_email)
  values (p_visit_id, 'VOID', jsonb_build_object('voided', jsonb_build_object('old', false, 'new', true)), v_reason, auth.uid(), v_email);
  insert into public.activity_log (activity_type, actor_id, entity_type, entity_id, room_no, notes, metadata)
  values ('Visitor Entry Voided', auth.uid(), 'VISITOR_LOG', p_visit_id::int, r.room_no,
          format('Visitor entry #%s voided by %s. Reason: %s', p_visit_id, coalesce(v_email, 'unknown'), v_reason),
          jsonb_build_object('visit_id', p_visit_id));
end $$;

-- Admin/user corrections. check_in_at and the photo are never editable.
create or replace function public.visitor_correct(p_visit_id bigint, p_changes jsonb, p_reason text) returns void
language plpgsql security definer set search_path = public as $$
declare
  v_role text := public.app_role();
  v_reason text := btrim(coalesce(p_reason, ''));
  v_email text := auth.jwt()->>'email';
  v_allowed text[] := array['visitor_name','contact_no','email','no_email','id_type','id_type_other','id_number',
                            'visit_kind','tenant_id','purpose','check_out_at'];
  v_diff_keys text[] := array['visitor_name','contact_no','email','no_email','id_type','id_type_other','id_number',
                              'visit_kind','tenant_id','tenant_name','room_id','room_no','bed_letters','purpose','check_out_at'];
  r public.visitor_logs;
  n public.visitor_logs;
  k text;
  v_txt text;
  v_out timestamptz;
  v_changes jsonb := '{}'::jsonb;
  v_old jsonb; v_new jsonb;
  v_retarget boolean := false;
  v_open_at timestamptz;
begin
  if v_role is null or v_role not in ('admin','user') then raise exception 'Not allowed.'; end if;
  if char_length(v_reason) < 3 then raise exception 'Enter the reason for the correction (at least 3 characters).'; end if;
  if p_changes is null or jsonb_typeof(p_changes) <> 'object' then raise exception 'Nothing to change.'; end if;
  for k in select jsonb_object_keys(p_changes) loop
    if not (k = any(v_allowed)) then raise exception 'This field cannot be corrected: %', k; end if;
  end loop;

  select * into r from public.visitor_logs where id = p_visit_id for update;
  if not found then raise exception 'Not found.'; end if;
  if r.voided_at is not null then raise exception 'This entry was voided and cannot be corrected.'; end if;
  n := r;

  if p_changes ? 'visitor_name' then
    n.visitor_name := regexp_replace(btrim(coalesce(p_changes->>'visitor_name', '')), '\s+', ' ', 'g');
    if char_length(n.visitor_name) not between 2 and 100 then
      raise exception 'Enter the visitor''s full name (2 to 100 characters).';
    end if;
  end if;
  if p_changes ? 'contact_no' then
    n.contact_no := btrim(coalesce(p_changes->>'contact_no', ''));
    n.contact_key := public.visitor_contact_key(n.contact_no);
    if char_length(n.contact_no) not between 7 and 30 or n.contact_key !~ '^[0-9]{7,15}$' then
      raise exception 'Enter a valid contact number (7 to 15 digits).';
    end if;
  end if;
  if p_changes ? 'no_email' then
    if jsonb_typeof(p_changes->'no_email') <> 'boolean' then raise exception 'No email must be true or false.'; end if;
    n.no_email := (p_changes->>'no_email')::boolean;
  end if;
  if p_changes ? 'email' then
    n.email := nullif(lower(btrim(coalesce(p_changes->>'email', ''))), '');
  end if;
  if n.no_email then
    if p_changes ? 'email' and n.email is not null then raise exception 'Clear the email or untick "No email".'; end if;
    n.email := null;
  else
    if n.email is null then raise exception 'Enter the visitor''s email, or tick "No email".'; end if;
    if char_length(n.email) > 254 or n.email !~* '^[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}$' then
      raise exception 'Enter a valid email address.';
    end if;
  end if;
  if p_changes ? 'id_type' then
    n.id_type := upper(btrim(coalesce(p_changes->>'id_type', '')));
    if n.id_type not in ('PHILSYS','DRIVERS_LICENSE','PASSPORT','UMID_SSS','PRC','POSTAL','VOTERS','COMPANY','SCHOOL','OTHER') then
      raise exception 'Choose the ID type.';
    end if;
  end if;
  if p_changes ? 'id_type_other' then
    n.id_type_other := nullif(btrim(coalesce(p_changes->>'id_type_other', '')), '');
  end if;
  if n.id_type = 'OTHER' then
    if char_length(coalesce(n.id_type_other, '')) not between 2 and 40 then
      raise exception 'Specify the ID type (2 to 40 characters).';
    end if;
  else
    n.id_type_other := null;
  end if;
  if p_changes ? 'id_number' then
    n.id_number := nullif(btrim(coalesce(p_changes->>'id_number', '')), '');
    if n.id_number is not null and char_length(n.id_number) not between 3 and 40 then
      raise exception 'The ID number must be 3 to 40 characters.';
    end if;
  end if;

  if p_changes ? 'visit_kind' then
    n.visit_kind := upper(btrim(coalesce(p_changes->>'visit_kind', '')));
    if n.visit_kind not in ('TENANT','OFFICE') then raise exception 'Choose the tenant being visited, or Office.'; end if;
  end if;
  if n.visit_kind = 'TENANT' then
    v_retarget := (p_changes ? 'tenant_id') or r.visit_kind <> 'TENANT';
    if v_retarget then
      v_txt := p_changes->>'tenant_id';
      if v_txt is null or v_txt !~ '^[0-9]{1,9}$' then raise exception 'Choose the tenant being visited (invalid tenant).'; end if;
      select t.id, btrim(t.name), b.room_id, rm.room_no into n.tenant_id, n.tenant_name, n.room_id, n.room_no
        from public.tenants t
        join public.beds  b  on b.id = t.bed_id
        join public.rooms rm on rm.id = b.room_id
       where t.id = v_txt::int and t.is_active and t.bed_id is not null;
      if not found then raise exception 'This tenant is no longer active. Search again.'; end if;
      select string_agg(b.bed_letter, '/' order by b.bed_letter) into n.bed_letters
        from public.tenants t join public.beds b on b.id = t.bed_id
       where t.is_active and b.room_id = n.room_id and lower(btrim(t.name)) = lower(n.tenant_name);
    end if;
    n.purpose := null;
  else
    n.tenant_id := null; n.tenant_name := null; n.room_id := null; n.room_no := null; n.bed_letters := null;
    if p_changes ? 'purpose' then n.purpose := nullif(btrim(coalesce(p_changes->>'purpose', '')), ''); end if;
    if char_length(coalesce(n.purpose, '')) not between 3 and 200 then
      raise exception 'Enter the purpose of the visit (3 to 200 characters).';
    end if;
  end if;

  if p_changes ? 'check_out_at' then
    v_txt := p_changes->>'check_out_at';
    if v_txt is null or btrim(v_txt) = '' then raise exception 'A check-out time cannot be cleared.'; end if;
    begin
      v_out := v_txt::timestamptz;
    exception when others then
      raise exception 'Enter a valid check-out time.';
    end;
    -- The form has minute precision: the check-in minute itself is accepted and stored as the check-in instant.
    if v_out < date_trunc('minute', r.check_in_at) then raise exception 'The check-out time cannot be before the check-in time.'; end if;
    if v_out > now() then raise exception 'The check-out time cannot be in the future.'; end if;
    n.check_out_at := greatest(v_out, r.check_in_at);
    if r.check_out_at is null then
      n.check_out_by := auth.uid();
      n.check_out_guard_name := left(coalesce(v_email, 'staff'), 254);
    end if;
  end if;

  foreach k in array v_diff_keys loop
    v_old := to_jsonb(r) -> k;
    v_new := to_jsonb(n) -> k;
    if v_old is distinct from v_new then
      v_changes := v_changes || jsonb_build_object(k, jsonb_build_object('old', v_old, 'new', v_new));
    end if;
  end loop;
  if v_changes = '{}'::jsonb then raise exception 'Nothing changed.'; end if;

  perform set_config('app.visitor_rpc', '1', true);
  perform set_config('app.visitor_correction', '1', true);
  begin
  update public.visitor_logs
     set visitor_name = n.visitor_name, contact_no = n.contact_no, contact_key = n.contact_key,
         email = n.email, no_email = n.no_email, id_type = n.id_type, id_type_other = n.id_type_other,
         id_number = n.id_number, visit_kind = n.visit_kind, tenant_id = n.tenant_id, tenant_name = n.tenant_name,
         room_id = n.room_id, room_no = n.room_no, bed_letters = n.bed_letters, purpose = n.purpose,
         check_out_at = n.check_out_at, check_out_by = n.check_out_by, check_out_guard_name = n.check_out_guard_name
   where id = p_visit_id;
  exception when unique_violation then
    select l.check_in_at into v_open_at from public.visitor_logs l
     where l.contact_key = n.contact_key and lower(l.visitor_name) = lower(n.visitor_name)
       and l.check_out_at is null and l.voided_at is null and l.id <> p_visit_id
     limit 1;
    if v_open_at is null then
      raise exception '% is already checked in. Check them out first.', n.visitor_name;
    end if;
    raise exception '% is already checked in since %. Check them out first.', n.visitor_name, public._visitor_fmt_time(v_open_at);
  end;
  perform set_config('app.visitor_correction', '', true);
  perform set_config('app.visitor_rpc', '', true);

  insert into public.visitor_log_edits (visit_id, action, changes, reason, edited_by, edited_by_email)
  values (p_visit_id, 'CORRECT', v_changes, v_reason, auth.uid(), v_email);
  insert into public.activity_log (activity_type, actor_id, entity_type, entity_id, room_no, notes, metadata)
  values ('Visitor Entry Corrected', auth.uid(), 'VISITOR_LOG', p_visit_id::int, n.room_no,
          format('Visitor entry #%s corrected by %s (%s). Reason: %s', p_visit_id, coalesce(v_email, 'unknown'),
                 (select string_agg(x, ', ' order by x) from jsonb_object_keys(v_changes) x), v_reason),
          jsonb_build_object('visit_id', p_visit_id, 'fields', (select jsonb_agg(x order by x) from jsonb_object_keys(v_changes) x)));
end $$;

-- History for admin/user. SECURITY INVOKER: explicit role check, plus RLS on visitor_logs.
create or replace function public.visitor_history(p_from date, p_to date, p_search text default null,
  p_status text default 'ACTIVE', p_overnight text default 'ANY', p_kind text default 'ALL',
  p_limit int default 100, p_offset int default 0)
returns setof public.visitor_logs_v
language plpgsql security invoker set search_path = public stable as $$
declare
  v_role text := public.app_role();
  v_q text := nullif(public._visitor_like_escape(left(btrim(coalesce(p_search, '')), 100)), '');
  v_status text := upper(coalesce(p_status, 'ACTIVE'));
  v_on text := upper(coalesce(p_overnight, 'ANY'));
  v_kind text := upper(coalesce(p_kind, 'ALL'));
begin
  if v_role is null or v_role not in ('admin','user') then raise exception 'Not allowed.'; end if;
  if p_from is null or p_to is null or p_to < p_from then raise exception 'Choose a valid date range.'; end if;
  return query
    select v.* from public.visitor_logs_v v
     where v.check_in_at >= (p_from::timestamp at time zone 'Asia/Manila')
       and v.check_in_at <  ((p_to + 1)::timestamp at time zone 'Asia/Manila')
       and case v_status
             when 'ACTIVE' then v.voided_at is null
             when 'INSIDE' then v.check_out_at is null and v.voided_at is null
             when 'OUT'    then v.check_out_at is not null and v.voided_at is null
             when 'VOID'   then v.voided_at is not null
             else true end
       and case v_on
             when 'REQUESTED'   then v.overnight_status <> 'NONE'
             when 'PENDING'     then v.overnight_status = 'PENDING'
             when 'APPROVED'    then v.overnight_status = 'APPROVED'
             when 'REJECTED'    then v.overnight_status = 'REJECTED'
             when 'PAST_CUTOFF' then v.overstay_unapproved
             else true end
       and (v_kind not in ('TENANT','OFFICE') or v.visit_kind = v_kind)
       and (v_q is null
            or v.visitor_name ilike '%' || v_q || '%' or v.contact_no ilike '%' || v_q || '%'
            or v.contact_key ilike '%' || v_q || '%' or v.email ilike '%' || v_q || '%'
            or v.id_number ilike '%' || v_q || '%' or v.tenant_name ilike '%' || v_q || '%'
            or v.room_no ilike '%' || v_q || '%' or v.purpose ilike '%' || v_q || '%')
     order by v.check_in_at desc
     limit least(greatest(coalesce(p_limit, 100), 1), 200)
     offset greatest(coalesce(p_offset, 0), 0);
end $$;

-- 90-day retention, run by the admin's browser (no scheduled job). Read only.
create or replace function public.visitor_photo_purge_candidates(p_limit int default 200)
returns table(path text, kind text)
language plpgsql security definer set search_path = public stable as $$
#variable_conflict use_column
declare v_lim int := least(greatest(coalesce(p_limit, 200), 1), 500);
begin
  if not public.is_admin() then raise exception 'Not allowed.'; end if;
  return query
    select x.path, x.kind from (
      (select l.id_photo_path as path, 'EXPIRED'::text as kind, l.id_photo_uploaded_at as sort_at
         from public.visitor_logs l
        where l.id_photo_purged_at is null
          and l.id_photo_uploaded_at < now() - interval '90 days'
          and (l.check_out_at is not null or l.voided_at is not null)
        order by l.id_photo_uploaded_at
        limit v_lim)
      union all
      (select o.name::text, 'ORPHAN'::text, o.created_at
         from storage.objects o
        where o.bucket_id = 'visitor-ids'
          and o.created_at < now() - interval '24 hours'
          and not exists (select 1 from public.visitor_logs l where l.id_photo_path = o.name)
        order by o.created_at
        limit v_lim)
    ) x
    order by x.sort_at
    limit v_lim;
end $$;

-- Marks only visits whose object is really gone, so a failed remove() is retried on the next run.
create or replace function public.visitor_photo_mark_purged(p_paths text[]) returns int
language plpgsql security definer set search_path = public as $$
declare v_n int := 0;
begin
  if not public.is_admin() then raise exception 'Not allowed.'; end if;
  if p_paths is null or cardinality(p_paths) = 0 then return 0; end if;
  perform set_config('app.visitor_rpc', '1', true);
  update public.visitor_logs l
     set id_photo_purged_at = now()
   where l.id_photo_path = any(p_paths)
     and l.id_photo_purged_at is null
     and not exists (select 1 from storage.objects o where o.bucket_id = 'visitor-ids' and o.name = l.id_photo_path);
  get diagnostics v_n = row_count;
  perform set_config('app.visitor_rpc', '', true);
  if v_n > 0 then
    insert into public.activity_log (activity_type, actor_id, entity_type, notes, metadata)
    values ('Visitor ID Photos Purged', auth.uid(), 'VISITOR_LOG',
            format('%s visitor ID photo(s) deleted after the 90-day retention by %s.', v_n, coalesce(auth.jwt()->>'email', 'unknown')),
            jsonb_build_object('count', v_n));
  end if;
  return v_n;
end $$;

revoke execute on function public.visitor_tenant_search(text) from public, anon;
revoke execute on function public.visitor_lookup_contact(text) from public, anon;
revoke execute on function public.visitor_check_in(text, int, text, text, text, text, boolean, text, text, text, text, boolean, text) from public, anon;
revoke execute on function public.visitor_check_out(bigint, text) from public, anon;
revoke execute on function public.visitor_request_overnight(bigint, text, text) from public, anon;
revoke execute on function public.visitor_guard_list() from public, anon;
revoke execute on function public.visitor_void(bigint, text) from public, anon;
revoke execute on function public.visitor_correct(bigint, jsonb, text) from public, anon;
revoke execute on function public.visitor_history(date, date, text, text, text, text, int, int) from public, anon;
revoke execute on function public.visitor_photo_purge_candidates(int) from public, anon;
revoke execute on function public.visitor_photo_mark_purged(text[]) from public, anon;
grant execute on function public.visitor_tenant_search(text) to authenticated;
grant execute on function public.visitor_lookup_contact(text) to authenticated;
grant execute on function public.visitor_check_in(text, int, text, text, text, text, boolean, text, text, text, text, boolean, text) to authenticated;
grant execute on function public.visitor_check_out(bigint, text) to authenticated;
grant execute on function public.visitor_request_overnight(bigint, text, text) to authenticated;
grant execute on function public.visitor_guard_list() to authenticated;
grant execute on function public.visitor_void(bigint, text) to authenticated;
grant execute on function public.visitor_correct(bigint, jsonb, text) to authenticated;
grant execute on function public.visitor_history(date, date, text, text, text, text, int, int) to authenticated;
grant execute on function public.visitor_photo_purge_candidates(int) to authenticated;
grant execute on function public.visitor_photo_mark_purged(text[]) to authenticated;

-- ════════════════════════════════════════════════════════════════
-- §9 RLS ON NEW TABLES
-- ════════════════════════════════════════════════════════════════
alter table public.visitor_logs enable row level security;
alter table public.visitor_log_edits enable row level security;
drop policy if exists visitor_logs_select on public.visitor_logs;
create policy visitor_logs_select on public.visitor_logs for select to authenticated
  using (exists (select 1 from public.profiles where id = auth.uid() and role in ('admin','user')));
drop policy if exists visitor_log_edits_select on public.visitor_log_edits;
create policy visitor_log_edits_select on public.visitor_log_edits for select to authenticated
  using (exists (select 1 from public.profiles where id = auth.uid() and role in ('admin','user')));
-- No insert/update/delete policies for any role: every write goes through the SECURITY DEFINER RPCs.
revoke insert, update, delete, truncate on public.visitor_logs, public.visitor_log_edits from anon, authenticated;
revoke all on public.visitor_logs, public.visitor_log_edits, public.visitor_logs_v from anon;
alter view public.visitor_logs_v set (security_invoker = on);
-- Guard and viewer get 0 rows. A user can read id_photo_path but cannot open the file (storage select is admin-only).

-- ════════════════════════════════════════════════════════════════
-- 8b. OCCUPANCY SIMULATOR (fully isolated — no FK to rooms/beds/tenants/bills/
-- payments; see docs/requirements.md for the isolation guarantee)
-- ════════════════════════════════════════════════════════════════

create table if not exists public.sim_rooms (
  id          bigint generated always as identity primary key,
  room_no     text not null unique,
  room_type   text not null,          -- free text, NOT constrained to live ROOM_TYPES enum
  floor       int,                    -- display-only, derived from leading digit of room_no at import time
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  updated_by  uuid references auth.users(id)
);

create table if not exists public.sim_beds (
  id              bigint generated always as identity primary key,
  sim_room_id     bigint not null references public.sim_rooms(id) on delete cascade,
  bed_letter      text not null,
  rate            numeric(10,2),      -- null when is_out_of_order = true
  is_out_of_order boolean not null default false,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  updated_by      uuid references auth.users(id),
  unique (sim_room_id, bed_letter)
);

alter table public.sim_rooms enable row level security;
alter table public.sim_beds  enable row level security;

-- SELECT + UPDATE: admin or user (single-cell edits: rate, toggle out-of-order)
drop policy if exists sim_rooms_select on public.sim_rooms;
create policy sim_rooms_select on public.sim_rooms
  for select to authenticated
  using (exists (select 1 from public.profiles where id = auth.uid() and role in ('admin','user')));

drop policy if exists sim_rooms_update on public.sim_rooms;
create policy sim_rooms_update on public.sim_rooms
  for update to authenticated
  using (exists (select 1 from public.profiles where id = auth.uid() and role in ('admin','user')))
  with check (exists (select 1 from public.profiles where id = auth.uid() and role in ('admin','user')));

-- INSERT + DELETE: admin only (defense-in-depth; the only insert/delete path is CSV bulk-replace,
-- which must be admin-only per the requirement — enforced here, not just hidden in the UI)
drop policy if exists sim_rooms_insert on public.sim_rooms;
create policy sim_rooms_insert on public.sim_rooms
  for insert to authenticated
  with check (exists (select 1 from public.profiles where id = auth.uid() and role = 'admin'));

drop policy if exists sim_rooms_delete on public.sim_rooms;
create policy sim_rooms_delete on public.sim_rooms
  for delete to authenticated
  using (exists (select 1 from public.profiles where id = auth.uid() and role = 'admin'));

-- Mirror all four policies on sim_beds
drop policy if exists sim_beds_select on public.sim_beds;
create policy sim_beds_select on public.sim_beds
  for select to authenticated
  using (exists (select 1 from public.profiles where id = auth.uid() and role in ('admin','user')));

drop policy if exists sim_beds_update on public.sim_beds;
create policy sim_beds_update on public.sim_beds
  for update to authenticated
  using (exists (select 1 from public.profiles where id = auth.uid() and role in ('admin','user')))
  with check (exists (select 1 from public.profiles where id = auth.uid() and role in ('admin','user')));

drop policy if exists sim_beds_insert on public.sim_beds;
create policy sim_beds_insert on public.sim_beds
  for insert to authenticated
  with check (exists (select 1 from public.profiles where id = auth.uid() and role = 'admin'));

drop policy if exists sim_beds_delete on public.sim_beds;
create policy sim_beds_delete on public.sim_beds
  for delete to authenticated
  using (exists (select 1 from public.profiles where id = auth.uid() and role = 'admin'));

-- Atomic bulk replace, used only by the admin-only CSV importer. SECURITY DEFINER + explicit
-- is_admin() check (mirrors the is_admin() helper convention) so a non-admin gets a clean error
-- instead of an opaque RLS violation. One function body = one implicit transaction: a mid-function
-- error rolls back everything, so there is no partial-write state.
create or replace function public.sim_replace_all(p_rooms jsonb)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if not is_admin() then
    raise exception 'admin role required' using errcode = '42501';
  end if;

  if coalesce(jsonb_array_length(p_rooms), 0) = 0 then
    raise exception 'p_rooms must be a non-empty array' using errcode = '22023';
  end if;

  delete from public.sim_rooms;  -- cascades to sim_beds

  insert into public.sim_rooms (room_no, room_type, floor, updated_by)
  select r->>'room_no', r->>'room_type', (r->>'floor')::int, auth.uid()
  from jsonb_array_elements(p_rooms) r;

  insert into public.sim_beds (sim_room_id, bed_letter, rate, is_out_of_order, updated_by)
  select sr.id, b->>'bed_letter',
         nullif(b->>'rate','')::numeric(10,2),
         coalesce((b->>'is_out_of_order')::boolean, false),
         auth.uid()
  from jsonb_array_elements(p_rooms) r
  join public.sim_rooms sr on sr.room_no = r->>'room_no'
  cross join lateral jsonb_array_elements(r->'beds') b;
end;
$$;

-- Mirrors the is_admin() precedent above (~line 863): functions grant EXECUTE to
-- PUBLIC by default, so without this an anon request could call this RPC directly.
-- is_admin() already blocks anon/non-admin callers inside the function body — this
-- is defense-in-depth only, for consistency with the rest of the codebase.
revoke execute on function public.sim_replace_all(jsonb) from public, anon;
grant execute on function public.sim_replace_all(jsonb) to authenticated;

-- ── Seed: exact snapshot of the owner's CSV (31 rooms / 87 beds), generated by a throwaway
--    Node script that parsed the source CSV and emitted the INSERT statements below.
--    Verified: 31 rooms, 87 beds, 5 out-of-order, sum(rate) where not is_out_of_order =
--    468250.00 exactly.
insert into public.sim_rooms (room_no, room_type, floor) values
  ('301', '6 - Bed Sharing', 3),
  ('302', '2 - Bed Sharing', 3),
  ('303', '4 - Bed Sharing', 3),
  ('304', '4 - Bed Sharing', 3),
  ('305', '2 - Bed Sharing', 3),
  ('306', '4 - Bed Sharing', 3),
  ('401', '6 - Bed Sharing', 4),
  ('402', '2 - Bed Sharing', 4),
  ('403', '4 - Bed Sharing', 4),
  ('404', '2 - Bed Sharing', 4),
  ('405', '2 - Bed Sharing', 4),
  ('406', 'Solo Room', 4),
  ('501 A', '1 - Bed Loft-Type', 5),
  ('501 B', '1 - Bed Loft-Type', 5),
  ('502', '4 - Bed Sharing', 5),
  ('503', 'Solo Room', 5),
  ('504', '4 - Bed Sharing', 5),
  ('505', '2 - Bed Sharing', 5),
  ('506', '4 - Bed Sharing', 5),
  ('601', '6 - Bed Sharing', 6),
  ('602', '2 - Bed Sharing', 6),
  ('603', 'Solo Room', 6),
  ('604', 'Solo Room', 6),
  ('605', '2 - Bed Sharing', 6),
  ('606', 'Solo Room', 6),
  ('701', '6 - Bed Sharing', 7),
  ('702', 'Solo Room', 7),
  ('703', 'Solo Room', 7),
  ('704', '4 - Bed Sharing', 7),
  ('705', '2 - Bed Sharing', 7),
  ('706', '4 - Bed Sharing', 7)
on conflict (room_no) do nothing;

insert into public.sim_beds (sim_room_id, bed_letter, rate, is_out_of_order)
select sr.id, v.bed_letter, v.rate, v.is_out_of_order
from (values
  ('301', 'A', 4750.00, false),
  ('301', 'B', 4750.00, false),
  ('301', 'D', 4750.00, false),
  ('301', 'C', 4500.00, false),
  ('301', 'E', 4500.00, false),
  ('301', 'F', 4500.00, false),
  ('302', 'A', 6750.00, false),
  ('302', 'B', 6500.00, false),
  ('303', 'A', 5000.00, false),
  ('303', 'B', 5000.00, false),
  ('303', 'C', 5000.00, false),
  ('303', 'D', 5000.00, false),
  ('304', 'A', 5000.00, false),
  ('304', 'B', 5000.00, false),
  ('304', 'C', 5000.00, false),
  ('304', 'D', 5000.00, false),
  ('305', 'A', 6750.00, false),
  ('305', 'B', 6500.00, false),
  ('306', 'A', 5000.00, false),
  ('306', 'B', 5000.00, false),
  ('306', 'C', 5000.00, false),
  ('306', 'D', 5000.00, false),
  ('401', 'A', 4750.00, false),
  ('401', 'B', 4750.00, false),
  ('401', 'C', 4750.00, false),
  ('401', 'D', 4500.00, false),
  ('401', 'E', 4500.00, false),
  ('401', 'F', 4500.00, false),
  ('402', 'A', 6750.00, false),
  ('402', 'B', 6500.00, false),
  ('403', 'A', 5000.00, false),
  ('403', 'B', 5000.00, false),
  ('403', 'C', 5000.00, false),
  ('403', 'D', 5000.00, false),
  ('404', 'A', 6750.00, false),
  ('404', 'B', 6500.00, false),
  ('405', 'A', 6750.00, false),
  ('405', 'B', 6500.00, false),
  ('406', 'A', 10000.00, false),
  ('501 A', 'A', 9000.00, false),
  ('501 B', 'B', 9000.00, false),
  ('502', 'A', 5000.00, false),
  ('502', 'B', 5000.00, false),
  ('502', 'C', 5000.00, false),
  ('502', 'D', 5000.00, false),
  ('503', 'A', 10000.00, false),
  ('504', 'A', 5000.00, false),
  ('504', 'B', 5000.00, false),
  ('504', 'C', 5000.00, false),
  ('504', 'D', 5000.00, false),
  ('505', 'A', 6750.00, false),
  ('505', 'B', 6500.00, false),
  ('506', 'A', 5000.00, false),
  ('506', 'B', 5000.00, false),
  ('506', 'C', 5000.00, false),
  ('506', 'D', 5000.00, false),
  ('601', 'A', 4750.00, false),
  ('601', 'B', 4750.00, false),
  ('601', 'C', 4750.00, false),
  ('601', 'D', 4500.00, false),
  ('601', 'E', 4500.00, false),
  ('601', 'F', 4500.00, false),
  ('602', 'A', 6750.00, false),
  ('602', 'B', 6500.00, false),
  ('603', 'A', 10000.00, false),
  ('604', 'A', 10000.00, false),
  ('605', 'A', 6750.00, false),
  ('605', 'B', 6500.00, false),
  ('606', 'A', 10000.00, false),
  ('701', 'A', 4750.00, false),
  ('701', 'B', 4750.00, false),
  ('701', 'C', 4750.00, false),
  ('701', 'D', 4500.00, false),
  ('701', 'E', 4500.00, false),
  ('701', 'F', 4500.00, false),
  ('702', 'A', null, true),
  ('703', 'A', 10000.00, false),
  ('704', 'A', 5000.00, false),
  ('704', 'B', 5000.00, false),
  ('704', 'C', 5000.00, false),
  ('704', 'D', 5000.00, false),
  ('705', 'A', 6750.00, false),
  ('705', 'B', 6500.00, false),
  ('706', 'A', null, true),
  ('706', 'B', null, true),
  ('706', 'C', null, true),
  ('706', 'D', null, true)
) as v(room_no, bed_letter, rate, is_out_of_order)
join public.sim_rooms sr on sr.room_no = v.room_no
on conflict (sim_room_id, bed_letter) do nothing;

-- ════════════════════════════════════════════════════════════════
-- 9. SEED DATA (as of July 28, 2026)
-- TRUNCATE wipes all data — remove these lines to skip the reset.
-- ════════════════════════════════════════════════════════════════

truncate table rooms, cutoffs, activity_log cascade;

select setval(pg_get_serial_sequence('rooms',         'id'), 1, false);
select setval(pg_get_serial_sequence('beds',          'id'), 1, false);
select setval(pg_get_serial_sequence('tenants',       'id'), 1, false);
select setval(pg_get_serial_sequence('cutoffs',       'id'), 1, false);
select setval(pg_get_serial_sequence('meter_readings','id'), 1, false);
select setval(pg_get_serial_sequence('addons',        'id'), 1, false);

-- ── Rooms ────────────────────────────────────────────────────────
-- 406, 503, 603, 604, 606, 703 corrected to Solo Room
insert into rooms (room_no, room_type, floor) values
  ('301','6-Bed Sharing',3), ('302','2-Bed Sharing',3),
  ('303','4-Bed Sharing',3), ('304','4-Bed Sharing',3),
  ('305','2-Bed Sharing',3), ('306','4-Bed Sharing',3),
  ('401','6-Bed Sharing',4), ('402','2-Bed Sharing',4),
  ('403','2-Bed Sharing',4), ('404','2-Bed Sharing',4),
  ('405','2-Bed Sharing',4), ('406','Solo Room',4),
  ('501','6-Bed Sharing',5), ('502','4-Bed Sharing',5),
  ('503','Solo Room',5),     ('504','4-Bed Sharing',5),
  ('505','2-Bed Sharing',5), ('506','4-Bed Sharing',5),
  ('601','6-Bed Sharing',6), ('602','2-Bed Sharing',6),
  ('603','Solo Room',6),     ('604','Solo Room',6),
  ('605','2-Bed Sharing',6), ('606','Solo Room',6),
  ('701','6-Bed Sharing',7), ('702','4-Bed Sharing',7),
  ('703','Solo Room',7),     ('704','4-Bed Sharing',7),
  ('705','2-Bed Sharing',7), ('706','4-Bed Sharing',7);

-- ── Beds ─────────────────────────────────────────────────────────
-- 2-bed A+C: 302,402,403,602  |  2-bed A+B: 305,404,405,505,605,705
-- Solo A: 406,503,603,703  |  604=bed B only  |  606=bed C only
-- 702,706: OUT OF ORDER
insert into beds (room_id, bed_letter, bed_location, default_rate, status)
select r.id, v.bl, v.loc, v.dr::numeric, v.st
from rooms r
join (values
  ('301','A','LOWER',4750,'LEASED'),  ('301','B','LOWER',4750,'LEASED'),
  ('301','C','UPPER',4500,'LEASED'),  ('301','D','LOWER',4750,'LEASED'),
  ('301','E','UPPER',4500,'VACANT'),  ('301','F','UPPER',4500,'VACANT'),
  ('302','A','LOWER',6750,'LEASED'),  ('302','C','UPPER',6500,'LEASED'),
  ('303','A','LOWER',5000,'LEASED'),  ('303','B','LOWER',5000,'LEASED'),
  ('303','C','UPPER',5000,'LEASED'),  ('303','D','UPPER',5000,'VACANT'),
  ('304','A','LOWER',5000,'LEASED'),  ('304','B','LOWER',5000,'VACANT'),
  ('304','C','UPPER',5000,'VACANT'),  ('304','D','UPPER',5000,'VACANT'),
  ('305','A','LOWER',6750,'LEASED'),  ('305','B','UPPER',6500,'VACANT'),
  ('306','A','LOWER',5000,'LEASED'),  ('306','B','LOWER',5000,'LEASED'),
  ('306','C','UPPER',5000,'LEASED'),  ('306','D','UPPER',5000,'LEASED'),
  ('401','A','LOWER',4750,'LEASED'),  ('401','B','LOWER',4750,'VACANT'),
  ('401','C','LOWER',4750,'LEASED'),  ('401','D','UPPER',4500,'VACANT'),
  ('401','E','UPPER',4500,'VACANT'),  ('401','F','UPPER',4500,'VACANT'),
  ('402','A','LOWER',6750,'LEASED'),  ('402','C','UPPER',6500,'LEASED'),
  ('403','A','LOWER',6500,'LEASED'),  ('403','C','UPPER',6500,'LEASED'),
  ('404','A','LOWER',6750,'RESERVED'),('404','B','LOWER',6500,'VACANT'),
  ('405','A','LOWER',6750,'LEASED'),  ('405','B','UPPER',6500,'RESERVED'),
  ('406','A','LOWER',8000,'LEASED'),
  ('501','A','LOWER',4750,'VACANT'),  ('501','B','LOWER',4750,'VACANT'),
  ('501','C','LOWER',4750,'VACANT'),  ('501','D','UPPER',4500,'VACANT'),
  ('501','E','UPPER',4500,'VACANT'),  ('501','F','UPPER',4500,'VACANT'),
  ('502','A','LOWER',5000,'LEASED'),  ('502','B','LOWER',5000,'LEASED'),
  ('502','C','UPPER',5000,'LEASED'),  ('502','D','UPPER',5000,'VACANT'),
  ('503','A','LOWER',8500,'LEASED'),
  ('504','A','LOWER',5000,'LEASED'),  ('504','B','LOWER',5000,'LEASED'),
  ('504','C','UPPER',5000,'LEASED'),  ('504','D','UPPER',5000,'VACANT'),
  ('505','A','LOWER',6750,'LEASED'),  ('505','B','UPPER',6500,'LEASED'),
  ('506','A','LOWER',5000,'LEASED'),  ('506','B','LOWER',5000,'LEASED'),
  ('506','C','UPPER',5000,'VACANT'),  ('506','D','UPPER',5000,'VACANT'),
  ('601','A','LOWER',4750,'LEASED'),  ('601','B','LOWER',4750,'LEASED'),
  ('601','C','LOWER',4750,'LEASED'),  ('601','D','UPPER',4500,'VACANT'),
  ('601','E','UPPER',4500,'VACANT'),  ('601','F','UPPER',4500,'VACANT'),
  ('602','A','LOWER',6750,'LEASED'),  ('602','C','UPPER',6500,'VACANT'),
  ('603','A','LOWER',8500,'LEASED'),
  ('604','B','LOWER',9000,'LEASED'),
  ('605','A','LOWER',6000,'LEASED'),  ('605','B','UPPER',6500,'LEASED'),
  ('606','C','LOWER',8500,'RESERVED'),
  ('701','A','LOWER',4750,'LEASED'),  ('701','B','LOWER',4750,'LEASED'),
  ('701','C','LOWER',4750,'RESERVED'),('701','D','UPPER',4500,'LEASED'),
  ('701','E','UPPER',4500,'RESERVED'),('701','F','UPPER',4500,'RESERVED'),
  ('702','A','LOWER',0,'OUT OF ORDER'),('702','B','LOWER',0,'OUT OF ORDER'),
  ('702','C','UPPER',0,'OUT OF ORDER'),('702','D','UPPER',0,'OUT OF ORDER'),
  ('703','A','LOWER',8000,'LEASED'),
  ('704','A','LOWER',5000,'LEASED'),  ('704','B','LOWER',5000,'LEASED'),
  ('704','C','UPPER',5000,'VACANT'),  ('704','D','UPPER',5000,'VACANT'),
  ('705','A','LOWER',6750,'LEASED'),  ('705','B','UPPER',6000,'LEASED'),
  ('706','A','LOWER',0,'OUT OF ORDER'),('706','B','LOWER',0,'OUT OF ORDER'),
  ('706','C','UPPER',0,'OUT OF ORDER'),('706','D','UPPER',0,'OUT OF ORDER')
) as v(room_no, bl, loc, dr, st) on r.room_no = v.room_no;

-- ── Tenants ──────────────────────────────────────────────────────
insert into tenants
  (bed_id, name, gender, rate, duration,
   move_in_date, move_out_date, last_pay_10th, last_pay_eom,
   contact_no, email, is_active)
select
  b.id,
  v.name, v.gender, v.rate::numeric, nullif(v.dur,''),
  nullif(v.mi,'')::date,  nullif(v.mo,'')::date,
  nullif(v.lp10,'')::date, nullif(v.lpeo,'')::date,
  nullif(v.phone,''), nullif(v.mail,''),
  true
from beds b
join rooms r on r.id = b.room_id
join (values
  -- 301
  ('301','A','Alyiah Marie Bulilan',         'F',4000,'25 Months','2024-08-27','2026-09-27','2026-04-23','2026-05-13','9610177360','alyiahmarie26@gmail.com'),
  ('301','B','Shaira Solano',                'F',4000,'23 Months','2024-08-22','2026-07-31','2026-02-19','2026-05-09','9663797963','shairasolano@gmail.com'),
  ('301','C','Romynah Jayne Rasay',          'F',4500,'15 Months','2025-07-01','2026-10-01','2026-04-20','2026-05-06','',''),
  ('301','D','Leicel Kaye Concepcion',       'F',4750,'2 Months', '2026-05-31','2026-07-31','','','',''),
  -- 302
  ('302','A','Kim Sung Soo',                 'M',6750,'3 Months', '2026-07-12','2026-10-12','2026-04-16','2026-05-08','',''),
  ('302','C','Jacob Joshua Elias Quiogue',   'M',6500,'6 Months', '2026-04-23','2026-10-23','2026-04-23','2026-04-23','',''),
  -- 303
  ('303','A','Cheska Andrea Bullo',          'F',5000,'34 Months','2023-11-28','2026-09-28','2026-04-16','2026-05-01','9955385029','pabruabullocheska@gmail.com'),
  ('303','B','Jolina Anne Navalta',          'F',5000,'1 Month',  '2026-07-11','2026-08-11','2026-04-30','2026-05-11','',''),
  ('303','C','Sofia Micah Nicole Isla',      'F',5000,'5 Months', '2026-07-26','2026-12-26','','','',''),
  -- 304
  ('304','A','John Paul Sarabillo',          'M',5000,'',         '2026-07-26','','2026-04-20','2026-04-20','',''),
  -- 305
  ('305','A','Klint Adrian Trangia',         'M',6750,'12 Months','2025-08-02','2026-08-02','2026-05-04','2026-04-10','',''),
  -- 306
  ('306','A','Arvin Atole',                  'M',5000,'23 Months','2024-09-15','2026-08-31','2026-04-15','2026-05-04','9617444092','arvinatole@gmail.com'),
  ('306','B','Marcus Zedric Capulong',       'M',5000,'15 Months','2025-05-19','2026-08-19','2026-04-08','2026-04-08','',''),
  ('306','C','Gabriel Fidel Basa',           'M',5000,'13 Months','2025-08-24','2026-09-24','2026-04-21','2026-04-21','',''),
  ('306','D','Lyle Jeremy Rosales',          'M',5000,'9 Months', '2025-12-18','2026-09-18','2026-04-22','2026-05-07','',''),
  -- 401
  ('401','A','Ryan Rafael Gonzales',         'M',4750,'16 Months','2025-05-01','2026-09-01','2026-04-21','2026-05-08','',''),
  ('401','C','Joseph Corpuz',                'M',4750,'6 Months', '2026-04-20','2026-10-20','','','',''),
  -- 402
  ('402','A','Patricia Salma Isabel Ronatay','F',6500,'26 Months','2024-07-20','2026-09-20','2026-04-30','2026-04-21','9567433445','salmaronatay@gmail.com'),
  ('402','C','Kieza Mae Pacete',             'F',6500,'24 Months','2024-08-24','2026-08-24','2026-04-29','2026-04-10','9661775566','kiezamaepacete@gmail.com'),
  -- 403 (same person pays for both beds)
  ('403','A','Christian P. Gregorio',        'M',6500,'28 Months','2024-03-30','2026-07-31','2026-04-30','2026-04-30','9604422511','christiangregorio62@gmail.com'),
  ('403','C','Christian P. Gregorio',        'M',6500,'28 Months','2024-03-30','2026-07-31','2026-04-30','2026-04-30','9604422511','christiangregorio62@gmail.com'),
  -- 404 RESERVED
  ('404','A','Kerri Maeve Agan',             'F',6750,'',         '2026-08-01','2026-09-01','','','',''),
  -- 405
  ('405','A','Vivian Panizares',             'F',6750,'3 Months', '2026-05-17','2026-08-17','','','',''),
  ('405','B','Loraine Sancio',               'F',6500,'',         '2026-07-27','','2026-04-20','2026-05-08','',''),
  -- 406
  ('406','A','Razeil Orioste',               'F',8000,'6 Months', '2026-03-14','2026-09-14','2026-04-17','2026-05-11','',''),
  -- 502
  ('502','A','Athena Gresha Camarao',        'F',5000,'17 Months','2025-07-31','2026-12-31','2026-04-23','2026-04-23','',''),
  ('502','B','Kristin Belle Deapera',        'F',5000,'7 Months', '2026-01-26','2026-08-26','2026-04-18','2026-05-07','',''),
  ('502','C','Darilla Love Joy Gonzaga',     'F',5000,'10 Months','2026-02-28','2026-12-28','2026-05-04','2026-04-22','',''),
  -- 503
  ('503','A','Alyssa Meira Serran',          'F',8500,'22 Months','2025-03-06','2027-01-27','2026-04-27','2026-04-10','',''),
  -- 504
  ('504','A','John Eric Rosario',            'M',5000,'7 Months', '2025-12-29','2026-08-27','2026-04-30','2026-05-14','',''),
  ('504','B','Jay Ar Adarlo 2',              'M',5000,'1 Month',  '2026-07-10','2026-08-10','2026-06-01','2026-06-01','',''),
  ('504','C','Dan Rilleson Llamoso',         'M',5000,'6 Months', '2026-07-25','2027-01-25','','','',''),
  -- 505
  ('505','A','Joana Marie Garcia',           'F',6750,'15 Months','2025-06-29','2026-09-29','2026-04-06','2026-04-06','',''),
  ('505','B','Mayvelle Vasquez',             'F',6500,'3 Months', '2026-07-26','2026-10-26','2026-05-01','2026-05-01','',''),
  -- 506
  ('506','A','Kriztel Narvaez',              'F',5000,'3 Months', '2026-05-11','2026-08-11','2026-05-11','2026-05-11','9691977440','domalenz@gmail.com'),
  ('506','B','Lieni Doma',                   'F',5000,'23 Months','2024-09-23','2026-08-23','2026-04-27','2026-04-27','',''),
  -- 601
  ('601','A','Kyla Alyssa Oliva',            'F',4750,'16 Months','2025-04-27','2026-08-27','2026-04-20','2026-05-07','',''),
  ('601','B','LJ Barrido',                   'F',4750,'3 Months', '2026-07-26','2026-10-26','','','',''),
  ('601','C','Rhea Mae Elcano',              'F',4750,'1 Month',  '2026-07-13','2026-08-13','','','',''),
  -- 602
  ('602','A','Franz Rowin Sarmiento',        'M',6750,'4 Months', '2026-05-10','2026-10-09','2026-05-09','2026-05-09','',''),
  -- 603
  ('603','A','John Bryan Baul',              'M',8500,'6 Months', '2026-07-15','2027-01-15','','','',''),
  -- 604
  ('604','B','Joshua Bogbog',                'M',9000,'3 Months', '2026-07-19','2026-10-19','','','',''),
  -- 605
  ('605','A','Rio Pescador',                 'F',6000,'25 Months','2024-07-10','2026-08-10','2026-05-10','2026-05-10','',''),
  ('605','B','Yasmin Reign Sidamon',         'F',6500,'12 Months','2025-08-31','2026-09-30','2026-04-16','2026-05-08','',''),
  -- 606 RESERVED
  ('606','C','Cassandra Camille Gravador',   'F',8500,'',         '2026-07-28','2027-01-28','2026-04-20','2026-05-13','',''),
  -- 701
  ('701','A','John Carlo Saure',             'M',4750,'3 Months', '2026-05-21','2026-08-21','','','',''),
  ('701','B','Junel Aquino',                 'M',4750,'6 Months', '2026-05-24','2026-11-24','','','',''),
  ('701','C','Rafael Quizon',                'M',4750,'',         '2026-08-02','2026-11-02','2026-04-20','2026-05-07','',''),
  ('701','D','Jestoni Anulao',               'M',4500,'8 Months', '2025-11-30','2026-07-31','','','',''),
  ('701','E','Alexis Emmanuel Decena',       'M',4500,'',         '2026-07-29','','','','',''),
  ('701','F','Duq B. Encabo',                'M',4500,'',         '2026-08-03','','','','',''),
  -- 703
  ('703','A','Ian Dominic De Guzman',        'M',8000,'6 Months', '2026-03-29','2026-09-29','2026-04-16','2026-05-06','',''),
  -- 704
  ('704','A','Lara Lieneth Sotomayor',       'F',5000,'12 Months','2025-08-24','2026-08-24','2026-04-18','2026-04-18','',''),
  ('704','B','Raven Allison Chavez',         'F',5000,'6 Months', '2026-07-25','2027-01-25','','','',''),
  -- 705
  ('705','A','Alven Pulla',                  'M',6750,'8 Months', '2026-01-10','2026-09-19','2026-04-17','2026-05-08','',''),
  ('705','B','ABCDE Jedidiah Condez',        'M',6000,'25 Months','2024-09-23','2026-10-23','2026-04-18','2026-05-11','9298018000','ajcondez1401@gmail.com')
) as v(room_no, bl, name, gender, rate, dur, mi, mo, lp10, lpeo, phone, mail)
on r.room_no = v.room_no and b.bed_letter = v.bl;

-- Special tenants (no bed)
insert into tenants (name, category, unit_label, rate, is_active) values
  ('JB Water Refilling Station','COMMERCIAL',   'JB Water Refilling Station', 21973.21, true),
  ('Anthony Salvador',           'PARKING_ONLY', 'Parking – Anthony',           6000.00,  true);

-- Alyssa Meira Serran — motorcycle parking, ₱1,500 recurring
insert into addons (tenant_id, cutoff_id, label, category, bill_on, amount, recurring)
select t.id, null, 'Motorcycle Parking', 'PARKING_MC', 'RENT_WATER', 1500, true
from tenants t
join beds  b on b.id = t.bed_id
join rooms r on r.id = b.room_id
where r.room_no = '503' and b.bed_letter = 'A' and t.is_active = true;

-- ── July 2026 cutoff (completed) ─────────────────────────────────
-- Billing issued July 2026. Named by billing month (reading dates:
-- water as of Jul 1, electric as of Jul 10).
-- Period: Water Jun 1→Jul 1 | Electric Jun 10→Jul 10
-- Main line: Manila Water 12453→12784 (331 m³ ₱35,610.95)
--            Meralco 1458→1502 (7,040 kWh ₱66,615.83 — CT multiplier applied)
insert into cutoffs
  (name, water_start, water_end, electric_start, electric_end,
   water_maynilad_rate, water_bedspace_rate,
   electric_meralco_rate, electric_bedspace_rate,
   water_main_prev, water_main_curr, water_main_consumption, water_main_amount,
   water_markup_pct, water_rate_override,
   electric_main_prev, electric_main_curr, electric_main_consumption, electric_main_amount,
   electric_markup_pct, electric_rate_override,
   is_active)
values
  ('July 2026','2026-06-01','2026-07-01','2026-06-10','2026-07-10',
   140.66, 154.72, 15.69, 22.00,
   12453, 12784, 331, 35610.95,
   10, true,
   1458, 1502, 7040, 66615.83,
   10, true,
   true);

-- ── July 2026 meter readings ──────────────────────────────────────
insert into meter_readings (cutoff_id, room_id, utility, previous_reading, current_reading, rate)
select c.id, r.id, v.util, v.prev::numeric, v.curr::numeric, v.rt::numeric
from (values
  ('301','WATER', 413,  424,  154.72), ('301','ELECTRIC', 10297, 10434, 22.00),
  ('302','WATER', 148,  151,  154.72), ('302','ELECTRIC',  4676,  4793, 22.00),
  ('303','WATER', 296,  302,  154.72), ('303','ELECTRIC',  6590,  6717, 22.00),
  ('304','WATER', 147,  148,  154.72), ('304','ELECTRIC',  7288,  7305, 22.00),
  ('305','WATER', 181,  181,  154.72), ('305','ELECTRIC',  5957,  5957, 22.00),
  ('306','WATER', 197,  208,  154.72), ('306','ELECTRIC',  6013,  6158, 22.00),
  ('401','WATER', 455,  461,  154.72), ('401','ELECTRIC', 15841, 16106, 22.00),
  ('402','WATER', 236,  239,  154.72), ('402','ELECTRIC',  5525,  5568, 22.00),
  ('403','WATER', 168,  171,  154.72), ('403','ELECTRIC',  6402,  6626, 22.00),
  ('404','WATER', 186,  187,  154.72), ('404','ELECTRIC',  4000,  4048, 22.00),
  ('405','WATER', 227,  232,  154.72), ('405','ELECTRIC', 14048, 14079, 22.00),
  ('406','WATER', 117,  119,  154.72), ('406','ELECTRIC',  3317,  3440, 22.00),
  ('501','WATER', 364,  368,  154.72), ('501','ELECTRIC', 11114, 11183, 22.00),
  ('502','WATER', 225,  235,  154.72), ('502','ELECTRIC',  6718,  6940, 22.00),
  ('503','WATER', 171,  176,  154.72), ('503','ELECTRIC',  3929,  4066, 22.00),
  ('504','WATER', 493,  498,  154.72), ('504','ELECTRIC',  7336,  7465, 22.00),
  ('505','WATER', 205,  205,  154.72), ('505','ELECTRIC',  7904,  7905, 22.00),
  ('506','WATER',  72,   75,  154.72), ('506','ELECTRIC',  4065,  4259, 22.00),
  ('601','WATER', 291,  292,  154.72), ('601','ELECTRIC', 11921, 11962, 22.00),
  ('602','WATER', 180,  181,  154.72), ('602','ELECTRIC',  3296,  3320, 22.00),
  ('603','WATER',  99,   99,  154.72), ('603','ELECTRIC',  3446,  3446, 22.00),
  ('604','WATER', 112,  118,  154.72), ('604','ELECTRIC',  3906,  4147, 22.00),
  ('605','WATER', 137,  142,  154.72), ('605','ELECTRIC',  7398,  7447, 22.00),
  ('606','WATER',  84,   90,  154.72), ('606','ELECTRIC',  4332,  4454, 22.00),
  ('701','WATER', 309,  314,  154.72), ('701','ELECTRIC', 16998, 17210, 22.00),
  ('702','WATER', 175,  178,  154.72), ('702','ELECTRIC',  7153,  7446, 22.00),
  ('703','WATER', 120,  122,  154.72), ('703','ELECTRIC',  1753,  1776, 22.00),
  ('704','WATER', 157,  164,  154.72), ('704','ELECTRIC',  4232,  4343, 22.00),
  ('705','WATER', 143,  148,  154.72), ('705','ELECTRIC',  7198,  7446, 22.00),
  ('706','WATER', 107,  107,  154.72), ('706','ELECTRIC',  2209,  2209, 22.00)
) as v(room_no, util, prev, curr, rt)
join rooms r on r.room_no = v.room_no
cross join (select id from cutoffs where name = 'July 2026') as c;

-- ── July 2026 area readings ───────────────────────────────────────
-- WATER: common areas at standard Manila Water rate; Commercial at bedspace rate
insert into area_readings (cutoff_id, area_name, utility, previous_reading, current_reading, rate_type, tenant_id)
select c.id, v.area, 'WATER', v.prev::numeric, v.curr::numeric, v.rt,
       case when v.area = 'Commercial' then (select t.id from tenants t where t.category = 'COMMERCIAL' limit 1) else null end
from (values
  ('Second Floor',  1057, 1073, 'STANDARD'),
  ('Roof Deck',      381,  388, 'STANDARD'),
  ('Commercial',    6645, 6855, 'BEDSPACE')
) as v(area, prev, curr, rt)
cross join (select id from cutoffs where name = 'July 2026') as c;

-- ELECTRIC: common areas at standard Meralco rate; Commercial at bedspace rate
insert into area_readings (cutoff_id, area_name, utility, previous_reading, current_reading, rate_type, tenant_id)
select c.id, v.area, 'ELECTRIC', v.prev::numeric, v.curr::numeric, v.rt,
       case when v.area = 'Commercial' then (select t.id from tenants t where t.category = 'COMMERCIAL' limit 1) else null end
from (values
  ('Lobby',      50671, 51830, 'STANDARD'),
  ('Second Floor',  36402, 36817, 'STANDARD'),
  ('Roof Deck',   3678,  3716, 'STANDARD'),
  ('Commercial', 24433, 24887, 'BEDSPACE')
) as v(area, prev, curr, rt)
cross join (select id from cutoffs where name = 'July 2026') as c;

-- ── Verify ───────────────────────────────────────────────────────
select
  (select count(*) from rooms)                            as rooms,          -- 30
  (select count(*) from beds)                             as beds,           -- 92
  (select count(*) from tenants where bed_id is not null) as bed_tenants,    -- 56
  (select count(*) from tenants where bed_id is null)     as special_tenants,--  2
  (select count(*) from cutoffs)                          as cutoffs,        --  1
  (select count(*) from meter_readings)                   as meter_readings, --  60
  (select count(*) from addons)                           as addons;         --  1

-- ════════════════════════════════════════════════════════════════
-- OPTIONAL: TEST ACCOUNTS
-- Uncomment the block below to seed two test users.
--   user@test.com   → role: user   (day-to-day ops)   password: Test1234!
--   viewer@test.com → role: viewer (read-only)         password: Test1234!
-- ════════════════════════════════════════════════════════════════
/*
do $$
declare
  user_uuid   uuid := 'aaaaaaaa-0000-0000-0000-000000000001';
  viewer_uuid uuid := 'aaaaaaaa-0000-0000-0000-000000000002';
begin
  insert into auth.users (
    instance_id, id, aud, role, email, encrypted_password, email_confirmed_at,
    raw_app_meta_data, raw_user_meta_data, created_at, updated_at,
    confirmation_token, email_change, email_change_token_new, recovery_token
  ) values
    ('00000000-0000-0000-0000-000000000000', user_uuid,
     'authenticated','authenticated','user@test.com',
     crypt('Test1234!', gen_salt('bf')), now(),
     '{"provider":"email","providers":["email"]}','{}',
     now(),now(),'','','',''),
    ('00000000-0000-0000-0000-000000000000', viewer_uuid,
     'authenticated','authenticated','viewer@test.com',
     crypt('Test1234!', gen_salt('bf')), now(),
     '{"provider":"email","providers":["email"]}','{}',
     now(),now(),'','','','')
  on conflict (id) do nothing;

  insert into auth.identities (provider_id, user_id, identity_data, provider, last_sign_in_at, created_at, updated_at)
  values
    (user_uuid::text,   user_uuid,   json_build_object('sub',user_uuid::text,  'email','user@test.com'),   'email',now(),now(),now()),
    (viewer_uuid::text, viewer_uuid, json_build_object('sub',viewer_uuid::text,'email','viewer@test.com'), 'email',now(),now(),now())
  on conflict (provider, provider_id) do nothing;
end $$;

update public.profiles set role = 'user' where email = 'user@test.com';
*/
