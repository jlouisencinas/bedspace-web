# Bedspace Management System — Detailed Technical Specification

**Version:** 1.0
**Companion to:** [`TECHNICAL_SPECIFICATION.md`](./TECHNICAL_SPECIFICATION.md) (architecture & roadmap overview)
**Source of truth:** Google Sheet "Bedspace System — Requirements Tracker"
(`1v-TvEr8RfuJne3rH_UIpp3YkHOCCFgFZYo-PAV5CADI`)
**Target stack:** Spring Boot (REST API) · Angular (SPA) · PostgreSQL
**Status:** For review

---

## How to read this document

`TECHNICAL_SPECIFICATION.md` is the architecture-level overview (goals, stack,
roadmap). This document is the **field-level, endpoint-level, rule-level**
drill-down for every module in the tracker — written so a backend/frontend
engineer can start building each module without re-deriving requirements from
the spreadsheet. §12 is a full row-by-row traceability matrix back to the
sheet, including current **Priority** and **Status**.

---

## 1. Roles & Permission Matrix

| Action | viewer | user | admin |
|---|:-:|:-:|:-:|
| View tenants, rooms, beds, bills, reports | ✅ | ✅ | ✅ |
| Record payment | ❌ | ✅ | ✅ |
| Raise / resolve maintenance ticket | ❌ | ✅ | ✅ |
| Edit tenant profile (non-protected fields) | ❌ | ✅ | ✅ |
| Edit protected fields (move-out date, rate, back-dated edits) | ❌ | Requires approval | ✅ direct |
| Room configuration (bed count, rates, layout) | ❌ | ❌ | ✅ |
| Approve/reject override requests | ❌ | ❌ | ✅ |
| Manage users/roles | ❌ | ❌ | ✅ |
| View activity log / audit trail | ❌ | ✅ (own actions) | ✅ (all) |

**Protected fields** (require the override-approval workflow when edited by a
`user`): tenant move-out date, bed/room rate, any back-dated edit (payment
dated in a closed cutoff, lease date in the past), deposit/advance amount.

---

## 2. Override Approval Workflow — detailed

**State machine:** `PENDING → APPROVED` or `PENDING → REJECTED`. No other
transitions; once decided, an `ApprovalRequest` is immutable.

**Trigger:** a `user` (not `admin`) attempts to write a protected field.
Instead of persisting the change, the API creates an `ApprovalRequest` in
`PENDING` state and returns `202 Accepted` with the request id. The
underlying entity is **not** mutated until approval.

**Fields captured:**

| Field | Type | Notes |
|---|---|---|
| `id` | UUID | |
| `requester_id` | FK → User | who proposed the change |
| `entity_type` | enum | `TENANT`, `TENANT_STAY`, `BED`, `ROOM`, `PAYMENT` |
| `entity_id` | UUID | target record |
| `field_name` | string | e.g. `move_out_date` |
| `old_value` | text/jsonb | snapshot at request time |
| `new_value` | text/jsonb | proposed value |
| `reason` | text | required, free text from requester |
| `status` | enum | `PENDING` / `APPROVED` / `REJECTED` |
| `decision_maker_id` | FK → User, nullable | admin who decided |
| `decision_notes` | text, nullable | |
| `created_at` | timestamp | |
| `decided_at` | timestamp, nullable | |

**Notification:** on creation, email all active `admin` users (§11 open
question: SMTP vs transactional API). On decision, email the requester.

**On approval:** service applies `new_value` to the target entity inside the
same transaction that marks the request `APPROVED`, and writes an
`AuditEntry` referencing the `ApprovalRequest` id.

**On rejection:** no mutation to the target entity; `AuditEntry` still
recorded (decision itself is an audited event).

**API:**
- `POST /api/v1/approval-requests` — created implicitly by the failing write
  (backend returns `202` + `Location` header to the request), not called
  directly by the client.
- `GET /api/v1/approval-requests?status=PENDING` — admin inbox.
- `POST /api/v1/approval-requests/{id}/approve` `{ decisionNotes }` — admin only.
- `POST /api/v1/approval-requests/{id}/reject` `{ decisionNotes }` — admin only.

