// PreToolUse guard for Supabase MCP calls (execute_sql, apply_migration, deploy_edge_function).
// The agents have full read-write access to the PRODUCTION database (there is no staging).
//
// Two kinds of rules:
// - GATED: destructive or security-sensitive operations (TRUNCATE, DROP TABLE/SCHEMA/DATABASE, DROP COLUMN,
//   turning RLS off, DROP POLICY without re-creating one, writes to auth.*, DELETE on billing/payment/audit
//   tables, a project other than bedspace-web). Refused by default; allowed only when the requirement needs it:
//   the call carries the marker  -- guard-db:allow <task-id>  (anywhere in the SQL, or in the tool input), and
//   .pipeline/<task-id>/plan.md exists and contains "guard-db:allow" (the architect declares the operation there).
//   Every allowed override is appended to .pipeline/<task-id>/guard-db-overrides.log.
// - HARD: always refused (unbounded DELETE / UPDATE, Edge Function deploy with verify_jwt=false).
import { readFileSync, existsSync, appendFileSync } from 'node:fs'
import { join } from 'node:path'

const ALLOWED_PROJECTS = ['hkminadjypkfmbkfcawx'] // bedspace-web production

// Billing / payment / audit tables: rows are normally never deleted (void/adjust only).
const PROTECTED = [
  'payments', 'payment_allocations', 'invoices', 'final_bills', 'advance_credits', 'tenant_deposits',
  'bed_reservation_payments', 'settlements', 'meter_readings', 'interim_readings', 'area_readings',
  'addons', 'tenant_splits', 'tenant_stays', 'tenant_transfers', 'tenants', 'cutoffs', 'activity_log',
  'approval_requests', 'visitor_logs', 'visitor_log_edits', 'room_logs', 'monthly_reports', 'beds', 'rooms',
]

function deny(reason, gated) {
  const how = gated
    ? 'If the requirement really needs this, the plan for the task (.pipeline/<task>/plan.md) must declare it with a line containing "guard-db:allow" and the reason, and the SQL must carry the comment  -- guard-db:allow <task-id>.  Back up affected rows first (db-migrations procedure). Otherwise do not retry; report it to the user.'
    : 'This is always blocked on the production database. Do not retry or work around it; report it to the user, who can run it by hand in the Supabase dashboard if it is really intended.'
  process.stdout.write(JSON.stringify({
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'deny',
      permissionDecisionReason: `[guard-db] ${reason} ${how}`,
    },
  }))
  process.exit(0)
}

let input
try { input = JSON.parse(readFileSync(0, 'utf8') || '{}') } catch { process.exit(0) }
const tool = String(input.tool_name || '')
const ti = input.tool_input || {}
const projectDir = process.env.CLAUDE_PROJECT_DIR || input.cwd || process.cwd()

// Requirement override: marker in the call + a plan that declares it.
const marker = JSON.stringify(ti).match(/guard-db:allow\s+([a-z0-9][a-z0-9-]{0,80})/i)
let override = null
if (marker) {
  const task = marker[1].toLowerCase()
  const plan = join(projectDir, '.pipeline', task, 'plan.md')
  try {
    if (existsSync(plan) && /guard-db:allow/i.test(readFileSync(plan, 'utf8'))) override = task
  } catch { /* unreadable plan = no override */ }
}

const gatedHits = []
function gated(reason) {
  if (!override) deny(reason, true)
  gatedHits.push(reason)
}

if (ti.project_id && !ALLOWED_PROJECTS.includes(ti.project_id)) {
  gated(`Project ${ti.project_id} is not the bedspace-web project (${ALLOWED_PROJECTS.join(', ')}).`)
}

if (/deploy_edge_function$/.test(tool)) {
  if (ti.verify_jwt === false) deny('Edge Functions must be deployed with verify_jwt=true (CLAUDE.md, Notifications).', false)
  finish()
}

const raw = String(ti.query ?? ti.sql ?? '')
if (!raw) finish()

// Drop comments and single-quoted literals so text inside notes/strings cannot trigger (or hide) a match.
const sql = raw
  .replace(/--[^\n]*/g, ' ')
  .replace(/\/\*[\s\S]*?\*\//g, ' ')
  .replace(/'(?:[^']|'')*'/g, "''")
  .toLowerCase()

const name = '(?:"?public"?\\.)?"?([a-z_][a-z0-9_]*)"?'
const statements = sql.split(';').map(s => s.trim()).filter(Boolean)

for (const s of statements) {
  // Gated: allowed only when the task's plan declares it (see header).
  if (/\btruncate\b/.test(s)) gated('TRUNCATE wipes tables (this is also how the init.sql seed starts; never run all of init.sql).')
  if (/\bdrop\s+(table|schema|database)\b/.test(s)) gated('DROP TABLE / SCHEMA / DATABASE destroys data.')
  if (/\balter\s+table\b[\s\S]*\bdrop\s+(column\b|(?!constraint|default|not\b|policy|trigger|index|identity|expression)[a-z_"])/.test(s)) gated('ALTER TABLE ... DROP COLUMN destroys data. Migrations are normally additive.')
  if (/\bdisable\s+row\s+level\s+security\b/.test(s) || /\bno\s+force\s+row\s+level\s+security\b/.test(s)) gated('Turning RLS off exposes every row to every role.')
  if (/\b(delete\s+from|update|insert\s+into|truncate)\s+"?auth"?\./.test(s)) gated('auth.* tables are normally never written directly.')
  if (/\bdrop\s+policy\b/.test(s) && !/\bcreate\s+policy\b/.test(sql)) gated('DROP POLICY without re-creating a policy in the same call leaves the table unprotected or locked.')

  const del = s.match(new RegExp(`\\bdelete\\s+from\\s+${name}`))
  if (del) {
    // Hard: an unbounded DELETE is never allowed.
    if (!/\bwhere\b/.test(s)) deny(`DELETE FROM ${del[1]} without a WHERE clause.`, false)
    if (PROTECTED.includes(del[1])) gated(`DELETE FROM ${del[1]}: billing/payment/audit rows are normally only voided or adjusted (non-negotiable).`)
  }
  const upd = s.match(new RegExp(`^(?:with\\b[\\s\\S]*?\\)\\s*)?update\\s+${name}`)) || s.match(new RegExp(`\\bupdate\\s+${name}\\s+set\\b`))
  if (upd && PROTECTED.includes(upd[1]) && !/\bwhere\b/.test(s)) deny(`UPDATE ${upd[1]} without a WHERE clause would rewrite every row.`, false)
}

finish()

function finish() {
  if (override && gatedHits.length) {
    try {
      appendFileSync(
        join(projectDir, '.pipeline', override, 'guard-db-overrides.log'),
        `${new Date().toISOString()} ${tool} ALLOWED by plan: ${gatedHits.join(' | ')}\n${raw || JSON.stringify(ti)}\n---\n`,
      )
    } catch { /* logging must not block the call */ }
  }
  process.exit(0)
}
