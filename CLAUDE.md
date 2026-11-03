# Bedspace Manager

Internal tool for managing a bedspace/dormitory rental business — bed map, tenants, utility meter
readings, per-day billing, printable statements of account, utility P&L, and owner reports. Replaced
a Google Sheets workflow (`scripts/` has the one-time migration scripts).

**Full business rules / domain vocabulary:** `docs/requirements.md` — read it before planning any
feature; it holds knowledge that isn't in the code (billing math, tenant lifecycle, non-negotiables).

## Stack
React 18 + Vite + react-router-dom + Tailwind (frontend) · Supabase/Postgres (DB, auth, RLS, Edge
Function) · deployed as a static SPA on Vercel (`vercel.json`).

## Commands
```
npm install
npm run dev       # http://localhost:5173
npm run build     # -> dist/, also the only automated correctness check — no test suite exists
npm run preview
```

## Layout
- `src/pages/` — one file per route (Dashboard, BedMap, Tenants, EditTenantProfile, Billing,
  Utilities, Collections, PaymentMonitoring, Maintenance, Approvals, Reports, Occupancy, Property, Activity,
  Users, NotificationSettings, PrintElectricity, PrintRentWater, PrintFinalBill, Login, OccupancySimulator, VisitorLog).
  `Occupancy.jsx` is the per-month daily-weighted occupancy module (`requirements.md` §9), all roles,
  built on `computeDailyOccupancy()` in `_shared/occupancy.ts`.
- `src/components/` — shared UI (MoveInModal, MoveOutModal, TransferModal, Statement, MultiEntryInput,
  SearchInput, TicketDetailModal, Sidebar, Toast, RoomReconfigureModal, AddRoomModal, RetireRoomModal,
  DrillDownModal, ReceiptLinesInput, ReservationLedgerModal, …).
  Visitor Log (`VisitorLog.jsx`, `/visitors`, requirements §17): `GuardShell` (guard top bar, menu sheet, red banner, bottom
  tabs; also exports `BottomSheet`), `GuardShiftPrompt`, `VisitorCheckIn`, `VisitTargetPicker`, `IdPhotoCapture`,
  `VisitorInsideList`, `VisitorTodayLog`, `VisitorHistory`, `VisitorDetailDrawer`, `VisitorCorrectModal`, `VisitorVoidModal`,
  `VisitorIdPhoto`; libs `src/lib/visitors.js` (RPC wrappers, Manila formatters, ID types), `src/lib/idPhoto.js` (compress,
  upload, signed URL, 90-day purge) and `src/lib/guardShift.js` (duty name per sign-in, recent names). Schema:
  `database/migrations/visitor_log.sql` (apply by hand, run its §0 audit first; mirrored in `init.sql` section 8c).
  Property.jsx has room reconfiguration split across two tabs: "Reconfigure" (rebalance bed count/
  rates) is in the Bed Rates tab; "+ Add Room" / "Retire" (create/retire a room entirely) are in the
  Room Config tab.
- `src/lib/` — data layer: `supabase.js`, `billing.js`, `pnl.js`, `snapshot.js`, `auth.jsx`,
  `approvals.js` (approval requests), `receiptLines.js` (pure, no imports: strict cents parsing,
  split receipt line validation, reservation/deposit math), `tenantProfile.js`, `notify.js` (client side of email
  notifications), `theme.jsx`, `simCsv.js` (Occupancy Simulator CSV parsing/validation)
- `supabase/functions/notify-email/` + `supabase/functions/_shared/notification-types.ts` — the
  notification Edge Function and its type registry. Deployed via the Supabase MCP/CLI, **not** by
  Vercel.
- `apps-script/bedspace-mailer.gs` — reference copy of the mailer. The live copy lives in Google
  Apps Script under bedspacemkt@gmail.com; changing it there needs a "New version" web-app
  deployment to take effect.
