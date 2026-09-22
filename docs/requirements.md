# Bedspace Management Tool — Functional Requirements

> Source of truth for business rules not visible from the code alone. Read by the Solution
> Architect agent before planning any feature (see `CLAUDE.md`). Sections marked `TBD` need
> more detail from the business owner before they can be implemented — don't guess at them.

## 1. Overview
Internal tool for a bedspace/dormitory rental business. Replaced a Google Sheets workflow.
Staff manage tenants, bed/room inventory, per-day utility billing, rent collection, maintenance
requests, and owner-facing occupancy/collections/P&L reporting.

## 2. Glossary
- **Bedspace / bed** — an individual rentable bed. A room contains one or more beds.
- **Room** — the physical unit containing 1+ beds. A room may be rented per-bed to separate
  tenants, or in full by a single tenant renting every bed in it ("whole-room tenancy" — see §3).
- **Cutoff** — the business's billing period. **Rent and water share one cutoff window: the 1st
  to the end of the month.** Electricity runs on an independent cutoff: the 10th to the 10th of
  the following month (e.g. July 10 → Aug 10).
- **Move-in / Move-out** — start/end of a tenancy.
- **Transfer** — moving an existing tenant from one bed to another (possibly a different room).
  Rent and utility responsibility split proportionally by day between old and new room/rate.
- **Solo Room** — room type (previously called "Studio" in old planning docs — that name is
  retired). Differs from a standard room only in size and bed capacity — **no rate difference**.
- **Whole-room tenancy** — one tenant renting every bed in a room (e.g. a 2-bed room rented
  entirely by one person). Billed as a single combined line (combined rate = sum of that room's
  bed rates), not as separate per-bed tenants.

## 3. Tenant lifecycle

### Move-in
- Lease term is typically monthly; a fixed move-in/move-out date is captured at move-in
  (matches current `MoveInModal` behavior — both dates required).
- Required documents: **2 valid government-issued IDs** (any type accepted) + a **scanned signed
  copy** of the lease contract (fixed template). Confirmed implemented — uploaded to Google Drive
  (one folder per tenant) and tracked in `tenant_documents`, viewable/manageable anytime from the
  tenant profile's Documents tab, not just at move-in.
- Billing starts immediately at move-in, prorated against the rent/water cutoff window (see §5)
  — day-exact proration, confirmed correct as currently implemented.

### Tenant profile — required fields
Confirmed field list (all required at move-in, all editable afterward from the tenant profile).
Confirmed implemented and matches this spec exactly:
- Name
- Contact number(s) — **multiple**, not a single phone field (tracked in `tenant_contacts`, one
  marked primary)
- Email(s) — **multiple** (tracked in `tenant_emails`, one marked primary)
- Permanent address
- Emergency contact (name + number)
- Occupation
- Employer
- Employer address
- Employer contact number
- Source (how the tenant found the property) — fixed set: **Referral, Facebook, TikTok,
  Instagram, Walk-In**. Used for the move-in-source report (§9).

### Payment recording is NOT part of the Tenant module — confirmed, done
**Record Payment has been removed from every entry point inside the Tenant module**: the
row-level "Record" button on the Tenants list, and the "Record Payment" button in the tenant
profile modal's footer (opened via "View"). Both were confirmed redundant with Collections
(§12), which already provides clickable payment-recording cells, and having multiple divergent
entry points for the same money-affecting action was a consistency risk. **Collections is now
the single, exclusive place in the app where a payment is recorded.** The Tenants list's row
actions are just **View** and **Move Out**; the tenant profile modal's footer keeps **Transfer**
and **Move Out** only (Edit Details moved to its own module — see below).

### Edit Tenant Profile module (new, replaces Tenants > View > Edit Details)
- **Gap being closed:** Tenants > View > Edit Details only allowed editing the **move-out date**.
  Every other personal detail captured at move-in had no edit path afterward.
- **Confirmed: this becomes its own module** — an **"Edit Tenant Profile"** entry in the main
  sidebar, with its own page. The old "Edit Details" button in the tenant profile modal is
  **removed**, so there's exactly one place to edit a tenant's details.
- **Flow:** open Edit Tenant Profile → **search by tenant name or room** → pick the tenant → edit →
  save.
- **Editable fields:**
  - Full name
  - Gender
  - How did they find us? (`source` — Referral / Facebook / TikTok / Instagram / Walk-In)
  - Permanent address
  - Contact number(s) (and emails — same multi-entry model as move-in). On edit, full name and
    at least one contact number are required; **email is optional**, so older tenants with no
    email on file can still have their other details updated.
  - Emergency contact (name + number)
  - Work & Employment — occupation, employer, employer address, employer contact number, location
    of work, work schedule
  - Planned move-out date (carried over from the old Edit Details)
- **Not editable here:** rate, bed/room assignment, move-in date, active status — those change
  only through their own flows (Transfer, Property bed rates, Move-out).
- **Permissions:** visible to `admin` and `user`, not `viewer` (same as the Tenants page).
  - **Admin:** saves directly.
  - **Non-admin (`user`): every change on this page requires admin approval** — personal details,
    contacts/emails, and move-out date alike. Confirmed by the owner: all non-admin actions here are
    subject to approval. A save submits **one approval request** containing the whole change set
    (with a required reason); nothing changes on the tenant until an admin approves it in
    Approvals, which then applies all of it at once. Enforced at the database layer too — a `user`
    session cannot write these tenant fields or edit/delete existing contacts/emails directly.
  - While a request for a tenant is pending, the page shows it, and a `user` can't submit another
    one for that tenant until it's approved or rejected (prevents conflicting requests).
- Every applied change (admin save, or an approved request) writes an `activity_log` entry
  recording which fields changed (old → new); a move-out date change also writes the
  `Move-out Date Changed` entry the lease-extension metric relies on — **including when it's
  applied via approval** (previously approved move-out changes skipped that entry).
- **Tenants > View > Contacts tab is read-only.** Contacts/emails are edited only here, so there's a
  single edit path that respects the approval rule.