---

## 3. Tenant Profiles — detailed

### 3.1 Fields

| Field | Type | Cardinality | Notes |
|---|---|---|---|
| `full_name` | string | 1 | required |
| `contact_numbers` | string[] | 1..n | one-to-many, one marked `primary` |
| `emails` | string[] | 0..n | one-to-many, one marked `primary` |
| `permanent_address` | text | 1 | required |
| `emergency_contact_name` | string | 1 | required |
| `emergency_contact_number` | string | 1 | required |
| `occupation` | string | 0..1 | |
| `employer` | string | 0..1 | |
| `employer_address` | text | 0..1 | |
| `employer_contact_number` | string | 0..1 | |
| `source` | enum | 1 | `REFERRAL` \| `FACEBOOK` \| `TIKTOK` \| `INSTAGRAM` \| `WALK_IN` |

### 3.2 Documents

| Field | Type | Notes |
|---|---|---|
| `doc_type` | enum | `GOVT_ID`, `SIGNED_CONTRACT`, `OTHER` |
| `filename` | string | original filename |
| `storage_ref` | string | S3 key or Google Drive file id |
| `size_bytes` | long | |
| `uploaded_by` | FK → User | |
| `uploaded_at` | timestamp | |

Upload flow: client requests a pre-signed upload URL (S3) or uses the Drive
API upload flow → uploads directly → confirms with backend to persist
metadata row. Download/view uses signed, time-limited URLs (§10 non-functional).

### 3.3 Profile aggregate view

`GET /api/v1/tenants/{id}/profile` returns a composed DTO:
- Core tenant fields (§3.1)
- Current `bed`/`room` (from active `TenantStay`)
- Lease dates (move-in, current move-out/expected)
- Payment history summary (last N payments; link to full history endpoint)
- Open + resolved maintenance tickets raised by this tenant

### 3.4 Edit rules

- Non-protected fields (contact info, employer info, source): `user` can
  edit directly; change is still logged to `AuditEntry`.
- Protected fields on the tenant/stay (move-out date, rate): routes through
  §2 approval workflow when actor role is `user`; `admin` edits directly
  (still audited).

---

## 4. Rooms & Beds — detailed

### 4.1 Entities

**Room:** `room_no` (unique), `floor`, `type`, `has_ongoing_repair` (bool,
derived from open `RoomLog` repair entries or maintained directly).

**Bed:** `room_id`, `label` (e.g. "A", "B"), `default_rate`, `status`.

**Bed status lifecycle:**

```
VACANT ──lease──▶ LEASED ──move-out──▶ VACANT
VACANT ──hold───▶ RESERVED ──lease──▶ LEASED
  any  ──flag────▶ OUT_OF_ORDER ──repair done──▶ VACANT
```

Only `admin` can force a transition into/out of `OUT_OF_ORDER` outside the
normal lease flow; all transitions write a `RoomLog` entry.

### 4.2 Room logs / history

| Field | Type | Notes |
|---|---|---|
| `room_id` | FK | |
| `event_type` | enum | `REPAIR`, `CONFIG_CHANGE`, `STATUS_CHANGE` |
| `description` | text | e.g. "clogged toilet", "sink drain" |
| `created_by` | FK → User | |
| `created_at` | timestamp | |

`GET /api/v1/rooms/{id}/logs` — paginated history, filterable by `event_type`.

### 4.3 Room configuration (admin/back-office)

`PUT /api/v1/rooms/{id}/configuration` — admin only; body: bed count/labels,
per-bed default rate, layout notes. Each change:
1. Writes a `CONFIG_CHANGE` `RoomLog` entry with before/after snapshot.
2. Writes an `AuditEntry`.
3. Is **versioned** — prior configuration is retrievable via the log, not
   overwritten destructively.

---

## 5. Room Maintenance (Ticketing) — detailed

### 5.1 Ticket fields

