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
`visitor-log` · `occupancy-dashboard` (occupancy, snapshots, drill-downs) · `git-workflow` (branch, PR, sync with main, re-sync open PRs, stacked PRs).

## Stack & commands
React 18 + Vite + react-router-dom + Tailwind · Supabase/Postgres (DB, auth, RLS, Edge Function) · static SPA on Vercel
(`vercel.json`; merging to `main` deploys production). Each build writes `dist/version.json` (build id, served no-store) so open tabs detect a new deploy.
```
npm install
npm run dev       # http://localhost:5173 (talks to the PRODUCTION database)
npm test          # Vitest unit tests for src/lib/ (fixture-only, never touches the database)
npm run test:watch
npm run build     # -> dist/
```

## Map
- `src/pages/` one file per route: Dashboard, BedMap, Tenants, CurrentTenants (Tenants with scope="current"), EditTenantProfile, Billing, Utilities, Collections,
  PaymentMonitoring, Maintenance, Approvals, Reports, Occupancy, OccupancySimulator, Property, Activity, Users,
  NotificationSettings, VisitorLog, Login, PrintElectricity, PrintRentWater, PrintFinalBill.
  Property.jsx: "Reconfigure" (bed count/rates) is in the Bed Rates tab; "+ Add Room" / "Retire" in the Room Config tab.
- `src/components/` shared UI (MoveInFlow (the one Move In path: Tenants + Bed Map), MoveInModal, MoveOutModal, TransferModal, Statement, DrillDownModal, ReceiptLinesInput,
  ReissueFinalBillModal (admin Void & re-issue of a final bill), ReservationLedgerModal, RoomReconfigureModal, AddRoomModal, RetireRoomModal, MonthlyStatementPreview, UpdateBanner (reload prompt after a new deploy), Guard*/Visitor* …);
  `tenantProfile/` holds the TenantProfileModal tabs (BillsTab, StatementHistory, StayTimeline, MaintenanceTab, VisitorsTab).
- `src/lib/` data layer: `supabase.js` (queries + move-out/receipt writes), `appVersion.js` (pure build-id compare) +
  `appVersionCheck.js` (`assertAppCurrent`: money writes refuse from an outdated tab), `billing.js`, `billingSearch.js` (Billing Per Tenant display-only search), `collectionsRows.js` (Collections rows, cutoff outstanding, past-due candidates + refresh tracker, cutoff picker `?cutoff=`), `commercialWater.js` (commercial 0-water warning, common-area Previous carry-forward), `paymentRefs.js` (Collections payment S.I#/T.R#: normalise, display, edit rights; amount-correction rules), `cutoffBilling.js` (the one
  loader + compute for a cutoff's statements: Billing, print pages, profile history), `monthlyStatement.js` (printed
  statement props), `billNumber.js` (monthly Billing No. `<room>-<YYYY>-<MM>`), `tenantStatements.js` (profile statement history), `finalBill.js`, `advanceWindow.js` (2nd-to-last advance window: the W days ending on the move-out date, `Less: Advance` credit days, final-bill rent after the cutoff, `rent_carryovers`), `reservation.js` (reservation target date, Move In defaults), `stay.js`, `stayExtension.js` (late move-out: P500/night after the contract date, 12:00 PM checkout),
  `utilityPieces.js`, `receiptLines.js`, `moveOutData.js`, `maintenanceTickets.js` (ticket target/place helpers), `pnl.js`,
  `snapshot.js`, `occupancyMtd.js` (Dashboard Occupancy tile: Manila month-to-date window + MTD average / today figures),
  `auth.jsx`, `approvals.js`,
  `tenantProfile.js`, `tenantHistory.js` (profile history reads, in-house rule), `notify.js`, `visitors.js`, `idPhoto.js`, `guardShift.js`, `simCsv.js`, `theme.jsx`.
- `supabase/functions/` notify-email Edge Function + `_shared/` (also imported by `src/`; `maintenance-locations.ts` = the
  fixed common-area list for tickets). `apps-script/` mailer copy.
- Tests: `src/lib/*.test.js` next to their modules (`nonNegotiables.test.js` = the §14 regression tests), synthetic
  fixtures in `src/lib/__fixtures__/`, safety guard `src/test/setup.js` (blanks the Supabase config, refuses
  `src/lib/supabase.js` and the network). CI: `.github/workflows/ci.yml` (`npm test` + `npm run build` on every PR).
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
- Verification: Vitest unit tests for `src/lib/` (`npm test`), plus `npm run build`, plus browser testing. Put new logic in
  a pure `src/lib/` function with a test; tests use synthetic fixtures only (the repo is public) and never the database.
  `it.fails` marks a known bug the test surfaced (listed in `docs/requirements.md` §15), not a test to delete.
- Theming: CSS custom properties in `src/index.css` (light + `data-theme="dark"`), bridged in `tailwind.config.js`. Use
  token classes (`bg-surface`, `text-ink`, `border-line`, …), not raw `slate`/`white`. `Login.jsx` and print pages are
  deliberately fixed light.
- Known gaps (`docs/requirements.md` §15): don't assume current behaviour there is the target.

## Known doc drift (don't trust without checking the code)
- `README.md` §3 lists ~11 separate SQL files; they were consolidated into `database/init.sql`.
- `README.md` §6 says RLS is disabled and the anon key unprotected; no longer true. Check `init.sql` for current policies.
- `owner` was a legacy role, migrated away; treat mentions as stale.