### Move-out
- **Direct admin move-out (today's behavior is correct, keep as-is):** frees the bed, deactivates
  the tenant, records the final payment and closing meter readings immediately.
- **Approval-path move-out (non-admin initiated) — currently broken, needs fixing.** Confirmed
  workflow: non-admin submits request with reason → admin approves → **admin then confirms
  payment** → only then does the system free the bed, soft-delete (deactivate) the tenant, and
  write an `activity_log` entry. Today, approving only updates the move-out date and does none of
  that — a real gap. *(Open question for implementation: does the same payment-confirmation step
  also get added to the direct-admin path, or does admin-direct move-out keep working exactly as
  it does today, one-step? Owner said the two-step flow applies to the approval path — confirm
  before touching the direct-admin path.)*
- **Move-out date edits (lease extensions/shortenings) must be logged. — DONE.** Any change to a
  tenant's `move_out_date` — including a plain admin edit via the tenant profile, not just a
  formal move-out — writes an `activity_log` entry (`activity_type: 'Move-out Date Changed'`).
  This is the infrastructure the lease-extension count metric (§9/§10) reads.

### Transfer
- Rate and utility responsibility split proportionally by exact day count between old and new
  bed/room within the cutoff. Admin can transfer directly; non-admin needs approval + reason.
  Current implementation confirmed correct.

## 4. Bed / property inventory
- Bed/room states: **Vacant, Leased, Reserved, Out-of-Order, Removed** (soft-delete). No other
  states needed.
- Room types differ only in **size and bed capacity** — not rate. No per-room-type utility rate
  differentiation is needed (confirms §6 — flat water rate applies to every room, including Solo
  Rooms).
- Whole-room tenancy (§2/§3) is a valid, intentional configuration — not a bug to fix.
- **Room repair/maintenance history — confirmed sufficient as-is, no further work needed.** The
  `room_logs` table already gets an entry automatically whenever a maintenance ticket is raised
  against a room (see §8). A dedicated "browse this room's repair history" screen is **not**
  required — the maintenance module (and its Dashboard panel, §10) is the single source of truth
  for a room's issue history. Confirmed done; not a backlog item.

### Room reconfiguration — DONE
Rooms are now genuinely reconfigurable, not just a cosmetic bed-count label. An admin can convert
a room's actual configuration — e.g. take a Solo Room and reconfigure it into a 6-bed sharing
room, or vice versa — adding/removing real `beds` rows and setting the new configuration's rate,
via an admin-only "Reconfigure" action on the Property page (Bed Rates tab). Implemented as one
atomic Postgres function (`reconfigure_room()`), applied and empirically verified live. Resolution
of the four open questions raised when this was planned:
1. **Reducing bed count below occupied beds** — resolved structurally: the function hard-blocks
   removing any `LEASED` bed (both in the UI and, independently, inside the function itself), so
   there's no separate "count below occupied" case to detect.
2. **Mid-cutoff utility-split interaction** — resolved: confirmed by reading `billing.js` that the
   Method B split is driven entirely by tenant move-in/move-out dates and room_id, never by bed
   count, so a bed added/removed mid-cutoff has zero effect on the room's metered-total-equals-
   billed-total invariant. No special proration logic was needed or added.
3. **Room type consistency** — resolved: `room_type` is a pure display label everywhere in the
   codebase (confirmed via full-codebase grep); nothing derives an expected bed count from it, so
   no enforced coupling was built. Admin sets the label manually as part of the same operation.
4. **Approval-workflow routing** — resolved as **admin-only, no approval routing**, per the
   original request that this "can be done in backend" — consistent with `beds` INSERT already
   being admin-only at the RLS layer.

## 5. Billing & rent
- **Cutoff windows:** Rent + Water = 1st to end-of-month. Electricity = 10th to 10th.
- **Proration:** mid-cycle move-in/move-out/transfer prorates by exact day count against the
  rent/water cutoff window (not a calendar month) — confirmed correct as implemented.
- **Due-date labels must be dynamic, not hardcoded.** Today `Collections.jsx` shows fixed strings
  ("due EOM" / "due 10th") regardless of the actual cutoff dates. These must be computed from the
  active cutoff's real `water_end` / `electric_end` dates so an off-cycle cutoff doesn't produce a
  misleading label. *(Implementation task.)*
- **Late fee: 2% of the tenant's unpaid prior balance, manual per-statement toggle — not
  automatic.** Add a checkbox on the PDF statement generation screens (`PrintRentWater.jsx`,
  `PrintElectricity.jsx`) that enables/disables a late-fee line on that specific printed
  statement. The fee is 2% of whatever the tenant still owed from before (not 2% of the current
  bill being printed) — so this depends on running-balance tracking existing first (see deposits/
  balance item below). There is no date-based auto-trigger — staff decide per print run.
  *(Implementation task — new feature. Depends on running-balance tracking being built.)*
- **Deposits, refunds, running balance — wanted, as a tracking/monitoring feature. Fully specified
  below.**
  - Today's real-world process (outside the app): tenant sends proof of payment to staff → staff
    verifies at the head office → once confirmed, staff manually updates an external Excel file →
    sent to accounting. **Confirmed: this moves in-app** — proof-of-payment should be an in-app
    upload + staff-verification step, mirroring the current external process, not just a bare
    amount field.
  - **Structure (classic PH rental convention): 1 month advance + 1 month deposit**, both
    equivalent to the tenant's rate at move-in, both collected **in full at move-in** (2 months'
    rent total upfront, as two separately tracked amounts — not one combined figure).
    - **Advance**: held for the duration of the tenancy. Returned at move-out unless reduced by a
      forfeiture condition below.
    - **Deposit**: at move-out, applied first against the tenant's final utility bill; the
      remaining balance ("change") is refunded.
  - **Forfeiture conditions** (advance and/or deposit may be reduced or forfeited):
    - Early termination — tenant leaves before the agreed lease end date: **the full 1-month
      advance is forfeited**, no partial/prorated credit regardless of how early the tenant
      leaves.
    - Unpaid balance at move-out — any outstanding rent/utility/add-on balance beyond what the
      deposit already covers is deducted from the advance before refund.
    - Otherwise (normal move-out, full lease term served, no outstanding balance): advance
      refunded in full, deposit's change refunded after covering the final utility bill.
  - **Refund timing/method**: not settled same-day/in cash — processed **within a few days after
    move-out, via bank transfer**.
- **Projected vs. actual rent collection, directly comparable — DONE.** `Reports.jsx` used to show
  only the billed/projected side and `Collections.jsx` only actual payments, with nothing putting
  them side by side. This is now surfaced at two levels — a summary widget on the Dashboard (§10)
  and a full per-tenant drill-down in the Tenant Payment Monitoring module (§11) — both sharing
  one calculation (`src/lib/collectionsSummary.js`), so staff can explain, during reporting, why
  the total amount actually collected differs from the projected figure on the property summary
  report.

