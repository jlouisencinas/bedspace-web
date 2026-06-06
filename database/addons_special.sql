-- ============================================================
-- Special/commercial tenants (no bed) + per-tenant add-ons.
-- Run in Supabase SQL Editor.
-- ============================================================

-- 1. Tenants can exist without a bed (commercial / parking-only)
alter table tenants
  add column if not exists category   text not null default 'BED',  -- BED | COMMERCIAL | PARKING_ONLY | OTHER
  add column if not exists unit_label text;
alter table tenants alter column bed_id drop not null;

-- 2. Link a Commercial meter reading to its tenant (e.g. JB Water Refilling)
alter table area_readings add column if not exists tenant_id int references tenants(id);

-- 3. Add-ons / extra charges
create table if not exists addons (
  id         serial primary key,
  tenant_id  int references tenants(id) on delete cascade,
  cutoff_id  int references cutoffs(id) on delete cascade,   -- NULL = recurring (every cutoff)
  label      text not null,
  category   text default 'OTHER',          -- PARKING_CAR | PARKING_MC | AIRCON | OTHER
  bill_on    text not null default 'RENT_WATER' check (bill_on in ('RENT_WATER','ELECTRIC')),
  amount     numeric(12,2) not null default 0,
  hours      numeric(10,2),                 -- aircon: hours
  rate       numeric(12,4),                 -- aircon: manual rate
  recurring  boolean not null default false,
  created_at timestamptz default now()
);
create index if not exists idx_addons_tenant on addons(tenant_id);
alter table addons disable row level security;

-- 4. Seed special tenants (idempotent by name)
insert into tenants (name, category, unit_label, rate, is_active)
select 'JB Water Refilling Station', 'COMMERCIAL', 'JB Water Refilling Station', 21973.21, true
where not exists (select 1 from tenants where name = 'JB Water Refilling Station');

insert into tenants (name, category, unit_label, rate, is_active)
select 'V60 Cafe', 'COMMERCIAL', 'V60 Cafe', 6000, true
where not exists (select 1 from tenants where name = 'V60 Cafe');

insert into tenants (name, category, unit_label, rate, is_active)
select 'Anthony', 'PARKING_ONLY', 'Parking – Anthony', 6000, true
where not exists (select 1 from tenants where name = 'Anthony');

-- 5. Link every Commercial area reading to JB Water Refilling Station
update area_readings
set tenant_id = (select id from tenants where name = 'JB Water Refilling Station' limit 1)
where area_name = 'Commercial';
