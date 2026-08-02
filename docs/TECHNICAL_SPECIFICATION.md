# Bedspace Management System — Technical Specification

**Version:** 0.1 (draft)
**Target stack:** Spring Boot (REST API) · Angular (SPA) · PostgreSQL
**Status:** For review
**Supersedes:** the current React + Vite + Supabase pilot

---

## 1. Purpose & Scope

This document specifies the requirements for rebuilding the Bedspace Management
System as a conventional 3-tier web application: an **Angular** single-page
frontend talking to a **Spring Boot** REST backend over a versioned HTTP API,
persisting to **PostgreSQL**.

It captures the functional requirements gathered for the next iteration
(tenant profiles & documents, room maintenance/ticketing, richer reporting,
a redesigned dashboard, and role-based access with an approval workflow) and
defines the architecture, data model, API conventions, and a phased build plan.

The accompanying tracker (Google Sheet "Bedspace System — Requirements Tracker")
holds the same scope as a per-module checklist (Module · Function · Details ·
Remarks · Status).

For field-level entity definitions, the override-approval state machine, the
utility-split engine's segment logic, per-module API endpoints, and a full
row-by-row traceability matrix back to the tracker, see the companion
[`detailed.md`](./detailed.md).

---

## 2. Goals & Non-Goals

**Goals**
- Clean separation of frontend and backend behind a documented API.
- Preserve the proven billing engine (segment-based per-day utility split,
  prorated rent, move-in/move-out, transfers) — see §8.5.
- Add: structured tenant profiles + document storage, room maintenance
  ticketing, override approval workflow, and expanded reporting.
- Strong audit trail (every state change is logged).

**Non-Goals (this phase)**
- Tenant-facing self-service portal (internal staff tool only).
- Online payment gateway integration (record payments manually for now).
- Native mobile apps (responsive web is sufficient).

---

## 3. Recommended Methodology — **API-First (Contract-First)**

**Yes — go API-first.** With Spring Boot + Angular, an OpenAPI contract is the
single source of truth that both sides build against in parallel, instead of the
frontend waiting on the backend.

**Why it fits here**
- One **OpenAPI 3.1** spec generates the **Angular TypeScript client**
  (`openapi-generator`) and the **Spring server interfaces**
  (`springdoc` / `openapi-generator` server stubs) — no hand-written, drifting
  DTOs on either side.
- Frontend can develop against a **mock server** (Prism/Stoplight) from day one.
- The contract doubles as living documentation and the basis for contract tests.

**Ideal step sequence**
1. **Domain & data model** — agree entities, relationships, lifecycle (§9).
2. **API contract** — author `openapi.yaml`: resources, DTOs, error model,
   pagination, auth scheme. Review before any code.
3. **Scaffold** — generate server stubs (Spring) + typed client (Angular).
   Stand up a mock server for the frontend.
4. **Vertical slices per module** — implement one module end-to-end
   (DB migration → repository → service → controller → Angular feature) behind
   the contract, module by module (see roadmap §7).
5. **Cross-cutting concerns** — auth/RBAC, audit log, approval workflow,
   validation, error handling — wired in early (Phase 1), not bolted on.
6. **Contract & integration tests** — verify implementation matches the spec.
7. **Reporting & dashboard** last, since they read from the now-stable modules.

---

## 4. Technology Stack

| Layer | Choice | Notes |
|---|---|---|
| Frontend | Angular 17+ (standalone components, signals), Angular Material | Generated API client from OpenAPI |
| Backend | Spring Boot 3.x (Java 21), Spring Web, Spring Security, Spring Data JPA, Validation | |
| API docs | springdoc-openapi | Serves Swagger UI from the same contract |
| DB | PostgreSQL 15+ | Flyway/Liquibase for migrations |
| Auth | JWT (access + refresh), Spring Security; or Keycloak if SSO later | RBAC: admin / user / viewer |
| File storage | Object storage (S3-compatible) or Google Drive API | Tenant documents (§8.2) |
| Build/CI | Maven/Gradle, GitHub Actions; Docker images | |
| Hosting | Backend container + managed Postgres; Angular static hosting/CDN | |

---

## 5. High-Level Architecture

```
Angular SPA  ──HTTPS/JSON──▶  Spring Boot API  ──JPA──▶  PostgreSQL
   │                              │
   │                              ├─▶ Object storage (documents)
   │                              ├─▶ Mail service (approval emails)
   └─ generated TS client         └─▶ Audit log (every mutation)
```

- **Layered backend:** Controller (DTO + validation) → Service (business rules,
  transactions) → Repository (JPA) → Entity.
