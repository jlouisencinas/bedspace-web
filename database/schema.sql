-- ============================================================
-- Bedspace Manager — Supabase Database Schema
--
-- Run this in: Supabase Dashboard → SQL Editor → Run
-- ============================================================

-- ── Rooms ────────────────────────────────────────────────────
create table if not exists rooms (
  id          serial primary key,
  room_no     text not null unique,
  room_type   text,
  floor       int,
  created_at  timestamptz default now()
);

-- ── Beds ─────────────────────────────────────────────────────
create table if not exists beds (
  id           serial primary key,
  room_id      int references rooms(id) on delete cascade,
  bed_letter   text not null,          -- A, B, C …
  bed_location text,                   -- LOWER | UPPER
  default_rate numeric(10,2),
  status       text default 'VACANT',  -- VACANT | LEASED | RESERVED | OUT OF ORDER
  created_at   timestamptz default now(),
  unique(room_id, bed_letter)
);

-- ── Tenants (active + historical) ────────────────────────────
-- last_pay_10th / last_pay_eom are stored directly here
-- (matches Google Sheets structure — only the latest date is needed).
-- Full payment history is in the payments table for future reference.
create table if not exists tenants (
  id                     serial primary key,
  bed_id                 int references beds(id),
  tenant_no              text,
  name                   text not null,
  gender                 text,
  rate                   numeric(10,2),
  duration               text,
  move_in_date           date,
  move_out_date          date,
  actual_move_out_date   date,
  last_pay_10th          date,          -- Last Payment Date 10th
  last_pay_eom           date,          -- Last Payment Date EOM
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
  is_active              boolean default true,
  created_at             timestamptz default now()
);

-- ── Payments (full history for future reference) ──────────────
create table if not exists payments (
  id           serial primary key,
  tenant_id    int references tenants(id),
  payment_date date not null,
  amount       numeric(10,2),
  pay_type     text,   -- '10th' | 'EOM' | 'Other'
  notes        text,
  created_at   timestamptz default now()
);

-- ── Activity Log ─────────────────────────────────────────────
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
  activity_type        text,   -- 'Move In' | 'Move Out'
  recorded_at          timestamptz default now()
);

-- ── Disable Row Level Security (internal app — add auth later if needed) ──
alter table rooms        disable row level security;
alter table beds         disable row level security;
alter table tenants      disable row level security;
alter table payments     disable row level security;
alter table activity_log disable row level security;

-- ── Seed rooms + beds (matches actual PROPERTY SUMMARY layout) ───────────────
-- IMPORTANT: rooms and beds are inserted in TWO SEPARATE statements.
-- (A data-modifying CTE's inserts are NOT visible to a table reference in the
--  same statement, so the beds insert must run after rooms is committed.)

-- A temporary definition table so both inserts can share the same source list.
create temporary table room_def (
  room_no text, room_type text, floor int, bed_count int, bed_status text
) on commit drop;

-- bed_status: default 'VACANT'. Rooms 702 & 706 currently have no usable beds
-- (0 setup) so their beds are seeded as 'OUT OF ORDER' but still exist/show.
insert into room_def (room_no, room_type, floor, bed_count, bed_status) values
  ('301','6-Bed Sharing',3,6,'VACANT'), ('302','2-Bed Sharing',3,2,'VACANT'),
  ('303','4-Bed Sharing',3,4,'VACANT'), ('304','4-Bed Sharing',3,4,'VACANT'),
  ('305','2-Bed Sharing',3,2,'VACANT'), ('306','4-Bed Sharing',3,4,'VACANT'),
  ('401','6-Bed Sharing',4,6,'VACANT'), ('402','2-Bed Sharing',4,2,'VACANT'),
  ('403','2-Bed Sharing',4,2,'VACANT'), ('404','2-Bed Sharing',4,2,'VACANT'),
  ('405','2-Bed Sharing',4,2,'VACANT'), ('406','Studio Room',4,1,'VACANT'),
  ('501','6-Bed Sharing',5,6,'VACANT'), ('502','4-Bed Sharing',5,4,'VACANT'),
  ('503','4-Bed Sharing',5,4,'VACANT'), ('504','4-Bed Sharing',5,4,'VACANT'),
  ('505','2-Bed Sharing',5,2,'VACANT'), ('506','4-Bed Sharing',5,4,'VACANT'),
  ('601','6-Bed Sharing',6,6,'VACANT'), ('602','2-Bed Sharing',6,2,'VACANT'),
  ('603','4-Bed Sharing',6,2,'VACANT'), ('604','4-Bed Sharing',6,4,'VACANT'),
  ('605','2-Bed Sharing',6,2,'VACANT'), ('606','Studio Room Upgraded',6,2,'VACANT'),
  ('701','6-Bed Sharing',7,6,'VACANT'), ('702','4-Bed Sharing',7,4,'OUT OF ORDER'),
  ('703','Studio Room',7,1,'VACANT'),   ('704','4-Bed Sharing',7,4,'VACANT'),
  ('705','2-Bed Sharing',7,2,'VACANT'), ('706','4-Bed Sharing',7,4,'OUT OF ORDER');

