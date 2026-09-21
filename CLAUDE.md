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
  Utilities, Collections, PaymentMonitoring, Maintenance, Approvals, Reports, Property, Activity,
  Users, NotificationSettings, PrintElectricity, PrintRentWater, Login)
- `src/components/` — shared UI (MoveInModal, MoveOutModal, TransferModal, Statement, MultiEntryInput,
  SearchInput, TicketDetailModal, Sidebar, Toast, …)
- `src/lib/` — data layer: `supabase.js`, `billing.js`, `pnl.js`, `snapshot.js`, `auth.jsx`,
  `approvals.js` (approval requests), `tenantProfile.js`, `notify.js` (client side of email
  notifications), `theme.jsx`
- `supabase/functions/notify-email/` + `supabase/functions/_shared/notification-types.ts` — the
  notification Edge Function and its type registry. Deployed via the Supabase MCP/CLI, **not** by
  Vercel.
- `apps-script/bedspace-mailer.gs` — reference copy of the mailer. The live copy lives in Google
  Apps Script under bedspacemkt@gmail.com; changing it there needs a "New version" web-app
  deployment to take effect.
- `database/init.sql` — single consolidated schema file (tables, views, functions, RLS policies, seed
  data). See the truncate warning under Working conventions.
- `database/UTILITIES_PLAN.md` — design notes for the utilities billing model.
- `scripts/` — one-time Node migration scripts from the old Google Sheets.

## Roles
`admin` / `user` / `viewer`, defined in `public.profiles.role` and enforced via **Supabase RLS
policies** (`database/init.sql`), not just client-side checks in `src/lib/auth.jsx` /
`src/components/Sidebar.jsx`. Route gating lives in `src/App.jsx` and waits for the role
(`useAuth().loading` stays true until it resolves) so deep links land correctly; a failed role
lookup falls back to `viewer`. `owner` was a legacy role, migrated away from — if you see it
mentioned anywhere (old commits, old docs), treat it as stale.

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
  approval flow, dynamic due-date labels, late-fee toggle, daily occupancy tracking,
  deposit/refund tracking). Don't assume current behavior in these areas is the intended target state.
- This repo also runs a build pipeline (`.claude/agents/`: solution-architect, fullstack-engineer,
  qa-engineer, tester, database-admin) orchestrated by the `dev-pipeline` skill
  (`.claude/skills/dev-pipeline/`) — invoke it for end-to-end feature work.
- Don't commit or push unless explicitly asked, even at the end of a pipeline run.
