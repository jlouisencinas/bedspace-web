-- visitor_log.sql  (idempotent; safe to run twice)
--
-- Visitor Log: a `guard` role ("Security / Front desk") whose only screen is /visitors, visitor
-- check-in/out with a required ID photo (private bucket `visitor-ids`, admin-only read, deleted after
-- 90 days by the admin purge), overnight requests through the existing approval workflow, and
-- admin/user history with correct/void. See docs/requirements.md section 17 "Visitor Log".
--
-- OWNER APPLIES BY HAND (Supabase SQL editor). Never run database/init.sql whole.
--   1. Run the §0 audit queries below and SAVE the output. Compare with the expected lists.
--   2. Apply this whole file.
--   3. Re-run §0 and compare with the "after" lists. Anything beyond them: stop and report.
--   4. Redeploy the notify-email Edge Function (JWT verification ON), then deploy the frontend.
--   5. Create the guard account (a real inbox) on /users and set its role to "Security / Front desk".
--
-- Mirrored into database/init.sql (role check, is_guard/app_role after is_admin, the entity_type
-- check, the 11 policy edits in place, and section "8c. VISITOR LOG"). NOT in its truncate/seed section.
--
-- PII rule: no visitor contact, email, ID number or photo path ever goes into approval_requests.new_value,
-- activity_log or emails. visitor_logs (+ visitor_log_edits) is the audit of check-ins and corrections.

-- ════════════════════════════════════════════════════════════════
-- §0 AUDIT (run before and after; save the output)
-- ════════════════════════════════════════════════════════════════
-- select schemaname, tablename, policyname, cmd, roles, qual, with_check from pg_policies where schemaname in ('public','storage') order by 1,2,3;
-- select c.relname from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname='public' and c.relkind in ('r','p') and not c.relrowsecurity;   -- expect 0 rows
-- select c.relname, c.reloptions from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname='public' and c.relkind in ('v','m');               -- expect views, all security_invoker=on
-- select p.oid::regprocedure, p.prosecdef, has_function_privilege('authenticated',p.oid,'execute') auth_exec, has_function_privilege('anon',p.oid,'execute') anon_exec from pg_proc p where p.pronamespace='public'::regnamespace order by 1;
-- select id, name, public, file_size_limit, allowed_mime_types from storage.buckets;
--
-- Expected BEFORE:
--   SECURITY DEFINER functions: exactly handle_new_user, advance_credits_guard, final_bills_advance_guard,
--     td_guard_credited_advance, brp_before_insert, beds_reservation_sync, apply_reservation_payments,
--     record_move_in_receipts, is_admin, sim_replace_all.
--   Policies that let any signed-in user in: exactly the 11 listed in §10.
--   Storage: 0 buckets and 0 policies on storage.objects.
-- Expected AFTER:
--   Views: visitor_logs_v added (security_invoker on).
--   New SECURITY DEFINER functions: is_guard, app_role, the visitor_* RPCs (visitor_tenant_search,
--     visitor_lookup_contact, visitor_check_in, visitor_check_out, visitor_request_overnight,
--     visitor_guard_list, visitor_void, visitor_correct, visitor_photo_purge_candidates,
--     visitor_photo_mark_purged) and visitor_overnight_sync. (visitor_history is SECURITY INVOKER.)
--   Storage: exactly 1 bucket visitor-ids (public=false, 1048576, {image/jpeg}) and exactly the 3
--     visitor_ids_* policies on storage.objects.
--   Policies: the 11 in §10 now start with `not (select public.is_guard())`; activity_log_select and
--     approval_requests_select additionally hide entity_type = 'VISITOR_LOG' rows from everyone but admin/user
--     (viewers keep every non-visitor row). New: visitor_logs_select and visitor_log_edits_select (admin/user).

-- ════════════════════════════════════════════════════════════════
-- §1 ROLE AND HELPERS
-- ════════════════════════════════════════════════════════════════
alter table public.profiles drop constraint if exists profiles_role_check;
alter table public.profiles add constraint profiles_role_check
  check (role in ('admin','user','viewer','guard'));

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

-- ════════════════════════════════════════════════════════════════
-- §2 APPROVAL_REQUESTS
-- ════════════════════════════════════════════════════════════════
alter table public.approval_requests drop constraint if exists approval_requests_entity_type_check;
alter table public.approval_requests add constraint approval_requests_entity_type_check
  check (entity_type in ('TENANT','TENANT_STAY','BED','ROOM','PAYMENT','INTERIM_READING','VISITOR_LOG'));
create unique index if not exists uq_approval_pending_overnight on public.approval_requests(entity_id)
  where entity_type = 'VISITOR_LOG' and field_name = 'overnight_visitor' and status = 'PENDING';

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
-- §10 EXISTING POLICY CHANGES (lock the guard out; admin/user/viewer unchanged)
-- For any account that is not a guard, `not is_guard()` is true, so access is identical to before, except that
-- activity_log / approval_requests rows with entity_type = 'VISITOR_LOG' are visible to admin/user only (viewers get
-- no visitor data; every visitor activity line and every overnight request carries that entity_type).
-- ════════════════════════════════════════════════════════════════
drop policy if exists rooms_select on public.rooms;
create policy rooms_select on public.rooms for select to authenticated using (not (select public.is_guard()));
drop policy if exists beds_select on public.beds;
create policy beds_select on public.beds for select to authenticated using (not (select public.is_guard()));
drop policy if exists activity_log_select on public.activity_log;
create policy activity_log_select on public.activity_log for select to authenticated
  using (not (select public.is_guard()) and (entity_type is distinct from 'VISITOR_LOG' or exists (select 1 from public.profiles where id = auth.uid() and role in ('admin','user'))));
