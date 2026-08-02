# Bedspace Manager — Feature Checklist

**Generated:** 2026-07-17  
**Current stack (pilot):** React + Vite + Supabase  
**Target stack (rebuild):** Angular + Spring Boot + PostgreSQL  
**Source of truth:** `detailed.md` · `TECHNICAL_SPECIFICATION.md` · code inspection

Legend: ✅ Done · 🔶 Partial · ❌ Not started · 🔁 Exists in pilot, needs port

---

## 1. Auth & Access Control

| Feature | Pilot status | Notes |
|---|---|---|
| Login / Supabase auth | ✅ Done | `src/lib/auth.jsx` + `Login.jsx` |
| Two-tier roles (admin / owner) | ✅ Done | `isAdmin` flag in `useAuth()` |
| Route protection per role | ✅ Done | `App.jsx` — admin-only routes gated |
| **Three-tier roles (admin / user / viewer)** | ❌ Not started | Spec §1 requires viewer (read-only) as a 3rd tier |
| **Override approval workflow** | ❌ Not started | Spec §2 — protected-field edits by `user` create ApprovalRequest; admin approves/rejects |
| Approval email notifications | ❌ Not started | Spec §2 — email admins on creation, requester on decision |

---

## 2. Tenant Profiles

| Feature | Pilot status | Notes |
|---|---|---|
| Basic tenant record (name, rate, move-in date, bed) | ✅ Done | `addTenant()` in `supabase.js` |
| Move-in modal | ✅ Done | `MoveInModal.jsx` |
| Move-out modal | ✅ Done | `MoveOutModal.jsx` |
| Tenant list with search + filter | ✅ Done | `Tenants.jsx` |
| Tenant detail view (read) | 🔶 Partial | Shows bed/room/rate/dates, not full profile |
| **Structured personal fields** | ❌ Not started | Spec §3.1 — contact numbers[], emails[], permanent address, emergency contact, occupation, employer, employer address, employer contact |
| **Multi-valued contacts & emails** | ❌ Not started | One-to-many per spec §3.1 |
| **Source field (referral / FB / TikTok / etc.)** | ❌ Not started | Spec §3.1 enum — drives move-in source report |
| **Document upload** (Gov't ID, contract, other) | ❌ Not started | Spec §3.2 — pre-signed URL upload to object storage |
| **Profile aggregate view** | ❌ Not started | Spec §3.3 — current bed, lease dates, payment history, open tickets, all in one GET |
| **Protected-field edits via approval** | ❌ Not started | Spec §3.4 — move-out date, rate changes by non-admin go through §2 workflow |

---

## 3. Rooms & Beds

| Feature | Pilot status | Notes |
|---|---|---|
| Bed status lifecycle (VACANT / LEASED / RESERVED / OUT OF ORDER) | ✅ Done | `updateBedStatus()` in `supabase.js` |
| Bed Map visual grid | ✅ Done | `BedMap.jsx` |
| Room type display | ✅ Done | Shown in bed map + billing |
| **Room logs / history** | ✅ Done | Tracked per requirements tracker |
| **Ongoing repair flag** | ✅ Done | Tracked per requirements tracker |
| **Room configuration (admin back-office)** | ✅ Done | Tracked per requirements tracker |
| RESERVED status (hold before move-in) | 🔶 Partial | Status exists, no dedicated reserve flow in UI |

---

## 4. Room Maintenance (Ticketing)

| Feature | Pilot status | Notes |
|---|---|---|
| **Room Maintenance tab / page** | ❌ Not started | Spec §5 — entirely new module |
| **Raise a ticket** (room, concern, remarks, tenant, date, status) | ❌ Not started | Spec §5.1 |
| **Resolve a ticket** (resolution notes, resolved-by, resolved-at) | ❌ Not started | Spec §5.2 |
| **Ticket linked to both room and tenant** | ❌ Not started | Spec §5.3 — surfaces in tenant profile AND room list |
| **Dashboard maintenance tab** (open tickets incl. tenant name) | ❌ Not started | Spec §8 |

---

## 5. Billing & Payments

| Feature | Pilot status | Notes |
|---|---|---|
| Cutoffs (billing periods) | ✅ Done | `Utilities.jsx` + `fetchCutoffs()` |
| Meter readings per room/utility | ✅ Done | `fetchUtilityBill()` |
| **Utility split engine** (segment-based, per-day) | ✅ Done | `billing.js` — fully functional |
| **Move-out interim readings** | ✅ Done | `addInterimReading()`, `RecordReadingModal` in `Billing.jsx` |
| **Add-ons / manual line items** (parking, aircon, other) | ✅ Done | `AddonModal` in `Billing.jsx` |
| Custom split overrides per room/utility | ✅ Done | `SplitModal` in `Billing.jsx` |
| Utility P&L (variance) | ✅ Done | `pnl.js` + dashboard tile |
| Print — Rent + Water bill | ✅ Done | `PrintRentWater.jsx` |
| Print — Electricity bill | ✅ Done | `PrintElectricity.jsx` |
| Per-tenant billing table with totals | ✅ Done | `Billing.jsx` tenants view |
| Per-room reconciliation view | ✅ Done | `Billing.jsx` rooms view |
| Billing report (grand totals summary) | ✅ Done | `Billing.jsx` report view |
| **Record payment** (Rent / Water / Electricity / Other + amount) | 🔶 Partial | `recordPayment()` exists in `supabase.js`, UI in `Tenants.jsx` pay modal — but not exposed in Dashboard Tenant tab as spec requires |
| **Payment history drill-down per tenant** | ❌ Not started | Spec §6.4 — `fetchPayments()` exists but no dedicated history view |
| **Tenant transfer** (old stay → new stay, carry readings) | ❌ Not started | Spec §6.3 — transfer flow not implemented |
| Deposit / advance tracking | ❌ Not started | Fields exist in spec §6.1 `TenantStay` but not in current DB/UI |

---

## 6. Reports & Analytics

| Feature | Pilot status | Notes |
|---|---|---|
| Quarterly snapshot view (P&L + occupancy + collections) | ✅ Done | `Reports.jsx` |
| Manual month entry / backfill | ✅ Done | `ManualReportModal` |
| Auto-snapshot on cutoff open | ✅ Done | `buildAndSaveSnapshot()` in `snapshot.js` |
| Admin snapshot controls (edit / delete) | ✅ Done | `Reports.jsx` |
| **Projected vs actual rent collection** | ❌ Not started | Spec §7 — who has not yet paid, gap analysis |
| **Tenant payment history report** | ❌ Not started | Spec §7 |
| **Upcoming move-outs** (configurable horizon) | 🔶 Partial | Dashboard shows next-30-day widget; no dedicated report page |
| **Move-in source report** (by source enum) | ❌ Not started | Spec §7 — requires source field on tenant first |
| **Beds moving out this month** (count) | ❌ Not started | Spec §7 |
| **Move-ins per month** (count, grouped) | ❌ Not started | Spec §7 |
| **Lease extensions count** | ❌ Not started | Spec §7 — derived from audit log |
| **Month-to-date move-outs projected** | ❌ Not started | Spec §7 |
| **Occupancy rate year-to-date** (bar graph, Jan–current) | ❌ Not started | Spec §7 |
| **Remove "losing" label** (reporting fix) | ❌ Not started | Spec §7 — do not show losing badge when projected < provider bill |

---

## 7. Dashboard

| Feature | Pilot status | Notes |
|---|---|---|
| Bed stats (leased / vacant / reserved / OOR) | ✅ Done | `Dashboard.jsx` |
| Occupancy percentage + bar | ✅ Done | |
| Property summary (by room type, tenants, revenue) | ✅ Done | |
| Upcoming move-outs widget (30 days) | ✅ Done | |
| Recent activity feed | ✅ Done | |
| Utilities P&L tile (active cutoff) | ✅ Done | |
| **"Your Property at a Glance" subheading** | ❌ Not started | Spec §8 — static copy not present |
| **Tenant tab: record payment** | 🔶 Partial | Exists in Tenants page, not surfaced as a Dashboard quick action |
| **Tenant tab: transfer** | ❌ Not started | Spec §8 |
| **Tenant tab: update profile** | ❌ Not started | Spec §8 |
| **Tenant tab: view profile + issues** | ❌ Not started | Spec §8 — aggregate view with tickets |
| **Room maintenance tab** (open tickets incl. tenant name) | ❌ Not started | Spec §8 |
| **Others: manual add-on input** (quick action) | ❌ Not started | Spec §8 |

---

## 8. Activity Log / Audit

| Feature | Pilot status | Notes |
|---|---|---|
| Move-in / Move-out log | ✅ Done | `Activity.jsx` + `logActivity()` in `supabase.js` |
| Search + filter by type | ✅ Done | `Activity.jsx` |
| **System-wide audit trail** (actor, action, entity, before→after, timestamp) | ❌ Not started | Spec §9 — currently only logs move-in/out; no actor, no diff, no entity type |
| **Every mutation logged** (cross-cutting, not just move events) | ❌ Not started | Spec §9 — payments, config changes, approvals, etc. |
| **Move-out date change logging** | ❌ Not started | Spec §9 |
| **Immutable audit entries** (no update/delete) | ❌ Not started | Spec §9 |
| **Viewer sees own actions only** | ❌ Not started | Spec §1 RBAC |

---

## 9. Target Rebuild Phases (Angular + Spring Boot + PostgreSQL)

> Nothing below has started. The current pilot is being used to prove business logic before the rebuild.

| Phase | Scope | Status |
|---|---|---|
| **Phase 0 — Foundations** | OpenAPI contract, DB schema + Flyway migrations, auth/RBAC skeleton, audit log, CI/CD, generated TS client, mock server | ❌ Not started |
| **Phase 1 — Core domain** | Rooms & Beds, Tenant Profiles + documents, Move-in/Move-out, Activity log wired everywhere | ❌ Not started |
| **Phase 2 — Billing** | Cutoffs, meter readings, utility split engine (port from `billing.js`), rent proration, add-ons, payment recording | ❌ Not started |
| **Phase 3 — Operations** | Room Maintenance ticketing, tenant transfer, override-approval workflow | ❌ Not started |
| **Phase 4 — Reporting & Dashboard** | Projected-vs-actual collections, occupancy trends, move-in/out analytics, source reporting, dashboard KPIs + quick actions | ❌ Not started |

---

## 10. Open Questions (from spec §12)

- [ ] Document storage: S3-compatible object storage **vs.** Google Drive API?
- [ ] Email provider for approval notifications: SMTP **vs.** transactional API (e.g. SendGrid)?
- [ ] Tenant self-service portal: later phase or out of scope entirely?
- [ ] Multi-property support: now or single-property only for the pilot?

---

## Summary

| Category | Done | Partial | Not Started |
|---|:-:|:-:|:-:|
| Auth & Access Control | 3 | 0 | 3 |
| Tenant Profiles | 3 | 1 | 6 |
| Rooms & Beds | 5 | 1 | 0 |
| Room Maintenance | 0 | 0 | 5 |
| Billing & Payments | 11 | 1 | 3 |
| Reports & Analytics | 4 | 1 | 8 |
| Dashboard | 6 | 1 | 6 |
| Activity Log / Audit | 2 | 0 | 5 |
| **TOTAL (pilot)** | **34** | **5** | **36** |
