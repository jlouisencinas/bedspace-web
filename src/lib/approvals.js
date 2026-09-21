import { supabase } from './supabase'
import { notifyAsync } from './notify'

// ── Helpers ───────────────────────────────────────────────────────────────────

async function logActivity(entry) {
  const { error } = await supabase.from('activity_log').insert(entry)
  if (error) console.warn('activity_log insert failed:', error.message)
}

function fmtD(d) {
  if (!d) return null
  return new Date(d).toLocaleDateString('en-PH', { month: 'short', day: 'numeric', year: 'numeric' })
}

function moveOutNoteParts(nv) {
  const parts = []
  if (nv?.move_out_date)        parts.push(`Move-out: ${fmtD(nv.move_out_date)}`)
  if (nv?.actual_move_out_date) parts.push(`Actual: ${fmtD(nv.actual_move_out_date)}`)
  if (nv?.amount_paid)          parts.push(`Amount: ₱${Number(nv.amount_paid).toLocaleString('en-PH')}`)
  return parts
}

/**
 * Fetch profiles (email) for a set of user UUIDs.
 * Used to enrich approval requests without touching auth.users
 * (which is inaccessible via the anon key).
 */
async function emailsForIds(ids) {
  const clean = ids.filter(Boolean)
  if (!clean.length) return {}
  const { data } = await supabase
    .from('profiles')
    .select('id, email')
    .in('id', clean)
  return Object.fromEntries((data || []).map(p => [p.id, p.email]))
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Submit a protected-field change for admin approval.
 * Called by non-admin users instead of writing the field directly.
 * Does NOT mutate the target entity — the change only applies once approved.
 */
export async function requestApproval({ entityType, entityId, fieldName, oldValue, newValue, reason }) {
  const { data: { user } } = await supabase.auth.getUser()

  const { data, error } = await supabase
    .from('approval_requests')
    .insert({
      requester_id:    user.id,
      requester_email: user.email,
      entity_type:     entityType,
      entity_id:       entityId,
      field_name:      fieldName,
      old_value:       oldValue ?? null,
      new_value:       newValue,
      reason,
    })
    .select()
    .single()
  if (error) throw error

  await logActivity({
    activity_type: 'Approval Requested',
    tenant_name:   newValue?._tenant_name ?? null,
    room_no:       newValue?._room_no     ?? null,
    bed_letter:    newValue?._bed_letter  ?? null,
    move_out_date: newValue?.move_out_date ?? null,
    notes: [
      `[${fieldName}] submitted for approval by ${user.email}.`,
      ...moveOutNoteParts(newValue),
      `Reason: ${reason}`,
    ].join(' '),
  })

  notifyAsync('approval_request', data.id)

  return data
}

/**
 * Fetch approval requests.
 * requester_email is stored at insert time — no cross-user profile lookup needed.
 * decision_maker email is resolved from profiles (admin reading own profile works).
 */
export async function fetchApprovals({ status } = {}) {
  let q = supabase
    .from('approval_requests')
    .select('*')
    .order('created_at', { ascending: false })
  if (status) q = q.eq('status', status)

  const { data: requests, error } = await q
  if (error) throw error
  if (!requests?.length) return []

  // Only look up decision-maker emails (admin reading own profile is fine)
  const decisionIds = [...new Set(requests.map(r => r.decision_maker_id).filter(Boolean))]
  const decisionEmailMap = decisionIds.length ? await emailsForIds(decisionIds) : {}

  return requests.map(r => ({
    ...r,
    requester:      { email: r.requester_email ?? r.requester_id },
    decision_maker: r.decision_maker_id
      ? { email: decisionEmailMap[r.decision_maker_id] ?? r.decision_maker_id }
      : null,
  }))
}

/**
 * Approve a pending request.
 * Returns the updated row (caller applies new_value to the target entity).
 */
export async function approveRequest(id, decisionNotes = null) {
  const { data: { user } } = await supabase.auth.getUser()

  const { data, error } = await supabase
    .from('approval_requests')
    .update({
      status:            'APPROVED',
      decision_maker_id: user.id,
      decision_notes:    decisionNotes,
      decided_at:        new Date().toISOString(),
    })
    .eq('id', id)
    .eq('status', 'PENDING')
    .select()
    .single()
  if (error) throw error

  const nv = data.new_value || {}
  await logActivity({
    activity_type: 'Approval Approved',
    tenant_name:   nv._tenant_name ?? null,
    room_no:       nv._room_no     ?? null,
    bed_letter:    nv._bed_letter  ?? null,
    move_out_date: nv.move_out_date ?? null,
    notes: [
      `[${data.field_name}] approved by ${user.email}.`,
      ...moveOutNoteParts(nv),
      decisionNotes ? `Admin note: ${decisionNotes}` : null,
    ].filter(Boolean).join(' '),
  })

  return data
}

/**
 * Reject a pending request. Target entity is NOT mutated.
 */
export async function rejectRequest(id, decisionNotes = null) {
  const { data: { user } } = await supabase.auth.getUser()

  const { data, error } = await supabase
    .from('approval_requests')
    .update({
      status:            'REJECTED',
      decision_maker_id: user.id,
      decision_notes:    decisionNotes,
      decided_at:        new Date().toISOString(),
    })
    .eq('id', id)
    .eq('status', 'PENDING')
    .select()
    .single()
  if (error) throw error

  const nv = data.new_value || {}
  await logActivity({
    activity_type: 'Approval Rejected',
    tenant_name:   nv._tenant_name ?? null,
    room_no:       nv._room_no     ?? null,
    bed_letter:    nv._bed_letter  ?? null,
    move_out_date: nv.move_out_date ?? null,
    notes: [
      `[${data.field_name}] rejected by ${user.email}.`,
      ...moveOutNoteParts(nv),
      decisionNotes ? `Reason: ${decisionNotes}` : null,
    ].filter(Boolean).join(' '),
  })

  return data
}

/**
 * Pending requests targeting one entity (any field_name), newest first.
 */
export async function fetchPendingForEntity(entityType, entityId) {
  const { data, error } = await supabase
    .from('approval_requests')
    .select('id, field_name, requester_email, requester_id, created_at')
    .eq('status', 'PENDING')
    .eq('entity_type', entityType)
    .eq('entity_id', entityId)
    .order('created_at', { ascending: false })
  if (error) throw error
  return data || []
}

/**
 * Count pending requests — used for the nav badge.
 */
export async function fetchPendingCount() {
  const { count, error } = await supabase
    .from('approval_requests')
    .select('id', { count: 'exact', head: true })
    .eq('status', 'PENDING')
  if (error) throw error
  return count ?? 0
}