## 6. Utilities
- Providers: Maynilad (water), Meralco (electricity). Provider rates **vary over time** — this is
  exactly why the manual markup-override checkbox exists in the Utilities screen; 10% is only a
  seed default, not a fixed business rule.
- Split method: Method B (segment-based, per-day, per-tenant proration) — **confirmed correct**
  against a real example: reading 10434 → 10541 (107 units consumed), room total ₱2,354.00, 5
  tenants present the whole period → ₱470.80 each (2,354.00 ÷ 5 = 470.80 exactly, matches the
  implemented algorithm with no discrepancy).
- Common areas (Lobby, 2nd Floor, Roof Deck): pure operating cost, **billed to nobody**, absorbed
  by the business — confirmed intentional, not a placeholder.
- Commercial tenants (e.g. water-refilling station, parking): billed **on the same cutoff/billing
  cadence as regular bedspace tenants** — the "(pending)" marker currently in `Utilities.jsx` and
  `pnl.js` should be resolved on that basis. *(Implementation task: verify current logic already
  matches this and remove the "(pending)" language, or adjust if it doesn't.)*
- **Judgment-laden "losing"/"earning" wording removed from the utility P&L variance display —
  DONE.** `Utilities.jsx` now renders the room-collections-vs-provider-cost variance as
  "Shortfall" / "Surplus" instead of "losing" / "earning."
- **Deleting a "Move-out readings this cutoff" entry (Billing) needs a confirmation step and
  proper approval.** These are the interim meter readings captured at a tenant's move-out for the
  active cutoff. Today's delete button removes one with no confirmation. Confirmed requirement:
  (1) a confirmation modal before deleting, always; (2) **proper approval** — matching the general
  principle in §7, admin deletes directly (after confirming), non-admin (`user`) submits the
  deletion for admin approval, since it affects a billing figure that's already fed into utility
  proration. — **DONE.** Confirmed rendered in `Billing.jsx`, backed by a DB trigger enforcing the
  admin-direct/non-admin-approval split (see backlog §15).

## 7. Roles & permissions
- **RLS must be real, not just client-side, even though this is an internal-only tool. — DONE.**
  Enabled Row Level Security consistently across all tables matching the admin/user/viewer role
  model (previously only 4 of 27 tables had real per-role policies; the rest shared one blanket
  "any authenticated session" policy). Applied and empirically verified live. Two known follow-ups
  remain open separately: a `profiles` RLS gap blocking the admin user-management page, and the
  `tenants_update` policy for payment-date bookkeeping (the latter already fixed this cycle).
- General principle: whatever is visible/accessible to the `user` role in the UI, they may do
  directly, **provided it's captured in `activity_log`**. A specific subset of actions additionally
  requires the approval workflow (current scope: move-out, transfer, room config, bed rate
  changes, bed removal — see `.claude/agents/`). Room reconfiguration (§4) is deliberately
  admin-only instead, not approval-gated.
- **Add-ons are explicitly NOT approval-gated.** `user` role can add/remove billing add-ons
  (parking, aircon, etc.) freely, with no approval and no reason required — the only requirement
  is that it's logged in `activity_log`. Confirmed intentional, not a gap to close.
- **Admin overrides on the approval workflow, and newly-raised maintenance tickets, should notify
  by EMAIL, not just an in-app list.** Today, approval requests (move-out, transfer, room config,
  bed rate, bed removal, tenant profile edits, interim-reading deletes) and maintenance tickets
  only appear in-app (Approvals / Maintenance pages); nobody finds out except by manually
  checking. **Confirmed requirement, expanded scope:** email notifications for both (1) a new
  pending approval request being raised, and (2) a new maintenance ticket being raised.
  **Delivery decision (revised): Google Apps Script, not Resend.** Mail is sent by an Apps Script
  web app running under the **bedspacemkt@gmail.com** account (`MailApp.sendEmail`), the same
  approach the owner already uses in the IDSS project. The Supabase Edge Function still decides
  *who* gets what (from the admin-managed recipient list) and then hands the finished email to
  the Apps Script web app, authenticated with a shared secret. Neither the shared secret nor the
  web app URL goes in the repo (Supabase secrets only). See the "Notification settings module"
  below for the configuration surface. — **DONE**, live and owner-tested (see below).

### Login & role-gated routing
- **Password show/hide toggle — DONE.** An eye icon button inside the Login page's password field
  toggles the input between masked and visible text. It is `type="button"` (never submits the
  form), keyboard-focusable, and carries an `aria-label` ("Show password" / "Hide password") plus
  `aria-pressed`. The input is not remounted, so typed text is preserved; `autoComplete` attributes
  are unchanged so password managers keep working. The field stays visible/masked only for the
  current page view — it is not reset after a failed login.
- **Role must be resolved before routing — DONE.** `useAuth().loading` stays true from sign-in
  until the user's role has been read from `profiles` (`src/lib/auth.jsx`); `App.jsx` shows the
  loading screen and only then mounts the router and the role-gated routes. This is what makes
  deep links work — e.g. a link in a notification email to `/maintenance` or `/approvals` lands in
  that module for a permitted role, instead of being bounced to the Dashboard before the role
  arrived. A role that isn't permitted for the target route (the catch-all `*` route) is redirected
  to the Dashboard.
- **Failed role lookup falls back to `viewer`** (least privilege) rather than granting anything.
- Client-side route gating is a UX convenience only; **RLS remains the real enforcement** (§7 above).

### Notification settings module (new)
- **Purpose:** let an admin configure who receives email notifications, without that list being
  tied to actual `profiles` accounts — the recipient(s) may not even be app users (e.g. an office
  manager's inbox, a shared distribution address).
- **Admin-only configuration page**: add/remove one or more notification email addresses. Each
  entry can opt in/out of each notification type independently. A newly-added address is
  subscribed to every currently-available type by default.
- **Extensible by design — more email types will be added later.** The owner confirmed further
  email notifications are planned, so the set of notification types must NOT be hardcoded as
  columns/checkboxes. Adding a new type later should be a small code change (register the type
  and its email template) with no schema migration and no rewrite of the settings page — the page
  should render its subscription options from a single registry of types (id, label, description).
  Today's three types: **Approval requests**, **Approval decisions** and **Maintenance tickets**. — **DONE**: the registry is
  `supabase/functions/_shared/notification-types.ts` (imported by both the Vite client and the Edge
  Function); subscriptions live in `notification_subscriptions` (one row per recipient + type id),
  not per-type columns.
- **Sender is fixed** (bedspacemkt@gmail.com via Apps Script) and not configurable in the app; the
  admin UI configures recipients only.
- **A "Send test email" action** on the settings page (admin-only) so an admin can confirm the
  Apps Script setup works end to end without having to raise a real ticket.
- **Triggers:**
  - A new `approval_requests` row is inserted (any `entity_type`/`field_name`) — matches the
    existing broad "any override requiring sign-off" scope, not just a subset.
  - A new `maintenance_tickets` row is inserted (raised, `status = 'PENDING'`).
- **Approval outcome (added later):** when an admin approves or rejects a request, the
  `approval_decision` type emails (a) the staff member who raised it, always, in their own
  single-recipient message (cannot be turned off on the settings page), and (b) admins subscribed
  to "Approval decisions". Still **not** in scope: notifying on ticket *resolution*, on later
  reversals of a decision, or any other event.
- **Delivery mechanism:** the Supabase Edge Function (`notify-email`, called fire-and-forget from
  the client right after the triggering insert succeeds) loads the subscribed recipients, builds
  the email, and POSTs it to the Apps Script web app with a shared secret; the Apps Script sends
  it with `MailApp`. Failure to send must not block or roll back the underlying
  ticket/approval-request creation — notification is best-effort, fire-and-forget from the
  user's perspective.
- **The Apps Script endpoint must not be an open mail relay.** Unlike the IDSS script (whose URL
  is its only protection, acceptable there because it can only trigger a fixed job), this
  endpoint accepts a recipient list and message body, so it must reject any request that doesn't
  carry the shared secret. Likewise the Edge Function must not let any logged-in user make it
  email arbitrary content to the admin list: prefer having it build the message from the actual
  ticket/approval row (by id) rather than trusting caller-supplied text.
- **Mail quota:** Google caps how many recipients a script can email per day (Gmail-account
  limit, lower than Workspace). Notifications are low-volume, but the design should send one
  message per event rather than one per recipient where practical, and surface a failure clearly
  in the function logs if the quota is hit.
- **The Apps Script lives outside the repo's deploy path** (edited in the Google editor). Keep a
  copy in the repo (`apps-script/`) as the reviewable source of truth, like the IDSS project
  does, and note that a code change needs a new web-app deployment version to take effect.
- **Delivery guards (implemented design):** the Edge Function only emails for a record that is
  still `PENDING` and was created within the last **5 minutes**, so it cannot be used to re-blast
  old records. Each record is emailed **at most once** (a unique `notification_log` row is claimed
  before sending; a repeat call is a no-op). The review-link base URL comes from the server-side
  `APP_URL` secret, never from the client. Subscriptions are **opt-in**: a newly-registered
  notification type does not email existing recipients until an admin ticks it for them (new
  recipients are subscribed to every registered type when added).

### Notification module — final state
- **Live and owner-tested (as reported by the owner, 2026-09-21; not verifiable from the repo).** The
  Apps Script mailer (sending as bedspacemkt@gmail.com) is deployed; the `notification_subscriptions`
  and `notification_log` tables were applied to the live database on 2026-09-20
  (both admin-read-only via `is_admin()`; `notification_log` has no client write policies — the
  Edge Function writes it with the service role).
- **Flow:** `requestApproval()` (`src/lib/approvals.js`) and `addTicket()` (`src/lib/supabase.js`)
  call `notifyAsync(type, recordId)` (`src/lib/notify.js`) after the insert succeeds. The client
  sends only the type and record id; the `notify-email` Edge Function loads the real row, checks
  the caller is allowed to have raised it, builds the email, and posts it to the Apps Script.
- **Admin "Send test email"** on `/notification-settings`, for all recipients or a single one.
- **Guards:** once-per-record (unique `notification_log` claim), 5-minute freshness window
  (`FRESHNESS_MS` in `events.ts`), record must still be `PENDING`, and sends are chunked at 20
  recipients per Apps Script call.
- **Approval emails (redesigned layout):** the request email and the outcome email share one
  email-client-safe design (600px table layout, inline styles, dark-mode and mobile-stacking
  progressive enhancement, status pill, changes table Field | Current | Requested, reason block,
  decision block, one CTA button). Builders are pure modules — `notify-email/email-kit.ts`,
  `approval-email.ts`, `approval-fixtures.ts` and `_shared/approval-labels.ts` (labels also used by
  the Approvals page and activity log) — so a Node script can render them. The maintenance-ticket email
  uses the same kit (`ticket-email.ts`, see §8); the plain test email is built inline in `index.ts`.
  - **Spacing:** one padding scale (4/6/8/10/12/16/20/24/32 px), all as `<td>` padding so it survives Outlook (no margins
    except `margin:0` on the h1 and `margin:0 auto` centering the button table); blocks
    are stacked with `stack()` in `email-kit.ts` (16px between blocks, 20px before sections, 24px above the
    centered CTA button); the footer strip sits inside the card's bottom edge; on narrow screens the
    summary and decision cells, the timeline boxes and the changes table columns (with small
    CURRENT/REQUESTED captions) stack with the gaps kept and nothing wider than the card (stacked
    cells are `box-sizing:border-box`; timeline boxes are nested tables with the gap as outer-cell
    padding). Labels break only between words; long values may break anywhere. The preview script checks these.
  - **Requester address:** never taken from `approval_requests.requester_email` (client-supplied,
    RLS only checks `requester_id = auth.uid()`). It comes from the auth admin API
    (`getUserById(requester_id)`) and is validated with the mailer's address pattern. If it is missing,
    or the requester is the decider, only the admin copy is sent. A requester who is also a
    subscribed admin gets the requester version only.
  - **When it fires:** `Approvals.jsx` `decide()` calls `notifyAsync('approval_decision', id)` after the
    whole approve/apply/reject path succeeded (not inside `approveRequest()`/`rejectRequest()`, whose
    ordering relative to applying the change differs by path). A failed apply sends nothing.
  - **Edge Function guards for `approval_decision`:** caller is an admin; the row is `APPROVED` or
    `REJECTED` (else `not_decided`); `decision_maker_id` equals the caller; `decided_at` within the
    last 10 minutes, at most 2 minutes in the future (it is written by the deciding admin's browser
    clock) and not before `created_at` (else `stale_record`). The claim is
    `('approval_decision', request id)`, distinct from the request email's claim. The message
    reflects the status at load time; a later reversal is not emailed. `approval_request` still
    requires the caller to be the requester, `PENDING`, and created within 5 minutes.
  - **PII masking:** phone-like values show only the last 4 digits and email addresses show the first
    letter plus domain (`m•••@example.com`); if masking would hide a real change the cell says
    "(changed)". Names, addresses, employer and work details are shown in full. No full record id
    (only `AR-` + 8 hex characters), no internal `_` keys, no requester_email, no URL except the CTA.
  - **Admin sample emails:** on `/notification-settings` an admin can choose "Sample: approval
    request / approved / rejected / maintenance ticket" for a row's Send button. Samples use fixed fictitious data, are
    subject-prefixed `[SAMPLE]`, go to exactly one existing recipient row (never everyone, never a raw
    address), and are not logged or claimed. The header "Send test email" stays a plain test.
  - **Preview:** `node scripts/preview-approval-email.mjs` renders fictitious fixtures (including
    hostile input) to `.email-preview/` (git-ignored) and runs automated checks. It sends nothing.
  - **Known limitations:** the CTA opens `/approvals` on its default Pending tab, so an already-decided
    request is not shown there; the requester CTA goes to `/` because staff cannot open `/approvals`.
    Delivery is best-effort: a failed send is not retried (the once-only claim stays burned).
- **Secrets:** `APPS_SCRIPT_URL`, `APPS_SCRIPT_SECRET` and `APP_URL` exist only as Supabase
  secrets; `MAILER_SECRET` exists only in the Apps Script's Script Properties. None is in the repo.
  If the first two are unset the function no-ops with a logged warning.

## 8. Maintenance requests
- Keep the current two-state model: **Pending → Resolved**. No priority, assignee, or
  cost-to-tenant fields needed — confirmed simple is correct, despite an unused schema table
  (`tickets`) that would support the richer version.
- Confirmed implemented, matches spec: room number, concern, remarks, date raised, tenant who
  raised it (nullable — supports staff-raised tickets with no tenant attached), resolution notes,
  resolved-by/resolved-at, pending/resolved status, with an auto-write to `room_logs` and
  `activity_log` on raise/resolve.
- This same ticket list (with tenant name shown) is also reachable from the Dashboard as a "Room
  Maintenance" panel — see §10. It's the same underlying data as `Maintenance.jsx`, not a second
  parallel maintenance system.
- **Dashboard's Room Maintenance panel (including its "View all in Maintenance →" link and its
  raise/resolve actions) is visible only to `admin` and `user` — not `viewer`.** Confirmed
  requirement: the panel is a write-capable operational tool, and `/maintenance` itself is already
  admin+user-only, so nothing about it should surface for a read-only viewer session on the
  Dashboard either. — **DONE**, browser-tested both roles.
- **Raising a ticket happens only in the Maintenance module, not from the Dashboard. — DONE.** The
  Dashboard's Room Maintenance panel (§10) stays as a view of pending tickets and keeps its
  Resolve action; "+ Raise Ticket" is Maintenance-page-only.
- **Clicking a ticket opens a view/detail modal.** Confirmed requirement: the Maintenance list
  (both the full `/maintenance` page and, if practical, the Dashboard panel) should let staff
  click a ticket to open a read-only detail view showing everything about it — room, concern,
  full remarks, who raised it (tenant or staff), date raised, status, and — once resolved —
  resolution notes, resolved-by, and resolved-at. Today only a truncated remarks preview is
  visible in the table row; there's no way to see the full remarks or (for a resolved ticket) the
  resolution details without re-opening the Resolve flow. This is a new read-only view, distinct
  from the existing Raise/Resolve action modals. — **DONE** (`TicketDetailModal.jsx`).
- **"New ticket raised" email is a designed layout (§7).** Built by `notify-email/ticket-email.ts` with
  the same kit as the approval emails: header label "Maintenance", "● PENDING" pill with a `MT-<id>`
  reference, summary card (Room, Tenant — "Staff-raised" when none, Concern, Raised by, Raised time in
  Manila time), a Remarks block ("No remarks provided" when empty), a centered "View ticket" button to
  `/maintenance` (omitted when `APP_URL` is unset), and a footer naming the "Maintenance tickets"
  subscription. Subject `[New ticket] Room 702 · <concern>`. The loading, authorization (admin/user only),
  `PENDING` and 5-minute freshness guards are unchanged; "Raised by" is the caller's JWT email. Admins can
  send a fictitious "Sample: maintenance ticket" to one recipient from the notification settings page.
  Follow-up idea (not built): a "ticket resolved" email to whoever raised the ticket.

## 9. Reporting
- **New requirement: daily occupancy tracking.** The business needs occupancy rate computed on a
  **daily** basis (not just once per cutoff as today), then averaged across all days in the month
  (1st through the 30th/31st) to produce the end-of-month occupancy % used in monthly/quarterly
  reports. Today's snapshot mechanism only fires once, when a cutoff opens — it does not sample
  daily. *(Implementation task — new feature; needs a design decision on how daily samples are
  captured: a scheduled job, or reconstructed after the fact from move-in/move-out/transfer dates
  already in the data.)* The occupancy-rate-YTD bar graph below depends on this existing at
  monthly granularity, at minimum.
- **Projected vs. actual rent collection, side by side — DONE.** See §5. Visible at two levels: a
  summary widget on the Dashboard (§10) and a full per-tenant drill-down in the Tenant Payment
  Monitoring module (§11). Both derive from the same calculation — no duplicate/divergent logic
  between the two.
- **Move-in source report — DONE.** Aggregate breakdown of tenants' `source` field (Referral/
  Facebook/TikTok/Instagram/Walk-In — see §3), surfaced on the Dashboard (§10).