- `database/init.sql` — single consolidated schema file (tables, views, functions, RLS policies, seed
  data). See the truncate warning under Working conventions.
- `database/migrations/` — one-off, apply-by-hand SQL (e.g. `advance_deposit.sql` → `tenant_deposits`:
  per-tenant advance/deposit receipts with S.I#/T.R#; requirements §5). `reservation_payments.sql` →
  `bed_reservation_payments` (optional money paid on a RESERVED bed, carried into `tenant_deposits` as the
  deposit at Move In, forfeited by a `beds` trigger on cancel) + `tenant_deposits.payment_mode/bank_ref` +
  the atomic RPCs `record_move_in_receipts` / `apply_reservation_payments`; apply it BEFORE deploying the
  frontend (Move In depends on the RPC; requirements §5 "Reservation payments").
- `src/lib/finalBill.js` — pure move-out Final Bill builder + automatic second-to-last-bill advance credit
  (`billPosition`, `advanceCredits`); `final_bills` table (`database/migrations/final_bills.sql`), flow in
  `MoveOutModal` → `processMoveOutWithBill`, print page `PrintFinalBill` (`/print/final-bill`); requirements §5.
  The advance can never be credited twice: `advanceCheck`/`verifyBillAgainstDb` re-check it from fresh DB data
  at draft, Confirm and approval apply (stamped in `details.advance_check`), backed by triggers G1-G3 in
  `database/migrations/advance_credit_guards.sql` (run its audit queries first; also in `init.sql`).
  Receipt numbers: every receipt the final bill credits/forfeits needs its S.I#/T.R# (`normalizeReceiptRef`/`applyReceiptRefs`/
  `applyCheckRefs` in `finalBill.js`, inputs in `ReceiptRefInputs`); admin Confirm writes them to the HELD receipts first, staff send
  `_bill.receipt_refs`; a settled receipt's number is fixed after move-out only via the admin RPC `correct_receipt_ref`
  (`database/migrations/final_bill_receipt_refs.sql`, also in `init.sql`; text-only, refuses any amount change).
- `src/lib/stay.js` (stay kind: one-month / whole-months / odd; per-utility cutoff coverage), `src/lib/utilityPieces.js`
  (stay-anchored utility split, integer-cent allocation, rate fallback) and `src/lib/moveOutData.js` (data loader shared by
  `MoveOutModal` and `Approvals`) back the final bill; `database/migrations/final_bill_covered_cutoffs.sql` adds
  `final_bills.covered_cutoffs` (apply it before the frontend). One-month stays are billed ONLY on the final bill (flat rent; ghost
  participants in `computeBilling`, shown as "billed on final bill"); sibling beds (same name, room, planned date) move out together
  through one flow and one approval request and print as ONE summed statement (`combineBillsForPrint`, display only; one `final_bills` row per bed stays). A move-out after the latest cutoff's window bills against that cutoff, no next cutoff needed (`finalCutoffForUtility`) (one pending move-out request per tenant; at review and apply the rent/water/electricity lines are recomputed from the DB, edited lines kept, `details.recomputed_at_approval`) (admin confirms with the "vacated the room" tick, recorded in `details.vacated`; utility pieces are shared only by active tenants, the leavers and ghosts, never stale inactive rows; final-bill print numbering is `FINAL-<room>-<series>`) (a month-end planned date is never stay-billed; the final bill's
  `covered_cutoffs` entries are plain ids or `{id, water, electric}`, and payments are netted per component; OTHER or uncategorised payments on any covered cutoff). New tenants' planned move-out is always a month end (Move In picks the lease length;
  `leaseMoveOut`/`stayRent` in `stay.js`: n whole months flat + excess days / the month's real days, requirements §5).
- `database/UTILITIES_PLAN.md` — design notes for the utilities billing model.
- `scripts/` — one-time Node migration scripts from the old Google Sheets.

