-- ============================================================
-- Correction: Rooms 404 and 602 are now 2-Bed Sharing (2 beds each).
-- They were seeded with 4 beds (A–D). This removes beds C and D.
--
-- Safe on dummy data. Run in Supabase SQL Editor.
-- ============================================================

-- 1. Remove any (dummy) tenants sitting on the beds being deleted,
--    plus their payments — so the bed delete won't hit a foreign key.
delete from payments where tenant_id in (
  select t.id from tenants t
  join beds b  on b.id = t.bed_id
  join rooms r on r.id = b.room_id
  where r.room_no in ('404','602') and b.bed_letter in ('C','D')
);

delete from tenants where bed_id in (
  select b.id from beds b
  join rooms r on r.id = b.room_id
  where r.room_no in ('404','602') and b.bed_letter in ('C','D')
);

-- 2. Remove beds C and D from 404 and 602
delete from beds
where id in (
  select b.id from beds b
  join rooms r on r.id = b.room_id
  where r.room_no in ('404','602') and b.bed_letter in ('C','D')
);

-- 3. Verify — both rooms should now have 2 beds (A, B)
select r.room_no, count(b.id) as beds
from rooms r
join beds  b on b.room_id = r.id
where r.room_no in ('404','602')
group by r.room_no;
