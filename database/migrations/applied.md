# Migrations applied to production

One line per migration applied to the production Supabase project `hkminadjypkfmbkfcawx` (the only database).
Written by the database-admin / fullstack-engineer agents following the `db-migrations` skill procedure.
Earlier migrations in this folder were applied by hand before this log existed.

| Date (Asia/Manila) | File | Task / branch | Backup table | Result |
|---|---|---|---|---|
| 2026-11-05 | `reservation_target_date.sql` | 20261105-reservation-target-date-move-in / `feat/reservation-target-date-move-in` | none (schema/function only) | Applied OK: `beds.reserved_move_in_date` (date, nullable), guard exclusion, `trg_beds_reservation_date`; verified per role in rolled-back tx (user/viewer/admin, Move In carries HELD payments). `_enforce.sql` NOT applied (after deploy). |
