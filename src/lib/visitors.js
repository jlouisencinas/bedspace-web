import { supabase } from './supabase'

// Every visitor write goes through a SECURITY DEFINER RPC (database/migrations/visitor_log.sql).
// Errors are thrown with the server's message so the screen can show it as-is.
async function rpc(name, args) {
  const { data, error } = await supabase.rpc(name, args)
  if (error) throw new Error(error.message)
  return data
}

export const ALLOW_NO_EMAIL = true

export const ID_TYPES = [
  { value: 'PHILSYS',         label: 'PhilSys / National ID' },
  { value: 'DRIVERS_LICENSE', label: "Driver's License" },
  { value: 'PASSPORT',        label: 'Passport' },
  { value: 'UMID_SSS',        label: 'UMID / SSS' },
  { value: 'PRC',             label: 'PRC' },
  { value: 'POSTAL',          label: 'Postal ID' },
  { value: 'VOTERS',          label: "Voter's ID" },
  { value: 'COMPANY',         label: 'Company ID' },
  { value: 'SCHOOL',          label: 'School ID' },
  { value: 'OTHER',           label: 'Other' },
]

export function idTypeLabel(type, other) {
  if (type === 'OTHER') return other ? `Other: ${other}` : 'Other'
  return ID_TYPES.find(t => t.value === type)?.label || type || '—'
}

// tone maps to theme tokens: danger / warning / success / info / neutral
export const STATE_META = {
  RED:      { label: 'Must leave',       tone: 'danger' },
  PENDING:  { label: 'Pending approval', tone: 'warning' },
  DUE_SOON: { label: 'Cut-off 10:00 PM', tone: 'warning' },
  APPROVED: { label: 'Approved tonight', tone: 'success' },
  OK:       { label: 'Inside',           tone: 'info' },
  OUT:      { label: 'Checked out',      tone: 'neutral' },
  VOID:     { label: 'Void',             tone: 'neutral' },
}

export const TONE_CHIP = {
  danger:  'bg-danger-bg text-danger-text border border-danger-border',
  warning: 'bg-warning-bg text-warning-text border border-warning-border',
  success: 'bg-success-bg text-success-text border border-success-border',
  info:    'bg-info-bg text-info-text border border-info-border',
  neutral: 'bg-surface-3 text-ink-muted border border-line',
}

// ── Manila formatting (device clock / time zone never matter) ────────────────
const TZ = 'Asia/Manila'
const F = {
  time:     new Intl.DateTimeFormat('en-PH', { timeZone: TZ, hour: 'numeric', minute: '2-digit' }),
  timeSec:  new Intl.DateTimeFormat('en-PH', { timeZone: TZ, hour: 'numeric', minute: '2-digit', second: '2-digit' }),
  date:     new Intl.DateTimeFormat('en-PH', { timeZone: TZ, month: 'short', day: 'numeric' }),
  dateYear: new Intl.DateTimeFormat('en-PH', { timeZone: TZ, month: 'short', day: 'numeric', year: 'numeric' }),
  weekday:  new Intl.DateTimeFormat('en-PH', { timeZone: TZ, weekday: 'short', month: 'short', day: 'numeric' }),
  key:      new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' }),
  local:    new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }),
}
const toDate = v => (v instanceof Date ? v : new Date(v))
const ok = v => v != null && v !== '' && !Number.isNaN(toDate(v).getTime())

export const fmtTime     = v => (ok(v) ? F.time.format(toDate(v)) : '—')
export const fmtTimeSec  = v => (ok(v) ? F.timeSec.format(toDate(v)) : '—')
export const fmtDate     = v => (ok(v) ? F.date.format(toDate(v)) : '—')
export const fmtDateYear = v => (ok(v) ? F.dateYear.format(toDate(v)) : '—')
export const fmtWeekday  = v => (ok(v) ? F.weekday.format(toDate(v)).replace(',', '') : '—')
export const fmtDateTime = v => (ok(v) ? `${F.date.format(toDate(v))}, ${F.time.format(toDate(v))}` : '—')
export const manilaDateKey = v => F.key.format(toDate(v))

