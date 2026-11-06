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
- Lease term is typically monthly; a fixed move-in/move-out date is captured at move-in.
  **For NEW tenants the planned move-out is always the LAST DAY OF A MONTH:** Move In asks for the lease length in months
  (1 to 12, default 1) and shows the computed month end read-only (`leaseMoveOut(moveIn, N)` in `src/lib/stay.js` = the last
  day of the month containing move-in + N months - 1 day: Oct 15 / 1 month -> Nov 30; Oct 15 / 2 -> Dec 31; Oct 1 / 1 -> Oct 31;
  Oct 2 / 1 -> Nov 30; Oct 31 / 1 -> Nov 30; Jan 30 / 1 -> Feb 28). The old "same date next month" option is not offered; an
  exact month only happens when moving in on the 1st. `addTenant` (Move In path only; backfill scripts are not affected) rejects
  a planned move-out that is not after the move-in or not a month end. Tenants who moved in before this rule keep their dates
  (e.g. the Oct 2 -> Nov 2 one-month stays stay stay-billed).
- **Move In form: only six fields are required** — vacant bed, rate, full name, gender, move-in
  date, move-out date. Everything else (contacts, emails, address, source, work/employer details,
  emergency contact, document uploads) is optional so tenants migrated from the old spreadsheet,
  which only carries name, gender, room/bed, rate and the two dates, can be added without
  fabricated values. Empty contact/email rows and missing files are simply not saved. The list
  under "Tenant profile" below is the intended full record, not a move-in gate.
