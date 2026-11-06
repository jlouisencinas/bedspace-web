# Migrations applied to production

One line per migration applied to the production Supabase project `hkminadjypkfmbkfcawx` (the only database).
Written by the database-admin / fullstack-engineer agents following the `db-migrations` skill procedure.
Earlier migrations in this folder were applied by hand before this log existed.

| Date (Asia/Manila) | File | Task / branch | Backup table | Result |
|---|---|---|---|---|
| 2026-11-05 19:45 | maintenance_common_areas.sql | 20261105-maintenance-common-areas / feat/maintenance-common-areas | none (schema-only) | OK: location column + 2 checks + index; 11 rows unchanged; RLS unchanged, per-role verified; notify-email v11 deployed (verify_jwt=true) |
| 2026-11-05 | `reservation_target_date.sql` | 20261105-reservation-target-date-move-in / `feat/reservation-target-date-move-in` | none (schema/function only) | Applied OK: `beds.reserved_move_in_date` (date, nullable), guard exclusion, `trg_beds_reservation_date`; verified per role in rolled-back tx (user/viewer/admin, Move In carries HELD payments). `_enforce.sql` NOT applied (after deploy). |
| 2026-11-06 | `final_bill_reissue.sql` | 20261106-billing-advance-extension-skip / `fix/billing-advance-extension-skip` | backup.final_bills_20261106_reissue (1 row, #26), backup.tenant_deposits_20261106_reissue (2 rows, tenant 74) | Applied OK: final_bills.voided_by / replaces_bill_id / replaced_by_bill_id (nullable, FKs), uq_final_bills_replaces, RPC reissue_final_bill (secdef, authenticated only); 5 rows unchanged; rolled-back role test: user/viewer/guard refused, admin passes every gate on #26. #26 NOT re-issued (admin does it in the app after deploy). |