// A YYYY-MM-DD calendar date (e.g. an overnight night) shown without any time-zone shift.
export function fmtNight(ymd, withWeekday = false) {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(ymd || ''))
  if (!m) return '—'
  const d = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3], 4))
  return withWeekday ? fmtWeekday(d) : fmtDate(d)
}

// Log day / night runs 06:00 -> 05:59 Manila.
export function logDayKey(ms) { return manilaDateKey(new Date(ms - 6 * 3600 * 1000)) }
export function logDayStartMs(ms) {
  const [y, mo, d] = logDayKey(ms).split('-').map(Number)
  return Date.UTC(y, mo - 1, d, 6 - 8, 0, 0)
}
export function manilaHour(ms) { return Number(F.local.format(new Date(ms)).slice(12, 14)) }
export function sameLogDay(a, b) { return logDayKey(toDate(a).getTime()) === logDayKey(toDate(b).getTime()) }

export function fmtWhen(v, nowMs) {
  if (!ok(v)) return '—'
  return sameLogDay(v, nowMs) ? fmtTime(v) : fmtDateTime(v)
}

export function fmtDuration(ms) {
  if (!Number.isFinite(ms) || ms < 0) return '—'
  const mins = Math.floor(ms / 60000)
  const h = Math.floor(mins / 60), m = mins % 60
  return h ? `${h} h ${m} m` : `${m} m`
}

// <input type="datetime-local"> values are Manila wall-clock time.
export function toManilaLocalInput(v) {
  if (!ok(v)) return ''
  return F.local.format(toDate(v)).replace(', ', 'T')
}
export function fromManilaLocalInput(s) {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(String(s || ''))) return null
  return new Date(`${s}:00+08:00`).toISOString()
}

// ── Contact number (client mirror of visitor_contact_key, only to decide when to look up) ──
export function contactKey(s) {
  const d = String(s || '').replace(/\D/g, '')
  if (/^639\d{9}$/.test(d)) return '0' + d.slice(2)
  if (/^9\d{9}$/.test(d)) return '0' + d
  return d
}
export function contactValid(s) {
  const t = String(s || '').trim()
  return t.length >= 7 && t.length <= 30 && /^\d{7,15}$/.test(contactKey(t))
}
export function contactKeyReady(s) {
  const k = contactKey(s)
  if (k.startsWith('09')) return k.length === 11
  if (k.startsWith('9') || k.startsWith('639')) return false
  return k.length >= 7 && k.length <= 15
}

export const EMAIL_RE = /^[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}$/
export const emailValid = s => { const t = String(s || '').trim(); return t.length <= 254 && EMAIL_RE.test(t) }
export const cleanName = s => String(s || '').replace(/\s+/g, ' ').trim()

// ── RPC wrappers ──────────────────────────────────────────────────────────────
export const fetchTenantDirectory = () => rpc('visitor_tenant_search', { p_query: '' }).then(d => d || [])

export async function lookupContact(contact) {
  const rows = await rpc('visitor_lookup_contact', { p_contact: contact })
  return rows?.[0] || null
}

export async function checkInVisitor(f) {
  const rows = await rpc('visitor_check_in', {
    p_visit_kind: f.visitKind, p_tenant_id: f.tenantId ?? null, p_purpose: f.purpose ?? null,
    p_visitor_name: f.visitorName, p_contact_no: f.contactNo, p_email: f.email ?? null, p_no_email: !!f.noEmail,
    p_id_type: f.idType, p_id_type_other: f.idTypeOther ?? null, p_id_photo_path: f.photoPath,
    p_guard_name: f.guardName ?? null, p_overnight: !!f.overnight, p_overnight_reason: f.overnightReason ?? null,
  })
  const r = rows?.[0]
  if (!r?.visit_id) throw new Error('Check-in was not confirmed by the server. Refresh and check the Inside list.')
  return r
}

export const checkOutVisitor = (visitId, guardName) =>
  rpc('visitor_check_out', { p_visit_id: visitId, p_guard_name: guardName ?? null })

export const requestOvernight = (visitId, reason, guardName) =>
  rpc('visitor_request_overnight', { p_visit_id: visitId, p_reason: reason, p_guard_name: guardName ?? null })