drop policy if exists cutoffs_select on public.cutoffs;
create policy cutoffs_select on public.cutoffs for select to authenticated using (not (select public.is_guard()));
drop policy if exists meter_readings_select on public.meter_readings;
create policy meter_readings_select on public.meter_readings for select to authenticated using (not (select public.is_guard()));
drop policy if exists monthly_reports_select on public.monthly_reports;
create policy monthly_reports_select on public.monthly_reports for select to authenticated using (not (select public.is_guard()));
drop policy if exists tenants_select on public.tenants;
create policy tenants_select on public.tenants
  for select to authenticated using (not (select public.is_guard()));
drop policy if exists tenants_insert on public.tenants;
create policy tenants_insert on public.tenants
  for insert to authenticated with check (not (select public.is_guard()));
drop policy if exists tickets_select on public.maintenance_tickets;
create policy tickets_select on public.maintenance_tickets
  for select to authenticated using (not (select public.is_guard()));
drop policy if exists approval_requests_select on public.approval_requests;
create policy approval_requests_select on public.approval_requests
  for select to authenticated using (not (select public.is_guard()) and (entity_type is distinct from 'VISITOR_LOG' or exists (select 1 from public.profiles where id = auth.uid() and role in ('admin','user'))));
drop policy if exists approval_requests_insert on public.approval_requests;
create policy approval_requests_insert on public.approval_requests
  for insert to authenticated
  with check (requester_id = auth.uid() and not (select public.is_guard()) and entity_type <> 'VISITOR_LOG');

-- ════════════════════════════════════════════════════════════════
-- §11 VERIFICATION (run by hand after applying; all commented out)
-- ════════════════════════════════════════════════════════════════
-- The SECURITY DEFINER functions read storage.objects as their owner. Confirm the owner bypasses RLS
-- (otherwise check-in reports "ID photo not found" and the purge finds no orphans):
--   select rolname, rolbypassrls from pg_roles where rolname = (select pg_get_userbyid(proowner) from pg_proc where proname = 'visitor_check_in');   -- expect true
--
-- Simulate a guard in the SQL editor:
--   begin;
--   select set_config('request.jwt.claims','{"sub":"<guard uuid>","role":"authenticated","email":"<guard email>"}',true);
--   set local role authenticated;
--   select count(*) from tenants;                         -- 0  (repeat for every public table + every view)
--   select count(*) from storage.objects where bucket_id='visitor-ids';   -- 0 (no select policy)
--   select * from visitor_tenant_search('');               -- rows (name/room/bed letters only)
--   select * from visitor_history(current_date - 7, current_date);        -- ERROR: Not allowed.
--   rollback;
--
-- Simulate a viewer (non-visitor rows unchanged, visitor rows hidden):
--   begin;
--   select set_config('request.jwt.claims','{"sub":"<viewer uuid>","role":"authenticated"}',true);
--   set local role authenticated;
--   select count(*) from activity_log where entity_type = 'VISITOR_LOG';        -- 0
--   select count(*) from approval_requests where entity_type = 'VISITOR_LOG';   -- 0
--   select count(*) from activity_log;        -- the admin count minus the VISITOR_LOG rows
--   select count(*) from approval_requests;   -- the admin count minus the VISITOR_LOG rows
--   select count(*) from visitor_logs;        -- 0
--   rollback;
--
-- Pure-function checks, all at +08:00:
--   select visitor_first_curfew('2026-11-03 14:00+08');      -- 2026-11-03 22:00+08
--   select visitor_first_curfew('2026-11-03 23:00+08');      -- 2026-11-03 23:00+08
--   select visitor_log_day('2026-11-04 02:00+08');           -- 2026-11-03
--   select visitor_log_day('2026-11-04 06:00+08');           -- 2026-11-04
--   select visitor_last_passed_night('2026-11-04 10:00+08'); -- 2026-11-03
--   select visitor_contact_key('+63 917 555 1234');           -- 09175551234
--   select visitor_state('2026-11-03 14:00+08', null, null, 'NONE', '{}', '2026-11-03 21:30+08');            -- DUE_SOON
--   select visitor_state('2026-11-03 14:00+08', null, null, 'NONE', '{}', '2026-11-03 22:00+08');            -- RED
--   select visitor_state('2026-11-03 14:00+08', null, null, 'APPROVED', '{2026-11-03}', '2026-11-04 10:00+08'); -- OK
--   select visitor_state('2026-11-03 14:00+08', null, null, 'APPROVED', '{2026-11-03}', '2026-11-04 22:00+08'); -- RED
--
-- Delete is impossible:
--   delete from visitor_logs where id = <id>;   -- ERROR: Visitor log entries are never deleted. Void the entry instead.
