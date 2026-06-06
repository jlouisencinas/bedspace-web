# Utilities (Water + Electric) Tracking — Plan

## The problem with the current sheet
Each cutoff is a hand-built block of columns with formulas copied per row. Previous
readings are re-typed, rates live inside formulas, and adding a new cutoff means
rebuilding the layout. Easy to break, hard to audit historically.

## The model (2 tables, 4 helpers)

```
cutoffs          ← one row per billing period (date windows + rates)
meter_readings   ← one row per room × cutoff × utility
                   consumption & amount are GENERATED (never typed)

v_latest_reading   ← each room's most recent reading (carry-forward source)
v_utility_bill     ← per-cutoff sheet: room | water block | electric block | total
v_cutoff_summary   ← totals per cutoff per utility
open_cutoff(...)   ← creates a cutoff + auto-seeds carried-forward readings
```

### Why this design fits your requirements
| Requirement | How it's handled |
|---|---|
| Water 1st→1st, Electric 10th→10th | Separate `water_start/end` and `electric_start/end` columns on `cutoffs` |
| Rates highly customizable | `water_rate`, `water_rate_studio`, `electric_rate` per cutoff — editable anytime |
| Studio higher water rate | `open_cutoff` snapshots `water_rate_studio` for rooms where `room_type ILIKE 'Studio%'` |
| No manual formulas | `consumption = current − previous`, `amount = consumption × rate` are GENERATED columns |
| Don't re-type previous readings | `open_cutoff` carries each room's last `current_reading` into the new `previous_reading` |
| Historical accuracy | `rate` is snapshotted per reading, so editing a future rate never rewrites past bills |
| F-flag (column F) | Ignored — confirmed it's just a counter from NEW_RAW_DATA |

## Monthly workflow (once UI is built)
1. **Open the cutoff** — call `open_cutoff('Jun 2026', '2026-06-01','2026-07-01', '2026-06-10','2026-07-10', 140.62,154.68,14.47)`.
   This creates the period and pre-fills every room's previous reading + rate.
2. **Enter current readings** — staff type only the new meter number per room.
   Consumption and amount appear instantly.
3. **Review totals** — `v_cutoff_summary` shows total m³ / kWh and pesos per utility.
4. **Bill** — `v_utility_bill` is the per-room billing sheet, same shape as today's tab.

## Rate changes
Edit the rate on the `cutoffs` row (or per individual reading) — amounts recompute
automatically because they're generated from `current − previous` × `rate`.

## Migrating existing readings (one-time)
To seed the current meter state so the *next* cutoff carries forward correctly, we
import the **current readings** from the existing sheet into the May 2026 cutoff:
- WATER  current_reading  ← column C
- ELECTRIC current_reading ← column J
A short Node script (like `migrate.mjs`) can read the
`Water & Electric Meter Reading` tab and upsert into `meter_readings`. I'll build it
when you approve the schema.

## Proposed UI (Utilities page) — for later
- Cutoff dropdown + "Open new cutoff" button (with date/rate fields)
- Two tabs: **Water** / **Electric**
- Table: Room | Previous (auto) | Current (input) | Consumption (auto) | Rate | Amount (auto)
- Sticky totals row; "Save all" bulk-upsert
- Editable rate fields at the top that recompute the column

## Next steps
1. ✅ Review this schema (`utilities_schema.sql`)
2. Run it in Supabase SQL Editor
3. I build the import script to seed current readings from the sheet
4. I build the Utilities page in the React app