- **Stateless API**, JWT bearer auth, method-level `@PreAuthorize` for RBAC.
- **Audit & approval** implemented as cross-cutting services invoked by domain
  services (not scattered in controllers).

---

## 6. Modules (overview)

1. **Auth & Access Control** — login, JWT, roles (admin/user/viewer),
   override-approval workflow.
2. **Tenant Profiles** — personal/employer/source fields, documents, history.
3. **Rooms & Beds** — layout, configuration, room logs.
4. **Room Maintenance** — ticketing for concerns/repairs.
5. **Billing & Payments** — cutoffs, meter readings, utility split, rent,
   move-in/out/transfer, payment recording.
6. **Reports & Analytics** — collections, occupancy, move-in/out, sources.
7. **Dashboard** — at-a-glance KPIs + quick actions.
8. **Activity Log / Audit** — system-wide change history.

---

## 7. Build Roadmap (phased)

**Phase 0 — Foundations**
OpenAPI contract, DB schema + migrations, auth/RBAC skeleton, audit log,
CI/CD, generated clients, mock server.

**Phase 1 — Core domain**
Rooms & Beds, Tenant Profiles (+ documents), Move-in/Move-out. Activity log
wired to every change.

**Phase 2 — Billing**
Cutoffs, meter readings, utility split engine, rent proration, add-ons,
payment recording, invoices/statements (port existing engine logic).

**Phase 3 — Operations**
Room Maintenance ticketing, tenant transfer, override-approval workflow.

**Phase 4 — Reporting & Dashboard**
Projected-vs-actual collections, occupancy trends, move-in/out analytics,
source reporting, dashboard KPIs + quick actions.

---

## 8. Module Specifications (functional requirements)

### 8.1 Auth & Access Control
- **Roles:** `admin`, `user`, `viewer`.
  - *viewer* — read-only across modules.
  - *user* — day-to-day operations (record payments, raise tickets, edit
    permitted tenant fields).
  - *admin* — full control incl. room configuration, rates, approvals.
- **Override approval workflow:** sensitive changes performed by a *user*
  (e.g. **change of move-out date**, rate change, back-dated edits) create an
  **Approval Request** that emails admins; the change only applies once an admin
  approves. Each request records requester, target entity, old→new value,
  reason, decision, decision-maker, timestamps. (Backed by the audit log.)
- All authentication and override events are audited.