- **Lease extension count — DONE.** Count of `move_out_date` edits (see §3) within the current
  month, counting only edits where the new date is **later** than the previous value (edits that
  pull the date earlier don't count as "extensions" — confirmed default, no correction received).
- **Monthly counts, surfaced on the Dashboard (§10) — DONE:**
  - Beds moving out this month — count of active tenants whose `move_out_date` falls within the
    current calendar month (regardless of whether that date is already past or still upcoming).
  - Move-ins per month — count of tenants whose `move_in_date` falls within the current month.
  - Month-to-date projected move-outs — a forward-looking count restricted to the **remainder** of
    the current month (from today through month-end), distinct from "beds moving out this month"
    above (which covers the whole month, including days already past). Built as two separate
    numbers per the default assumption made during implementation — no correction received.
- **Occupancy rate year-to-date, as a bar graph — DONE.** Added `recharts` as a charting-library
  dependency (none existed before) and a monthly occupancy-rate bar chart on the Dashboard (§10),
  fed by the existing per-cutoff `monthly_reports` snapshots (grouped by month for the current
  year; months with no snapshot render as a gap, not a fabricated zero bar) — this didn't end up
  needing daily occupancy tracking to exist first, since monthly granularity was already being
  captured by the existing snapshot mechanism.

## 10. Dashboard module
The Dashboard is the property's home screen, showing at-a-glance metrics and a couple of
genuinely Dashboard-native panels — **it does not duplicate workflows that already live properly
in another module.**

- **Heading/subheading — DONE.** Heading stays **"Dashboard"**. Subheading is **"Your Property at
  a Glance"**.
- **Tenant quick actions — built, then removed. Confirmed as the wrong design.** Record Payment,
  Transfer Tenant, Edit Profile, and View Tenant were initially added to the Dashboard as
  tenant-search-then-act quick actions. **Confirmed: this duplicated functionality that already
  exists in the Tenants module** (View → tenant profile → Edit Details/Transfer/Move Out; payment
  recording lives in Collections per §3/§12). All four quick-action buttons, and the
  tenant-search picker that powered them, have been removed from the Dashboard. **The Dashboard
  does not offer a tenant-search-and-act entry point** — staff use the Tenants page for that.
- **Room Maintenance panel — DONE, with role gating (see §8).** Compact pending-ticket list and a
  "View all in Maintenance →" link, visible only to `admin`/`user`. **Raise Ticket is removed from
  this panel** — raising a ticket happens only in the Maintenance module (§8); the panel is a
  read/monitor surface for the Dashboard, not a duplicate entry point.
- **Metrics/widgets — DONE** (definitions in §9):
  - Beds moving out this month
  - Move-ins this month
  - Lease extensions (this month, later-date edits only)
  - Month-to-date projected move-outs
  - Occupancy rate YTD (bar graph)
  - Move-in source breakdown
  - Projected vs. actual rent collection summary (links into §11 for full drill-down)
- **Icon convention. — DONE.** The Monthly Revenue KPI card uses `lucide-react`'s `PhilippinePeso`
  icon (it does exist in the installed version — an earlier note here assuming otherwise was
  wrong), not a dollar sign.
- **Existing Dashboard elements to keep, unchanged:** Upcoming Move-outs (rolling 30-day) list,
  Recent Activity feed, today's occupancy segmented bar (this is a *different, complementary*
  widget from the YTD bar graph above, not a replacement for it).