export const fetchGuardList = () => rpc('visitor_guard_list').then(d => d || [])

export const voidVisit = (visitId, reason) => rpc('visitor_void', { p_visit_id: visitId, p_reason: reason })

export const correctVisit = (visitId, changes, reason) =>
  rpc('visitor_correct', { p_visit_id: visitId, p_changes: changes, p_reason: reason })

export const fetchHistory = ({ from, to, search, status, overnight, kind, limit = 100, offset = 0 }) =>
  rpc('visitor_history', {
    p_from: from, p_to: to, p_search: search || null, p_status: status || 'ACTIVE',
    p_overnight: overnight || 'ANY', p_kind: kind || 'ALL', p_limit: limit, p_offset: offset,
  }).then(d => d || [])

async function withDecisionNotes(rows) {
  const ids = [...new Set(rows.map(r => r.overnight_request_id).filter(Boolean))]
  if (!ids.length) return rows
  const { data, error } = await supabase.from('approval_requests').select('id, decision_notes').in('id', ids)
  if (error) throw new Error(error.message)
  const notes = Object.fromEntries((data || []).map(a => [a.id, a.decision_notes]))
  return rows.map(r => ({ ...r, overnight_decision_note: notes[r.overnight_request_id] ?? null }))
}

// Admin/user front desk: every open visit with full contact.
export async function fetchInsideNowFull() {
  const { data, error } = await supabase.from('visitor_logs_v').select('*')
    .is('check_out_at', null).is('voided_at', null).order('check_in_at', { ascending: true }).limit(500)
  if (error) throw new Error(error.message)
  return withDecisionNotes(data || [])
}

export async function fetchVisit(visitId) {
  const id = Number(visitId)
  if (!Number.isInteger(id) || id <= 0) throw new Error(`Invalid visit id: "${visitId}"`)
  const { data, error } = await supabase.from('visitor_logs_v').select('*').eq('id', id).maybeSingle()
  if (error) throw new Error(error.message)
  return data
}

export async function fetchVisitEdits(visitId) {
  const { data, error } = await supabase.from('visitor_log_edits').select('*')
    .eq('visit_id', visitId).order('edited_at', { ascending: false })
  if (error) throw new Error(error.message)
  return data || []
}

export async function fetchOvernightRequests(visitId) {
  const { data, error } = await supabase.from('approval_requests')
    .select('id, status, reason, decision_notes, created_at, decided_at, requester_email, new_value')
    .eq('entity_type', 'VISITOR_LOG').eq('field_name', 'overnight_visitor').eq('entity_id', String(visitId))
    .order('created_at', { ascending: false })
  if (error) throw new Error(error.message)
  return data || []
}

// ── Recent targets (this device) ──────────────────────────────────────────────
const RECENT_TARGETS_KEY = 'bedspace.visitRecentTargets'
export function getRecentTargets() {
  try {
    const v = JSON.parse(localStorage.getItem(RECENT_TARGETS_KEY) || '[]')
    return Array.isArray(v) ? v.filter(x => Number.isInteger(x?.tenant_id) && Number.isInteger(x?.room_id)).slice(0, 6) : []
  } catch { return [] }
}
export function addRecentTarget(t) {
  if (t?.kind !== 'TENANT') return
  const item = { tenant_id: t.tenant_id, room_id: t.room_id }
  const next = [item, ...getRecentTargets().filter(x => !(x.tenant_id === item.tenant_id && x.room_id === item.room_id))].slice(0, 6)
  try { localStorage.setItem(RECENT_TARGETS_KEY, JSON.stringify(next)) } catch { /* storage full or blocked */ }
}

export function targetLabel(t) {
  if (!t) return ''
  if (t.kind === 'OFFICE') return `Office: ${t.purpose}`
  return [t.tenant_name, t.room_no && `Room ${t.room_no}`, t.bed_letters && `Bed ${t.bed_letters}`].filter(Boolean).join(' · ')
}

export function visitTargetText(v) {
  if (v.visit_kind === 'OFFICE') return `Office: ${v.purpose || '—'}`
  return [v.tenant_name, [v.room_no, v.bed_letters].filter(Boolean).join(' ')].filter(Boolean).join(' · ')
}