## Roles
`admin` / `user` / `viewer` / `guard`, defined in `public.profiles.role` and enforced via **Supabase RLS
policies** (`database/init.sql`), not just client-side checks in `src/lib/auth.jsx` /
`src/components/Sidebar.jsx`. Route gating lives in `src/App.jsx` and waits for the role
(`useAuth().loading` stays true until it resolves) so deep links land correctly; a failed role
lookup falls back to `viewer`. `owner` was a legacy role, migrated away from — if you see it
mentioned anywhere (old commits, old docs), treat it as stale.
- `guard` ("Security / Front desk") sees only the Visitor Log: `App.jsx` renders `GuardApp` (no Sidebar, duty-name prompt,
  `/visitors`, everything else redirects there). In the DB it is locked out of every existing table via
  `not (select public.is_guard())` on the any-signed-in-user policies (admin/user/viewer unchanged); new policies that
  let any signed-in user in must add the same clause. `public.app_role()` (SECURITY DEFINER) returns the caller's role.
- `visitor_logs` / `visitor_log_edits` have no write grants or policies: every write goes through the `visitor_*`
  SECURITY DEFINER RPCs (a trigger rejects anything else and every DELETE; void/correct only). The private
  `visitor-ids` storage bucket (ID photos) is upload-only for guard/admin/user and read/delete for admin only;
  photos are removed only through the Storage API by the admin purge, never by SQL.

## Notifications
Email on new approval requests, approval decisions (approved/rejected) and maintenance tickets. Client
calls `notifyAsync(type, recordId)` (`src/lib/notify.js`); the `notify-email` Edge Function loads the
row, emails subscribed recipients via the Apps Script mailer.
- `approval_decision` is fired from `Approvals.jsx` `decide()` after the whole path succeeded (never
  from `approvals.js`). It also emails the requester on their own (single recipient) using the address
  from the auth admin API, never `approval_requests.requester_email`; subscribed admins get the admin
  copy. Its `load()` requires: admin caller, status `APPROVED`/`REJECTED`, `decision_maker_id` = caller,
  fresh `decided_at` (10 min). Request-type handlers require `PENDING` + fresh instead.
- Approval and maintenance-ticket emails are built by pure modules (`email-kit.ts`, `approval-email.ts`,
  `ticket-email.ts`, `approval-fixtures.ts`, `_shared/approval-labels.ts`; no Deno globals, no imports of
  `events.ts`/`email.ts`/`index.ts`); approval emails also mask PII. Layout spacing is `<td>` padding on a
  4/6/8/10/12/16/20/24/32 scale via `stack()` in the kit; no margins except `margin:0` (h1) and `margin:0 auto`
  (centering the button table). Never write `\u` escapes under
  `supabase/functions/` (the deploy transport decodes them; use `String.fromCharCode`) — the preview script
  scans for this. The plain test email is built inline in `index.ts`. After changing them run `node scripts/preview-approval-email.mjs` (sends nothing; writes
  git-ignored `.email-preview/`). Admins can send fictitious samples per recipient from the settings page.
- **Add a type:** add an entry to `NOTIFICATION_TYPES` in `_shared/notification-types.ts`, add its
  handler in `notify-email/events.ts`, call `notifyAsync` after the triggering insert, redeploy the
  function. No SQL, no settings-page change. The new handler's `load()` must authorize the caller,
  require the record to be in the right state (`PENDING` for "raised" events; `APPROVED`/`REJECTED` by
  the caller for the decision event) and fresh, like the existing ones. Existing recipients are NOT
  subscribed to a new type until an admin ticks it on the settings page.
- Secrets (`APPS_SCRIPT_URL`, `APPS_SCRIPT_SECRET`, `APP_URL`) live only in Supabase; `MAILER_SECRET`
  only in the Apps Script's Script Properties. Never put any of them in the repo.