## 11. Tenant Payment Monitoring module — DONE
A new, dedicated page (`/payment-monitoring`, admin+user only) — property-wide, not per-tenant —
for monitoring rent collection status across all tenants at once.

- **Purpose:** let staff see, for the current (or a selected) cutoff period, every tenant's billed
  amount vs. amount actually collected, so they can identify who hasn't paid yet and explain any
  gap between total actual collections and the projected figure on the property summary report
  (§5/§9).
- **Shows, per tenant:** billed total (rent/water/electric/add-ons), amount paid, outstanding
  balance (or a credit, if overpaid — never shown as a negative outstanding number), last payment
  date.
- **Supports filtering/sorting** by outstanding balance / unpaid status, so "who hasn't paid" is a
  direct view.
- **Selecting a non-active (historical) cutoff shows a warning banner**, since billed totals for a
  closed cutoff may not reflect tenants who've since moved out.
- **Feeds the Dashboard's projected-vs-actual summary widget (§10)** — the two share one
  calculation (`src/lib/collectionsSummary.js`), so there's no room for the numbers to drift apart.
  This must continue to hold once payments are recorded via the new multi-select/batch-save flow
  in Collections (§12) — confirm this at implementation time, don't assume it silently still holds
  just because it held for the old single-click write pattern.