-- Statement 1: insert rooms
insert into rooms (room_no, room_type, floor)
select room_no, room_type, floor from room_def
on conflict (room_no) do nothing;

-- Statement 2: insert beds A..bed_count per room
-- Beds get alternating LOWER/UPPER (bunk arrangement: A=lower, B=upper, …).
insert into beds (room_id, bed_letter, bed_location, default_rate, status)
select
  r.id,
  chr(64 + g)                                       as bed_letter,  -- 65 = 'A'
  case when g % 2 = 1 then 'LOWER' else 'UPPER' end as bed_location,
  case
    when d.room_type like '6-%'      then 4000
    when d.room_type like '4-%'      then 5000
    when d.room_type like '2-%'      then 6000
    when d.room_type = 'Studio Room' then 8000
    else 10000   -- Studio Room Upgraded
  end                                               as default_rate,
  d.bed_status
from room_def d
join rooms r on r.room_no = d.room_no
cross join generate_series(1, d.bed_count) g
where d.bed_count > 0
  and not exists (
    select 1 from beds b where b.room_id = r.id and b.bed_letter = chr(64 + g)
  );

-- ── View: beds_with_tenant ────────────────────────────────────
-- Joins every bed to its current active tenant.
-- Includes all tenant columns so the UI only needs one query.
-- last_pay_10th / last_pay_eom come directly from the tenants row.
create or replace view beds_with_tenant as
select
  -- Bed
  b.id            as bed_id,
  b.bed_letter,
  b.bed_location,
  b.default_rate,
  b.status,
  -- Room
  r.id            as room_id,
  r.room_no,
  r.room_type,
  r.floor,
  -- Tenant (null when vacant)
  t.id            as tenant_id,
  t.tenant_no,
  t.name          as tenant_name,
  t.gender,
  t.rate,
  t.duration,
  t.move_in_date,
  t.move_out_date,
  t.last_pay_10th,
  t.last_pay_eom,
  t.contact_no,
  t.email,
  t.location_of_work,
  t.work_schedule,
  t.govt_id1,
  t.govt_id2,
  t.contract,
  t.emergency_contact_name,
  t.emergency_contact_no,
  t.comments
from beds b
join  rooms   r on r.id = b.room_id
left join tenants t on t.bed_id = b.id and t.is_active = true;

-- ── View: occupancy_summary ───────────────────────────────────
create or replace view occupancy_summary as
select
  r.room_no,
  r.room_type,
  count(b.id)                                               as total_beds,
  count(b.id) filter (where b.status = 'LEASED')           as leased,
  count(b.id) filter (where b.status = 'VACANT')           as vacant,
  count(b.id) filter (where b.status = 'RESERVED')         as reserved,
  coalesce(sum(t.rate) filter (where b.status = 'LEASED'), 0) as monthly_revenue
from rooms r
join  beds    b on b.room_id = r.id
left join tenants t on t.bed_id = b.id and t.is_active = true
group by r.id, r.room_no, r.room_type
order by r.room_no;