| Field | Type | Notes |
|---|---|---|
| `room_id` | FK | required |
| `tenant_id` | FK, nullable | tenant who raised it (nullable if staff-raised) |
| `concern` | string | required, e.g. "aircon leak" |
| `remarks` | text | optional free text at creation |
| `status` | enum | `PENDING` \| `RESOLVED` |
| `raised_at` | timestamp | defaults to now |
| `resolution_notes` | text, nullable | filled on resolve |
| `resolved_by` | FK → User, nullable | |
| `resolved_at` | timestamp, nullable | |

Display convention (per tracker example): `702 — aircon leak (date) —
raised by: <tenant>`.

### 5.2 Endpoints

- `POST /api/v1/maintenance-tickets` — `user`/`admin`.
- `GET /api/v1/maintenance-tickets?status=&room_id=&tenant_id=` — filterable list.
- `POST /api/v1/maintenance-tickets/{id}/resolve` `{ resolutionNotes }` —
  sets `status=RESOLVED`, `resolved_by`, `resolved_at`.

### 5.3 Surfacing

- Tenant profile (§3.3) — tickets where `tenant_id = tenant`.
- Room maintenance list (module home) — all tickets, filterable by room/status.
- Dashboard maintenance tab (§8) — open tickets incl. tenant name.

---

## 6. Billing & Payments — detailed

*(Ports the existing engine — see `src/lib/billing.js`, `src/lib/pnl.js` in
the current pilot for reference logic to carry over.)*

### 6.1 Core entities

| Entity | Key fields |
|---|---|
| `Cutoff` | `period_start`, `period_end`, `status` (`OPEN`/`CLOSED`) |
| `MeterReading` | `cutoff_id`, `room_id`, `utility_type` (`WATER`/`ELECTRICITY`), `previous_reading`, `current_reading`, `consumption`, `rate`, `amount` |
| `InterimReading` | `room_id`, `reading_date`, `reading_value`, `reason` (`MOVE_IN`/`MOVE_OUT`/`TRANSFER`), `tenant_stay_id` — slices a cutoff period at the exact day of the event |
| `Addon` | `tenant_stay_id`, `cutoff_id`, `label` (e.g. "car parking rent"), `amount`, `created_by` |
| `Payment` | `tenant_id`, `tenant_stay_id`, `cutoff_id` (nullable), `type` (`RENT`/`WATER`/`ELECTRICITY`/`OTHER`), `amount`, `paid_at`, `recorded_by`, `notes` |
| `TenantStay` | `tenant_id`, `bed_id`, `room_id`, `move_in_date`, `move_out_date` (nullable), `rate_at_movein`, `deposit_amount`, `advance_amount`, `status`, `transfer_from_stay_id` (nullable) |

### 6.2 Utility split engine (segment-based, per-day)

- A cutoff period is divided into **segments** bounded by any interim event
  (move-in/out/transfer) affecting the room.
- Each segment's utility cost = `consumption_in_segment × rate`, where
  `consumption_in_segment` is apportioned by **day-count within the segment**
  relative to the full period (equal per-day split among tenants present in
  that segment).
- Segments must **reconcile exactly** to the cutoff's total metered
  consumption (no rounding drift left unaccounted — reconciliation check is
  a required test case, not just a UI nicety).

### 6.3 Move-in / Move-out / Transfer

- **Move-in:** creates `TenantStay`, sets bed → `LEASED`, records an
  `InterimReading` (`MOVE_IN`) if mid-cutoff.
- **Move-out:** closes `TenantStay` (`move_out_date` set, `status=ENDED`),
  bed → `VACANT`, records `InterimReading` (`MOVE_OUT`) if mid-cutoff.
  Move-out date changes on an *existing* stay are a protected field (§2, §7).
- **Transfer:** ends the old `TenantStay` (`status=TRANSFERRED`), creates a
  new `TenantStay` in the destination room/bed with
  `transfer_from_stay_id` pointing back, and carries the **previous room's
  final reading together with the new room's opening reading** so utility
  accounting is continuous across the move (no gap, no double-count).

