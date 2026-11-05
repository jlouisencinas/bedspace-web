-- maintenance_common_areas.sql  (idempotent; safe to run twice)
-- Task 20261105-maintenance-common-areas: a maintenance ticket targets either a room or one of 9
-- common areas. The code list is mirrored in supabase/functions/_shared/maintenance-locations.ts.
-- Schema-only (no data rewritten), backward compatible: the deployed frontend keeps inserting room_id
-- with a null location, which passes both checks.

-- §0 audit (run first; expect with_room = total, with_location column absent or all null)
-- select count(*) as total, count(room_id) as with_room from public.maintenance_tickets;

alter table public.maintenance_tickets add column if not exists location text;
alter table public.maintenance_tickets alter column room_id drop not null;

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'maintenance_tickets_location_check') then
    alter table public.maintenance_tickets
      add constraint maintenance_tickets_location_check
      check (location is null or location in
        ('LOBBY','FLOOR_2','FLOOR_3','FLOOR_4','FLOOR_5','FLOOR_6','FLOOR_7','KITCHEN','ROOF_DECK'));
  end if;
  if not exists (select 1 from pg_constraint where conname = 'maintenance_tickets_room_xor_location') then
    alter table public.maintenance_tickets
      add constraint maintenance_tickets_room_xor_location
      check ((room_id is not null) <> (location is not null));
  end if;
end $$;

create index if not exists tickets_location_status_idx
  on public.maintenance_tickets(location, status) where location is not null;

comment on column public.maintenance_tickets.location is
  'Common-area code (fixed list in supabase/functions/_shared/maintenance-locations.ts). Exactly one of room_id / location is set.';
