---
name: roles-and-rls
description: bedspace-web role model (admin / user / viewer / guard), route gating and Supabase RLS policy rules. Load before adding or reviewing a table, policy, RPC, route, sidebar link or anything that shows or hides data by role.
---

# Roles & RLS (bedspace-web)

Full rules: `docs/requirements.md` §7.

- Roles `admin` / `user` / `viewer` / `guard` live in `public.profiles.role` and are enforced by **Supabase RLS policies** (`database/init.sql`), not just client checks in `src/lib/auth.jsx` / `src/components/Sidebar.jsx`.
- Route gating is in `src/App.jsx` and waits for the role (`useAuth().loading` stays true until it resolves) so deep links land correctly; a failed role lookup falls back to `viewer`.
- The role is read once at sign-in. If an admin changes someone's role, that person's open page keeps the old UI until they refresh; the database already enforces the new role (this caused the Nov 2026 "cannot coerce the result to a single JSON object" move-out error).
- `owner` is a legacy role that was migrated away. Treat any mention as stale.
- `guard` ("Security / Front desk") sees only the Visitor Log: `App.jsx` renders `GuardApp` (no Sidebar, duty-name prompt, `/visitors`, everything else redirects there). In the DB it is locked out of every existing table via `not (select public.is_guard())` on the any-signed-in-user policies. **Any new policy that lets any signed-in user in must add the same clause.**
- `public.app_role()` (SECURITY DEFINER) returns the caller's role.
- Viewers see data but no clickable rows/links into admin/user-only routes (`/tenants`, `/property`); gate with `canAct = isAdmin || isUser` like the Dashboard drill-downs.

## Checklist for a new table / policy
1. `alter table ... enable row level security`.
2. Policies per command (select/insert/update/delete) for exactly the roles that need them; add `not (select public.is_guard())` to any "any signed-in user" policy.
3. Billing/payment tables get no DELETE policy (void/adjust only).
4. An UPDATE with `.select().single()` returns 0 rows when RLS denies it: handle that case with a clear message.
5. Verify empirically per role (set `request.jwt.claims` + `set local role authenticated` inside a rolled-back transaction), not by reading the policy text.