### 6.4 Payments & add-ons

- `POST /api/v1/tenants/{id}/payments` — records Rent/Water/Electricity/Other
  + amount against the tenant's active stay.
- `POST /api/v1/cutoffs/{id}/addons` — manual line item (e.g. car parking
  rent) tied to a tenant stay + cutoff.
- `GET /api/v1/tenants/{id}/payments` — drill-down payment history,
  paginated.

---

## 7. Reports & Analytics — detailed

| Report | Definition | Data source |
|---|---|---|
| Projected vs. actual rent collection | `projected = Σ expected rent for active stays in period`; `actual = Σ Payment(type=RENT) in period`; also lists tenants with `actual < projected` (not yet paid) | `TenantStay`, `Payment` |
| "Losing" label removal | Reporting fix: **do not** render a "losing" badge purely because `projected < provider's bill` — that comparison is not a loss indicator on its own | Reporting layer only, no new data |
| Tenant payment history | Same as §6.4 drill-down, exposed as a report view | `Payment` |
| Upcoming move-outs | `TenantStay` where `move_out_date` is set and within a configurable horizon (default: next 30 days) | `TenantStay` |
| Move-in source | Count of tenants per `source` enum, filterable by date range | `Tenant.source` |
| Beds moving out this month | Count of `TenantStay` with `move_out_date` in current calendar month | `TenantStay` |
| Move-ins per month | Count of `TenantStay.move_in_date` grouped by month | `TenantStay` |
| Lease extensions | Count of `AuditEntry` where `entity_type=TENANT_STAY` and `field=move_out_date` and action is an extension (new date later than old) | `AuditEntry` |
| Month-to-date move-outs (projected) | Count of `TenantStay` with `move_out_date` between month start and today | `TenantStay` |
| Occupancy rate YTD | Per month: `leased_beds / total_beds`, rendered as a bar graph, Jan–current month | `Bed`, `TenantStay` |

All report endpoints live under `/api/v1/reports/*`, accept `from`/`to` query
params where applicable, and return data shaped for direct chart consumption
(no client-side aggregation).

---

## 8. Dashboard — detailed

- **Heading/Subheading:** "Dashboard" / "Your Property at a Glance" (static copy).
- **Tenant tab:**
  - Record payment (Rent/Water/Electricity/Other + amount) → calls §6.4 endpoint.
  - Transfer → calls §6.3 transfer flow.
  - Update profile → calls §3 tenant update (protected fields go through §2).
  - View profile + issues → calls §3.3 aggregate view (includes §5 tickets).
- **Room maintenance tab:** open tickets list including tenant name — reuses
  §5.2 `GET /api/v1/maintenance-tickets?status=PENDING`.
- **Others (manual item input):** same as §6.4 add-ons, surfaced as a quick
  action.
- KPI cards pull from §7 report endpoints (occupancy, collections gap, open
  tickets count).

---

## 9. Activity Log / Audit — detailed

| Field | Type | Notes |
|---|---|---|
| `actor_id` | FK → User | |
| `action` | enum | `CREATE`/`UPDATE`/`DELETE`/`APPROVE`/`REJECT`/`LOGIN` |
| `entity_type` | string | table/aggregate name |
| `entity_id` | UUID | |
| `diff` | jsonb | `{ before: {...}, after: {...} }` |
| `timestamp` | timestamp | |

- Written by a cross-cutting service (e.g. Spring AOP aspect or explicit
  service-layer call) — **not** scattered per-controller, so no mutation path
  can skip it.
- Immutable: no update/delete endpoint for `AuditEntry`; retention policy TBD.
- Powers: lease-extension counts (§7), move-out date change history (§3.4,
  §6.3), and the override-approval trail (§2).
- `GET /api/v1/audit?entity_type=&entity_id=&actor_id=&from=&to=` — paginated,
  `admin` only (viewer sees own actions only per §1 matrix).

---

## 10. Non-Functional Notes (supplementing §11 of the overview doc)

