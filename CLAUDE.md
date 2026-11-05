# Bedspace Manager

Internal tool for a bedspace/dormitory rental business: bed map, tenants, utility meter readings, per-day billing,
printable statements, utility P&L, owner reports, visitor log. Replaced a Google Sheets workflow.

**Business rules:** `docs/requirements.md` (large: read only the section you need, by its `## N.` heading). It holds
knowledge that isn't in the code (billing math, tenant lifecycle, non-negotiables).

## How requests are handled (orchestrator)
The main session is the orchestrator. Triage every request first (a hook reminds you on each prompt):
- Question / advice → answer directly. Small direct action (commit, PR, data lookup) → do it directly.
- Production error → investigate (database-admin, read-only), then fix through the pipeline.
- Feature / change / bug fix → the **`dev-pipeline`** skill: tiers S/M/L, agents in `.claude/agents/`
  (solution-architect, fullstack-engineer, qa-engineer, tester, database-admin), handoff files in `.pipeline/<task>/`.
- **Every change goes on its own branch (`feat/…` / `fix/…`) and ends in a pull request; the user merges.** Never commit or
  push to `main` (the guard-git hook blocks it). See the `git-workflow` skill.
- Every feature/change updates the affected section of `docs/requirements.md` in the same branch.

## Knowledge skills (load the one that matches the code you touch)
`billing-rules` (money, receipts, final bill, stays) · `roles-and-rls` (roles, policies, guard lockout) ·
`db-migrations` (production DB procedure, init.sql) · `notifications` (Edge Function, emails) ·
`visitor-log` · `occupancy-dashboard` (occupancy, snapshots, drill-downs) · `git-workflow` (branch, PR).

## Stack & commands
React 18 + Vite + react-router-dom + Tailwind · Supabase/Postgres (DB, auth, RLS, Edge Function) · static SPA on Vercel
(`vercel.json`; merging to `main` deploys production).
```
npm install
npm run dev       # http://localhost:5173 (talks to the PRODUCTION database)
npm run build     # -> dist/, the only automated correctness check (no test suite)
```

## Map
- `src/pages/` one file per route: Dashboard, BedMap, Tenants, CurrentTenants (Tenants with scope="current"), EditTenantProfile, Billing, Utilities, Collections,
  PaymentMonitoring, Maintenance, Approvals, Reports, Occupancy, OccupancySimulator, Property, Activity, Users,
  NotificationSettings, VisitorLog, Login, PrintElectricity, PrintRentWater, PrintFinalBill.
  Property.jsx: "Reconfigure" (bed count/rates) is in the Bed Rates tab; "+ Add Room" / "Retire" in the Room Config tab.
- `src/components/` shared UI (MoveInModal, MoveOutModal, TransferModal, Statement, DrillDownModal, ReceiptLinesInput,
  ReservationLedgerModal, RoomReconfigureModal, AddRoomModal, RetireRoomModal, Guard*/Visitor* …);
  `tenantProfile/` holds the TenantProfileModal tabs (BillsTab, StayTimeline, MaintenanceTab, VisitorsTab).
- `src/lib/` data layer: `supabase.js` (queries + move-out/receipt writes), `billing.js`, `finalBill.js`, `stay.js`,
  `utilityPieces.js`, `receiptLines.js`, `moveOutData.js`, `pnl.js`, `snapshot.js`, `auth.jsx`, `approvals.js`,
  `tenantProfile.js`, `tenantHistory.js` (profile history reads, in-house rule), `notify.js`, `visitors.js`, `idPhoto.js`, `guardShift.js`, `simCsv.js`, `theme.jsx`.
- `supabase/functions/` notify-email Edge Function + `_shared/` (also imported by `src/`). `apps-script/` mailer copy.
- `database/init.sql` consolidated schema · `database/migrations/` one-off SQL + `applied.md` log · `scripts/` one-time
  Sheets migration scripts and the email preview script.

## Roles
`admin` / `user` (staff) / `viewer` / `guard`, in `public.profiles.role`, enforced by **RLS** in `database/init.sql`,
not only client checks. Route gating in `src/App.jsx`. Details: `roles-and-rls` skill.

## Non-negotiables (hard blockers, `docs/requirements.md` §14)
- A tenant's outstanding balance always reconciles (sum of bills = sum of payments + adjustments).
- A room's metered utility consumption equals the total billed across its tenants for that period, even across
  move-ins/move-outs/transfers mid-period.
- No two active tenants occupy the same bed at the same time.
- Never delete billing/payment records: void/adjust only. Money math is exact (cents), errors on financial writes are
  never swallowed.

## Database (production only)
One Supabase project, `hkminadjypkfmbkfcawx`, free tier: no staging, no branches. Agents have full read-write access and
follow the `db-migrations` procedure (inspect → back up → apply → verify → log). **Never run all of `database/init.sql`**:
its seed starts with `truncate table rooms, cutoffs, activity_log cascade`. The guard-db hook blocks destructive SQL.

## Conventions
- No test suite: `npm run build` plus running the app is the verification.
- Theming: CSS custom properties in `src/index.css` (light + `data-theme="dark"`), bridged in `tailwind.config.js`. Use
  token classes (`bg-surface`, `text-ink`, `border-line`, …), not raw `slate`/`white`. `Login.jsx` and print pages are
  deliberately fixed light.
- Known gaps (`docs/requirements.md` §15): don't assume current behaviour there is the target.

## Known doc drift (don't trust without checking the code)
- `README.md` §3 lists ~11 separate SQL files; they were consolidated into `database/init.sql`.
- `README.md` §6 says RLS is disabled and the anon key unprotected; no longer true. Check `init.sql` for current policies.
- `owner` was a legacy role, migrated away; treat mentions as stale.
