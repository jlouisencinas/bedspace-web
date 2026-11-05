import { supabase } from './supabase'
import { dbToCents } from './receiptLines'

export const VISITS_LIMIT = 300

export const CATEGORY_LABEL = { COMMERCIAL: 'Commercial', PARKING_ONLY: 'Parking', OTHER: 'Other' }

// In-house (Current Tenants): active BED and COMMERCIAL tenants. PARKING_ONLY / OTHER rows do not live there.
export function isInHouse(t) {
  return !!t.is_active && (t.category === 'BED' || t.category === 'COMMERCIAL')
}

function todayManila() {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Manila', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date())
}

function addDays(ymd, n) {
  const [y, m, d] = ymd.split('-').map(Number)
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10)
}

// Stay window as YYYY-MM-DD: [move_in_date, actual/planned move-out, or today while active].
export function stayWindow(tenant) {
  const start = tenant.move_in_date ? String(tenant.move_in_date).slice(0, 10) : null
  const out = tenant.is_active ? null : (tenant.actual_move_out_date || tenant.move_out_date)
  const end = out ? String(out).slice(0, 10) : todayManila()
  return { start, end, open: !out }
}

// Visits are keyed to min(id) of the active same-name group in the room at check-in (visitor_tenant_search),
// so a tenant's visits may sit on a sibling bed row: same trimmed name, same room, overlapping stay.
export function siblingIdsFor(tenant, allTenants) {
  const norm = v => String(v || '').trim().toLowerCase()
  const roomId = tenant.beds?.room_id ?? tenant.room_id ?? null
  const ids = new Set([tenant.id])
  if (roomId == null) return [...ids]
  const w = stayWindow(tenant)
  for (const t of allTenants || []) {
    if (t.id === tenant.id || norm(t.name) !== norm(tenant.name)) continue
    if ((t.beds?.room_id ?? t.room_id ?? null) !== roomId) continue
    const o = stayWindow(t)
    if ((o.start || '') <= w.end && (w.start || '') <= o.end) ids.add(t.id)
  }
  return [...ids]
}

export async function fetchTenantTransfers(tenantId) {
  const { data, error } = await supabase
    .from('tenant_transfers')
    .select(`id, transfer_date, old_rate, new_rate, notes, status, created_at,
      from_bed:beds!from_bed_id(bed_letter), to_bed:beds!to_bed_id(bed_letter),
      from_room:rooms!from_room_id(room_no), to_room:rooms!to_room_id(room_no)`)
    .eq('tenant_id', tenantId)
    .eq('status', 'COMPLETED')
    .order('transfer_date', { ascending: true })
    .order('id', { ascending: true })
  if (error) throw error
  return data
}

// Read-only; never selects the ID number or the photo path.
export async function fetchVisitsForTenant(tenant, siblingIds) {
  const w = stayWindow(tenant)
  let q = supabase
    .from('visitor_logs_v')
    .select('id, visit_kind, tenant_id, tenant_name, room_no, bed_letters, visitor_name, contact_no, check_in_at, check_out_at, state, overnight_status, voided_at, void_reason, check_in_guard_name, check_out_guard_name')
    .in('tenant_id', siblingIds?.length ? siblingIds : [tenant.id])
  if (w.start) q = q.gte('check_in_at', `${w.start}T00:00:00+08:00`)
  if (!w.open) q = q.lt('check_in_at', `${addDays(w.end, 1)}T00:00:00+08:00`)
  const { data, error } = await q.order('check_in_at', { ascending: false }).limit(VISITS_LIMIT)
  if (error) throw error
  return data
}

// Groups follow the cutoffs' order (newest first), "No cutoff" last. Totals are integer cents.
export function groupPaymentsByCutoff(payments, cutoffs) {
  const order = new Map((cutoffs || []).map((c, i) => [c.id, i]))
  const names = new Map((cutoffs || []).map(c => [c.id, c.name]))
  const groups = new Map()
  for (const p of payments || []) {
    const key = p.cutoff_id ?? null
    if (!groups.has(key)) {
      groups.set(key, {
        cutoffId: key,
        name: key == null ? 'No cutoff' : (names.get(key) || `Cutoff #${key}`),
        rows: [], totalCents: 0,
      })
    }
    const g = groups.get(key)
    g.rows.push(p)
    g.totalCents += dbToCents(p.amount)
  }
  const rank = g => g.cutoffId == null ? order.size + 1 : (order.has(g.cutoffId) ? order.get(g.cutoffId) : order.size)
  const list = [...groups.values()].sort((a, b) => rank(a) - rank(b) || (b.cutoffId ?? 0) - (a.cutoffId ?? 0))
  const totalCents = list.reduce((s, g) => s + g.totalCents, 0)
  return { groups: list, totalCents }
}

export function centsToPeso(cents) {
  const neg = cents < 0
  const abs = Math.abs(cents)
  const whole = Math.floor(abs / 100).toLocaleString('en-PH')
  const frac = String(abs % 100).padStart(2, '0')
  return `${neg ? '-' : ''}₱${whole}.${frac}`
}