- **Distinct from** the existing single-tenant Payments tab in `Tenants.jsx` (unchanged) — that's a
  one-tenant drill-down; this module is the all-tenants monitoring view.

## 12. Collections module
Collections (`Collections.jsx`) is the **single, exclusive place in the app where a payment is
recorded** — see §3 for the removal of the duplicate entry points that used to exist in the
Tenants module.

- **Existing behavior, confirmed correct, keep:** a table of tenants × billing categories
  (rent+water, electricity) with clickable cells for the active cutoff; clicking a cell records
  that tenant's payment for that category.
- **Both Rent+Water and Electricity amounts auto-populate from the active billing period. — DONE**
  when a cell is staged for entry (checkbox or "+ add"): defaults to that tenant's actual billed
  amount for the active cutoff (rent+water from the Rent+Water cutoff, electricity from the
  Electric cutoff — independent windows per §2/§5), editable before saving. Browser-verified
  correct to the peso for both categories. See the next section for a follow-up display gap found
  right after this shipped (the amount was only visible once staged, not at rest).
- **New requirement: multi-select + batch save. — DONE.** Instead of writing to the database on
  every single click, staff select multiple cells (a multi-select/checkbox interaction across
  tenants and/or categories) and commit all of them with one "Save" action — one batched insert,
  not N round-trips.
- **New requirement: undo functionality. — DONE.** Staff can reverse a payment they just recorded.
  **This must comply with the non-negotiable in §14 — never delete a payment record.**
  "Undo" has to be implemented as a void/compensating adjustment that preserves the original
  record and the full audit trail, never a hard `DELETE` of the `payments` row. *(Open question
  for implementation: is "undo" scoped to reversing the just-completed save/batch only, or a
  general void-any-past-payment capability reachable anytime? Default assumption unless corrected:
  undo applies to the just-completed action only — a broader "void any historical payment" ability
  is a bigger feature that overlaps with the deposits/running-balance work in §5, and shouldn't be
  assumed in scope here without confirmation.)*
- **Payments recorded here must be immediately reflected in the Tenant Payment Monitoring module
  (§11) and the Dashboard's collections summary widget (§10)** — both already read from the same
  shared calculation, so this should hold automatically; re-verify it still holds once the
  write pattern changes from single-click to multi-select/batch-save.