- Deploy the Edge Function with JWT verification on (`verify_jwt=true`; no `config.toml` in the repo,
  so it is a deploy-time setting — never pass `--no-verify-jwt`). Keep it building messages from the DB row by id,
  never from caller-supplied text.

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
- **Never run all of `database/init.sql` against the live DB.** Its last section is a seed that
  starts with `truncate table rooms, cutoffs, activity_log cascade` (wipes live data). Apply only the
  specific blocks you need.
- Theming: CSS custom properties in `src/index.css` (light + `data-theme="dark"`), bridged in
  `tailwind.config.js`. Use token classes (`bg-surface`, `text-ink`, `border-line`, …), not raw
  `slate`/`white`. `Login.jsx` and the print pages are deliberately fixed light and don't follow the theme.
- Money logic (billing, utilities allocation, rent, late fees) must be exact — no silent rounding
  assumptions, no swallowed errors on financial writes. Full detail: `docs/requirements.md` §5–6.
- Non-negotiables (see `docs/requirements.md` §14 for full detail) — treat these as hard blockers,
  not style preferences:
  - A tenant's outstanding balance must always reconcile (sum of bills = sum of payments + adjustments).
  - A room's metered utility consumption must always equal the total billed across its tenants for
    that period, even across move-ins/move-outs/transfers mid-period.
  - No two active tenants may occupy the same bed at the same time.
  - Never delete billing/payment records — void/adjust only, for audit trail.
- Known gaps awaiting fixes — see `docs/requirements.md` §15 for the full backlog (move-out
  approval flow, dynamic due-date labels, late-fee toggle, deposit/refund tracking). Don't assume
  current behavior in these areas is the intended target state.
- **Day-weighted occupancy** (`docs/requirements.md` §9): `supabase/functions/_shared/occupancy.ts`
  is the single pure formula module, imported unmodified by both `src/lib/snapshot.js` and
  `src/pages/Dashboard.jsx` (same `_shared/` → `src/` cross-runtime import precedent as
  `PROFILE_FIELD_LABELS` in `src/lib/supabase.js`). Snapshots are captured on cutoff-open
  (`src/pages/Utilities.jsx`, one combined water+electric "Open Cutoff" action — there's no
  separate per-utility cutoff-open flow) and via the manual "Snapshot now" / admin-only "Recompute
  occupancy %" buttons on Reports — **not** by a scheduled job; a pg_cron/pg_net Edge Function was
  considered and rejected in favor of this embedded mechanism. Snapshot timing never affects any
  live Dashboard number (those read live `beds`/`tenants` directly) — only the historical
  "Occupancy Rate YTD" chart depends on `monthly_reports` having been snapshotted.
- **Dashboard KPI drill-downs** (`docs/requirements.md` §10): all 8 Dashboard KPI tiles (plus the Occupancy card's "Month detail" link) open a
  shared `src/components/DrillDownModal.jsx` (table shape with search/row-cap/footer-link, or list
  shape reusing `.upcoming-item`), built from data already in `Dashboard.jsx`'s memory — no new
  fetches. Row clicks pass `location.state.{openTenantId}` to `/tenants` (auto-opens
  `TenantProfileModal`, resolved via a `Tenants.jsx` `allEnriched` memo that isn't filtered to
  `is_active` so it still finds tenants who've since moved out) or `location.state.{tab,
  focusRoomId}` to `/property` (auto-switches to the Bed Rates tab and scrolls/expands that room).
  Row-click and footer-link navigation are gated on the same `canAct` (`isAdmin || isUser`) boolean
  the Room Maintenance panel uses — viewers see full modal data but no clickable rows/links, since
  `/tenants` and `/property` are admin/user-only routes.
- This repo also runs a build pipeline (`.claude/agents/`: solution-architect, fullstack-engineer,
  qa-engineer, tester, database-admin) orchestrated by the `dev-pipeline` skill
  (`.claude/skills/dev-pipeline/`) — invoke it for end-to-end feature work.
- Don't commit or push unless explicitly asked, even at the end of a pipeline run.
