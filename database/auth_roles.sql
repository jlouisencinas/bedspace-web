-- ============================================================================
-- auth_roles.sql  —  Login + role-based access (admin / owner) + lock down RLS
-- Run this in Supabase SQL Editor.  Safe to re-run.
--
-- After running:
--   1) Authentication → Providers → Email: ENABLED (default).
--   2) Authentication → Providers → Email → turn OFF "Allow new users to sign
--      up" (so only you can create accounts).
--   3) Authentication → Users → "Add user" for each person (tick
--      "Auto Confirm User"). The trigger below creates their profile as 'owner'.
--   4) Promote yourself to admin:
--        update public.profiles set role = 'admin' where email = 'you@email.com';
-- ============================================================================

-- 1. Profiles table: maps an auth user to a role -----------------------------
create table if not exists public.profiles (
  id         uuid primary key references auth.users(id) on delete cascade,
  email      text,
  role       text not null default 'owner' check (role in ('admin','owner')),
  created_at timestamptz default now()
);

alter table public.profiles enable row level security;

-- A logged-in user may read their OWN profile row (to discover their role).
drop policy if exists profiles_self_select on public.profiles;
create policy profiles_self_select on public.profiles
  for select to authenticated using (id = auth.uid());

-- 2. Auto-create a profile when a new auth user is added ----------------------
create or replace function public.handle_new_user()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  insert into public.profiles (id, email) values (new.id, new.email)
  on conflict (id) do nothing;
  return new;
end $$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- Backfill profiles for any users that already exist
insert into public.profiles (id, email)
select id, email from auth.users
on conflict (id) do nothing;

-- 3. Enable RLS on every data table + allow only logged-in users -------------
--    (blocks the anonymous public from reading/writing your data via the URL)
do $$
declare t text;
begin
  foreach t in array array[
    'rooms','beds','tenants','payments','activity_log',
    'cutoffs','meter_readings','interim_readings','area_readings',
    'tenant_splits','addons','monthly_reports'
  ] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('drop policy if exists app_authenticated_all on public.%I', t);
    execute format(
      'create policy app_authenticated_all on public.%I '
      'for all to authenticated using (true) with check (true)', t);
  end loop;
end $$;

-- 4. Make views respect the caller's RLS (so they don't leak to anon) ---------
alter view public.beds_with_tenant  set (security_invoker = on);
alter view public.occupancy_summary set (security_invoker = on);
alter view public.v_latest_reading  set (security_invoker = on);
alter view public.v_utility_bill    set (security_invoker = on);
alter view public.v_cutoff_summary  set (security_invoker = on);

-- Done. The database now answers only to authenticated users; admin vs owner
-- capability limits are enforced in the app UI.