### 8.2 Tenant Profiles
- **Document upload** per tenant (Gov't IDs, signed contract, etc.); store in
  object storage with metadata (type, filename, size, uploaded-by, date).
- **Required fields:**
  - *Personal:* Name, Contact Number(s), Email(s), Permanent Address,
    Emergency Contact, Occupation, Employer, Employer Address,
    Employer Contact Number.
  - *Source (how they found us):* Referral, Facebook, TikTok, Instagram,
    Walk-In. (Enum — drives the move-in source report, §8.6.)
- Multi-valued fields (numbers/emails) supported (one-to-many).
- Profile view aggregates: current bed/room, lease dates, **payment history**
  (§8.5), and **maintenance concerns the tenant raised** (§8.4).
- Profile edits by *user* on protected fields route through the approval
  workflow (§8.1); each edit is logged.

### 8.3 Rooms & Beds
- **Room logs / history:** every room keeps a history of events — e.g. repairs
  (clogged toilet, sink drain), configuration changes, status changes — with a
  flag for **currently-ongoing repair needed**.
- **Room configuration (admin/back-office):** bed configuration, change of rate,
  number of tenants/beds per room. Changes are versioned and logged.
- Bed status lifecycle: VACANT / LEASED / RESERVED / OUT OF ORDER.

### 8.4 Room Maintenance (Ticketing) — *new tab*
- A **ticket** captures: Room number, Concern, Remarks, **Tenant who raised it**,
  Date raised, Status (Pending / Resolved).
  - Example: `702 — aircon leak (date) — raised by: <tenant>`.
- **Resolve** action: add Resolution details (remarks), set status → Resolved,
  capture resolved-by + resolved date.
- Tickets are linked to both **room** and **tenant** so they surface:
  - in the **tenant profile** (concerns raised by that tenant), and
  - in a **room maintenance list** (all open/closed issues per room).
- Feeds the Dashboard maintenance tab (§8.7) including tenant name per concern.

### 8.5 Billing & Payments *(port the existing engine)*
- **Cutoffs** (billing periods) with per-utility windows + bedspace rates.
- **Meter readings** per room/utility (consumption & amount derived).
- **Utility split** — segment-based per-day equal split among tenants present;
  interim readings slice the period at move-in/out; reconciles exactly.
- **Rent** — prorated by days present; **deposits/advances** tracked.
- **Move-in / Move-out / Transfer** lifecycle (transfer accounts for the
  previous room's reading together with the new room — see the lifecycle doc).
- **Record payment** against a tenant: type = Rent, Water, Electricity, Other
  (with amount); manual line items (e.g. **car parking rent**) via add-ons.
- **Payment history** drill-down per tenant.

### 8.6 Reports & Analytics
- **Projected vs. Actual rent collection** — show projected collectible vs.
  actually collected, and **who has not yet paid**, so the gap on the property
  summary is explainable. (Requires the payment-collection tracking in §8.5.)
- Remove the **"losing"** label when projected collection is less than the
  provider's bill (reporting/labeling fix).
- **Tenant payment history** drill-down (payment tab).
- **Upcoming move-outs** tab.
- **Move-in source** report (from §8.2 source field).
- **# of beds moving out this month**; **# of move-ins per month**.
- **# of lease extensions** — every change to a move-out date is recorded in the
  activity log and counted here.
- **Month-to-date move-outs** (projected).
- **Occupancy rate, year-to-date** (bar graph).

### 8.7 Dashboard
- **Heading:** "Dashboard" · **Subheading:** "Your Property at a Glance".
- **Tenant tab:** record payment (Rent / Water / Electricity / Other + amount);
  tenant **transfer**; update tenant profile info; **view tenant profile**
  including raised issues/concerns.
- **Room maintenance tab:** list concerns/issues **including tenant name**.
- **Others:** manual add-on input — staff enter the item per the bill
  (e.g. car parking rent) with amount.
- KPI summary cards sourced from the Reports module (§8.6).

### 8.8 Activity Log / Audit (cross-cutting)
- Every create/update/delete and every approval decision is recorded with:
  actor, action, entity, before→after, timestamp.
- Specifically powers: lease-extension counts, move-in/out history, and the
  override-approval trail.

---

## 9. Domain Data Model (entities)

Core (carried from the current schema, normalized for JPA):

- **Room** (room_no, type, floor) → **Bed** (letter, location, default_rate,
  status).
- **Tenant** (personal + employer fields, source enum, lease dates, deposits)
  → **TenantDocument** (type, storage ref, metadata).
- **TenantContact** / **TenantEmail** (one-to-many multi-values).
- **TenantStay** (occupancy period per room/bed — supports transfer history).
- **Cutoff**, **MeterReading**, **InterimReading**, **Addon**, **Payment**,
  **Invoice/Statement**.
- **MaintenanceTicket** (room, tenant, concern, remarks, status, resolution,
  dates).
- **RoomLog** (room event history).
- **ApprovalRequest** (entity ref, field, old→new, reason, status, decision).
- **AuditEntry** (actor, action, entity, diff, timestamp).
- **User / Role** (auth).

A detailed ERD and field list is maintained alongside the OpenAPI contract.

---

## 10. API Design Conventions

- **REST resources**, plural nouns: `/api/v1/tenants`, `/api/v1/rooms/{id}/logs`,
  `/api/v1/maintenance-tickets`, `/api/v1/cutoffs/{id}/readings`, etc.
- **Versioned** under `/api/v1`.
- **DTOs** separate from entities; request validation via Bean Validation.
- **Pagination/sorting/filtering**: `?page=&size=&sort=&...` with a standard
  page envelope.
- **Consistent error model**: `{ timestamp, status, code, message, details[] }`.
- **OpenAPI 3.1** is the contract of record; clients/stubs generated from it.
- **Auth**: `Authorization: Bearer <JWT>`; RBAC enforced per endpoint.

---

## 11. Non-Functional Requirements

- **Security:** JWT auth, RBAC, server-side authorization on every endpoint,
  signed document URLs, secrets via env/secret manager (never in code).
- **Auditability:** immutable audit log; approval workflow for sensitive edits.
- **Reliability:** DB migrations versioned (Flyway); transactional services.
- **Performance:** indexed queries for reports; pagination on all list APIs.
- **Maintainability:** contract-first, generated clients, layered architecture,
  module-per-feature.
- **Observability:** structured logging, health/readiness endpoints, metrics.

---

## 12. Open Questions

- Document storage target: S3-compatible vs. continue with Google Drive API?
- Email provider for approval notifications (SMTP vs. transactional API)?
- Is a tenant self-service portal in a later phase (affects auth design)?
- Multi-property support now or single-property for the pilot?

---

*Companion documents:* [`detailed.md`](./detailed.md) (field-level spec,
API endpoints, and full traceability matrix), the billing lifecycle doc
(move-in/out/transfer), and the Requirements Tracker (Google Sheet) for
per-module status.
```
