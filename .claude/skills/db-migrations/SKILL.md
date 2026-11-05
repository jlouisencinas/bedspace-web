---
name: db-migrations
description: How schema changes and SQL are written and applied to the bedspace-web PRODUCTION Supabase database (the only database; free tier, no staging or branches). Load before writing a migration, running execute_sql/apply_migration, deploying an Edge Function, or touching database/init.sql or database/migrations/.
---

# Database changes on production (bedspace-web)

There is **one** database: production, Supabase project `hkminadjypkfmbkfcawx` (free tier, no branches, no staging). The fullstack-engineer and database-admin agents have full read-write access to it, authorized by the owner. Every call is live and immediate; git cannot undo it.

## Files
- `database/init.sql`: single consolidated schema (tables, views, functions, RLS policies, seed). **Never run all of it**: its last section is a seed that starts with `truncate table rooms, cutoffs, activity_log cascade` (wipes live data). Apply only the blocks you need. Keep it in sync: every migration is mirrored into `init.sql`.
- `database/migrations/<name>.sql`: one file per change, applied by hand or by an agent following the procedure below. Many start with a §0 audit block: run it first.
- `database/migrations/applied.md`: the log of what was applied to production, when, by which pipeline task.
- `database/UTILITIES_PLAN.md`: design notes for the utilities billing model.

## Rules for writing a migration
1. **Additive and backward compatible**: add tables/columns/functions/policies; never drop or rename something the deployed frontend uses. The migration is applied before the PR is merged, so the old frontend must keep working against the new schema.
2. Idempotent: `create ... if not exists`, `create or replace function`, `drop policy if exists` + `create policy` in the same file.
3. Every new table: RLS on + policies per the `roles-and-rls` skill.
4. Money columns `numeric(12,2)`; never delete billing/payment rows (void/adjust only).

## Procedure to apply to production (agents follow this exactly)
1. **Inspect**: read the current state of every object the migration touches (`list_tables`, a `select` from `pg_policies` / `information_schema`, row counts). Run the file's audit queries if it has them; stop and report if an audit finds rows that would break.
2. **Back up the affected rows** when the migration changes existing data (UPDATE/backfill/constraint that rewrites rows): `create table backup.<table>_<yyyymmdd>_<task> as select * from public.<table> where <affected rows>;` (`create schema if not exists backup;` first; never add RLS-free tables to `public`). Schema-only additions need no backup.
3. **Apply** with `apply_migration` (name = the file name) using exactly the reviewed SQL in the file.
4. **Verify**: re-run the inspection, check the expected objects/rows, and test RLS per role inside a rolled-back transaction.
5. **Log** one line in `database/migrations/applied.md`: date (Asia/Manila), file, task/branch, backup table if any, result.
6. Report before/after in the agent's output.

## What the guard-db hook blocks
**Gated (refused unless the requirement needs it):** TRUNCATE; DROP TABLE/SCHEMA/DATABASE; ALTER TABLE ... DROP COLUMN;
disabling RLS; writes to `auth.*`; DROP POLICY without a CREATE POLICY in the same call; DELETE on billing/payment/audit
tables; any project other than `hkminadjypkfmbkfcawx`.
To run one, both must hold:
1. `.pipeline/<task>/plan.md` declares it: a line `guard-db:allow <operation> - <why the requirement needs it>` (the
   architect writes it under "Schema changes"; QA checks the operation really follows from requirement.md).
2. The SQL sent to `execute_sql` / `apply_migration` carries the comment `-- guard-db:allow <task-id>`.
Back up every affected row first (step 2 above, also for DROP/TRUNCATE/DELETE), and use only the operation the plan
declares. The hook logs each override in `.pipeline/<task>/guard-db-overrides.log`. Never add the marker to SQL the
plan doesn't declare, and never run all of `init.sql` (its seed truncates rooms, cutoffs, activity_log).

**Hard (always refused):** DELETE without WHERE; UPDATE on protected tables without WHERE; Edge Function deploys with
`verify_jwt:false`. If a task truly needs one of these, stop and tell the user: they run it in the Supabase dashboard.

## Testing against production data
Test edits made through the app (by the tester) touch real records: prefer read-only checks; when a write is needed, use a clearly named test record (`ZZ TEST <task>`), record original values first, restore or void them after, and list anything left behind in the report. Never test by moving out, billing or charging a real tenant.