- Document URLs (§3.2) are always time-limited signed URLs, never public.
- All list endpoints are paginated by default (`page`, `size`, max `size=100`).
- Money fields use a fixed-point/decimal type end-to-end (never float) to
  keep the utility-split reconciliation (§6.2) exact.
- Dates are stored as `DATE` (not `TIMESTAMP`) for lease/move-in/move-out to
  avoid timezone-shift bugs in day-count proration.

---

## 11. Open Items Carried From Overview Doc

See `TECHNICAL_SPECIFICATION.md` §12 — document storage target, email
provider, tenant self-service portal timing, multi-property support. None of
these block Phase 0/1 design.

---

## 12. Traceability Matrix (source: Requirements Tracker sheet)

| Module | Function / Feature | Priority | Status |
|---|---|---|---|
| Auth & Access Control | Login / JWT authentication | High | DONE |
| Auth & Access Control | Roles: admin / user / viewer | High | DONE |
| Auth & Access Control | Override approval workflow | High | DONE |
| Tenant Profiles | Upload tenant documents | High | Not Started |
| Tenant Profiles | Personal required fields | High | Not Started |
| Tenant Profiles | Source field (how they found us) | Medium | Not Started |
| Tenant Profiles | Profile aggregates view | Medium | Not Started |
| Tenant Profiles | Protected-field edits via approval | Medium | Not Started |
| Rooms & Beds | Room logs / history | High | DONE |
| Rooms & Beds | Ongoing repair flag | Medium | DONE |
| Rooms & Beds | Room configuration (back office) | Medium | DONE |
| Rooms & Beds | Bed status lifecycle | High | DONE |
| Room Maintenance | New 'Room Maintenance' tab | High | Not Started |
| Room Maintenance | Ticket fields | High | Not Started |
| Room Maintenance | Resolve ticket | High | Not Started |
| Room Maintenance | Link ticket to tenant & room | Medium | Not Started |
| Billing & Payments | Record payment | High | Not Started |
| Billing & Payments | Manual add-ons / line items | Medium | Not Started |
| Billing & Payments | Payment history drill-down | High | Not Started |
| Billing & Payments | Utility split engine | High | Existing (port) |
| Billing & Payments | Move-in / Move-out / Transfer | High | Existing (port) |
| Reports & Analytics | Projected vs actual rent collection | High | Not Started |
| Reports & Analytics | Remove 'losing' label | Low | Not Started |
| Reports & Analytics | Tenant payment history report | Medium | Not Started |
| Reports & Analytics | Upcoming move-outs | Medium | Not Started |
| Reports & Analytics | Move-in source report | Medium | Not Started |
| Reports & Analytics | Beds moving out this month | Medium | Not Started |
| Reports & Analytics | Move-ins per month | Medium | Not Started |
| Reports & Analytics | Lease extensions count | Medium | Not Started |
| Reports & Analytics | Month-to-date move-outs (projected) | Low | Not Started |
| Reports & Analytics | Occupancy rate year-to-date | Medium | Not Started |
| Dashboard | Heading & subheading | Low | Not Started |
| Dashboard | Tenant tab - record payment | High | Not Started |
| Dashboard | Tenant tab - transfer | Medium | Not Started |
| Dashboard | Tenant tab - update profile | Medium | Not Started |
| Dashboard | Tenant tab - view profile + issues | Medium | Not Started |
| Dashboard | Room maintenance tab | Medium | Not Started |
| Dashboard | Others - manual item input | Medium | Not Started |
| Activity Log / Audit | System-wide audit trail | High | Not Started |
| Activity Log / Audit | Move-out date change logging | Medium | Not Started |

**Reading the matrix against the roadmap:** everything marked `DONE` here
reflects the *current pilot's* behavior (React/Supabase), not the target
Spring Boot/Angular rebuild — those modules still need to be re-implemented
in the new stack per `TECHNICAL_SPECIFICATION.md` §7 Phase 1, even though
functionally proven. `Existing (port)` items (billing engine) are the ones
whose *business logic* carries over as-is and only need re-platforming.
