---
name: occupancy-dashboard
description: bedspace-web day-weighted occupancy, monthly snapshots, Reports, the Occupancy page/simulator and Dashboard KPI drill-downs. Load before changing Dashboard.jsx, Occupancy.jsx, OccupancySimulator.jsx, Reports.jsx, DrillDownModal, snapshot.js or _shared/occupancy.ts.
---

# Occupancy, snapshots & Dashboard (bedspace-web)

Full rules: `docs/requirements.md` §9 (reporting/occupancy), §10 (Dashboard), §16 (Occupancy Simulator).

- `supabase/functions/_shared/occupancy.ts` is the single pure formula module (`computeDailyOccupancy()`), imported unmodified by `src/lib/snapshot.js`, `src/pages/Dashboard.jsx` and `src/pages/Occupancy.jsx` (same `_shared/` → `src/` cross-runtime import precedent as `PROFILE_FIELD_LABELS` in `src/lib/supabase.js`).
- `Occupancy.jsx` is the per-month daily-weighted occupancy module, all roles.
- Snapshots are captured on cutoff-open (`src/pages/Utilities.jsx`, one combined water+electric "Open Cutoff" action; no separate per-utility flow) and via the manual "Snapshot now" / admin-only "Recompute occupancy %" buttons on Reports. **Not** a scheduled job (pg_cron/pg_net was considered and rejected).
- Snapshot timing never affects a live Dashboard number (those read live `beds`/`tenants`); only the historical "Occupancy Rate YTD" chart depends on `monthly_reports` snapshots.
- Dashboard drill-downs: all 8 KPI tiles (plus the Occupancy card's "Month detail" link) open the shared `src/components/DrillDownModal.jsx` (table shape with search/row-cap/footer-link, or list shape reusing `.upcoming-item`), built from data already in `Dashboard.jsx` memory, no new fetches.
- Row clicks pass `location.state.{openTenantId}` to `/current-tenants` (drill-downs whose rows are in-house tenants) or to `/tenants` (drill-downs whose rows may be moved-out tenants; see the `navigate(` calls in `Dashboard.jsx`); both auto-open `TenantProfileModal` from an unfiltered tenant list. Or `location.state.{tab, focusRoomId}` to `/property` (Bed Rates tab, scroll/expand that room). Row-click and footer navigation are gated on `canAct` (`isAdmin || isUser`).
- Occupancy Simulator (`OccupancySimulator.jsx`, `sim_rooms`/`sim_beds`, `src/lib/simCsv.js`) is an isolated what-if module (§16): keep it separate from live beds/tenants.
- Six old inactive tenant rows flagged by the old Dashboard data check have real dates: don't change them.
