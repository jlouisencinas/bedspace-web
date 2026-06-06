-- ============================================================
-- Billing — interim (move-out) meter readings
--
-- When a tenant moves out mid-cutoff you record the ROOM meter
-- reading on that date. This slices the cutoff into segments with
-- exact (metered) consumption, which the app splits per tenant
-- using per-day occupancy (Method B). No estimation.
--
-- Run in Supabase SQL Editor.
-- ============================================================

create table if not exists interim_readings (
  id                   serial primary key,
  cutoff_id            int references cutoffs(id) on delete cascade,
  room_id              int references rooms(id)   on delete cascade,
  utility              text not null check (utility in ('WATER','ELECTRIC')),
  reading_date         date not null,
  reading_value        numeric(12,2) not null,
  moving_out_tenant_id int references tenants(id),   -- optional, for reference
  note                 text,
  created_at           timestamptz default now()
);

create index if not exists idx_interim_cutoff_room
  on interim_readings(cutoff_id, room_id, utility);

alter table interim_readings disable row level security;
