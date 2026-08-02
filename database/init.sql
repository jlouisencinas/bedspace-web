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
             check (role in ('admin','user','viewer')),
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
  check (role in ('admin','user','viewer'));

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
  id         serial primary key,
  label      text not null unique,
  category   text not null default 'RENT_WATER'
             check (category in ('RENT_WATER','ELECTRIC')),
  bill_on    text not null default 'RENT_WATER'
             check (bill_on in ('RENT_WATER','ELECTRIC')),
  is_active  boolean not null default true,
  created_at timestamptz default now()
);

-- Seed default add-on types
insert into addon_types (label, category, bill_on) values
  ('Parking',          'RENT_WATER', 'RENT_WATER'),
  ('Aircon Surcharge', 'ELECTRIC',   'ELECTRIC'),
  ('Laundry',          'RENT_WATER', 'RENT_WATER'),
  ('Extra Bed',        'RENT_WATER', 'RENT_WATER'),
  ('Pet Fee',          'RENT_WATER', 'RENT_WATER'),
  ('Key Deposit',      'RENT_WATER', 'RENT_WATER')
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
  occupied_beds  int,
  active_tenants int,
  occupied_rooms int,
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
  room_id          int  not null references rooms(id),
  tenant_id        int  references tenants(id),
  concern          text not null,
  remarks          text,
  status           text not null default 'PENDING'
                   check (status in ('PENDING','RESOLVED')),
  raised_at        timestamptz default now(),
  resolution_notes text,
  resolved_by      uuid references auth.users(id),
  resolved_at      timestamptz,
  created_at       timestamptz default now()
);

create index if not exists tickets_room_status_idx   on maintenance_tickets(room_id, status);
create index if not exists tickets_tenant_idx        on maintenance_tickets(tenant_id);
create index if not exists tickets_status_raised_idx on maintenance_tickets(status, raised_at desc);

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

-- profiles: each user reads only their own row.
alter table public.profiles enable row level security;
drop policy if exists profiles_self_select on public.profiles;
create policy profiles_self_select on public.profiles
  for select to authenticated using (id = auth.uid());

-- General tables: any authenticated session may read/write.
-- App-layer role checks (admin/user/viewer) are enforced in the UI.
do $$
declare t text;
begin
  foreach t in array array[
    'rooms','beds','payments','activity_log',
    'cutoffs','meter_readings','interim_readings','area_readings',
    'tenant_splits','addons','monthly_reports',
    'tenant_transfers','room_logs',
    -- extended tables
    'documents','invoices','payment_allocations','settlements',
    'tenant_contacts','tenant_documents','tenant_emails',
    'tenant_stays','tickets','addon_types'
  ] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('drop policy if exists app_authenticated_all on public.%I', t);
    execute format(
      'create policy app_authenticated_all on public.%I '
      'for all to authenticated using (true) with check (true)', t);
  end loop;
end $$;

-- tenants: select/insert = any authenticated; update/delete = admin only.
alter table public.tenants enable row level security;

drop policy if exists tenants_select on public.tenants;
create policy tenants_select on public.tenants
  for select to authenticated using (true);

drop policy if exists tenants_insert on public.tenants;
create policy tenants_insert on public.tenants
  for insert to authenticated with check (true);

drop policy if exists tenants_update on public.tenants;
create policy tenants_update on public.tenants
  for update to authenticated
  using (exists (
    select 1 from public.profiles where id = auth.uid() and role = 'admin'
  ));

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
  for select to authenticated using (true);

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
  for select to authenticated using (true);

drop policy if exists approval_requests_insert on public.approval_requests;
create policy approval_requests_insert on public.approval_requests
  for insert to authenticated
  with check (requester_id = auth.uid());

drop policy if exists approval_requests_update on public.approval_requests;
create policy approval_requests_update on public.approval_requests
  for update to authenticated
  using (exists (
    select 1 from public.profiles where id = auth.uid() and role = 'admin'
  ));

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
-- WATER: common areas at standard Maynilad rate; Commercial at bedspace rate
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
