# Bedspace Manager

Internal tool for managing a bedspace/dormitory rental business — bed map, tenants, utility meter
readings, per-day billing, printable statements of account, utility P&L, and owner reports. Replaced
a Google Sheets workflow (`scripts/` has the one-time migration scripts).

**Full business rules / domain vocabulary:** `docs/requirements.md` — read it before planning any
feature; it holds knowledge that isn't in the code (billing math, tenant lifecycle, non-negotiables).

## Stack
React 18 + Vite + react-router-dom + Tailwind (frontend) · Supabase/Postgres (DB, auth, RLS) · deployed
as a static SPA on Vercel (`vercel.json`).

## Commands
```
npm install
npm run dev       # http://localhost:5173
npm run build     # -> dist/, also the only automated correctness check — no test suite exists
npm run preview
```

## Layout
- `src/pages/` — one file per route (Dashboard, BedMap, Tenants, Billing, Utilities, Collections,
  Maintenance, Approvals, Reports, Property, Activity, Users, PrintElectricity, PrintRentWater, Login)
- `src/components/` — shared UI (MoveInModal, MoveOutModal, TransferModal, Statement, MultiEntryInput,
  Sidebar, Toast)
- `src/lib/` — data layer: `supabase.js`, `billing.js`, `pnl.js`, `snapshot.js`, `auth.jsx`
- `database/init.sql` — single consolidated schema file (tables, views, functions, RLS policies, seed
  data). Run once in the Supabase SQL Editor. Idempotent — safe to re-run.
- `database/UTILITIES_PLAN.md` — design notes for the utilities billing model.
- `scripts/` — one-time Node migration scripts from the old Google Sheets.

## Roles
`admin` / `user` / `viewer`, defined in `public.profiles.role` and enforced via **Supabase RLS
policies** (`database/init.sql`), not just client-side checks in `src/lib/auth.jsx` /
`src/components/Sidebar.jsx`. `owner` was a legacy role, migrated away from — if you see it mentioned
anywhere (old commits, old docs), treat it as stale.

## Known doc drift — don't trust these without verifying against code
- `README.md` §3 lists database setup as ~11 separate SQL files (`schema.sql`, `seed_rooms_beds.sql`,
  etc.). Those were consolidated into the single `database/init.sql` — the file list in the README is
  stale.
- `README.md` §6 "Security note" says RLS is disabled and the anon key is unprotected. That's no longer
  true — `init.sql` enables RLS with real per-table policies. Don't repeat that warning as current fact;
  verify current policy state against `init.sql` directly if it matters for a change.

## Working conventions
- No test suite (no vitest/jest configured). `npm run build` is the only automated signal — verify
  everything else by actually running the app.
- Money logic (billing, utilities allocation, rent, late fees) must be exact — no silent rounding
  assumptions, no swallowed errors on financial writes. Full detail: `docs/requirements.md` §5–6.
- Non-negotiables (see `docs/requirements.md` §10 for full detail) — treat these as hard blockers,
  not style preferences:
  - A tenant's outstanding balance must always reconcile (sum of bills = sum of payments + adjustments).
  - A room's metered utility consumption must always equal the total billed across its tenants for
    that period, even across move-ins/move-outs/transfers mid-period.
  - No two active tenants may occupy the same bed at the same time.
  - Never delete billing/payment records — void/adjust only, for audit trail.
- Known gaps awaiting fixes — see `docs/requirements.md` §11 for the full backlog (move-out
  approval flow, RLS hardening across all tables, dynamic due-date labels, late-fee toggle, daily
  occupancy tracking, deposit/refund tracking). Don't assume current behavior in these areas is the
  intended target state.
- This repo also runs a 4-agent build pipeline (`.claude/agents/`: solution-architect,
  fullstack-engineer, qa-engineer, tester) orchestrated by the `dev-pipeline` skill
  (`.claude/skills/dev-pipeline/`) — invoke it for end-to-end feature work.
- Don't commit or push unless explicitly asked, even at the end of a pipeline run.
