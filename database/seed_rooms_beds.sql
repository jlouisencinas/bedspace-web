-- ============================================================
-- Seed ONLY rooms + beds (run this in Supabase SQL Editor)
-- Safe to re-run — uses ON CONFLICT / NOT EXISTS guards.
-- Use this when the tables already exist but are empty.
-- ============================================================

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

-- Rooms
insert into rooms (room_no, room_type, floor)
select room_no, room_type, floor from room_def
on conflict (room_no) do nothing;

-- Beds A..bed_count per room
insert into beds (room_id, bed_letter, bed_location, default_rate, status)
select
  r.id,
  chr(64 + g),
  case when g % 2 = 1 then 'LOWER' else 'UPPER' end,
  case
    when d.room_type like '6-%'      then 4000
    when d.room_type like '4-%'      then 5000
    when d.room_type like '2-%'      then 6000
    when d.room_type = 'Studio Room' then 8000
    else 10000
  end,
  d.bed_status
from room_def d
join rooms r on r.room_no = d.room_no
cross join generate_series(1, d.bed_count) g
where d.bed_count > 0
  and not exists (
    select 1 from beds b where b.room_id = r.id and b.bed_letter = chr(64 + g)
  );

-- Verify
select
  (select count(*) from rooms) as rooms,
  (select count(*) from beds)  as beds;   -- should show 30 rooms, 96 beds
