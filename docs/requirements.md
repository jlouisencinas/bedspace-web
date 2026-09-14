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
- **Admin overrides on the approval workflow should notify admin by EMAIL, not just an in-app
  list.** Today, approval requests (move-out, transfer, room config, bed rate, bed removal — and
  any override requiring sign-off, e.g. a non-standard move-out date change) only appear in the
  in-app Approvals page; an admin only finds out by manually checking it. **Confirmed requirement:
  admin should additionally be notified by email** when an override needs their approval. Not yet
  implemented — no email-sending capability exists anywhere in the codebase today (no SMTP
  provider, no Supabase Edge Functions). *(Implementation task — see backlog §14. Open question:
  which email-sending mechanism — a Supabase Edge Function calling a transactional email provider
  (Resend/SendGrid/etc.) is the natural fit given the stack, but needs an account/API key decision
  before implementation.)*

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
  Dashboard either. *(Implementation task — see backlog §14.)*

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
- **Room Maintenance panel — DONE, with role gating (see §8).** Compact pending-ticket list with
  raise/resolve actions and a "View all in Maintenance →" link, visible only to `admin`/`user`.
- **Metrics/widgets — DONE** (definitions in §9):
  - Beds moving out this month
  - Move-ins this month
  - Lease extensions (this month, later-date edits only)
  - Month-to-date projected move-outs
  - Occupancy rate YTD (bar graph)
  - Move-in source breakdown
  - Projected vs. actual rent collection summary (links into §11 for full drill-down)
- **Icon convention.** The Monthly Revenue KPI card must use a **peso-appropriate icon** (₱), not
  a dollar-sign icon — confirmed correction, since this is a Philippine-peso business tool.
  *(Implementation task — see backlog §14. `lucide-react`, the icon set already used throughout
  the app, has no dedicated peso glyph — use a styled "₱" character in place of an `<Icon>`
  component, matching the size/color conventions of the other KPI card icons, unless a suitable
  icon is found.)*
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
- **New requirement: multi-select + batch save.** Instead of writing to the database on every
  single click (today's behavior), staff should be able to **select multiple cells** (a
  multi-select/checkbox interaction across tenants and/or categories) and then commit all of them
  with **one "Save" action**. Purpose: faster data entry during high-volume collection periods
  (e.g. many tenants paying around the same date), fewer round-trips. *(Implementation task — see
  backlog §14.)*
- **New requirement: undo functionality.** Staff must be able to reverse a payment they just
  recorded. **This must comply with the non-negotiable in §13 — never delete a payment record.**
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

## 13. Non-negotiables
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

## 14. Confirmed implementation backlog
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
- [ ] Build admin-override email notifications for the approval workflow (§7) — needs an
      email-sending mechanism decision first (no such capability exists today).
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
      delete (§12/§13) — **done**, via a compensating negative-amount row (`voids_payment_id`),
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
- [ ] Fix the `profiles` RLS gap so the admin Users page actually works (§7) — confirmed still
      broken: only `profiles_self_select` exists, no admin-broad-select or update policy, so
      `Users.jsx`'s list-all-users and change-role actions silently fail/no-op under real RLS.
