-- ============================================================
-- Per-room custom utility split (overrides Method B for a cutoff).
-- Choose Water and/or Electric independently. Weights per (room,
-- utility) should total 100% so the room bill is fully distributed.
-- Rent is never split here (each tenant pays their own bed rate).
--
-- Run in Supabase SQL Editor.
-- ============================================================

create table if not exists tenant_splits (
  id          serial primary key,
  cutoff_id   int references cutoffs(id)  on delete cascade,
  room_id     int references rooms(id)    on delete cascade,
  tenant_id   int references tenants(id)  on delete cascade,
  utility     text not null check (utility in ('WATER','ELECTRIC')),
  weight_pct  numeric(6,2) not null default 0,
  created_at  timestamptz default now(),
  unique(cutoff_id, room_id, tenant_id, utility)
);

create index if not exists idx_splits_cutoff_room on tenant_splits(cutoff_id, room_id, utility);
alter table tenant_splits disable row level security;