- **A cell's billed amount must be visible whether or not it's checked/selected — DONE, then a
  gap found.** The auto-populate work above (now shipped) only actually surfaces the amount once
  a cell is ticked/opened for entry — staff can't see what a tenant owes at a glance without
  interacting with the row. **Confirmed requirement: the actual (billed) amount must be visible
  in the cell at all times**, checked or not, with proper currency formatting (₱, thousands
  separator, 2 decimal places — matching the peso formatting convention used elsewhere in the app,
  e.g. Payment Monitoring). Checking the cell still stages it for the batch save as before; this
  is purely about always-visible display. *(Implementation task — see backlog §15.)*

## 13. UI/UX & theming
- **Dark / Light theme toggle.** Confirmed requirement: the app gets a theme toggle (dark and
  light modes), reachable from the main UI (e.g. Sidebar). Persists per browser (`localStorage`),
  respects a sensible default (system preference on first visit is a reasonable choice, confirm at
  implementation time rather than defaulting silently to one or the other). **Modernize the look
  and feel while building this** — not just a color-inversion pass. *(Implementation task — see
  backlog §15. Use the project's design-taste-frontend skill for this: audit the current UI first,
  build a real light+dark design system — tokens/CSS variables, not ad-hoc per-component
  overrides — rather than a templated look. This is a real visual redesign touching shared
  components broadly; budget it as such, not as a small toggle switch.)*
- **Search bar icon/placeholder overlap — confirmed bug.** In search inputs across the app (at
  least Tenants, Edit Tenant Profile, wherever else a search icon is positioned inside the input),
  the search icon visually overlaps the placeholder/typed text instead of sitting cleanly to one
  side with proper padding. *(Implementation task — see backlog §15: audit every search input for
  this, fix as one consistent pattern rather than one-off per page, since it'll be touched again
  by the theming work above — coordinate the two.)*

## 14. Non-negotiables
- A tenant's outstanding balance must always reconcile — sum of bills must equal sum of payments
  plus adjustments, with no drift.
- A room's metered utility consumption (water or electric) must always equal the total amount
  billed across tenants for that room/period, even when move-ins, move-outs, or transfers happen
  mid-period. (Matches the existing reconciliation check in `billing.js` — confirmed as a hard
  invariant, not just a nice-to-have.) Room reconfiguration (§4) preserves this invariant even
  when a room's bed count changes mid-cutoff — confirmed, no special handling was needed.
- No two active tenants may occupy the same bed at the same time. Room reconfiguration (§4)
  cannot violate this — reducing bed count below currently-occupied beds is hard-blocked.
- Never delete billing/payment records — void/adjust only, for audit trail. **This directly
  governs the new Collections undo feature (§12)** — undo must be a void/compensating entry, never
  a `DELETE`.

## 15. Confirmed implementation backlog
Concrete follow-up work items surfaced by this requirements pass, for the dev pipeline to pick up:
- [ ] Fix move-out approval flow: add payment-confirmation step, then free bed + deactivate tenant
      + log activity (§3).
- [ ] Make due-date labels in `Collections.jsx` derive from the active cutoff's real dates instead
      of hardcoded strings (§5).
- [ ] Add a 2%-of-unpaid-prior-balance late-fee toggle to the PDF statement generation screens
      (§5) — depends on running-balance tracking existing first.
- [x] Enable real RLS policies across all tables, matching the admin/user/viewer role model (§7)
      — **done**.
- [ ] Resolve the "(pending)" commercial-tenant utility billing marker in `Utilities.jsx`/`pnl.js`
      (§6).
- [ ] Design + build daily occupancy tracking feeding the EOM average (§9).
- [ ] Build deposit/refund/running-balance tracking per §5 (advance + deposit structure, in-app
      proof-of-payment verification, forfeiture rules — full advance forfeited on early
      termination, deductions for unpaid balance — bank-transfer refund within a few days of
      move-out).
- [x] Fix the missing `activity_log` entry when a tenant's `move_out_date` is edited directly
      (§3) — **done**.
- [x] Remove "losing"/"earning" wording from the utility P&L variance display in `Utilities.jsx`
      (§6) — **done**.
- [x] Build real room reconfiguration (bed count + rate change as one structural operation) (§4)
      — **done**.
- [x] Build admin-override email notifications for the approval workflow (§7) — **done**, see the
      notification items at the end of this list.
- [x] Build the Dashboard module: metrics/widgets (monthly move-in/out counts, lease extensions,
      MTD projected move-outs, occupancy YTD bar graph, move-in source breakdown, projected-vs-
      actual summary) + subheading text change (§10) — **done**. Tenant-search quick actions
      (record payment/transfer/edit profile/view tenant) were built, then intentionally removed
      as duplicate of the Tenants module — not part of the shipped Dashboard.
- [x] Build the Tenant Payment Monitoring module (§11) — **done**.
- [x] Remove Record Payment from the Tenant module entirely: the row-level "Record" button on the
      Tenants list, and the "Record Payment" button in the tenant profile modal's footer (§3) —
      **done**. Collections is now the sole payment-recording entry point.
- [x] Build Collections' multi-select + batch-save payment recording UX (§12) — **done**.
- [x] Build Collections' payment-undo/void functionality — audit-trail-preserving, never a hard
      delete (§12/§14) — **done**, via a compensating negative-amount row (`voids_payment_id`),
      applied and empirically verified live (double-void correctly rejected by a DB unique index).
- [x] Gate the Dashboard's Room Maintenance panel (including its "View all in Maintenance" link
      and raise/resolve actions) to `admin`/`user` only, hidden from `viewer` (§8/§10) — **done**.
- [x] Swap the Dashboard's Monthly Revenue KPI card icon from a dollar sign to a peso-appropriate
      icon/glyph (§10) — **done**, using `lucide-react`'s `PhilippinePeso` icon (it does exist in
      the installed version — this doc's earlier assumption that no such icon existed was wrong).
- [x] Build the Edit Tenant Profile module (§3): new sidebar page, search by tenant or room, edit
      full name, gender, source, address, contacts/emails, emergency contact, work & employment,
      and move-out date; remove the old Edit Details button from the tenant profile modal —
      **done**. Admin saves directly; every non-admin change goes through one approval request,
      enforced at the DB layer. Browser-tested as both `user` and `admin`.