- **Upfront payments at move-in:** the form also records the 1-month **advance** (S.I#) and
  1-month **deposit** (T.R#) — "Advance due" / "Deposit due" default to the entered Rate and are
  editable; each is covered by one or **several receipt lines** (amount, BANK/CASH mode, S.I#/T.R#
  text, bank reference, date) whose sum must equal the due amount exactly (never rounded; more than
  2 decimals is rejected). A **reservation payment** already held on the selected RESERVED bed is
  carried in automatically as the deposit (see §5 "Reservation payments"), so the cashier collects
  only the remainder. Move In also has an optional **Reservation payment** section (first, above the
  advance) where lines can be typed even when the bed was never reserved or recorded on the Bed Map:
  each line needs amount, mode, **T.R# (required)** and the received date (not in the future); lines
  have no target sum. Deposit due (default Rate, editable) minus the total reservation (Bed Map
  payments + typed lines) is what the cashier collects as deposit; the advance is never reduced.
  Admin and user only. All receipts are written by one atomic database call
  (`record_move_in_receipts`). Move In stops with a clear message, before creating the tenant, if
  that function has not been deployed. If saving the receipts fails after the tenant was created,
  the user is told explicitly (the tenant exists; use "Apply reservation payment" on the profile's
  Advance & Deposit tab when the bed had a reservation payment, or an admin adds receipts there).
- Intended documents: **2 valid government-issued IDs** (any type accepted) + a **scanned signed
  copy** of the lease contract (fixed template). Confirmed implemented — uploaded to Google Drive
  (one folder per tenant) and tracked in `tenant_documents`, viewable/manageable anytime from the
  tenant profile's Documents tab, not just at move-in.
- **Bed eligibility:** a tenant can be moved directly into a VACANT **or RESERVED** bed (the reserved
  person arrives; Full Name is pre-filled from the reservation and stays editable; the bed becomes
  LEASED and the reservation name is cleared). A bed that already has an active tenant is always shown
  as LEASED (derived in `fetchBeds()` regardless of the stored `beds.status`) and is never offered for
  move-in (`moveInEligibleBeds` in `src/lib/bedEligibility.js`). The one-active-tenant-per-bed rule is
  enforced by the DB (`uniq_active_tenant_per_bed`, a partial unique index on `tenants(bed_id)` where
  `is_active`) and `addTenant` surfaces a violation as a clear message naming the room/bed (and the
  current tenant) instead of the raw Postgres error; the Move In modal stays open. A RESERVED bed may
  hold optional **reservation payments** (§5): selecting such a bed at Move In shows them and applies
  them as the deposit; switching to another bed re-reads that bed's payments (the money never
  follows the tenant to a different bed). If the typed name differs from the name the payment was
  recorded under, an explicit confirmation tick is required. Reservation payments can also be typed
  at Move In itself, for any VACANT or RESERVED bed (§5).
- **Move In from the Bed Map (reserved bed):** a RESERVED bed's status modal has a **Move In <name>**
  button (admin + user). It opens the same Move In modal, locked to that bed (read-only "Selected Bed",
  so its reservation money can never be applied to another bed), with Full Name = the reserved name and
  every normal required field and receipt rule. Tenants page and Bed Map share one Move In path
  (`src/components/MoveInFlow.jsx`: HELD payments, `addTenant`, `record_move_in_receipts`, contacts,
  emails, documents), so the result is identical. On any RESERVED bed (either entry point) **Move In
  Date defaults to the reservation's target move-in date** (today when the reservation has none) and
  shows "Target move-in from the reservation: <date>"; an amber, non-blocking notice appears whenever
  the Move In Date is not today ("N days after/before today: rent starts on this date") or differs from
  the target. Staff change the date as needed; rent is prorated from it. The `Move In` activity row
  stores `metadata.from_reservation` (reserved name + target date) for audit. Rules in
  `src/lib/reservation.js`.
- Billing starts immediately at move-in, prorated against the rent/water cutoff window (see §5)
  — day-exact proration, confirmed correct as currently implemented.

### Tenant profile — required fields
Confirmed field list (originally all required at move-in — now optional at move-in, see above; all editable afterward from the tenant profile).
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
  - Contact number(s) (and emails — same multi-entry model as move-in). On edit, only full name is
    required; **contact number and email are both optional**, since a large share of tenants
    migrated from the old spreadsheet have no phone number on file at all, and that shouldn't block
    correcting their other details (e.g. move-out date).
  - Emergency contact (name + number)
  - Work & Employment — occupation, employer, employer address, employer contact number, location
    of work, work schedule
  - Planned move-out date (carried over from the old Edit Details). A CHANGED date snaps to the last day of the month of the
    date picked (the form shows the result); an unchanged legacy date that is not a month end stays allowed. Enforced again in
    `applyTenantProfileChange` (so an approval request with a non-month-end date fails at apply and stays pending). Moving the
    move-in date is not part of this form.
- **Not editable here:** rate, bed/room assignment, move-in date, active status — those change
  only through their own flows (Transfer, Property bed rates, Move-out, and the admin-only
  "Correct move-in date" action below).
- **Correct move-in date (admin-only, direct):** Tenants > View > Overview shows a "Correct" button
  next to Move In for **active** tenants, visible to admins only. It sets `tenants.move_in_date`
  directly (no approval request, no email) with a required reason, rejects a date on/after the
  move-out date, and logs a `Tenant Move-in Date Corrected` activity entry (old → new + reason).
  **Retroactive-billing caveat:** billing and occupancy recompute live from `move_in_date` (there
  is no historical lock), so correcting it changes the tenant's first-period rent and occupancy,
  including for statements of already-closed periods if they are reopened or reprinted. Check
  recorded payments against the recomputed balance after correcting.
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
- **Update (Phase 2):** a request raised from the new Move Out flow carries the full final bill, and an
  admin approving it now executes the whole move-out (tenant inactive, bed vacated, readings, final bill,
  receipts settled) in one step — see §5 "Phase 2 as built". Requests raised by the old modal (no
  `_bill` in the payload) still only update the dates when approved.
- **One pending move-out request per tenant.** While a move-out request is PENDING for a tenant (or any bed of its sibling group,
  matched on the request's entity id, `new_value._tenant_id` and `_siblings[]._tenant_id`), opening Move Out again shows "A move-out
  request for <name> is already waiting for admin approval (submitted <date> by <email>)" and disables Next, for non-admins and admins
  alike (admins are pointed to Approvals). It costs one query when the modal opens. At apply, a bed that is already out is only skipped when
  ITS final bill was issued by this same request (`details.approval_request_id`); otherwise the apply and the review refuse ("already moved out ... issued
  outside this request. Reject this request."). A bed already applied by THIS request (a resume after a partial failure) is shown as "already applied
  (final bill #n)", is not reconciled again and is left out of the combined total, so Approve stays available for the remaining beds; "Mark approved
  (already applied)" requires every bed's final bill to carry this request's id.
- **Move-out date edits (lease extensions/shortenings) must be logged. — DONE.** Any change to a
  tenant's `move_out_date` — including a plain admin edit via the tenant profile, not just a
  formal move-out — writes an `activity_log` entry (`activity_type: 'Move-out Date Changed'`).
  This is the infrastructure the lease-extension count metric (§9/§10) reads.

### Tenants and Current Tenants
- **Two pages (admin and user; viewer and guard have neither).** `/tenants` ("Tenants") is the
  register of every tenant, past and present. `/current-tenants` ("Current Tenants", sidebar entry right
  after Tenants; `src/pages/CurrentTenants.jsx` renders the Tenants page with `scope="current"`) lists
  only the in-house tenants and has no status filter.
- **In-house** = `tenants.is_active = true` and `category` is `BED` or `COMMERCIAL` (JB Water Refilling
  Station is in-house). Active `PARKING_ONLY` / `OTHER` rows are not in-house: they appear only on
  Tenants ("All tenants"). An active tenant whose planned move-out date has passed stays in-house until
  the move-out is processed. A reserved bed is not a tenant and is never listed. `tenants.status` is
  unused; `is_active` is the flag.
- **Tenants status filter:** "All tenants" (default), "Current (in-house)" (same list as Current
  Tenants) and "Moved out" (inactive rows). In "All tenants" inactive rows carry a "Moved out" chip.
  Subtitle: "{n} tenants · {a} in-house · {m} moved out", plus "· {p} active parking/other" when there
  are any. Current Tenants subtitle: "{n} in-house tenants · {b} bed · {c} commercial".
- Every view defaults to room number ascending, then bed letter; switching the filter resets to that
  order and the column headers still re-sort. Room and search filters apply on top; a moved-out tenant
  matches the last room and bed they occupied. Search also matches the unit label. The date column
  reads "Moved Out" in the Moved-out view and "Move Out" otherwise. The effective move-out date of an
  inactive tenant is `actual_move_out_date`, falling back to the planned `move_out_date` for legacy
  rows; rows with neither show "—" and sort last when sorting by that column descending.
- **No-bed rows (commercial / parking / other):** a category chip ("Commercial", "Parking", "Other"),
  the `unit_label` in the Room column, "—" for the bed, and they sort after every room. They have no
  Move Out or Transfer buttons (row or profile footer); the profile header shows "<unit label> ·
  <category>" instead of "Room · Bed". How a commercial tenancy ends is a §15 follow-up.
- **Moved-out profile:** a "Moved out <date>" chip under the name, an "Actual Move Out" row when it
  differs from the planned date, and an Overview banner listing each final bill ("Final bill #id ·
  STATUS · Refund/Due amount") with a Print link for admin and user and a "Go to Bills" button. With
  no final bill it says so (moved out before final bills existed, or imported from the sheet).
- **Actions hidden for inactive tenants:** the row "Move Out" button, the profile footer Transfer /
  Move Out, and the Rate / Move-In "Correct" buttons. View stays available. Admin receipt Add/Edit
  on the Advance & Deposit tab is unchanged (used to fix receipts after a final bill is voided).

### Tenant profile history
The profile (`TenantProfileModal`, tabs scroll sideways on a narrow screen) is the tenant's full
record and works the same for moved-out tenants. Every source is read by `tenant_id`; each tab shows
its own "Could not load …: <message>" if its read fails (the other tabs still load). Nothing here writes.
- **Bills** (`tenantProfile/BillsTab.jsx`): the final bills (with Print for admin and user, Void and Void & re-issue for
  admin only, voided bills shown with their reason and "Replaced by #n", a re-issued bill with "Replaces #n (voided)"); payments grouped by cutoff name, newest cutoff
  first and "No cutoff" last, columns Date / Category / Type / Amount / Notes, a void row shown
  negative with "Void of #id" and its original marked "Voided"; per-cutoff and overall totals summed
  in integer cents (a void pair nets to 0); a summary of advance/deposit receipts by status linking to
  the Advance & Deposit tab.
  - **Monthly statements** (`tenantProfile/StatementHistory.jsx`, between Final bills and Payments by cutoff): one row per
    cutoff, newest first, the newest 12 then "Load older (n)". A cutoff is listed when the stay
    (`[move_in, actual/planned move-out]`, open while active) overlaps its water or electric window, a FINAL final bill covers
    it (`covered_cutoffs` / `cutoff_id`, per component), or the tenant has a payment on it. The row header shows the windows, an
    "Open period" chip on the active cutoff, the final bill # when covered, and Paid R+W / Paid Elec (integer cents, voids
    netted). Nothing is fetched when the tab opens.
  - **Active tenants:** expanding a row recalculates that cutoff through the same loader and compute as the Billing page
    (`src/lib/cutoffBilling.js`; tenants and advance-credit data fetched once, then 6 reads per cutoff, at most 2 at a time,
    cached per cutoff, "Refresh" recomputes, an error shows on that row only). It shows the Billing page's figures to the cent
    (Rent, Water m³/₱ with the old/new room split on a transfer, add-ons, RW Total, Less advance / Net, kWh, Elec ₱, Elec
    add-ons, Elec Total), Paid, and Balance = displayed Net (or Elec Total) minus that component's payments in cents ("Credit"
    when overpaid, never a negative balance). OTHER payments are listed apart, not netted. Every expanded row says
    "Recalculated from current data … not the original printout": rate edits, re-readings, add-on/split/move-in corrections and
    tenants who have since moved out without a final bill (left out of the recalculation) can make room shares differ from what
    was originally billed. Kinds: own row; whole-room (a non-primary same-name bed shows the primary bed's row, no balance);
    one-month stay ("billed on the final bill"); no row ("no charge computed"). A warning shows when the Billing page places the
    tenant in their current room for a period they spent in another room (transfer in an earlier cutoff), and "Check readings
    for Room X" when that room does not reconcile. Preview (admin and user) opens the printed statement, identical to the
    print page, with Billing Date / Bill No. / Prepared by and the REPRINT notice (on by default); admin also gets Print
    (`/print/rent-water` or `/print/electricity` `?cutoff=&tenant=`). Preview and Print are offered only when the component
    is over ₱0.01 (the print filter), and not for Rent + Water while advance credits failed to load. Nothing is written or
    cached for the Billing page.
  - **Moved-out tenants:** no statement is recalculated (the Billing page drops moved-out tenants from earlier cutoffs, and
    old inactive rows not covered by a final bill would dilute a rebuilt split). Each cutoff shows its payments per component
    and, where a FINAL final bill covers that component, "Billed on final bill #n; payments on this cutoff are netted on that
    final bill" (no balance); otherwise "Not on the current Billing page (moved out): payments only".
- **Advance & Deposit:** unchanged, plus a "Final bills are on the Bills tab" link.
- **Maintenance** (`tenantProfile/MaintenanceTab.jsx`): tickets with this `tenant_id` (location: room
  or common area, concern, remarks, resolution notes, status, raised and resolved dates). Common-area
  tickets linked to the tenant are shown too. Tickets with no tenant linked are not shown.
- **Visitors** (`tenantProfile/VisitorsTab.jsx`, admin/user only): read-only visits (check-in,
  check-out, visitor name, contact, state chip, overnight status, void reason), no ID number or photo,
  latest 300, link to the Visitor Log. A visit is keyed to the lowest tenant id of the active same-name
  group in the room at check-in (§17), so the profile reads visits for every same-name row in the same
  room whose stay overlaps this one ("siblings", `siblingIdsFor` in `src/lib/tenantHistory.js`),
  limited to check-ins inside this tenant's stay window (Manila dates, move-in to move-out). Sibling
  beds therefore show the same visits; two separate stays of the same person each show their own.
  Commercial / parking tenants have none (visits target bed tenants).
- **History:** a stay timeline (`tenantProfile/StayTimeline.jsx`): Move in (first room/bed), each
  COMPLETED transfer (date, from → to room/bed, rate change) and Moved out (date, final bill ids) or
  the planned move-out while active; then the tenant's `activity_log` entries (latest 500, with a note
  when capped). Legacy log rows with only a name and no `tenant_id` are not shown.

### Transfer
- Rate and utility responsibility split proportionally by exact day count between old and new
  bed/room within the cutoff. Admin can transfer directly; non-admin needs approval + reason.
  Current implementation confirmed correct.

## 4. Bed / property inventory
- Bed/room states: **Vacant, Leased, Reserved, Out-of-Order, Removed** (soft-delete). No other
  states needed.
- **Reserved state:** a reservation carries `beds.reserved_name` and a required target move-in date
  `beds.reserved_move_in_date` (migration `reservation_target_date.sql`). Reserving from the Bed Map
  (from Vacant or Out of Order) cannot be confirmed without a valid date that is **today or later**;
  no upper limit. Admin and user can set/change it from the bed's status modal (Edit / Set date, today
  or later; logged as `Reservation Target Date Changed`, old → new); viewers see it, guards cannot read
  beds. A trigger clears the date whenever the bed leaves RESERVED (move-in, Remove Reservation, Out of
  Order, transfer, retire, reconfigure). The Bed Map card shows "Target <date>" ("· overdue" in red when
  past), the status modal a state chip (in N days / today / overdue N days / not set). Legacy
  reservations made before the date existed show "No target date" and keep working (Move In, remove,
  Set date); no backfill. Nothing automatic happens when a target date passes (no forfeit, no email).
  After deploy, `reservation_target_date_enforce.sql` makes the DB reject entering RESERVED without a
  date or clearing the date of a RESERVED bed (legacy null-date rows stay updatable).
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

### Room creation / retirement — DONE
An admin can also create a brand-new room (room number, optional type/floor, and its initial beds)
or retire an existing room (marks every active bed `REMOVED` and the room `CONVERTED`), via
"+ Add Room" and per-room "Retire" actions on the Property page (Room Config tab). These are two
separate general-purpose actions, not a fused "split room" wizard — used in sequence to split one
room into two (e.g. retiring a 6-bed room and creating two new 1-bed rooms from it). Implemented as
`create_room()` / `retire_room()`, both admin-only at the RLS layer (same `SECURITY INVOKER`
pattern as `reconfigure_room()` — no dedicated `SECURITY DEFINER` check, since the only client
entry point is already `isAdmin`-gated). `retire_room()` hard-blocks retiring a room with any
`LEASED` bed, mirroring `reconfigure_room()`'s removal guard, and is idempotent on an
already-`CONVERTED` room. No approval-request fallback, consistent with the reconfigure precedent.

## 5. Billing & rent
- **Cutoff windows:** Rent + Water = 1st to end-of-month. Electricity = 10th to 10th.
- **One compute path for monthly statements.** The Billing page, the Rent + Water / Electricity print pages and the tenant
  profile's statement history all load a cutoff with `loadCutoffBillingInputs` and compute it with `computeCutoffBilling`
  (`src/lib/cutoffBilling.js`: `computeBilling` with the cutoff's mid-period transfers, plus the advance credits). The printed
  statement props (charges, total, billing details, notes) are built only in `src/lib/monthlyStatement.js`, shared by the print
  pages and the profile preview. Since 2026-11-05 the print pages include mid-period transfers like the Billing page (before,
  they left them out: a transferred tenant's printout showed different amounts than the screen, or no statement at all).
- **Single-tenant reprint.** `/print/rent-water?cutoff=X&tenant=ID` (and `/print/electricity`) prints one tenant's statement
  (for a whole-room rental, the primary bed's id). The Bill No. defaults to that statement's position in the full print, stays
  editable, and the header reads "1 bill · … · reprint". A "Show reprint notice" checkbox (on by default) prints
  "REPRINT - recalculated <date> from current data; may differ from the statement originally issued" on both copies, as a
  small two-line note in the top-right corner under the copy label (it takes no height, so nothing on the fixed half-page copy
  is pushed off). Back returns to the previous page. A tenant with no statement there gets "No … statement for this tenant on
  <cutoff>"; a failed load shows "Could not load this cutoff: <message>" instead (on the full print too).
- **Print selected / hold a statement (2026-11-06).** Billing's Per Tenant view (admin, the role that can open the print
  pages) has a "Print" checkbox column (with select-all) on every row that gets a statement in the chosen category, a per-row
  print icon (`?only=<id>`), "Print all", "Print selected (n)" (`?skip=<held ids>`) and "Clear holds". Unticking a row holds
  it: a "Held" badge shows, and the hold is kept in this browser only (`localStorage`, per cutoff and category; not shared
  with other staff). The print pages accept `?only=` / `?skip=` (comma-separated tenant ids, unknown ids ignored;
  `pickStatements` in `monthlyStatement.js`): the Bill No. of every statement stays its position in the FULL list (a held
  tenant printed later gets the number it would have had), the header reads "n of M bills · skipped: <names>", and `?only=`
  prints without the reprint notice. Nothing is recomputed per selection: every amount, the roommates' utility shares, the
  Per Room reconciliation and Collections are exactly the same whether a tenant is held or not. In print, every print page
  lets the app shell grow to its full height, so every selected statement prints on its own A4 page; before 2026-11-06 the
  app shell's one-screen height clipped the print to the first page.
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
  - **Structure — CONFIRMED (supersedes the earlier "advance forfeited / deposit covers utilities
    only" wording):** a bed tenant pays, at move-in, **1 month ADVANCE + 1 month DEPOSIT**, each
    **equal to the tenant's monthly rate** (₱5,000 rate → ₱10,000 upfront; a whole-room/two-bed
    tenant has one rate per bed row, so each bed row carries its own advance and deposit). They are
    two separately tracked amounts, not one combined figure.
    - **Advance** is documented by a **Sales Invoice (S.I#)**.
    - **Deposit** is documented by a **Temporary Receipt (T.R#)**; a tenant may have several
      (e.g. "TR# 121 & TR# 133").
    - S.I#/T.R# are **free text captured by staff at move-in** — no formula, no auto-generation, may
      be left blank and filled in later (at the latest at move-out: see "Receipt numbers on the final bill").
  - **Phase 1 — DONE (record-keeping only).** Table `tenant_deposits` (one row per receipt: `kind`
    ADVANCE/DEPOSIT, `amount`, `ref_no`, `received_date`, `status` HELD/APPLIED/FORFEITED/REFUNDED,
    `settled_note`, `notes`); migration `database/migrations/advance_deposit.sql` (DDL + a separate,
    re-runnable backfill of one ADVANCE + one DEPOSIT row = current rate for every active bed
    tenant, ref blank). Move In captures both amounts (defaulting to the Rate) and S.I#/T.R#; the
    tenant profile has an "Advance & Deposit" tab (read-only for non-admin; admin can edit
    amount/ref/date/notes and add a receipt). Rows are never deleted; `status` is only changed by
    the move-out phase. The unused `tenants.advance_rent/security_deposit/credit_balance` columns
    are not used.
  - **Reservation payments + split receipt lines — built** (migration
    `database/migrations/reservation_payments.sql`, mirrored into `init.sql`; apply the SQL BEFORE
    deploying the frontend that uses it).
    - **Storage:** table `bed_reservation_payments`, keyed by **bed**, many rows per bed allowed:
      amount (> 0, 2 decimals), own **T.R# (required on every reservation payment: enforced in the
      Bed Map form and `addReservationPayment`, in Move In's `validateLines`, and again in
      `record_move_in_receipts`; the table itself does not enforce it)**, bank ref, mode BANK/CASH, received date, `reserved_name`
      snapshot (filled by a DB trigger), status HELD / APPLIED / FORFEITED / VOID, `tenant_id` once
      applied. Second entry point: reservation lines typed in the Move In modal (kind RESERVATION in the
      receipts RPC) are inserted by the RPC as HELD rows of the tenant's bed (the bed is already LEASED
      then, so a transaction-local, bed-bound flag lets the insert trigger skip its RESERVED check; direct
      client inserts on a non-RESERVED bed still fail) with note "Recorded at Move In" and the tenant's
      name, then applied together with any Bed Map payments, all in the same transaction; the ledger
      shows them APPLIED. Optional: a RESERVED bed with no payment (e.g. beds 71 and 75) works exactly as before.
      Recorded from the Bed Map status modal (on a RESERVED bed, or right when reserving) by admin and
      user; viewers see no reservation UI and cannot read the table. Rows are never deleted; an admin
      can edit a HELD row or void it with a required reason; APPLIED / FORFEITED / VOID rows are
      immutable. The Bed Map card shows a "P3,000 held" chip and a "Reservation payments" ledger
      lists every row (`ReservationLedgerModal`; the one place forfeited reservation income is
      reported). Collections, Payment Monitoring, Dashboard and utility reconciliation read
      `payments`, not this table, so they are unaffected.
    - **Carry-over at Move In:** the HELD payments of the selected bed are copied into
      `tenant_deposits` as `kind = DEPOSIT`, status HELD, **same amount, T.R#, bank ref, mode and
      original date** (`reservation_payment_id` links back; a unique index allows one deposit per
      payment), and the reservation row becomes APPLIED with the tenant. Example: rent 6,000,
      reservation 3,000 (TR# 500), deposit due 3,000: the tenant ends with ADVANCE 6,000 (S.I#) and
      one DEPOSIT 3,000 (TR# 500, dated the reservation date); total held 9,000, never 12,000. Deposit
      math: R = HELD reservation total, due = the editable Deposit due. R = due: nothing more to
      collect. R < due: the cashier collects exactly due - R as new deposit line(s). **R > due: the
      full R stays as the deposit** (a T.R# is never split or shrunk); the surplus comes back through
      the final bill's "Amount to be returned"; no cash rebate and no use toward the advance (open
      question O2, confirm with the owner). The advance is unaffected. A deposit carried from a
      reservation keeps amount/date/type/tenant locked (UI and DB trigger); ref, bank ref, mode and
      notes stay editable by an admin. The Move In receipts step is one transaction; if it fails
      after the tenant was created the reservation stays HELD and the profile's Advance & Deposit tab
      shows an amber banner with **Apply reservation payment** (admin + user, idempotent).
    - **Forfeiture:** when a RESERVED bed leaves RESERVED for anything but LEASED (Remove Reservation,
      Out of Order, retire_room, reconfigure_room, approval bed removal) a trigger on `beds` marks
      every HELD payment FORFEITED with a reason note and writes one `Reservation Payment Forfeited`
      activity row per payment. Leftover HELD rows are also forfeited if the bed is reserved again.
      Nothing is deleted. The Bed Map asks for a confirmation tick showing the amount before a
      reservation holding money is removed. A mistaken forfeiture is irreversible in the app
      (workaround: record a new reservation payment referencing the forfeited TR#). Non-admins can
      remove a reservation (as before); the tick and the activity entry are the control.
      RESERVED → LEASED (Move In, from the Tenants page or the Bed Map's Move In button, §3) never
      forfeits: both entry points use the same `record_move_in_receipts` path, so HELD payments become
      APPLIED with one DEPOSIT row each and the cashier collects only the shortfall.
    - **Split lines:** an advance or a deposit can have several receipt lines (e.g. 4,000 BANK + 2,000
      CASH), each = one `tenant_deposits` row with `payment_mode` (BANK/CASH, null on legacy rows,
      shown "mode not recorded") and `bank_ref`. Their sum must equal the due amount exactly in
      integer cents: typed amounts are parsed strictly (`src/lib/receiptLines.js`, max 2 decimals,
      never rounded, negative / blank rejected), the mismatch message states both figures and the
      difference, and `record_move_in_receipts` repeats the check with exact `numeric` math. The final
      bill math (`finalBill.js`) needed no change: it already pools all HELD receipts per kind, so the
      combined refs read "TR# 500 & TR# 612" and an overage deposit is credited in full. A Move In line
      whose ref equals a reservation T.R# on that bed is blocked (duplicate guard).
    - **Move In arithmetic (6,000 rent, 3,000 reservation TR#, 6,000 advance):** deposit due defaults to
      the Rate = 6,000, so the cashier collects 6,000 - 3,000 = 3,000 with its own T.R#; stored are
      ADVANCE 6,000, DEPOSIT 3,000 (reservation TR#, original date) and DEPOSIT 3,000 (new T.R#). Deposit
      due edited to 3,000: nothing more to collect, one DEPOSIT 3,000. R > due with typed lines needs an
      explicit tick before saving; the surplus returns via the final bill. On file is always advance due
      + max(deposit due, R). A new reservation line whose T.R# equals an existing reservation T.R# on the
      bed, or an advance/deposit line ref, is blocked (client and server); the same amount and date as an
      existing payment only shows a warning.
    - **Known limits:** reservation lines typed at Move In are lost if the receipts RPC fails after the
      tenant was created (an admin adds Deposit receipts from the profile, which carry no ledger row);
      retyping a payment already on the Bed Map with a different T.R# is only caught by the same
      amount/date warning. HELD rows left after a failed apply stay on the bed until applied from the tenant
      profile; an unapplied one blocks the next Move In on that bed with the "Reservation payments on
      this bed changed" message, so apply or void it first. Reservation money cannot be moved to another bed (admin voids and a new payment
      is recorded); the DB does not require a date on split lines (the form does); open question O1:
      the Deposit due defaults to the Rate (§5 structure, confirmed by the owner: the deposit due
      is collected at move-in) and staff edit the field when the real deposit differs.
  - **Rent of a stay (owner rule for new tenants; `stayRent()` in `src/lib/stay.js`).** n = the largest whole number of months
    with `addMonths(moveIn, n) <= moveOut`. If the move-out is exactly `addMonths(moveIn, n)` (n >= 1) the rent is n months flat, no
    excess (this keeps the legacy Oct 2 -> Nov 2 = 6,750.00). Otherwise the excess runs from E = `addMonths(moveIn, n)` through the
    move-out date inclusive, each calendar month's part as days / that month's real number of days (Nov 30, Dec 31, Feb 28; an excess
    that crosses a month end is split by month), rounded to the cent per month; total = n x rate + excess, in integer cents. With
    rate 6,750: Oct 15 -> Nov 30 = 6,750 + 16/30 = 10,350.00; Oct 1 -> Oct 31 = 6,750.00; Oct 1 -> Nov 30 = 13,500.00; Oct 15 ->
    Dec 31 = 13,500 + 17/31 = 17,201.61. The FINAL BILL rent line = max(0, that total - rent already billed on CLOSED cutoffs'
    statements, by the Billing rule), labelled with the arithmetic ("Rent (1 month + 16 of 30 days = P10,350.00, less P3,701.61
    billed on closed statements)": 6,648.39 for Oct 15 -> Nov 30 with the Oct statement closed). It applies to every stay that began on
    or after the first cutoff of the app (earlier move-ins keep day-based proration over the covered windows) except stays whose
    PLANNED length is exactly one month and not a month end (the legacy same-date leases), which are stay-billed (flat rent, below). Regular monthly statements keep their day-prorated rent.
  - **Final bill / move-out settlement — Phase 2 DONE** (rules below; what was built and its known
    limits are in the "Phase 2 as built" bullet that follows the rules). Only the refund tracker is left (Phase 3):
    - **Billing periods** follow the cutoff windows (rent/water 1st–EOM, electric 10th–10th).
    - The **advance is credited against the rent of the second-to-last bill, pro-rated by days** (2026-11-06) — the
      billing period *before* the one containing the move-out date gets advance x (days of the stay in the move-out
      month) / (days of the second-to-last month); the rest of the advance is credited on the final bill. If the tenant stays only one or two billing
      periods, the unused advance is credited on the final bill and any excess is refunded.
    - The **deposit covers the final bill**: prorated rent through the move-out date + utilities as
      of the move-out readings + any unsettled earlier amounts entered manually by staff. (Data in
      the app only started September 2026, so earlier unsettled balances are keyed in by staff.)
    - **Excess over charges is refunded** ("Amount to be returned"); a **shortfall is paid by the
      tenant**.
    - **Early termination forfeits BOTH the advance and the deposit** unless management approves a
      **waiver** (admin-only, with a required reason).
    - **Non-admin move-outs require admin approval** (see §3 Move-out).
  - **Phase 2 as built (final bill + automatic second-to-last advance credit).**
    - **Schema:** `final_bills` (`database/migrations/final_bills.sql`, also in `init.sql`): lines jsonb
      (credits stored as negative amounts), `details` jsonb (billing-details table), totals, `early_termination`,
      `forfeit_waived` + `waived_reason`, `refund_status/refund_paid_date/refund_ref` (columns exist, unused until
      Phase 3), `status` FINAL/VOID. RLS: select admin+user, insert/update admin only, no delete; a partial unique
      index allows one non-void FINAL bill per tenant. `advance_credits` stores the second-to-last credit (below).
      The QA-hardening SQL is `database/migrations/phase2_hardening.sql` (also mirrored into `init.sql`);
      `tenant_deposits` insert by a non-admin is limited to status HELD.
    - **Pure builder** `src/lib/finalBill.js` (`buildFinalBillDraft`, `billPosition`, `advanceCredits`,
      `buildCreditLines`, `computeTotals`). Rent = rate x days from max(period start, move-in) through the
      move-out date inclusive / days in the rent-water window, capped at the window. Utilities reuse
      `computeBilling` with the tenant treated as present through the move-out date and the move-out readings
      applied as hypothetical interim readings (nothing is written until confirm). Every line is rounded to 2
      decimals when stored; totals are the exact sum of the stored lines.
    - **Move Out flow** (`MoveOutModal.jsx`): (1) date + readings, (2) Final Bill editor, (3) confirm. The editor
      is pre-filled from existing data (period, prorated rent, water/electric share with the billing-details
      table, advance/deposit credits with their S.I#/T.R#, forfeiture flag); rows are read-only until clicked and
      staff can edit any line, delete it, or add a free line (unsettled earlier amounts are typed in, no
      automatic carry-over). Admin confirm runs `processMoveOutWithBill` (`supabase.js`): final bill saved
      FIRST, then tenant out, bed vacated, move-out readings saved, optional final payment, receipts settled
      (HELD to APPLIED/FORFEITED with a note naming the bill), activity `Move Out` + `Final Bill Issued`. If the
      tenant update fails the bill is auto-voided; any later failure raises an error listing exactly which steps
      ran. A non-admin submits the whole draft as an approval request (`new_value._bill`); the admin reviews the
      bill in Approvals (and, for an early termination, can tick the waiver there), and approving executes the
      move-out + bill in the admin session (applied before the request is marked approved, so a failed apply
      leaves it pending).
    - **Receipt numbers on the final bill.** Every advance/deposit receipt the final bill credits or forfeits
      (amount > 0) needs its real number: one **S.I#** input per ADVANCE receipt and one **T.R#** per DEPOSIT receipt
      under the matching credit/forfeit line in the Move Out bill editor (every bed of a sibling group), prefilled from
      `tenant_deposits.ref_no`. Staff type the bare number; the field's own prefix (`S.I#`, `SI`, `S.I. No.`, `T.R#`,
      `TR`, ...) and a leading `#` are stripped (`normalizeReceiptRef` in `finalBill.js`); the other kind's prefix,
      an empty / prefix-only value, more than 30 characters, no digit, `·` or control characters are refused. The
      Details column, Advance check and Preview show the prefixed number as typed. A number already on ANOTHER
      tenant's receipt of the same kind is an amber warning only; the same tenant's split BANK+CASH rows may share
      one S.I#, and a sibling bed in the same flow gets a soft "fine if one invoice covers both beds" note. A
      reservation-carried deposit that already has its T.R# is read-only (empty: editable and required); a 0.00
      receipt needs no number. Numbers are text only: no amount, total, advance-check figure or reconcile diff
      depends on them. **Admin Confirm** writes the numbers to the HELD receipts (`updateTenantDeposit`, logged
      'Advance/Deposit Updated' old -> new) inside `processMoveOutWithBill` BEFORE the advance re-check and the bill
      insert, so the stored line details and `details.advance_check` (text, `receipts[].ref`) carry them; a failed
      number write changes nothing else and offers "Retry failed bed(s)". **Staff** submit the numbers in the request
      (`_bill.receipt_refs`, also per sibling); nothing is written until approval. **Approvals** shows them as
      editable inputs (seeded from the request, else from the receipt; an "on file now" hint when the receipt's
      number differs); Approve stays disabled until every required number is valid, and the apply re-checks before
      writing anything. **After move-out** an admin fixes a number of an APPLIED/FORFEITED receipt from
      `/print/final-bill` ("Receipt numbers" panel) or the tenant profile ("Fix S.I#"/"Fix T.R#") through the
      admin-only RPC `correct_receipt_ref` (`database/migrations/final_bill_receipt_refs.sql`, also in `init.sql`):
      one transaction updates the receipt, the FINAL bill's line details and Advance check text, appends
      `details.ref_corrections` {old, new, by, at} and logs 'Receipt Number Corrected'; it refuses any other change to
      the bill and a reservation-carried T.R#. Out of scope: the `advance_credits.ref_text` snapshot on an earlier
      second-to-last statement is not updated by a correction.
    - **Stay extension (late move-out, 2026-11-06).** When the actual move-out is AFTER the contract (planned) move-out date as
      stored when the flow opened, the nights after it are charged as a stay extension instead of pro-rated rent:
      nights = (actual - contract) + 1 if the tenant vacated after 12:00 PM on the actual day (checkout is 12:00 PM; staying
      past it is another full night). Out on the contract date: 0, also after 12:00 PM. Rate `STAY_EXTENSION_NIGHTLY` = P500.00
      per night (code constant, `src/lib/stayExtension.js`), integer cents, one line per bed, no cap (a warning above 7
      nights suggests editing the planned date instead, i.e. a lease extension). **Rent runs to the contract date** with the
      rent rule of that date (one-month stay -> flat monthly rate; whole months -> `stayRent(move-in, contract)` less closed
      statements; older stays -> windows prorated through the contract date); **utilities, coverage and readings run to the
      actual date**. Input: Move Out step 1 shows "Stay extension ..." with a required choice "Vacated by 12:00 PM" /
      "Vacated after 12:00 PM" (no default; Next stays disabled until chosen). The line `{ source: 'EXTENSION', mid: 'N nights',
      rate: 500, computed }` follows the rent line, is editable like rent (not removable), and `details.extension = { contract_date,
      actual_date, after_noon, nights, rate, amount }` is stored. A staff request carries `_vacated_after_noon`; Approvals
      recomputes the extension from that choice (an unedited line follows the database, an edited one is kept with a warning);
      a stay extension staff typed by hand (a rent line or an "Unsettled" line whose label mentions "extension", as before this
      rule existed) is removed in favour of the computed line, listed in the differences and shown as "Typed stay extension
      replaced", so the nights are never charged twice (`isTypedExtension`, shared with the re-issue);
      an older request without the choice shows the same choice and keeps Approve disabled until the admin picks one. The
      printed bill and "Preview bill" show the line (rate P500.00) and a foot note; the activity note names the extension.
      Example: one-month stay Oct 2 -> contract Nov 2 at P10,000, out Nov 5 after 12:00 PM: rent P10,000.00 flat + stay
      extension 4 nights P2,000.00 (by 12:00 PM: 3 nights P1,500.00) + water and electricity to Nov 5.
    - **Early termination** = actual move-out earlier than the tenant's planned `move_out_date` as stored when
      the modal opened. Default: advance and deposit forfeited (`forfeit` lines at 0.00 with the original amounts
      shown). The "Management approved, do not forfeit" waiver is admin-only and needs a typed reason.
    - **Second-to-last bill (automatic, no staff action).** `billPosition(tenant, cutoff)`: the bill
      for a cutoff is `FINAL` if the tenant's move-out date (actual, else planned) is inside its rent/water window,
      `SECOND_TO_LAST` if it is inside the NEXT window (`water_end` .. `addMonths(water_end, 1)`, same month
      arithmetic as Utilities; `water_end` is exclusive, as in `billing.js`), else `STANDARD`. A tenant who moved
      in during the candidate window has no second-to-last bill (stays of only one or two billing periods get the
      advance on the final bill instead). **A move-out on a calendar month end has none either** (2026-11-06): when the
      date is the LAST day of the next window (`nextEnd - 1`, e.g. out Nov 30 for the Oct cutoff) the Oct bill is
      `STANDARD` and the whole advance goes on the final bill (a full month); a non-month-end date in the next window
      (Nov 15, Nov 29) still gets the Oct credit. This applies to the active cutoff (Oct 2026) and every later one: no badge,
      no "Less advance", no credit line on PrintRentWater, no Collections / Payment Monitoring adjustment, and Open Cutoff
      stores no `advance_credits` row for that tenant. Credits already stored for closed cutoffs (Sep 2026) are unchanged.
      Billing (Rent + Water view) shows a "2nd-to-last bill" badge plus "Less advance (pro-rated D of W days) / Net";
      PrintRentWater prints the credit line and the reduced total.
      **The credit is pro-rated by days (2026-11-06, `proratedAdvanceCents` in `finalBill.js`):** W = days of the
      second-to-last window (`water_end - water_start`, e.g. Oct = 31, Sep = 30, Feb = 28/29), D = days of the stay in the
      next window through the move-out day inclusive (`moveOut - water_end + 1`, 1..W-1 since a month end is STANDARD);
      A = advance on file (HELD/APPLIED ADVANCE receipts, whole-room beds summed; never the deposit or a reservation
      payment). credit = min(half-up integer cents of A x D / W, that period's rent); remaining = A - credit, exact by
      subtraction (it absorbs the rounding, so credit + remaining = A to the cent). The remaining part stays HELD and the
      final bill credits it ("already credited P.. on <cutoff> · remaining P.. (credited here)"); the final bill's rent is
      unchanged (Nov 1-23 on `stayRent`, no flat month). Worked example (rate and advance 5,000, out Nov 23, Oct window 31
      days): Oct credit 5,000 x 23/31 = 3,709.68, Oct rent due 1,290.32 (+ water); final bill (in Sep 1) rent 3,833.33
      (2 months + 23 of 30 days = 13,833.33 less 10,000.00 billed on closed statements), Less: Advanced Payment
      -1,290.32, rent payable 2,543.01; total rent after the advance 1,290.32 + 2,543.01 = 3,833.33. Other days: out Nov 15
      -> 2,419.35 (2,580.65 carried), Nov 1 -> 161.29 (4,838.71 carried, any excess on the final bill is returned), Nov 29
      -> 4,677.42. Advance 6,000 on rent 5,000, out Nov 23 -> 4,451.61; out Nov 29 -> capped at 5,000.00. Printed detail:
      "S.I# 1234 · credited ₱3,709.68 on this bill (pro-rated 23 of 31 days) · remaining ₱1,290.32 for the final bill"
      (the day count prints only while advance x D / W reproduces the credit; a credit capped at the rent says
      "(pro-rated)"; a stored credit from before this rule, or one whose move-out date moved since, prints no note).
      Live while the cutoff is ACTIVE (the amount follows the move-out date until Open Cutoff, which stores it and freezes
      it). It applies to the active Oct 2026 cutoff too, so Oct statements printed before the deploy show the old full
      credit and differ from a reprint. Stored credits (Sep 2026) and issued final bills are unchanged; Void & re-issue
      keeps the stored credit. The credit is an **adjustment, not cash**: Collections' amount to collect is net of it,
      and Payment Monitoring / Dashboard use it as `adjustments` in `buildPaymentMonitoring` (outstanding =
      billed - adjustments - paid; "paid"/collected never includes it), so sum(bills) = sum(payments) +
      adjustments + outstanding. Viewers cannot read the receipts (RLS), so their Dashboard summary omits it.
    - **Stored credit (`advance_credits`) makes it immutable.** While a cutoff is ACTIVE the credit is detected
      live from the move-out date. When the next cutoff is opened (Utilities "Open Cutoff", admin only: the button is
      hidden for other roles) `recordAdvanceCredits` runs BEFORE `openCutoff` for the cutoff being closed, and a
      failure ABORTS the open (nothing opened, error toast, safe to retry: recording is idempotent). Every
      tenant who was on their second-to-last bill gets one row (tenant, cutoff, amount, ref text, `allocations` =
      which receipts were used). From then on: a CLOSED cutoff's statement/adjustments read the stored row only (no
      row = no credit); live detection for a later cutoff SKIPS a tenant who already has a stored credit (the advance
      is consumed - a lease extension or date change can neither drop nor repeat it) and Billing shows "Advance
      already credited in <cutoff>". The final-bill draft reads the stored rows first (matched by receipt, so
      whole-room sibling beds are handled); there is no live estimate (the cutoff before the final one is always
      closed, and stored, by then).
    - **Final bill vs. the earlier credit (advance can never be used twice).** The final-bill draft, the Confirm
      step and an approval apply re-read the receipts, stored credits and cutoffs from the database and credit
      only what is left of every ADVANCE receipt: per receipt, remaining = amount - what a stored credit already
      took from it. Rules: (R1) a stored credit counts only if its cutoff window ENDS on or before the move-out date;
      a credit stored for the final bill's own cutoff or a later one (an "orphan", e.g. after the date was shortened)
      is ignored - the full advance is credited on the final bill, nothing is charged back, and the bill shows a
      notice (`advance_check.ignored`). (R2) fail closed: a stored credit of this tenant that matches none of the
      tenant's HELD ADVANCE receipts (and is not on a same-name same-room sibling bed's receipt) BLOCKS the move-out
      ("does not match this tenant's advance receipts"). (R3) credited before + credited on the final bill never
      exceeds a receipt. (R4) the system lines (advance/deposit credit, forfeit lines, charge-back) are locked:
      amount and kind cannot be edited and the line cannot be deleted in the Move Out modal; label and details
      can; any other deduction is a typed "Unsettled" line. If the advance was fully credited the advance line is
      0.00 and its text names the cutoff(s) ("already credited P6,000.00 on Sep 2026 · remaining P0.00"); a tenant
      who extends after the credit does NOT pay a new advance - the advance stays consumed, the deposit stays
      held and monthly rent continues normally. With no stored credit (1-2 period stay, or the earlier cutoff was
      closed before this feature) the full advance is credited on the final bill. **Forfeiture after a credit:**
      if the draft forfeits (early termination, no waiver) the forfeit line shows the full advance and a locked
      charge line "Advance credited on second-to-last bill (forfeited)" takes back the part that was really
      credited (valid stored credits only); a waiver removes both. Receipts are only marked "credited on the bill
      of cutoff X" when a stored credit really covered them.
    - **Advance check (`details.advance_check`).** `finalBill.advanceCheck()` returns { status, advance_total,
      credited_before, credited_here, forfeited, remaining_before, receipts[], prior[], ignored[], text,
      checked_at }; status is NO_ADVANCE / NOT_CREDITED_BEFORE / PARTLY_CREDITED_BEFORE / FULLY_CREDITED_BEFORE /
      FORFEITED / ORPHAN_IGNORED / BLOCKED. It is shown in an "Advance check" box on Move Out steps 2 and 3
      (step 3 says when it was checked against the database), in the Approvals review modal, and its text is
      printed on the final bill (`PrintFinalBill`) and listed under each bill in the tenant profile. Every created
      final bill carries the check computed from fresh data inside `processMoveOutWithBill` (never one supplied by
      the caller). `verifyBillAgainstDb()` (= `reconcileBill()` plus a verdict) is the strict comparison: if the
      credit/forfeit/charge-back lines, the cutoff or the early-termination flag no longer match the database the
      save is refused BEFORE anything is written (`stale`), the modal rebuilds the draft (typed lines kept) and
      asks staff to review it again. The approval apply also recomputes the charge-back amount and the advance
      text from the database and lists every difference.
    - **Database guards** (`database/migrations/advance_credit_guards.sql`, mirrored in `init.sql` next to
      `advance_credits`; run its four read-only audit queries first): G1 on `advance_credits` insert (allocations
      must add up and be ADVANCE receipts, no receipt over-credited, none after a FINAL bill or settled receipt);
      G2 on `final_bills` insert (a credit/forfeit line may only use that tenant's HELD receipts, once, and an
      ADVANCE credit cannot exceed what earlier statements left; orphan credits are not counted); G3 on
      `tenant_deposits` update (an ADVANCE receipt cannot be edited below what was credited from it).
      `recordAdvanceCredits` (Open Cutoff) fetches transfers and final bills too, stores HELD receipts only, skips
      tenants with a FINAL bill and checks that allocations add up before inserting. The credit lines on Billing
      and the printed Rent + Water statement say "credited P x on this bill · remaining P y for the final bill".
      Not built yet (stage B): the leaving confirmation at the Billing buttons.
    - **Safeguards:** `processMoveOutWithBill` refuses an inactive tenant or an existing FINAL bill (the unique
      index backs it); after a partial failure the Move Out modal locks to Close only and lists what ran.
      Receipt settlement is filtered by tenant id and HELD status. For an approval request, the apply step
      recomputes cutoff (from the move-out date), early termination (from the tenant's planned date in the DB)
      and the credit/forfeit lines (amounts + receipt ids from the tenant's own HELD receipts); it rejects a
      request whose credit lines reference foreign receipts, exceed the receipts, or whose totals do not match
      its lines, and the review modal lists every difference between "requested" and "will apply". If apply
      fails after the tenant was moved out (or the final approve step fails), the admin sees that plainly and can
      use "Mark approved (already applied)", which first re-reads the DB and refuses unless the tenant is inactive
      and a non-void FINAL bill for the request's date exists. If the move-out failed while the bill could not be
      auto-voided (bill saved, tenant still ACTIVE), the admin is told to void that bill from the tenant profile
      and no mark-approved action is offered. The closed-cutoff "2nd-to-last" badge shows only with a stored credit. Only HELD receipts are editable. Readings are rounded to 2 decimals.
      With no cutoff covering the move-out date an admin can still proceed (rent/utility lines at 0, to be keyed
      in); non-admins cannot. Going back and changing the date/readings rebuilds the computed lines but keeps
      lines staff added.
    - **Print:** `/print/final-bill?id=` / `?ids=` (`PrintFinalBill.jsx`, admin and user, read-only for user: the
      receipt-number fix panel is admin-only; the rent-water / electricity print pages stay admin-only) reuses
      `Statement.jsx` (additive props: rate column, amount text, italic rows, total label/colour). Buttons: "Print
      final bill" on the move-out result screen and in the tenant profile (Bills tab, with an admin-only
      Void). Voiding sets the bill VOID with a reason (and `voided_by`) and puts its HELD-then-settled receipts back to HELD.
    - **Void & re-issue (2026-11-06, admin).** Tenant profile -> Bills -> "Void & re-issue" on a FINAL bill of a moved-out
      tenant whose refund is not PAID (`reissueBlocker`; bills of several beds, `details.stay.group.tenant_ids` > 1, are not
      supported yet: the button says so and the RPC refuses them). `ReissueFinalBillModal`: step 1 shows the move-out date and readings read-only
      (the saved move-out interim readings of that tenant and date, else the bill's own) and, for a late move-out, the required
      12:00 PM choice (no default); step 2 is the bill editor with rent and stay extension recomputed (`loadReissueBundle`: the
      bill's receipts treated as HELD, the bill left out of the ghost stamps, contract date = `details.extension.contract_date`,
      else the move-out request's `old_value.move_out_date`, else the tenant row), water and electricity RECOMPUTED from the
      database (so the bill equals the ghost share the room's statements use, §14; edit a line to change it), typed lines carried
      over, a typed extension (rent or "Unsettled" line mentioning "extension") replaced by the computed one, and a comparison
      table (old bill = approved amounts / new bill / change per line type, plus the water and electricity recomputed now); step 3 asks a required reason. Confirm re-checks the advance and payments against
      the database, then the RPC `reissue_final_bill` (`database/migrations/final_bill_reissue.sql`) does everything in ONE
      transaction: old bill VOID ("Re-issued: <reason>", `voided_at`, `voided_by`), its receipts back to HELD, the new FINAL
      bill inserted (guard G2 runs), `replaces_bill_id` / `replaced_by_bill_id` linked, the receipts settled on the new bill,
      activity rows "Final Bill Voided" and "Final Bill Reissued". It refuses (nothing written) a non-admin, a non-FINAL bill,
      a several-beds bill, a PAID refund, an active tenant, another tenant or move-out date, and totals that are not the exact cent sum of the
      lines. Never a delete: the old bill stays as VOID history (its refund value too). The new bill: new number
      FINAL-<room>-<new id>, `details.reissue = { of, reason, at, by }`, the same `details.approval_request_id` (else the
      tenant's approved move-out request for that date; so the request's "Final bill" button opens it), covered cutoffs = the
      fresh coverage merged per component with the old bill's, refund PENDING when net < 0. The tenant, bed, readings and the
      approval request are not written. The leaver stays a ghost throughout (the swap is atomic), so roommates' statements do
      not move. Prints: the VOID bill "VOID — <reason> · Replaced by FINAL-<room>-<n>", the new one the foot note "Replaces
      FINAL-<room>-<old> (voided <date>)"; the Bills tab shows "Replaced by #n" / "Replaces #n (voided)".
      Final bills stay reachable after the move-out: Tenants → View (Overview banner and Bills tab, §3), and
      Approvals: after an admin approves a move-out request a banner shows "Move-out applied: <tenant>.
      Final bill #n" with Print final bill(s) and Open tenant profile; every Approved move-out row has a
      "Final bill" button (opens that request's FINAL bills, found by `details.approval_request_id`; "No
      final bill on this request" for an old date-only request, "Final bill voided (#n)" when all are void)
      and "Open tenant".
    - **Utility split after a move-out:** `fetchTenants()` stamps tenants that have a non-void final bill
      (`_finalBilled`, `_finalBilledCutoffs`); for that bill's cutoff `computeBilling` keeps them in the split as
      non-billed participants (their days still apportion the room, so roommates pay only their own share) but
      gives them no `perTenant` row or rent. The leaver's share stays in `perRoom.sum`, so the room still
      reconciles and the utility P&L counts it as a collection; Collections / Payment Monitoring / Dashboard
      iterate `perTenant` and do not double count it. The monthly snapshot's collections columns sum `perTenant`
      and therefore exclude final-bill utilities. Move-outs saved without a final bill (before Phase 2), other
      cutoffs, and viewers (who cannot read `final_bills`) keep the old behaviour (roommates absorb the days).
    - **Final bill catch-up, one-month stays and sibling beds (built; migration
      `database/migrations/final_bill_covered_cutoffs.sql`, apply it BEFORE deploying the frontend).** The pure rules live in
      `src/lib/stay.js` (stay kind, cutoff coverage), `src/lib/utilityPieces.js` (stay-anchored utility split) and
      `src/lib/finalBill.js` (`buildFinalBillDrafts`); `src/lib/moveOutData.js` loads the data for the Move Out modal and
      the Approvals review.
      - **Per-utility cutoff (D2).** Water and electricity each use the cutoff whose OWN window holds the move-out date (they
        differ on days 1-9: electric Oct 10 - Nov 10 vs water Oct 1 - Oct 31). The move-out reading of each utility is saved
        as an interim reading against that utility's cutoff, once per tenant or sibling group for a room+utility+date+value (a retry never duplicates it; an unrelated tenant leaving the same day at the same reading saves their own row, a zero-day, zero-usage segment).
        **No next cutoff is needed:** a date AFTER the end of the latest window of a utility uses that latest cutoff (no blocking, no zero
        lines), the usage runs through the move-out reading at that cutoff's rate, and the reading is saved against it with its real date (the
        statement ignores an interim outside its window; the next tenant's start reading still finds it). Where day-based rent needs a window that does not
        exist, that calendar month is used with its real days (out Nov 1 with no Nov cutoff: 1 of 30); a window's days stop at its end, so no day is charged twice.
        A stay that began after the latest window does not touch that cutoff: it adds no rent and is not covered, and the meter starts at the room's last reading
        before move-in; the cutoff only supplies the rate and holds the saved reading. A reading below that cutoff's current reading, a date more than 31 days past the last
        window and a date more than 31 days from today each raise a warning. **Re-attach step (automatic, no manual reading step):** `open_cutoff` still starts the new cutoff
        from the old current reading. Right after Open Cutoff, and whenever an admin loads Utilities (self-heal), `reattachMoveOutReadings` moves each such reading to the
        cutoff whose window now holds its date (insert + delete: `interim_readings` has no UPDATE policy) and adds that cutoff, for that component only, to the `covered_cutoffs` of the
        final bills that reading belongs to. The leaver is then a ghost for those days and roommates pay only their share; bill lines stay frozen. Example: A and B, Oct water
        100 -> 110, A out Nov 2 at 120, B stays, Nov current 130, rate 100: A's bill 1,000.00, B's Oct 500.00, B's Nov 1,500.00, total 3,000.00 = metered. In an emptied room the rest stays
        unbilled with the room. A failure names the rooms and is safe to re-run. A reading belongs to a non-void final bill with stay details, in the same room and date, when its `moving_out_tenant_id` is that bill's tenant, a sibling in that bill's group, or a tenant whose own bill's group names this bill's tenant (a retried bed's list can be partial). Only such readings move and only those bills gain coverage; stale, transfer and manual rows and legacy bills never change. A copy already in the target counts as a duplicate only if it is linked to the same tenant or group, and the last copy is never removed. Each move is traced in the activity row's metadata. A cutoff that a non-void final bill references, or that holds such a bill's move-out reading, cannot be deleted ("This cutoff is part of final bill #n and cannot be deleted. Edit its rate or name instead."). Only a date with a later window but none holding it (the electric gap, e.g. Oct 5) still has no cutoff: a non-admin is blocked with
        "Open the <Mon YYYY> cutoff first"; an admin may continue (that utility's lines are 0, its reading is not saved, a warning says so). When two cutoffs store the
        same electric window the one whose water window also holds the date wins.
      - **Covered cutoffs (D1, D9).** A final bill covers every cutoff window the stay touches that is not already billed.
        `final_bills.covered_cutoffs` (jsonb array) records them. **Coverage is per component:** an element is a plain cutoff id
        (rent/water AND electricity: every legacy bill, bill #7 is an empty array) or `{ id, water, electric }` when the bill bills only
        one component of that cutoff (no schema change). Example: a long stay moving out Nov 5 has water final = Nov (Nov window) but
        electricity final = Oct (the Oct 10 - Nov 10 window), and Oct is closed for rent/water, so Oct is `{id, water:false, electric:true}`
        and Nov `{id, water:true, electric:false}`. `fetchTenants()` stamps `_finalBilledCutoffs` (both), `_finalBilledWater` and
        `_finalBilledElectric`; `computeBilling` makes the leaver a non-billed participant (ghost) per utility, only where that
        component is covered, and suppresses the leaver's rent only where rent/water is covered. A component the bill does not cover
        stays on that statement as a normal billed row (the Oct statement keeps the leaver's rent and water). Voiding the bill releases them.
        The tenant profile's Monthly statements show a covered component as "Billed on final bill #n" (§3 "Tenant profile history"). "Closed"
        means: not the active cutoff and older than it (no active cutoff = all closed); `open_cutoff()` deactivates every
        other cutoff, so the window holding the move-out date is covered regardless of is_active, a one-month stay covers
        every window it touches (it never appeared on a statement), and only EARLIER windows of longer or odd stays are
        tested for "closed". Closed periods are assumed billed; any open balance is a typed "Unsettled" line.
      - **One-month stays (D3).** An ACTIVE tenant whose planned stay is exactly one month (`move_out_date = addMonths(move_in, 1)`) and
        whose planned move-out is NOT a calendar month end (the old same-date-next-month leases such as Oct 2 -> Nov 2; a month-end lease
        such as Oct 31 -> Nov 30 or Jan 31 -> Feb 28 goes through the normal flow, billed on the statements and rent by "Rent of a stay")
        has no standalone bill on any regular statement (Billing, Collections, Payment Monitoring, Dashboard, snapshot, P&L
        collections): `computeBilling` keeps them as ghost participants of the room split (the room still reconciles and
        roommates pay only their own share) and returns a `stayBilled` list that Billing shows as "billed on final bill". Rent is ONE flat
        monthly rate on the final bill; there is no second-to-last credit and the full advance and deposit are credited
        there. An early or late move-out prorates the rent by days over every window the stay touched.
      - **Longer stays (D6) and month-end stays.** For a stay that is not stay-billed and began on or after the first cutoff of the
        app (pre-app guard), the rent line is max(0, months-plus-excess total - rent already billed on CLOSED cutoffs) (see "Rent of
        a stay"), with the label showing the arithmetic; regular monthly statements keep day-prorated rent. Pre-app move-ins are
        day-prorated over the covered windows, one line per window.
      - **Stay-anchored utilities (D4).** Quantity = the room's consumption between the stay's start reading and the move-out
        reading, split by days present between the beds (siblings equal; days nobody was present are shared by the people
        overlapping that piece, as in Billing; a piece nobody overlaps stays unbilled), each piece priced at the bedspace rate of
        the cutoff its days fall in. Start reading precedence per utility: a move-in reading (`interim_readings.moving_in_tenant_id`),
        else the latest reading of the room at or before the day before move-in (previous tenant's move-out interim, a closed
        cutoff's closing reading, a cutoff's opening reading), else the opening reading of the cutoff pricing the move-in day. Staff
        can override it in the bill editor. Days in the gap between two electric windows are priced at the nearest FOLLOWING window
        and the line says so. A change of rate inside the stay uses the meter readings at the window boundary (the later cutoff's
        opening reading, else the earlier one's closing reading); with none usable the piece is split pro rata by days and a warning
        is shown. Negative consumption blocks (the error names both readings).
      - **Rate fallback (D5).** On the final bill only: a cutoff whose water/electric bedspace rate is empty or 0 uses the most
        recent earlier cutoff with a rate, noted on the line with where that rate came from ("rate from Sep 2026 (computed from the provider bill) - not
        set for Oct 2026", or "(manual rate)" when that cutoff's rate is a manual override) and in a warning. The rate is frozen into the stored line: when the
        Oct provider bill arrives later, this bill does not change. Normal Billing is unchanged.
      - **Rounding.** Each reading-to-reading piece (per pricing cutoff) is rounded to the cent; the cents are shared by day-weights
        with exact integer arithmetic, any odd cent going to the larger fractional share, ties to the lower tenant id (first bed). The
        shares always add up to the piece; every stored line is rounded to 2 decimals and the totals are the exact sum of the
        stored lines. The final bill is stay-anchored, so it need not equal the leaver's ghost share on the cutoff statement (see section 6).
      - **Payments netting (D8).** Only payments for a component THIS bill bills come off, as one locked "Less: payment received" line
        (kind `payment`, `payment_ids`): RENT_WATER payments on cutoffs whose rent/water the bill bills, ELECTRICITY payments on cutoffs
        whose electricity it bills (so in the Nov 5 example Oct ELECTRICITY counts but the Oct RENT_WATER payment, which belongs to the
        statement already issued, is ignored). Payments of any other category (OTHER, empty, unknown) are not tied to a statement
        component and are netted on ANY covered cutoff. Voids (negative rows of the same category and cutoff) are honoured; payments on
        uncovered cutoffs and payments with no cutoff (the move-out "Final Amount Paid", recorded after the bill) are never netted. The save and the approval apply recompute
        it with the same rule. It counts under total credits; G2 only looks at credit/forfeit lines, so it is not affected.
      - **Siblings (D7).** Active tenants with the same trimmed case-insensitive name, in the same room, with the same planned
        move-out date leave through ONE Move Out flow: one date, one set of room readings, a bill section per bed, a combined summary, one final
        bill per tenant processed in bed order. A failed bed does not stop the others; the result lists what ran and "Retry failed bed(s)" re-runs
        only those (a partly processed bed locks as before). A non-admin submits ONE approval request carrying all beds
        (`new_value._siblings`); approving applies the beds in order, a failure lists which beds were applied and the request stays PENDING;
        re-approving skips the beds already applied. **Utilities are recomputed at approval:** a request's rent, water and electricity lines were
        computed when it was submitted, each request assuming the other leavers of the room are still present, so two requests of the same room would not
        reconcile. At review AND at apply the lines are rebuilt from the database as it is then (same date, readings and start-reading overrides; beds already
        applied are ghosts in the split) and merged per source: a line the staff did NOT edit (amount equals its own `computed`, or an old request with no marker) is
        replaced by the fresh figure; a line staff edited is kept with a warning; typed "Unsettled" lines and locked system lines follow the existing rules. The
        review lists every difference per bed (requested vs will apply), shows the will-apply total, and the saved bill carries
        `details.recomputed_at_approval = { at, diffs }` and `details.approval_request_id`. Example (electric 6240 -> 6260 at 22, Solo out Oct 22, a pair out Oct 25, three
        beds from Oct 1): submitted independently the Pair lines are 155.47 / 155.46 (total with Solo 384.27, not 440.00); approved after Solo they are 183.33 each
        because Solo is a ghost, and 73.34 + 183.33 + 183.33 = 440.00 exactly. **Approve move-outs in move-out date order** (the earlier leaver first) so
        the room reconciles: the review warns "<name> leaves earlier (<date>) and is not processed yet ..." when another active tenant of the room has an earlier
        planned date. The apply compares each bed's will-apply net with the net shown in the review and stops BEFORE writing anything ("The figures changed since
        you opened this review ... Reopen the review and approve again") when they differ. Same name with a different date is not grouped (the modal says so). The combined
        print page is `/print/final-bill?ids=12,13`.
      - **Stale data.** The save and the approval apply re-read the covered periods and the payments (plus the advance data) and refuse
        BEFORE anything is written when they differ from the bill; the modal rebuilds the draft. A staff-edited computed amount only raises a warning.
      - **Who shares a stay-anchored utility piece.** Follows `billing.js` (not an exact mirror, see known limit 10): the room's ACTIVE tenants, the tenants moving out now, and
        inactive tenants that are ghosts for a cutoff being priced (final-billed with that utility's component covered, from the
        per-utility stamps). Every other inactive row of the room, even with an actual move-out date (historical transfer rows,
        old tenants), is ignored: they are not billed in the cutoff statements, so counting them would dilute everyone's share. The draft
        warns "N earlier tenant rows of this room were ignored: they are not billed in the cutoff statements."
      - **Reading order.** The move-out reading of a utility is checked against the room's other interim readings of that utility (a
        retry's own readings are ignored): lower than an EARLIER reading, or higher than a LATER reading saved in the SAME cutoff (the one it will be
        saved against), blocks the move-out with an error naming both readings; a later reading in ANOTHER cutoff is only a warning
        (stale or future-dated entries there must not block). Same rule for water and electricity. Billing's Per Room view never says
        "Reconciled" for a room with a segment whose reading went backwards or a negative unbilled amount: it says "Check readings"
        (amounts are not changed; a -0 is shown as 0).
      - **Closed-rent assumption.** The months-plus-days rent subtracts the rent a CLOSED cutoff's statement "billed", computed live
        from the move-in date. A tenant added (created) after the next cutoff was opened, with a back-dated move-in, was never actually billed
        on that statement; the draft then warns "<name> was added after the <cutoff> statement closed; the closed-period rent deducted (P x) assumes it was
        billed" (amounts unchanged; staff adjust with a typed line if needed).
      - **One summed final bill for several beds (display only).** The database keeps one `final_bills` row per bed (receipts, guards G1-G3, the unique index
        and retries stay per tenant). `combineBillsForPrint` sums in integer cents per line type (one rent line, water and electricity per rate, advance, deposit,
        payment, forfeits; typed lines listed individually with their bed; refs combined; room consumption once, personal consumption summed), and the total is the
        exact sum of the beds' nets. Bills with the same trimmed case-insensitive name, room and move-out date (non-void) print as ONE statement with one Billing No.
        (series = the lowest bill id, editable), one prepared-by and a bed note ("Bed A: rent ..., water ..., electricity ..., to return ..."). Printing one
        bed's bill opens the whole group (`details.stay.group.tenant_ids`, plus the same name/room/date). Move Out steps 2-3 and the Approvals review show the same
        summed block above the per-bed sections.
      - **Preview before confirming.** "Preview bill" on Move Out steps 2-3 and in the Approvals review shows the printed statement of the current on-screen draft
        (edits, typed lines, the summed sibling statement; in Approvals the will-apply figures) in an overlay. It writes nothing and stores nothing, the modal stays as it
        was, and it carries Billing No. "DRAFT" and the banner "DRAFT - not saved, not yet a final bill" on each copy, also when printed.
      - **Final-bill print.** `/print/final-bill?id=` / `?ids=` reuses the Rent + Water statement layout (same `Statement` component, rate column and
        foot notes kept). The rate column is a unit price, not an amount: water shows "155.0375 / cu. m", electricity "22.00 / kWh" (no peso sign)
        (the unit may wrap under the number); also in the draft "Preview bill". Billing No. = `FINAL-<room_no>-<series>`, series = the final bill id zero-padded to 4 digits (a "Series" box lets staff
        override it, one per bill); a "Billing Date" box (default = the move-out date) sets the Due Date = billing date + 7 days; "As of" stays the
        move-out date. The copy grows with its content instead of clipping; when a copy is taller than half an A4 page the Tenant's and Owner's copies go
        on separate pages. The print pages are fixed light whatever the app theme. Old bills (no stay details) print as before.
      - **Vacated confirmation.** Moving a tenant out (admin confirm in the Move Out modal, or the admin's Approve of a non-admin request) requires the tick
        "Tenant has vacated the room and access has been returned" (one tick covers every bed of a sibling flow). It is recorded on each bed's bill as
        `final_bills.details.vacated = { confirmed, by, at }` and in the Move Out activity note ("Vacated confirmed by X"); `processMoveOutWithBill`
        and `processMoveOutGroup` refuse without it before writing anything. A non-admin only submits; in Approvals the admin must tick it before Approve
        is enabled (also for requests made before the tick existed). It is not printed.
    - **Known limits:** (1) a tenant who moved out WITHOUT a covered-cutoffs bill (before this change) keeps the old behaviour
      outside the bill's own cutoff; (2) whole-room tenancies are billed per bed row, utilities are not collapsed (billing.js only collapses
      same-name beds with no move-out date, so dated tenants never are); the advance credit code still handles a collapsed row by
      summing all same-name beds against the combined rent; (3) add-ons and custom utility splits of the covered cutoffs are not on the final
      bill (a warning is shown; add a typed line); (4) transfers inside the stay are not folded into the rent/utility lines (warning
      shown); (5) unsettled earlier amounts are typed in by staff; (6) a voided bill is re-issued only through "Void & re-issue" (single-bed bills; sibling-group bills not yet), a plain Void still leaves the tenant with no bill; (7) the credit on a printed
      second-to-last statement is not retroactively corrected if the date later moves; (8) an interim reading dated on a window's first day now
      counts as a boundary in Billing (a live audit found none); (9) editing the move-in or planned move-out date of a stay-billed tenant to something
      that is no longer one month makes the tenant reappear on the statements; (12) if Open Cutoff records the advance credits but opening then fails, and the tenant moves out with no next cutoff, the stored credit still counts against the final bill although that bill covers the cutoff (fixing it needs a change to guard G2); (13) usage after the last window is priced at that cutoff's rate and stays frozen on the bill even if the next cutoff's rate differs, so the leaver's ghost share in the new cutoff need not equal the bill; (10) a leaver final-billed electric-only on one cutoff and water-only on a different cutoff is a billed row for the uncovered component in `billing.js`, but is not a participant for that utility in the final-bill split (low likelihood); (11) retroactive back-dated move-in: a tenant added AFTER roommates were already final-billed, with a move-in inside the period those bills covered, gets a utility split that includes days the earlier bills already absorbed, so the room's final-bill utility total can exceed the metered consumption (the draft warns when the tenant was created after another final bill of the room that overlaps the span; amounts are not changed, staff review the utility lines).
    - **Phase 3 (not built):** refund tracker (mark `refund_status` PAID with date/reference), in-app
      proof-of-payment.
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
- Providers: Manila Water (water), Meralco (electricity). (The DB columns keep their old `water_maynilad_rate` name; it is the provider's standard water rate.) Provider rates **vary over time** — this is
  exactly why the manual markup-override checkbox exists in the Utilities screen; 10% is only a
  seed default, not a fixed business rule.
- Split method: Method B (segment-based, per-day, per-tenant proration) — **confirmed correct**
  against a real example: reading 10434 → 10541 (107 units consumed), room total ₱2,354.00, 5
  tenants present the whole period → ₱470.80 each (2,354.00 ÷ 5 = 470.80 exactly, matches the
  implemented algorithm with no discrepancy).
- Common areas (Lobby, 2nd Floor, Roof Deck): pure operating cost, **billed to nobody**, absorbed
  by the business — confirmed intentional, not a placeholder.
- Commercial tenants (e.g. water-refilling station, parking): billed **on the same cutoff/billing
  cadence as regular bedspace tenants**. **Commercial WATER — done:** the Commercial area reading is
  linked (`area_readings.tenant_id`) to the single active `COMMERCIAL` tenant when saved from
  `Utilities.jsx`; `billing.js` then bills that tenant `consumption × bedspace rate`, and the utility
  P&L counts it as part of the amount to be collected, so water variance = (rooms to be collected +
  commercial water) − provider cost. The commercial tenant's `rate` stays a separate fixed monthly charge. **Commercial ELECTRIC is
  still pending** (not linked, not in variance). Actual collections for a cutoff = bedspace tenants +
  the commercial tenant.
- **Final-bill utilities vs the cutoff statement.** A leaver's final bill is stay-anchored (reading-to-reading, split by days
  present, priced per window), so it need not equal the share that tenant would have had on the cutoff statement as a ghost
  participant (gap days, a window opening reading older than the previous tenant's closing reading). The room still reconciles inside
  `computeBilling` because the ghost share stays in `perRoom.sum`. See section 5 "Final bill catch-up".
- **Transferred tenant on a printed statement.** A tenant who transferred rooms inside a cutoff's rent/water window prints with
  the same split as the Billing page: rent at the old rate for the days before the transfer and the new rate after, and water /
  electricity shares from both rooms (since 2026-11-05; before, the print pages ignored the transfer). The billing-details box
  still shows the tenant's current room's meter readings.
- **Judgment-laden "losing"/"earning" wording removed from the utility P&L variance display —
  DONE.** `Utilities.jsx` now renders the room-collections-vs-provider-cost variance as
  "Shortfall" / "Surplus" instead of "losing" / "earning."
- **Utility P&L variance = amount to be collected − provider cost (since 2026-11-06).** The P&L uses the
  amount **billed** to tenants per the bedspace submeters (Method B, submeters × bedspace rate), never
  payments received: tenants pay late, so payments would understate a cutoff. On the Utilities P&L card
  the row is "To be collected (submeters)" (hint: billed to tenants, not payments received; it was
  "Room collections"), and a formula line under VARIANCE shows the parts: Water "To be collected ₱A
  (rooms ₱R + commercial ₱C) − Provider cost ₱P", Electric "To be collected ₱R − Provider cost ₱P"
  (commercial electric pending, not included). Sign unchanged: negative = Shortfall, positive = Surplus;
  the variance values stored in snapshots and shown on Dashboard/Reports are unchanged.
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
- **Roles:** `admin`, `user`, `viewer` and `guard` ("Security / Front desk"). The `guard` role sees
  only the Visitor Log (§17): no sidebar, every other route redirects to `/visitors`, and in the
  database it is locked out of every existing table (`not (select public.is_guard())` on the
  any-signed-in-user policies, so admin/user/viewer access is unchanged). Its only reads and writes
  are the `visitor_*` SECURITY DEFINER RPCs plus uploading ID photos to the private `visitor-ids`
  bucket. `public.app_role()` returns the caller's role for RPC and storage-policy checks.
- **Users page, Add New User (admin):** creates the account with `supabase.auth.signUp`. If the email is
  already registered, Supabase returns a fake success (empty `identities`) and keeps the old password, so
  the page rejects it with "This email already has an account" instead of reporting success
  (`src/lib/userAccounts.js`). Re-adding a user is never a way to change a password: reset it from the
  Supabase dashboard (Authentication → Users).
- General principle: whatever is visible/accessible to the `user` role in the UI, they may do
  directly, **provided it's captured in `activity_log`**. A specific subset of actions additionally
  requires the approval workflow (current scope: move-out, transfer, room config, bed rate
  changes, bed removal — see `.claude/agents/`). Room reconfiguration (§4) is deliberately
  admin-only instead, not approval-gated.
- **Beds (column split):** `beds_update` RLS lets admin and user update a bed row; the
  `guard_beds_protected_fields` trigger then lets a non-admin change only `status`, `reserved_name` and
  `reserved_move_in_date` (reserve, remove a reservation, set the target move-in date, Move In). Bed rate
  and every other column stay admin-only, and REMOVED transitions need admin approval.
- **Tenants / Current Tenants / profile history:** both pages are admin and user (viewer is redirected
  to `/`, guard never reaches them). `user` sees every tenant, past and present, and every profile tab
  (bills, payments, final bills, receipts, transfers, activity, maintenance, visitors; RLS allows the
  reads). `user` may open and print final bills read-only (`/print/final-bill` is in the admin+user
  route block); Void and the receipt-number fixes stay admin-only. The profile's Visitors tab is
  admin/user only, like the Visitor Log (§17).
- **Monthly statement history (profile Bills tab):** admin and user see it and open the statement Preview (including its
  browser print, read-only). The "Print" link to `/print/rent-water` / `/print/electricity` `?tenant=` is admin-only, like those
  routes (admin-only in `App.jsx`). Every input it reads is admin/user under RLS; nothing is written.
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
- **A ticket targets a room or a common area (2026-11-05).** The required "Location" select in the New
  Ticket modal lists a "Common areas" group (LOBBY, 2ND FLOOR, 3RD FLOOR, 4TH FLOOR, 5TH FLOOR, 6TH FLOOR,
  7TH FLOOR, KITCHEN, ROOF DECK, shown as the user typed them) and then a "Rooms" group. The common areas
  are a fixed list in `supabase/functions/_shared/maintenance-locations.ts` (shared by the client and the
  email), stored as a code in `maintenance_tickets.location` (`LOBBY`, `FLOOR_2`…`FLOOR_7`, `KITCHEN`,
  `ROOF_DECK`); a CHECK constraint mirrors the list and another requires exactly one of `room_id` /
  `location`. It is a code list, not a table, because these are fixed parts of one building and nobody edits
  them; adding a location = a migration replacing the CHECK plus a one-line change in that file.
  - The tenant stays optional ("Staff-raised" by default). For a room, the picker lists that room's tenants;
    for a common area, all active tenants. Changing the location clears the tenant.
  - A common-area ticket writes no `room_logs` entry (room repair history stays per room). Its activity
    entries have no room number, notes `"<area>: <concern>"` and `metadata.location`.
  - Everywhere a ticket is shown (Maintenance list, Dashboard panel, detail and resolve modals, tenant
    profile tab, email) it has one place label: "Room 702" or the area ("LOBBY"). The Maintenance list's
    first column and filter are "Location" (filter: all locations, one common area, or one room; a floor
    does not include its rooms), and search matches the label.
- A tenant's tickets (`maintenance_tickets.tenant_id`) also appear on their profile's Maintenance tab,
  past tenants included (§3 "Tenant profile history").
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
  reference, summary card (Location — "Room 702" or the common area, Tenant — "Staff-raised" when none,
  Concern, Raised by, Raised time in Manila time), a Remarks block ("No remarks provided" when empty), a
  centered "View ticket" button to `/maintenance` (omitted when `APP_URL` is unset), and a footer naming the
  "Maintenance tickets" subscription. The intro ("… raised a ticket for <place>."), preheader and subject
  use the place: `[New ticket] Room 702 · <concern>`, `[New ticket] LOBBY · <concern>`. The loading, authorization (admin/user only),
  `PENDING` and 5-minute freshness guards are unchanged; "Raised by" is the caller's JWT email. Admins can
  send a fictitious "Sample: maintenance ticket" to one recipient from the notification settings page.
  Follow-up idea (not built): a "ticket resolved" email to whoever raised the ticket.

## 9. Reporting
- **Day-weighted occupancy — DONE.** `monthly_reports.occupancy_pct` (and the sibling
  `occupied_beds`/`active_tenants`/`occupied_rooms` columns) used to be point-in-time: computed from
  whichever beds happened to be `LEASED` at the moment the snapshot ran, so a tenant who moved out
  mid-month contributed 0 for that month instead of the fraction of the month they actually
  occupied. Reworked to a day-weighted average, computed once by
  `supabase/functions/_shared/occupancy.ts`'s `computeOccupancySnapshot()` (pure, no Deno/browser
  globals — imported unmodified by both `src/lib/snapshot.js`/`src/pages/Dashboard.jsx` and, in
  principle, any future Edge Function):
  - **Numerator.** For each `tenants` row with a `bed_id` (whole-room tenancy is N one-per-bed rows
    sharing a name, not a special structure, so no whole-room-specific logic is needed), the
    effective occupied interval is `[move_in_date, (actual_move_out_date || move_out_date) + 1 day)`
    — open-ended if neither move-out field is set — clamped to the reporting period. This is the
    **same rule for a closed historical month as for the still-open current one** (only the period's
    end date differs), so editing `move_out_date` weeks after a month has closed self-corrects that
    month's occupancy on the next recompute, not just going forward. Same-day move-in/move-out counts
    as 1 day (same inclusive-last-day/exclusive-period-end convention as `billing.js`'s `dayNum()`).
    A transfer mid-period updates the same tenant row's `bed_id` in place (no second row). The formula
    splits that row's span at `transfer_date` — pre-transfer days on `previous_bed_id`, post-transfer
    days on the current `bed_id` — and a period that ended before the transfer sits wholly on
    `previous_bed_id`. A bed counts at most once a day (distinct bed ids), so same-day turnovers and
    duplicate rows on one bed don't double-count. This reconstructs only **one hop back**: a tenant
    transferred twice within the same period still shows their earliest days on the wrong (2nd) bed,
    since `previous_bed_id` is a single column, and that can undercount by merging with that bed's real
    occupant for those days. Saved months keep their old figures until "Recompute occupancy %" is run.
  - **Denominator.** Current sellable-bed count (excludes `OUT OF ORDER` and `REMOVED`) × days in
    the period — a **documented approximation**: it uses today's bed inventory as the historical
    denominator too, not a reconstruction of the bed count as it stood during that period (bed-status
    history isn't reliably reconstructable from `activity_log` — seed/migrated data predates that
    discipline). `total_beds`/`sellable`/`total_rooms` stay simple current-inventory integer counts
    (property structure, not tenancy-driven — day-weighting doesn't apply to them);
    `occupied_beds`/`active_tenants`/`occupied_rooms` are `numeric(6,2)` fractional averages now
    (`database/migrations/occupancy_daily_weighting.sql`).
  - **Audit trail.** Every write to a non-manual `monthly_reports` row's occupancy/collections/P&L
    fields logs one `activity_log` row (`entity_type: 'MONTHLY_REPORT'`) with an old→new diff in
    `metadata.changes`, attributed to the acting user — the automatic snapshot on cutoff-open, the
    manual "Snapshot now" button, and the admin-only "Recompute occupancy %" button on Reports (which
    retroactively re-derives the 4 occupancy fields for every saved non-manual month from current
    data) all go through this. Rows created via "+ Manual month" (`manual = true`) are a deliberate
    admin override and are never touched by any of the above.
  - **Snapshot timing does not affect any live Dashboard number** — worth stating explicitly since it
    was a real point of confusion during implementation. Both figures on the Dashboard's Occupancy
    card (the headline month-to-date average, and the secondary "right now" rate) compute directly from live
    `beds`/`tenants`, never from stored `monthly_reports` rows. Only the historical "Occupancy Rate
    YTD" bar chart reads stored snapshots, so it only reflects a month once that month has actually
    been snapshotted.
  - **When the snapshot is captured — DONE, embedded (not a scheduled job).** A cutoff's `water_*`
    and `electric_*` windows both open together, in one `cutoffs` row, via a single "Open Cutoff"
    action on the Utilities page (there is no separate water-only vs. electric-only cutoff-open
    flow) — `buildAndSaveSnapshot(prior)` already fires on that action, snapshotting the outgoing
    cutoff with both utilities' final data. A pg_cron-scheduled Edge Function was considered and
    explicitly **rejected** by the owner in favor of this embedded, app-triggered mechanism (no
    scheduler, no extra Edge Function, no `pg_cron`/`pg_net` dependency).
- **Bonus bug fixed while auditing the above:** `Dashboard.jsx`'s inline sellable/total bed-count
  calc (like `snapshot.js`'s, before the rework) didn't exclude `REMOVED` beds — every other place in
  the app (`BedMap.jsx`, `Property.jsx`, `RoomReconfigureModal.jsx`, `supabase.js`) does. Fixed.
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
  year; months with no snapshot render as a gap, not a fabricated zero bar). At the time this was
  built, monthly granularity from the existing (point-in-time) snapshot mechanism was judged
  sufficient and day-weighting was thought unnecessary — **that call was reversed**: point-in-time
  snapshots silently zeroed out mid-month move-outs (see the day-weighted occupancy rework above),
  so day-weighting was needed after all, just not a literal daily-sampling job — the per-cutoff
  snapshot now computes a day-weighted average across the whole period in one pass instead of
  sampling once per day.
- **Occupancy module (`/occupancy`, `src/pages/Occupancy.jsx`) — DONE.** Replaces the owner's Google
  Sheet "current occupancy" (which counted every `LEASED` row with no dates, overcounting people who
  already left / hadn't moved in yet and ignoring mid-month movers). Same access as Reports (all roles).
  - **Definition.** The monthly occupancy rate is the **weighted average of the daily occupancy across
    all days of the month**, not the month-end reading: a tenant leaving on the 29th of a 30-day month
    only reduces the last 2 days (the move-out day itself counts as occupied — same inclusive-last-day
    rule as above). Computed by `computeDailyOccupancy()` in `_shared/occupancy.ts`, which shares one
    interval builder (`buildIntervals`) with `computeOccupancySnapshot()`, so the Occupancy page and the
    stored `monthly_reports` snapshots use identical tenant-interval rules.
  - **Months shown.** September 2026 onward only (`MIN_MONTH = '2026-09'`; no earlier months), newest
    first, through the current month. The current month is "Month to date", computed through today
    inclusive.
  - **Two value columns per month card:** "Month-end (last day)" (labelled "Today" for the current
    month) and "Weighted daily average". Rows: total beds (current setup), sellable beds, available
    (vacant) beds = sellable - occupied, rooms occupied, distinct tenants (people, keyed by room + name
    as elsewhere), beds occupied, revenue from beds leased, occupancy rate = beds occupied / sellable.
    Revenue per day = sum of each present tenant row's `tenants.rate`; the weighted column is the
    average daily revenue. Each card also has a collapsible daily detail table + bar strip.
  - **Approximations.** Denominators (total/sellable beds) are **today's** bed inventory applied to
    every month (same documented approximation as the snapshot denominator — bed-status history isn't
    reconstructable). Tenants fed in include **inactive / moved-out** tenants (`fetchTenants()` has no
    `is_active` filter), which is what makes historical months correct. No new tables or DB changes.

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
- **Room Maintenance panel — DONE, with role gating (see §8).** Compact pending-ticket list (room and
  common-area tickets, each with its place label) and a
  "View all in Maintenance →" link, visible only to `admin`/`user`. **Raise Ticket is removed from
  this panel** — raising a ticket happens only in the Maintenance module (§8); the panel is a
  read/monitor surface for the Dashboard, not a duplicate entry point.
- **Metrics/widgets — DONE** (definitions in §9):
  - Beds moving out this month
  - Move-ins this month
  - Lease extensions (this month, later-date edits only)
  - Month-to-date projected move-outs
  - Occupancy rate YTD (bar graph)
  - Occupancy — ONE card ("Occupancy · Month to date"; replaces the separate "Occupied Beds" and
    "Occupancy This Month" tiles). **Headline (2026-11-05, owner request):** the live **calendar-month**
    day-weighted average occupancy % (1st of this month through today, Asia/Manila; §9), one decimal,
    with "avg X of Y beds per day" and the date range under it; it equals the Occupancy page's
    current-month weighted daily average. **Secondary:** today's point-in-time rate (beds leased right
    now / sellable, whole %), a smaller non-bold "Today: …" line. Clicking the card opens Month detail;
    its "Beds occupied now" link opens Occupied Beds. With no sellable beds the headline shows "—". On
    the same day the two figures can differ: the average counts tenant records by their dates, "Today"
    counts bed statuses (see "Occupancy counts records by their dates" below); neither is adjusted to
    match the other. Logic in `src/lib/occupancyMtd.js`. The month figure no longer follows the active
    cutoff (a cutoff stays active after month-end until the next one is opened, which kept showing last
    month).
  - Move-in source breakdown
  - Projected vs. actual rent collection summary (links into §11 for full drill-down). Active cutoff only, so late
    payments to past cutoffs (§12) do not change it; billed figures come from the shared loader `src/lib/cutoffBilling.js`
    (2026-11-06, mid-period transfers included).
- **Icon convention. — DONE.** The Monthly Revenue KPI card uses `lucide-react`'s `PhilippinePeso`
  icon (it does exist in the installed version — an earlier note here assuming otherwise was
  wrong), not a dollar sign.
- **Existing Dashboard elements to keep, unchanged:** Upcoming Move-outs (rolling 30-day) list,
  Recent Activity feed, today's occupancy segmented bar. The Dashboard shows occupancy in three
  places, each answering a different question: the merged Occupancy card (calendar-month
  average so far as the headline + right now), the segmented bar (right now, by status), and the YTD bar graph (day-weighted
  per-month history from stored snapshots).
- **Occupancy counts records by their dates.** The day-weighted formula counts a tenant record by its
  dates, active or not, so an inactive tenant whose move-out date is still in the future counts until
  that date, possibly alongside the same person's current bed. An active tenant whose planned date has
  passed stops counting in the month average until moved out or extended. A Dashboard "Occupancy data
  check" banner that listed such records was removed at the owner's request (2026-11-03): the six rows
  it flagged have real dates and are kept as they are.
- **KPI tile drill-downs — DONE.** All KPI tiles (Occupancy [the card opens Month detail, the calendar-month
  occupancy list; its "Beds occupied now" link opens Occupied Beds], Vacant, Reserved, Monthly
  Revenue, Moving Out This Month, Move-ins This Month, Lease
  Extensions, MTD Projected Move-outs) are clickable, opening a shared `DrillDownModal`
  (`src/components/DrillDownModal.jsx`) built from data already in the Dashboard's memory (no new
  network calls, except "Month detail" which reuses the existing `computeOccupancySnapshot`
  call's `detail` field). Two shapes: **table** (Occupied Beds/Vacant/Reserved/Monthly
  Revenue/Month detail — search bar, row cap with "···N more", optional "Open full list in
  …" footer link) and **list** (the other four — reuses `.upcoming-item` styling, no search/cap).
  Occupied Beds / Month detail / the four monthly-metric tiles navigate a clicked row to a tenants page
  and auto-open that tenant's profile (works even if the tenant has since moved out): Occupied Beds,
  Moving Out This Month, Lease Extensions and MTD Projected Move-outs go to `/current-tenants` (the
  Occupied Beds footer is "Open full list in Current Tenants →"); Month detail and Move-ins This Month
  go to `/tenants` because those tenants may already have moved out;
  Vacant/Reserved navigate to `/property`'s Bed Rates tab with the room auto-expanded and scrolled
  into view. The Reserved table has a **Target move-in** column (the reservation's date, "No target date" when
  none, red "· overdue" when past); the Reserved KPI count is unchanged. Monthly Revenue's rows are aggregate (by room type) and not clickable. **Viewer
  role:** every drill-down still opens with full, correct data — only row-click navigation and the
  footer link are hidden (routes `/tenants`/`/current-tenants`/`/property` are admin/user only, same `canAct` gate as
  the Room Maintenance panel above). The month occupancy no longer depends on an active cutoff.

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
  closed cutoff may not reflect tenants who've since moved out. The tenant profile's Monthly statements (§3) carry the same
  caveat in their "Recalculated from current data" label.
- **Late payments (2026-11-06):** a payment recorded in Collections against a past cutoff (§12) carries that cutoff's id,
  so it lowers that cutoff's outstanding here. Billed figures come from the shared loader `src/lib/cutoffBilling.js`
  (same as Billing and Collections, mid-period transfers included).
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
- **Past cutoffs and late payments — DONE (2026-11-06).** A cutoff picker in the header (default: the active cutoff,
  marked "(active)") switches the table to any cutoff; a past one shows a "Past cutoff" badge. A late payment is
  recorded while its own cutoff is selected, so `payments.cutoff_id` is the cutoff it belongs to (not the active one);
  the save bar says "Recording against <cutoff>". One batch never mixes cutoffs: changing the cutoff clears the staged
  cells and the picker is locked while saving. Undo voids with the original row's `cutoff_id`, so the reversal lands on
  the same cutoff.
  - **Past-due banner:** the 3 most recent closed cutoffs (`pickPastDueCandidates`) are checked after the table loads;
    each with money still owed shows "<cutoff>: ₱x outstanding (n tenants) · View". Outstanding is per tenant and
    component, never netted against another tenant's overpayment. If the check fails the page says "Past-due check
    unavailable: <reason>". Refreshed after every save/undo. Older cutoffs are reachable through the picker.
  - **Rows:** the active cutoff lists every active tenant, as before. A past cutoff lists exactly the tenants on that
    cutoff's bill (moved-out ones included); a tenant whose final bill covers the cutoff has no row (the balance lives on
    the final bill). A past cutoff with no utility bill says "No billing data for this cutoff".
  - **Figures:** billed amounts come from the shared loader `src/lib/cutoffBilling.js` (same as Billing, so mid-period
    transfers are included), net of the second-to-last-bill advance credit; row logic in `src/lib/collectionsRows.js`.
  - A late payment never moves `tenants.last_pay_eom` / `last_pay_10th` back to an earlier date than they hold.

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
      (§6) — **water done**; commercial ELECTRIC still pending.
- [x] Design + build day-weighted occupancy tracking feeding the EOM average (§9) — **done**, via a
      day-weighted formula computed per cutoff (not literal daily sampling); see
      `supabase/functions/_shared/occupancy.ts`.
- [ ] Build deposit/refund/running-balance tracking per §5. **Phase 1 done** (`tenant_deposits`
      table, advance/deposit + S.I#/T.R# captured at Move In, "Advance & Deposit" tab in the tenant
      profile, backfill for active tenants). **Phase 2 done** (see §5 "Phase 2 as built"): Move Out flow
      with editable Final Bill, automatic second-to-last-bill advance credit, printable final bill,
      early-termination forfeiture with admin-only waiver, admin approval for non-admin move-outs.
      **Phase 3, not built:** refund tracker (mark the refund PAID with date/reference, bank transfer
      within a few days) and in-app proof-of-payment verification. Also open: keep the moved-out tenant
      in the utility split without billing them (known limit 1 in §5).
- [x] Reservation payments (own T.R#, BANK/CASH) on RESERVED beds, carried into the deposit at Move
      In, forfeited automatically when the reservation is cancelled, plus split (bank + cash)
      advance/deposit receipt lines with an exact-sum check (§3, §5) — **built**; the migration
      `database/migrations/reservation_payments.sql` must be applied by the DBA before deploying.
      Move In can also take typed reservation lines (T.R# required). Owner decisions: the deposit due
      is collected at move-in (default = Rate, editable, reservation credited toward it). Open: the
      reservation-greater-than-deposit rule (O2); no tester pass yet.
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
- [x] Automated unit tests for the money logic — **done** (phase 1). Vitest (`npm test`) covers the pure `src/lib/`
      modules (`receiptLines`, `stay`, `utilityPieces`, `billing`, `finalBill`, `pnl`, `finalBillStatement`,
      `bedEligibility`, `collectionsSummary`, `cutoffDates`), using the worked examples of §5 and §6 as golden cases.
      `src/lib/nonNegotiables.test.js` runs the §14 non-negotiables over a table of scenarios (simple, mid-period move-out,
      move-in, transfer, vacant days, odd centavo splits). Tests are fixture-only and synthetic: `src/test/setup.js` blanks
      the Supabase config and refuses `src/lib/supabase.js` and the network, so a test can never reach production. CI
      (`.github/workflows/ci.yml`) runs `npm test` + `npm run build` on every PR, without secrets. What pure logic can't
      show (one active tenant per bed is the DB index `uniq_active_tenant_per_bed`; never deleting billing records is RLS)
      stays a QA/tester check. Tests describe today's behaviour; a test marked `it.fails` documents a known bug below.

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
- [ ] Commercial / parking tenants (no bed) have no Move Out or Transfer in the app: ending one is done
      in the database by an admin until a dedicated flow exists (Tenants and Current Tenants, §3).
- [ ] Vercel Hobby plan is for non-commercial use — check the terms against this business's use.
- [ ] Gmail Apps Script daily recipient quota (~100/day for a consumer account) — unverified;
      confirm before adding many recipients or notification types.
- [x] Non-admin blocked check — **done**. The owner confirmed on 2026-09-21 that an admin's email
      link lands in the correct module and a `user` is blocked from modules they have no access to.
- [ ] `snapshot.js` still computes cutoffs without mid-period transfers. Collections, Payment Monitoring and the Dashboard
      moved to the shared loader on 2026-11-06 (`src/lib/cutoffBilling.js`, like Billing, the print pages and the profile
      statement history), so those now include them.
- [ ] The Billing page for a closed cutoff drops tenants who have since moved out without a final bill covering it (their
      roommates absorb those days) and places every tenant in their current room, even for a period before an earlier
      transfer. The profile statement history mirrors this (with a room warning) and shows moved-out tenants payments only.
      Fixing it (period participation for closed cutoffs) changes Billing, Collections, P&L and snapshot figures of closed periods.
      Collections' past-cutoff view and past-due banner (2026-11-06, §12) inherit this: such a tenant shows no row and is not
      counted as past due.
- [ ] Second-to-last Rent + Water statements lose their bottom lines when printed (found 2026-11-05, predates the reprint
      notice): the long "Less: Advanced Payment" detail (S.I# · credited … · remaining … for the final bill) wraps in the narrow
      middle column, so the copy needs about 540 px of its 501 px fixed height and the "2% late fee" line (with an add-on or
      split, also the notes) is cut off. The fix needs owner-approved wording/layout (e.g. move that detail to a note line). No
      figure is affected.
- [ ] Stored issued statements (`issued_statements`, captured at cutoff close) would give exact "as issued" figures from then
      on; today every past statement is recalculated from current data.
- [ ] Billing statements drift by a centavo (found by the unit tests, `it.fails` in `billing.test.js` and
      `nonNegotiables.test.js`). `billing.js` computes in float pesos and never allocates the odd cent: (a) a room's
      tenant shares, each rounded as printed, can add up to a centavo less than consumption x rate (100.00 over three
      tenants prints 33.33 x 3 = 99.99; a room with a final-billed ghost shows 73.33 + 403.33 + 403.33 = 879.99 for 880.00); (b) a
      statement's rounded lines can differ from its rounded total (4,838.71 + 10.65 printed, total due 4,849.35). The final
      bill (`utilityPieces.js`) already does this exactly with integer-cent largest-remainder allocation.
- [x] (2026-11-05) Bed Map reservations require a target move-in date (today or later) and a RESERVED bed has a
      **Move In** action using the shared Move In flow (§3, §4, §5). `reservation_target_date.sql` is applied before merge;
      **`reservation_target_date_enforce.sql` must be applied after the new frontend is live** (it rejects reserving
      without a date).
- [ ] `finalBill.js` `toCents` (low): an x.xx5 float half is not always rounded up (1.005 -> 1.00, 0.285 -> 0.28; 2.675 -> 2.68 is fine) because
      it multiplies by 100 before rounding. Stored 2-decimal amounts are unaffected; only computed floats are.
- [ ] (2026-11-05) The Occupancy page (`Occupancy.jsx`) takes "today" from the browser's local date (`localISO`), the
      Dashboard Occupancy card from Asia/Manila (`manilaMonthToDateWindow` in `src/lib/occupancyMtd.js`). Outside the
      Philippines, between 00:00 and 08:00 Manila time, their current-month averages can briefly disagree. Follow-up:
      have Occupancy.jsx use `manilaMonthToDateWindow`.
- [ ] (2026-11-06) Billing statement holds ("Print selected") are kept in the browser only (`localStorage`): another staff member
      or another browser does not see them.
- [ ] (2026-11-06) The stay extension has no cap (P500/night, a warning above 7 nights); a long overstay should be a lease extension
      (edit the planned move-out date) instead.
- [ ] (2026-11-06) The pro-rated second-to-last advance credit (§5) changed the live Oct 2026 statements of tenants moving
      out in November (rent due goes up): copies printed before the deploy show the full credit; reprint and hand out
      the new figures. A move-out on day 1-2 of the month gives a tiny credit and a large carry to the final bill (what the formula gives; no minimum credit).
- [ ] (2026-11-06) "Void & re-issue" is per bed: a final bill of a sibling group (several beds, one name) cannot be re-issued yet.

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

## 17. Visitor Log
- **Purpose.** A guard/front-desk log of every visitor: who, contact, email, tenant (or office)
  visited, ID type + a required ID photo, check-in and check-out. Schema and functions:
  `database/migrations/visitor_log.sql` (mirrored in `init.sql` section 8c). Page `/visitors`
  (`src/pages/VisitorLog.jsx`).
- **Roles.** `guard` ("Security / Front desk", one shared account with a real inbox): Visitor Log
  only, mobile-first layout with a bottom tab bar (Check in | Inside (N) | Today) and no sidebar.
  `admin` / `user`: the same front desk inside the normal app (full contact shown) plus History
  with Correct and Void. `viewer`: no access (`/visitors` redirects to `/`) and no visitor data
  anywhere: `activity_log` and `approval_requests` rows with `entity_type = 'VISITOR_LOG'` (overnight
  requests and their decisions, void/correct/purge lines) are readable by admin/user only.
- **Who is on duty.** Because the guard account is shared, a full-screen "Who is on duty?" prompt
  appears after every sign-in (also signing in again on the same device), after 12 hours, and
  after End shift; recent names (max 5) are chips on the device. The name is sent with every
  check-in, check-out and overnight request and stored on the row (`check_in_guard_name`,
  `check_out_guard_name`). Admin/user are recorded under their account email.
- **Check-in.** Required: target (an active tenant from the picker, or Office / delivery / repair
  with a purpose), contact number, full name, email or an explicit "No email", ID type ("Other"
  needs a description) and an uploaded ID photo; optional "Staying overnight" with a reason. The
  ID number is not asked of the guard; admin/user can add it later through Correct. Check-in and
  check-out times are server time (`now()`), never typed. The tenant, room and bed letters are a
  snapshot (a two-bed tenant appears once, e.g. "405 · Bed A/B"), so the log stays right after
  transfers/move-outs. The same name + number cannot be inside twice. A known contact number fills
  name, email and ID type from the latest non-voided visit (never the ID number or photo, never
  over typed fields). One check-in and one photo per person; "Same as last" re-selects the target.
- **ID photo.** Taken with the back camera (file picker on desktop), compressed on the device
  (long edge ≤ 1280 px, JPEG, about 150 KB, ≤ 1 MB; re-encoding strips EXIF/GPS) and uploaded when
  taken to the private `visitor-ids` bucket as `yyyy/mm/<uuid>.jpg`. `visitor_check_in` links it only
  if it exists, was uploaded by the same account in the last 30 minutes, is a JPEG ≤ 1 MB and is not
  used by another visit. Only admins can view photos (2-minute signed URLs); users see "Photo on
  file — visible to admin only"; guards never see a saved photo.
- **90-day retention, no scheduled job.** When an admin opens the Visitor Log (at most every 6
  hours per browser) or presses "Purge old ID photos", photos older than 90 days of visits that are
  checked out or voided, plus unlinked uploads older than 24 hours, are removed through the Storage
  API; a visit is marked `id_photo_purged_at` only once its object is confirmed gone. A visitor
  still inside never loses the photo. Photos can stay past 90 days if no admin opens the page.
- **Overnight rule (Asia/Manila).** The log day / night N runs 06:00 on N to 05:59 on N+1; its
  curfew is 22:00 on N. First curfew of a visit = max(check-in, 22:00 of its log day), so a
  check-in from 22:00 to 05:59 is overnight immediately. A request always targets tonight
  (`visitor_log_day(now())`) and goes through the normal Approvals page and approval emails
  (`entity_type = 'VISITOR_LOG'`, `field_name = 'overnight_visitor'`; one pending per visit). An open
  visit turns RED ("Overnight not approved – must leave") once now ≥ its first curfew and no
  approved night is on or after the last passed night; an approval for night N clears it through
  the next day and it turns red again at 22:00 on N+1. Amber: request pending, or 21:00–21:59 with
  tonight not approved. The guard cannot re-request a night the admin rejected; admin/user can.
  Approve/reject updates the visit atomically in the same UPDATE (`trg_approval_overnight_sync`).
  The app never checks anyone out automatically.
- **Guard data limits.** The guard sees only "Inside now" (every open visit, any day) and today's
  log (since 06:00), with the contact masked to the last 4 digits and the email to first letter +
  domain, no ID number and no photo; voided entries are hidden. The tenant picker returns only
  active tenants' name, room and bed letters.
- **Correct / void (admin, user).** Never delete. Void needs a reason, keeps the row (greyed in
  History, hidden from the front desk) and is final. Correct needs a reason and can change name,
  contact, email/No email, ID type, ID number, visiting and the check-out time (between check-in
  and now, never cleared); the check-in time and photo are never editable. Every correction or
  void writes `visitor_log_edits` (old → new) and a non-PII `activity_log` line. Direct writes to
  `visitor_logs` are impossible (no grants/policies; a trigger rejects anything outside the RPCs
  and every DELETE).
- **On the tenant profile.** Visits also appear read-only on the visited tenant's profile (Visitors tab,
  admin/user only; no ID number or photo), matched through the same-name group in the room and the
  tenant's stay window (§3 "Tenant profile history").
- **PII.** The visitor's contact number, email, ID number, photo and photo path never appear in
  `approval_requests.new_value`, `activity_log` or any email. Check-ins/check-outs are not written to
  `activity_log`; `visitor_logs` is that audit.