- [x] Fix the `profiles` RLS gap so the admin Users page actually works (§7) — **done**. Fixed via
      a `SECURITY DEFINER is_admin()` helper (the first attempt, a self-referential RLS subquery,
      caused live infinite recursion — 42P17, broke all `profiles` reads for every role including
      login/role resolution; caught and reverted immediately, then rebuilt correctly). All users
      (admin, user, viewer) now visible on `/users`, role changes persist, browser-tested.
- [x] Remove the "Raise Ticket" action from the Dashboard's Room Maintenance panel (§8/§10) —
      **done**. Raising a ticket now only happens in the Maintenance module; browser-tested both
      roles.
- [x] Auto-populate Collections' Rent+Water and Electricity amounts from the active billing period
      for both categories (§12) — **done** for the amount staged into an interaction (checkbox/"+
      add"), browser-verified correct for both categories. A follow-up gap was found immediately
      after — see the next item.
- [x] Make Collections' billed amount always visible per cell, checked or not, with proper
      currency formatting (§12) — **done**. Renders via the existing `fmtPeso` formatter, no
      interaction required.
- [x] Add a confirmation modal + approval step to the "Move-out readings this cutoff" delete
      button (§6) — **done**. Backed by a DB trigger that only permits a direct delete for admin
      while still letting the cutoff-delete cascade through for `user` (first version's depth
      check was wrong and was a no-op — caught in live verification, fixed, re-verified).
- [x] Build a Dark/Light theme toggle with a modernized visual design (§13) — **done**. CSS
      custom-property token system (bridged through Tailwind's color config) covering the shared
      chrome and a mechanical sweep of common color patterns app-wide; Sun/Moon toggle in the
      Sidebar, persisted to `localStorage`, defaults to system preference, no flash on load.
      Excludes `Login.jsx` and the print pages by design (always render their fixed/print-safe
      look regardless of theme). QA caught and a revision round fixed: two core token values that
      failed WCAG AA contrast (recomputed with real luminance math), several dark-mode-breaking
      spots the mechanical sweep correctly skipped but never migrated (opacity-suffixed classes,
      a hardcoded white ring), and ~16 of Activity's activity-type badge colors plus Property's
      status badges that weren't in the original sweep's mapping table — extended with 7 new
      theme-aware badge tokens, all contrast-verified in both modes on re-review.
- [x] Fix the search-bar icon/placeholder-text overlap across the app (§13) — **done**. Root
      cause was a CSS specificity bug (a global `.toolbar` rule silently overriding each input's
      padding), fixed via a shared `SearchInput` component across all 6 affected pages.
- [x] Remove the "© {year} LKL Reports — All rights reserved" footer line from the Login page —
      **done**.
- [x] Add a view/detail modal to Maintenance tickets, showing full remarks and (once resolved)
      resolution details — see §8 — **done**. Click a ticket row on `/maintenance` or the
      Dashboard panel; browser-tested as admin.
- [x] Build the Notification settings module (§7) — **done**. Admin-only `/notification-settings`
      page (add/remove recipients, per-type opt-in), `notification_recipients` +
      `notification_subscriptions` + `notification_log` tables with admin-only RLS via
      `is_admin()`, and the project's first Edge Function (`notify-email`), called fire-and-forget
      from `requestApproval()` and `addTicket()`.
- [x] Switch notification delivery from Resend to a Google Apps Script mailer sending as
      bedspacemkt@gmail.com, make notification types extensible (registry-driven, no per-type
      columns), and add an admin "Send test email" action (§7) — **done**, live and owner-tested.
      Resend is no longer used (it was never activated).
- [x] Fix role-gated deep links so notification-email links land in the target module for
      permitted roles (§7 "Login & role-gated routing") — **done**.
- [x] Add a show/hide password toggle to the Login page (§7) — **done**.

### Known follow-ups (not scheduled)
- [ ] Mobile: the sidebar drawer stays open after tapping a nav link (unverified whether this
      pre-dates the notification work).
- [ ] Mobile: the "Send test email" button wraps on narrow screens.
- [ ] `auth.jsx` (low): on a direct user switch without sign-out, there is a possible one-frame
      window with the previous user's role.
- [ ] `auth.jsx` (low): the role fetch has no timeout, and a transient failure demotes the session
      to `viewer` until reload.
- [ ] Tickets have no `created_by` column, so "Raised by" in notification emails is the JWT email
      of the user who triggered the notification.
- [ ] Vercel Hobby plan is for non-commercial use — check the terms against this business's use.
- [ ] Gmail Apps Script daily recipient quota (~100/day for a consumer account) — unverified;
      confirm before adding many recipients or notification types.
- [x] Non-admin blocked check — **done**. The owner confirmed on 2026-09-21 that an admin's email
      link lands in the correct module and a `user` is blocked from modules they have no access to.

## 16. Occupancy Simulator (isolated what-if module)
- **Purpose.** Lets `admin`/`user` roles model potential rent at 100% (or a scaled) occupancy
  against an editable, standalone copy of room/bed rates seeded from the owner's CSV, plus an
  admin-only bulk CSV re-import.
- **Isolation guarantee.** `sim_rooms`/`sim_beds` (`database/init.sql`) have no foreign key to
  `rooms`, `beds`, `tenants`, `bills`, or `payments`, and no code path in `src/lib/simCsv.js`,
  the `sim_*` functions in `src/lib/supabase.js`, `OccupancySimulator.jsx`, or `SimImportModal.jsx`
  reads or writes those tables. Verifiable directly:
  `grep -n "references public.rooms\|references public.beds" database/init.sql` has no hits inside
  the `sim_rooms`/`sim_beds` block. Because nothing real is touched, **§14's non-negotiables do not
  apply to this module** — there is no balance to reconcile, no metered consumption to match, no bed
  to double-book, and edits may be hard-updated in place (no void/audit-trail requirement).
- **Occupancy slider is a coarse pro-rata estimate**, not a per-bed occupied/vacant simulation — it
  simply scales the sum of active (non-out-of-order) bed rates by `occupancyRate/100`. The UI states
  this explicitly.
- **CSV re-import is admin-only** and atomic (`sim_replace_all`, one Postgres function = one
  transaction — any internal error rolls back the whole replace, so there is no partial-write
  state). A duplicate `room_no,bed_letter` pair within one re-import file is a hard validation
  error: the whole file is rejected and nothing is written, before any RPC call.
- **Concurrency.** Last-write-wins via `updated_at`/`updated_by`, no locking — acceptable for a
  low-stakes sandbox with no financial consequence.
- **Out of scope for v1.** A "reset to CSV baseline" affordance (would need an import-history
  table).
