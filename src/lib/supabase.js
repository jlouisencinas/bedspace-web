import { createClient } from '@supabase/supabase-js'
import { notifyAsync } from './notify'
import { normalizeLines, computeTotals, round2 } from './finalBill'
import { parseMoney, moneyProblem, centsToNumber } from './receiptLines'
import { deriveBedStatuses, activeTenantOnBedMessage, isActiveTenantPerBedViolation } from './bedEligibility'
import { PROFILE_FIELD_LABELS } from '../../supabase/functions/_shared/approval-labels.ts'

const url = import.meta.env.VITE_SUPABASE_URL
const key = import.meta.env.VITE_SUPABASE_ANON_KEY

export const isMissingConfig = !url || !key

// Only create the client when credentials exist
export const supabase = isMissingConfig ? null : createClient(url, key)

// ── Beds ──────────────────────────────────────────────────────────────────────
export async function fetchBeds() {
  const [viewRes, bedsRes] = await Promise.all([
    supabase.from('beds_with_tenant').select('*').order('room_no').order('bed_letter'),
    supabase.from('beds').select('id, reserved_name'),
  ])
  if (viewRes.error) throw viewRes.error
  const nameMap = {}
  if (bedsRes.data) bedsRes.data.forEach(b => { nameMap[b.id] = b.reserved_name })
  return deriveBedStatuses(viewRes.data.map(b => ({ ...b, reserved_name: nameMap[b.bed_id] ?? null })))
}

export async function updateBedStatus(bedId, status, reservedName = null) {
  const patch = { status, reserved_name: status === 'RESERVED' ? reservedName : null }
  const { error } = await supabase.from('beds').update(patch).eq('id', bedId)
  if (error) throw error
}

// ── Tenants ───────────────────────────────────────────────────────────────────
export async function fetchTenants() {
  const { data, error } = await supabase
    .from('tenants')
    .select(`*, beds!bed_id(bed_letter, bed_location, room_id, rooms(room_no, room_type))`)
    .order('created_at', { ascending: false })
  if (error) throw error

  // Tenants moved out WITH a (non-void) final bill: computeBilling keeps them in the utility split
  // for that bill's cutoff without billing them. Best-effort on purpose: if the table is missing
  // (migration not applied yet), unreadable (viewer RLS) or errors, fall back to the old behaviour.
  try {
    const { data: bills, error: bErr } = await supabase
      .from('final_bills').select('tenant_id, cutoff_id').eq('status', 'FINAL')
    if (bErr) throw bErr
    const byTenant = new Map()
    for (const b of bills || []) {
      if (b.cutoff_id == null) continue
      if (!byTenant.has(b.tenant_id)) byTenant.set(b.tenant_id, [])
      byTenant.get(b.tenant_id).push(b.cutoff_id)
    }
    return data.map(t => (byTenant.has(t.id) ? { ...t, _finalBilled: true, _finalBilledCutoffs: byTenant.get(t.id) } : t))
  } catch (e) {
    console.warn('final_bills lookup skipped:', e.message)
    return data
  }
}

const TENANT_COLUMNS = new Set([
  'name', 'gender', 'rate', 'duration',
  'move_in_date', 'move_out_date',
  'contact_no', 'email',
  'occupation', 'employer', 'employer_address', 'employer_contact_no',
  'location_of_work', 'work_schedule',
  'permanent_address', 'source', 'comments',
  'emergency_contact_name', 'emergency_contact_no',
  'govt_id1', 'govt_id2', 'contract',
])

export async function addTenant(bedId, tenantData) {
  // Strip helper fields and any non-column keys (e.g. contacts, emails arrays)
  const { _room_no, _bed_letter, ...raw } = tenantData
  // Convert empty strings to null so optional fields (incl. source CHECK constraint) don't break
  const dbData = Object.fromEntries(
    Object.entries(raw)
      .filter(([k]) => TENANT_COLUMNS.has(k))
      .map(([k, v]) => [k, v === '' ? null : v])
  )

  // Friendly pre-check; the unique index uniq_active_tenant_per_bed remains the real guard.
  const { data: existing, error: exErr } = await supabase
    .from('tenants')
    .select('name')
    .eq('bed_id', bedId)
    .eq('is_active', true)
    .limit(1)
  if (exErr) console.warn('active-tenant pre-check skipped:', exErr.message)
  else if (existing?.length) throw new Error(activeTenantOnBedMessage(_room_no, _bed_letter, existing[0].name))

  // 1. Insert tenant
  const { data: tenant, error: tErr } = await supabase
    .from('tenants')
    .insert({ bed_id: bedId, is_active: true, ...dbData })
    .select()
    .single()
  if (tErr) {
    if (isActiveTenantPerBedViolation(tErr)) throw new Error(activeTenantOnBedMessage(_room_no, _bed_letter))
    throw tErr
  }

  // 2. Mark bed as LEASED
  await updateBedStatus(bedId, 'LEASED')

  // 3. Log activity
  const { data: { user } } = await supabase.auth.getUser()
  await logActivity({
    activity_type: 'Move In',
    actor_id:      user?.id || null,
    tenant_id:     tenant.id,
    tenant_name:   dbData.name,
    room_no:       _room_no,
    bed_letter:    _bed_letter,
    rate:          dbData.rate,
    move_in_date:  dbData.move_in_date,
    entity_type:   'TENANT',
    entity_id:     tenant.id,
    notes:         `Moved in to Room ${_room_no} Bed ${_bed_letter} at ₱${dbData.rate}/mo`,
  })

  return tenant
}

export async function recordPayment(tenantId, paymentData) {
  // Strip helper fields used only for activity logging
  const { _tenant_name, _room_no, _bed_letter, _cutoff_name, ...raw } = paymentData

  // Derive pay_type from category when not explicitly set
  if (!raw.pay_type) {
    raw.pay_type = raw.category === 'ELECTRICITY' ? '10th'
                 : raw.category === 'RENT_WATER'  ? 'EOM'
                 : 'Other'
  }

  // 1. Insert payment record
  const { error: pErr } = await supabase
    .from('payments')
    .insert({ tenant_id: tenantId, ...raw })
  if (pErr) throw pErr

  // 2. Update last-pay date on tenant row
  const colMap = { '10th': 'last_pay_10th', 'EOM': 'last_pay_eom' }
  const col = colMap[raw.pay_type]
  if (col) {
    const { error: tErr } = await supabase
      .from('tenants')
      .update({ [col]: raw.payment_date })
      .eq('id', tenantId)
    if (tErr) throw tErr
  }

  // 3. Log to activity
  const catLabel = raw.category === 'ELECTRICITY' ? 'Electricity'
                 : raw.category === 'RENT_WATER'  ? 'Rent + Water'
                 : 'Other'
  const noteParts = [_cutoff_name, raw.notes].filter(Boolean)
  await logActivity({
    activity_type: `Payment - ${catLabel}`,
    tenant_id:     tenantId,
    tenant_name:   _tenant_name || null,
    room_no:       _room_no     || null,
    bed_letter:    _bed_letter  || null,
    amount_paid:   raw.amount,
    entity_type:   'PAYMENT',
    notes:         noteParts.join(' · ') || null,
  })
}

// Collections §12 multi-select batch save. Mirrors recordPayment()'s pay_type
// derivation / activity_log labeling, but as ONE multi-row payments insert +
// ONE multi-row activity_log insert instead of N sequential single-row calls.
// Every write here throws on error (no logActivity()-style swallowing) since
// this is money-adjacent.
export async function recordPaymentsBatch(entries) {
  if (!entries || entries.length === 0) return []

  const payTypeFor = category =>
    category === 'ELECTRICITY' ? '10th'
    : category === 'RENT_WATER'  ? 'EOM'
    : 'Other'

  const rows = entries.map(e => ({
    tenant_id:    e.tenantId,
    payment_date: e.paymentDate,
    amount:       Number(e.amount),
    category:     e.category,
    cutoff_id:    e.cutoffId ?? null,
    pay_type:     e.payType || payTypeFor(e.category),
    notes:        e.notes || null,
  }))

  const { data: inserted, error: pErr } = await supabase
    .from('payments')
    .insert(rows)
    .select()
  if (pErr) throw pErr

  // Dedup tenant+pay_type -> latest payment_date (Promise.all, not a sequential loop).
  const colMap = { '10th': 'last_pay_10th', 'EOM': 'last_pay_eom' }
  const latestByKey = new Map()
  entries.forEach(e => {
    const payType = e.payType || payTypeFor(e.category)
    const col = colMap[payType]
    if (!col) return
    const key = `${e.tenantId}:${col}`
    const prev = latestByKey.get(key)
    if (!prev || e.paymentDate > prev) latestByKey.set(key, e.paymentDate)
  })
  await Promise.all(
    Array.from(latestByKey.entries()).map(async ([key, date]) => {
      const [tenantId, col] = key.split(':')
      const { error } = await supabase.from('tenants').update({ [col]: date }).eq('id', tenantId)
      if (error) throw error
    })
  )

  const activityRows = entries.map((e, i) => {
    const catLabel = e.category === 'ELECTRICITY' ? 'Electricity'
                   : e.category === 'RENT_WATER'  ? 'Rent + Water'
                   : 'Other'
    const noteParts = [e._cutoffName, e.notes].filter(Boolean)
    return {
      activity_type: `Payment - ${catLabel}`,
      tenant_id:     e.tenantId,
      tenant_name:   e._tenantName || null,
      room_no:       e._roomNo     || null,
      bed_letter:    e._bedLetter  || null,
      amount_paid:   Number(e.amount),
      entity_type:   'PAYMENT',
      entity_id:     inserted[i]?.id ?? null,
      notes:         noteParts.join(' · ') || null,
    }
  })
  const { error: aErr } = await supabase.from('activity_log').insert(activityRows)
  if (aErr) throw aErr

  return inserted
}

// Undo for recordPaymentsBatch() — a compensating INSERT, never an UPDATE/DELETE
// (payments has no update/delete policy for any role, by design). Scoped to the
// exact rows passed in — never queries for "other payments to void."
export async function voidPayments(paymentRows) {
  if (!paymentRows || paymentRows.length === 0) return []

  const today = new Date().toISOString().slice(0, 10)
  const voidRows = paymentRows.map(p => ({
    tenant_id:        p.tenant_id,
    payment_date:     today,
    amount:           -Number(p.amount),
    category:         p.category,
    cutoff_id:        p.cutoff_id,
    pay_type:         'VOID',
    notes:            `Undo of payment #${p.id}`,
    voids_payment_id: p.id,
  }))

  const { data: inserted, error: pErr } = await supabase
    .from('payments')
    .insert(voidRows)
    .select()
  if (pErr) throw pErr

  const activityRows = paymentRows.map(p => ({
    activity_type: 'Payment Voided',
    tenant_id:     p.tenant_id,
    amount_paid:   -Number(p.amount),
    entity_type:   'PAYMENT',
    entity_id:     p.id,
    notes:         `Undo of payment #${p.id}`,
  }))
  const { error: aErr } = await supabase.from('activity_log').insert(activityRows)
  if (aErr) throw aErr

  return inserted
}

export async function fetchPayments(tenantId) {
  const { data, error } = await supabase
    .from('payments')
    .select('*')
    .eq('tenant_id', tenantId)
    .order('payment_date', { ascending: false })
  if (error) throw error
  return data
}

// ── Advance & Deposit receipts (tenant_deposits) ──────────────────────────────
// Rows are never deleted: status moves HELD -> APPLIED/FORFEITED/REFUNDED in the
// move-out phase. Phase 1 only records receipts and lets admin correct them.
export const DEPOSIT_KIND_LABEL = { ADVANCE: 'Advance', DEPOSIT: 'Deposit' }
export const DEPOSIT_REF_LABEL  = { ADVANCE: 'S.I#',    DEPOSIT: 'T.R#'   }
export const PAYMENT_MODES      = ['BANK', 'CASH']
export const PAYMENT_MODE_LABEL = { BANK: 'Bank', CASH: 'Cash' }

export async function fetchTenantDeposits(tenantId) {
  const { data, error } = await supabase
    .from('tenant_deposits')
    .select('*')
    .eq('tenant_id', tenantId)
    .order('kind')
    .order('id')
  if (error) throw error
  return data
}

export async function fetchAllTenantDeposits() {
  const { data, error } = await supabase
    .from('tenant_deposits')
    .select('*')
    .order('tenant_id')
    .order('id')
  if (error) throw error
  return data
}

function depositAmount(v) {
  if (v === '' || v == null) throw new Error('Amount is required.')
  const cents = parseMoney(v)
  if (cents == null) throw new Error(`Amount: ${moneyProblem(v)}.`)
  return centsToNumber(cents)
}

function depositMode(v) {
  const m = blankToNull(v)
  if (m != null && !PAYMENT_MODES.includes(m)) throw new Error('Payment mode must be BANK or CASH.')
  return m
}

function blankToNull(v) {
  const s = typeof v === 'string' ? v.trim() : v
  return s === '' || s == null ? null : s
}

async function depositTenantMeta(tenantId) {
  const { data } = await supabase
    .from('tenants')
    .select('name, beds!bed_id(bed_letter, rooms(room_no))')
    .eq('id', tenantId)
    .maybeSingle()
  return {
    tenant_name: data?.name,
    room_no:     data?.beds?.rooms?.room_no,
    bed_letter:  data?.beds?.bed_letter,
  }
}

const peso = n => '₱' + Number(n).toLocaleString('en-PH', { minimumFractionDigits: 2, maximumFractionDigits: 2 })

// Inserts all rows in one statement so a move-in never ends up with only one of
// the two receipts. Throws on any error; the activity log is best-effort.
export async function addTenantDeposits(tenantId, entries, actorId) {
  const rows = entries.map(e => ({
    tenant_id:     tenantId,
    kind:          e.kind,
    amount:        depositAmount(e.amount),
    ref_no:        blankToNull(e.refNo),
    bank_ref:      blankToNull(e.bankRef),
    payment_mode:  depositMode(e.paymentMode),
    received_date: blankToNull(e.receivedDate),
    notes:         blankToNull(e.notes),
    created_by:    actorId || null,
  }))
  const { data, error } = await supabase.from('tenant_deposits').insert(rows).select()
  if (error) throw error

  const meta = await depositTenantMeta(tenantId)
  for (const r of data) {
    await logActivity({
      activity_type: 'Advance/Deposit Recorded',
      entity_type:   'TENANT', entity_id: tenantId,
      tenant_id:     tenantId,
      tenant_name:   meta.tenant_name,
      room_no:       meta.room_no,
      bed_letter:    meta.bed_letter,
      actor_id:      actorId || null,
      notes:         `${DEPOSIT_KIND_LABEL[r.kind]} ${peso(r.amount)} recorded${r.ref_no ? ` (${DEPOSIT_REF_LABEL[r.kind]} ${r.ref_no})` : ''}`,
      metadata: {
        deposit_id: r.id, kind: r.kind, amount: r.amount,
        ref_no: r.ref_no, received_date: r.received_date,
      },
    })
  }
  return data
}

export async function addTenantDeposit({ tenantId, kind, amount, refNo, bankRef, paymentMode, receivedDate, notes }, actorId) {
  const [row] = await addTenantDeposits(tenantId, [{ kind, amount, refNo, bankRef, paymentMode, receivedDate, notes }], actorId)
  return row
}

// Admin-only (RLS is the enforcement). Status is deliberately not patchable here.
export async function updateTenantDeposit(id, patch, actorId) {
  const { data: current, error: cErr } = await supabase
    .from('tenant_deposits')
    .select('*')
    .eq('id', id)
    .single()
  if (cErr) throw cErr
  if (current.status !== 'HELD') {
    throw new Error(`This ${DEPOSIT_KIND_LABEL[current.kind].toLowerCase()} receipt is ${current.status}: it was settled on a final bill and can no longer be edited.`)
  }

  const next = {}
  if ('amount' in patch)        next.amount        = depositAmount(patch.amount)
  if ('ref_no' in patch)        next.ref_no        = blankToNull(patch.ref_no)
  if ('bank_ref' in patch)      next.bank_ref      = blankToNull(patch.bank_ref)
  if ('payment_mode' in patch)  next.payment_mode  = depositMode(patch.payment_mode)
  if ('received_date' in patch) next.received_date = blankToNull(patch.received_date)
  if ('notes' in patch)         next.notes         = blankToNull(patch.notes)

  const changes = {}
  for (const [k, v] of Object.entries(next)) {
    const before = current[k]
    const same = k === 'amount' ? Number(before) === v : (before ?? null) === v
    if (!same) changes[k] = { old: before, new: v }
  }
  if (!Object.keys(changes).length) return current
  if (current.reservation_payment_id && (changes.amount || changes.received_date)) {
    throw new Error('This deposit came from a reservation payment: its amount and date cannot be changed.')
  }

  const { data: updated, error } = await supabase
    .from('tenant_deposits')
    .update(Object.fromEntries(Object.entries(changes).map(([k, c]) => [k, c.new])))
    .eq('id', id)
    .select()
    .single()
  if (error) throw error

  const meta = await depositTenantMeta(current.tenant_id)
  await logActivity({
    activity_type: 'Advance/Deposit Updated',
    entity_type:   'TENANT', entity_id: current.tenant_id,
    tenant_id:     current.tenant_id,
    tenant_name:   meta.tenant_name,
    room_no:       meta.room_no,
    bed_letter:    meta.bed_letter,
    actor_id:      actorId || null,
    notes:         `${DEPOSIT_KIND_LABEL[current.kind]} receipt updated (${Object.keys(changes).join(', ')})`,
    metadata:      { deposit_id: id, kind: current.kind, changes },
  })
  return updated
}

// ── Reservation payments (bed_reservation_payments) ───────────────────────────
// Money paid on a RESERVED bed before move-in. Rows are never deleted. HELD becomes APPLIED at Move In
// (carried into tenant_deposits by the DB), FORFEITED when the reservation ends (DB trigger on beds),
// or VOID (admin, with a reason). Reads are admin+user only (RLS).
const RESERVATION_SELECT = '*, beds!bed_id(bed_letter, rooms(room_no)), tenants!tenant_id(name)'

export async function fetchReservationPayments({ bedId, statuses } = {}) {
  let q = supabase.from('bed_reservation_payments').select(RESERVATION_SELECT)
  if (bedId != null) q = q.eq('bed_id', bedId)
  if (statuses?.length) q = q.in('status', statuses)
  const { data, error } = await q.order('received_date').order('id')
  if (error) throw error
  return data
}

export function fetchAllReservationPayments({ statuses } = {}) {
  return fetchReservationPayments({ statuses })
}

function reservationAmount(v) {
  const cents = parseMoney(v)
  if (cents == null) throw new Error(`Reservation payment: ${moneyProblem(v)}.`)
  if (cents <= 0) throw new Error('Reservation payment: amount must be greater than 0.')
  return centsToNumber(cents)
}

function reservationRef(v) {
  const r = blankToNull(v)
  if (r == null) throw new Error('Reservation payment: T.R# is required.')
  return r
}

function reservationMode(v) {
  if (!PAYMENT_MODES.includes(v)) throw new Error('Choose how the reservation was paid (BANK or CASH).')
  return v
}

async function reservationBedMeta(bedId) {
  const { data } = await supabase
    .from('beds')
    .select('bed_letter, rooms(room_no)')
    .eq('id', bedId)
    .maybeSingle()
  return { room_no: data?.rooms?.room_no, bed_letter: data?.bed_letter }
}

export async function addReservationPayment({ bedId, amount, refNo, bankRef, paymentMode, receivedDate, notes }, actorId) {
  const row = {
    bed_id:        bedId,
    amount:        reservationAmount(amount),
    ref_no:        reservationRef(refNo),
    bank_ref:      blankToNull(bankRef),
    payment_mode:  reservationMode(paymentMode),
    received_date: blankToNull(receivedDate) || undefined,
    notes:         blankToNull(notes),
    created_by:    actorId || null,
  }
  const { data, error } = await supabase.from('bed_reservation_payments').insert(row).select().single()
  if (error) throw error

  const meta = await reservationBedMeta(bedId)
  await logActivity({
    activity_type: 'Reservation Payment Recorded',
    entity_type:   'BED', entity_id: bedId,
    room_no:       meta.room_no,
    bed_letter:    meta.bed_letter,
    actor_id:      actorId || null,
    notes:         `Reservation payment ${peso(data.amount)}${data.ref_no ? ` (TR# ${data.ref_no})` : ''} recorded for ${data.reserved_name || 'reserved bed'} (${PAYMENT_MODE_LABEL[data.payment_mode]})`,
    metadata:      { reservation_payment_id: data.id, amount: data.amount, ref_no: data.ref_no, payment_mode: data.payment_mode, received_date: data.received_date },
  })
  return data
}

// Admin-only (RLS + trigger). Only HELD rows can change.
export async function updateReservationPayment(id, patch, actorId) {
  const { data: current, error: cErr } = await supabase
    .from('bed_reservation_payments').select('*').eq('id', id).single()
  if (cErr) throw cErr
  if (current.status !== 'HELD') throw new Error(`This reservation payment is ${current.status} and can no longer be changed.`)

  const next = {}
  if ('amount' in patch)        next.amount        = reservationAmount(patch.amount)
  if ('ref_no' in patch)        next.ref_no        = reservationRef(patch.ref_no)
  if ('bank_ref' in patch)      next.bank_ref      = blankToNull(patch.bank_ref)
  if ('payment_mode' in patch)  next.payment_mode  = reservationMode(patch.payment_mode)
  if ('received_date' in patch) {
    if (!blankToNull(patch.received_date)) throw new Error('Date received is required.')
    next.received_date = patch.received_date
  }
  if ('notes' in patch)         next.notes         = blankToNull(patch.notes)

  const changes = {}
  for (const [k, v] of Object.entries(next)) {
    const before = current[k]
    const same = k === 'amount' ? Number(before) === v : (before ?? null) === v
    if (!same) changes[k] = { old: before, new: v }
  }
  if (!Object.keys(changes).length) return current

  const { data: updated, error } = await supabase
    .from('bed_reservation_payments')
    .update(Object.fromEntries(Object.entries(changes).map(([k, c]) => [k, c.new])))
    .eq('id', id).eq('status', 'HELD')
    .select().single()
  if (error) throw error

  const meta = await reservationBedMeta(current.bed_id)
  await logActivity({
    activity_type: 'Reservation Payment Updated',
    entity_type:   'BED', entity_id: current.bed_id,
    room_no:       meta.room_no,
    bed_letter:    meta.bed_letter,
    actor_id:      actorId || null,
    notes:         `Reservation payment #${id} updated (${Object.keys(changes).join(', ')})`,
    metadata:      { reservation_payment_id: id, changes },
  })
  return updated
}

export async function voidReservationPayment(id, reason, actorId) {
  const why = (reason || '').trim()
  if (!why) throw new Error('A reason is required to void a reservation payment.')
  const { data, error } = await supabase
    .from('bed_reservation_payments')
    .update({ status: 'VOID', settled_note: why })
    .eq('id', id).eq('status', 'HELD')
    .select().single()
  if (error) throw error

  const meta = await reservationBedMeta(data.bed_id)
  await logActivity({
    activity_type: 'Reservation Payment Voided',
    entity_type:   'BED', entity_id: data.bed_id,
    room_no:       meta.room_no,
    bed_letter:    meta.bed_letter,
    actor_id:      actorId || null,
    notes:         `Reservation payment ${peso(data.amount)}${data.ref_no ? ` (TR# ${data.ref_no})` : ''} voided: ${why}`,
    metadata:      { reservation_payment_id: id, amount: data.amount, ref_no: data.ref_no, reason: why },
  })
  return data
}

const RPC_MISSING = 'The database update for reservation payments / split receipts (database/migrations/reservation_payments.sql) has not been applied yet. Ask an admin to apply it before moving anyone in.'

function isMissingRpc(error) {
  return error?.code === 'PGRST202' || error?.code === '42883'
}

// Harmless probe: an existing function rejects tenant 0 and writes nothing; only "function not found"
// matters. Lets Move In stop before creating a tenant it could not record receipts for.
export async function assertMoveInReceiptsAvailable() {
  const { error } = await supabase.rpc('record_move_in_receipts', {
    p_tenant_id: 0, p_advance_due: 0, p_deposit_due: 0, p_expected_reservation: 0, p_lines: [],
  })
  if (error && isMissingRpc(error)) throw new Error(RPC_MISSING)
}

// All money here is integer cents from receiptLines.js (line kinds ADVANCE, DEPOSIT, RESERVATION); converted once to exact 2-decimal numbers.
// The DB re-validates the sums with numeric arithmetic and writes everything in one transaction.
export async function recordMoveInReceipts(tenantId, { advanceDueCents, depositDueCents, expectedReservationCents, lines }) {
  const { data, error } = await supabase.rpc('record_move_in_receipts', {
    p_tenant_id:            tenantId,
    p_advance_due:          centsToNumber(advanceDueCents),
    p_deposit_due:          centsToNumber(depositDueCents),
    p_expected_reservation: centsToNumber(expectedReservationCents),
    p_lines: lines.map(l => ({
      kind:          l.kind,
      amount:        centsToNumber(l.amountCents),
      payment_mode:  l.paymentMode,
      ref_no:        l.refNo || null,
      bank_ref:      l.bankRef || null,
      received_date: l.receivedDate || null,
      notes:         l.notes || null,
    })),
  })
  if (error) throw isMissingRpc(error) ? new Error(RPC_MISSING) : error
  return data
}

export async function applyReservationPayments(tenantId) {
  const { data, error } = await supabase.rpc('apply_reservation_payments', { p_tenant_id: tenantId })
  if (error) throw isMissingRpc(error) ? new Error(RPC_MISSING) : error
  return data
}

// ── Final bills (move-out settlement) ─────────────────────────────────────────
// Bills are never deleted: voidFinalBill() sets status VOID + reason. Every write here
// throws on error; only the activity log is best-effort.
export async function fetchFinalBills(tenantId) {
  const { data, error } = await supabase
    .from('final_bills')
    .select('*')
    .eq('tenant_id', tenantId)
    .order('created_at', { ascending: false })
  if (error) throw error
  return data
}

export async function fetchFinalBill(id) {
  const { data, error } = await supabase.from('final_bills').select('*').eq('id', id).single()
  if (error) throw error
  return data
}

// Just what the automatic second-to-last advance credit needs, for every tenant.
export async function fetchFinalBillsLite() {
  const { data, error } = await supabase
    .from('final_bills')
    .select('tenant_id, status, early_termination, forfeit_waived')
  if (error) throw error
  return data
}

export async function fetchStoredAdvanceCredits() {
  const { data, error } = await supabase.from('advance_credits').select('*')
  if (error) throw error
  return data
}

// Inputs of finalBill.advanceCredits(). Viewers cannot read these tables (RLS), so for them the
// credit is simply not applied. Never throws: a failure comes back as `error` so the page can say
// that the credit is missing instead of failing to load the whole billing view.
export async function fetchAdvanceCreditData() {
  try {
    const [deposits, finalBills, stored] = await Promise.all([fetchAllTenantDeposits(), fetchFinalBillsLite(), fetchStoredAdvanceCredits()])
    return { deposits, finalBills, stored, error: null }
  } catch (e) {
    return { deposits: [], finalBills: [], stored: [], error: e.message }
  }
}

// Admin session only (RLS). Idempotent per (tenant, cutoff): a credit that is already recorded is kept.
export async function saveAdvanceCredits(rows, actorId) {
  if (!rows.length) return []
  const { data, error } = await supabase
    .from('advance_credits')
    .upsert(rows, { onConflict: 'tenant_id,cutoff_id', ignoreDuplicates: true })
    .select()
  if (error) throw error
  await logActivity({
    activity_type: 'Advance Credited',
    entity_type:   'CUTOFF', entity_id: rows[0].cutoff_id,
    actor_id:      actorId || null,
    notes:         `Second-to-last-bill advance credit recorded for ${rows.length} tenant(s): ${peso(rows.reduce((s, r) => s + Number(r.amount), 0))}.`,
    metadata:      { cutoff_id: rows[0].cutoff_id, tenant_ids: rows.map(r => r.tenant_id) },
  })
  return data
}

export async function saveFinalBill(bill, actorId) {
  if (!bill.tenant_id) throw new Error('Final bill: tenant is required.')
  if (!bill.move_out_date) throw new Error('Final bill: move-out date is required.')
  if (!Array.isArray(bill.lines) || bill.lines.length === 0) throw new Error('Final bill: at least one line is required.')
  for (const l of bill.lines) {
    if (!String(l.label ?? '').trim()) throw new Error('Final bill: every line needs a label.')
    if (!Number.isFinite(Number(l.amount))) throw new Error(`Final bill: line "${l.label}" has an invalid amount.`)
  }
  if (bill.forfeit_waived && !String(bill.waived_reason ?? '').trim()) {
    throw new Error('Final bill: a reason is required to waive the forfeiture.')
  }
  const lines = normalizeLines(bill.lines)
  const totals = computeTotals(lines)
  const { data, error } = await supabase
    .from('final_bills')
    .insert({
      tenant_id:         bill.tenant_id,
      cutoff_id:         bill.cutoff_id ?? null,
      status:            'FINAL',
      move_out_date:     bill.move_out_date,
      early_termination: !!bill.early_termination,
      forfeit_waived:    !!bill.forfeit_waived,
      waived_reason:     bill.forfeit_waived ? String(bill.waived_reason).trim() : null,
      lines,
      details:           bill.details ?? null,
      total_charges:     totals.total_charges,
      total_credits:     totals.total_credits,
      net_amount:        totals.net_amount,
      refund_status:     totals.net_amount < 0 ? 'PENDING' : 'NONE',
      prepared_by:       blankToNull(bill.prepared_by),
      created_by:        actorId || null,
    })
    .select()
    .single()
  if (error) throw error
  return data
}

// Admin-only (RLS): HELD -> APPLIED / FORFEITED. Throws unless every id is this tenant's and still HELD.
export async function settleTenantDeposits(ids, status, note, tenantId) {
  if (!ids.length) return []
  if (!tenantId) throw new Error('settleTenantDeposits: tenant id is required.')
  if (status !== 'APPLIED' && status !== 'FORFEITED') throw new Error(`Invalid receipt status: ${status}`)
  const { data, error } = await supabase
    .from('tenant_deposits')
    .update({ status, settled_note: note })
    .in('id', ids)
    .eq('tenant_id', tenantId)
    .eq('status', 'HELD')
    .select()
  if (error) throw error
  if (data.length !== ids.length) {
    throw new Error(`Only ${data.length} of ${ids.length} receipts could be set to ${status} (the others are not this tenant's or are no longer HELD).`)
  }
  return data
}

// Has this tenant really been moved out with a (non-void) final bill for this date? Used before an approval
// request is marked approved without being applied again.
export async function verifyMoveOutApplied(tenantId, moveOutDate) {
  const [t, b] = await Promise.all([
    supabase.from('tenants').select('is_active').eq('id', tenantId).single(),
    supabase.from('final_bills').select('id, move_out_date').eq('tenant_id', tenantId).eq('status', 'FINAL'),
  ])
  if (t.error) throw t.error
  if (b.error) throw b.error
  if (t.data.is_active) return { ok: false, reason: 'the tenant is still active' }
  const day = String(moveOutDate || '').slice(0, 10)
  const bill = b.data.find(x => String(x.move_out_date).slice(0, 10) === day)
  if (!bill) return { ok: false, reason: `there is no final bill for ${day}` }
  return { ok: true, billId: bill.id }
}

export async function voidFinalBill(id, reason, actorId) {
  if (!String(reason ?? '').trim()) throw new Error('A reason is required to void a final bill.')
  const { data: bill, error: bErr } = await supabase
    .from('final_bills')
    .update({ status: 'VOID', void_reason: reason.trim(), voided_at: new Date().toISOString() })
    .eq('id', id)
    .eq('status', 'FINAL')
    .select()
    .single()
  if (bErr) throw bErr

  const { error: rErr } = await supabase
    .from('tenant_deposits')
    .update({ status: 'HELD', settled_note: `Final bill #${id} voided: ${reason.trim()}` })
    .eq('tenant_id', bill.tenant_id)
    .like('settled_note', `Final bill #${id}:%`)
    .in('status', ['APPLIED', 'FORFEITED'])
  if (rErr) throw new Error(`Final bill #${id} was voided, but its advance/deposit receipts could NOT be set back to HELD (${rErr.message}). Fix them manually.`)

  const meta = await depositTenantMeta(bill.tenant_id)
  await logActivity({
    activity_type: 'Final Bill Voided',
    entity_type:   'TENANT', entity_id: bill.tenant_id,
    tenant_id:     bill.tenant_id,
    tenant_name:   meta.tenant_name, room_no: meta.room_no, bed_letter: meta.bed_letter,
    actor_id:      actorId || null,
    notes:         `Final bill #${id} voided. Reason: ${reason.trim()}`,
    metadata:      { final_bill_id: id, net_amount: bill.net_amount },
  })
  return bill
}

const settleNote = (billId, line) => {
  if (line.kind === 'forfeit') return `Final bill #${billId}: forfeited (early termination)`
  if (line.source === 'ADVANCE' && line.prior_cutoff) {
    const bal = -Number(line.amount)
    return `Final bill #${billId}: credited on second-to-last bill (cutoff ${line.prior_cutoff})`
      + (bal > 0 ? `; balance ${peso(bal)} applied on final bill` : '')
  }
  return `Final bill #${billId}: applied on final bill`
}

/**
 * ONE admin-side move-out: final bill saved first (nothing else is touched if that fails), then
 * the tenant is moved out / bed vacated / move-out readings saved, then the receipts are settled.
 * If a later step fails the error says exactly what was and was not done.
 *   moveOutData: { move_out_date, actual_move_out_date, amount_paid, water_reading, electric_reading }
 *   bill: { cutoff_id, lines, details, early_termination, forfeit_waived, waived_reason, prepared_by }
 * Returns { billId, net_amount }.
 */
export async function processMoveOutWithBill(tenant, moveOutData, bill, actorId) {
  const actual = moveOutData.actual_move_out_date || moveOutData.move_out_date

  // Refuse a duplicate / repeated move-out (the partial unique index uq_final_bills_one_final backs this up).
  const { data: cur, error: cErr } = await supabase.from('tenants').select('is_active').eq('id', tenant.id).single()
  if (cErr) throw cErr
  if (!cur.is_active) throw new Error('This tenant has already moved out; nothing was changed.')
  const { data: open, error: oErr } = await supabase
    .from('final_bills').select('id').eq('tenant_id', tenant.id).eq('status', 'FINAL')
  if (oErr) throw oErr
  if (open.length) throw new Error(`A final bill (#${open[0].id}) already exists for this tenant; nothing was changed. Void it first if it was issued by mistake.`)

  const saved = await saveFinalBill({ ...bill, tenant_id: tenant.id, move_out_date: actual }, actorId)
  const done = [`final bill #${saved.id} saved`]
  const fail = (step, err, advice) => Object.assign(new Error(
    `Final bill #${saved.id} was saved. Done: ${done.join('; ')}. FAILED: ${step} (${err.message}). ${advice}`), { partial: true, billId: saved.id })

  // 2. Tenant out. If this fails nothing else has changed, so cancel the bill again.
  const { error: tErr } = await supabase
    .from('tenants')
    .update({
      is_active:            false,
      move_out_date:        moveOutData.move_out_date || null,
      actual_move_out_date: actual,
    })
    .eq('id', tenant.id)
  if (tErr) {
    const { error: vErr } = await supabase
      .from('final_bills')
      .update({ status: 'VOID', void_reason: `Move-out failed: ${tErr.message}`, voided_at: new Date().toISOString() })
      .eq('id', saved.id)
    // partial = the tenant WAS moved out; here they were not. orphanBill = a FINAL bill is left behind on an active tenant.
    throw Object.assign(new Error(`Move-out failed (${tErr.message}); the tenant is still active. `
      + (vErr ? `The draft final bill #${saved.id} could NOT be voided automatically (${vErr.message}); void it from the tenant profile.`
              : `The draft final bill #${saved.id} was voided automatically. Nothing else changed.`)), { partial: false, orphanBill: !!vErr, billId: saved.id })
  }
  done.push('tenant marked moved out')

  try {
    if (tenant.bed_id) {
      await updateBedStatus(tenant.bed_id, 'VACANT')
      done.push('bed set to VACANT')
    }
  } catch (e) { throw fail('setting the bed to VACANT', e, 'Set the bed to Vacant on the Bed Map, then check the receipts and readings.') }

  const readings = []
  if (moveOutData.water_reading !== '' && moveOutData.water_reading != null) readings.push(['WATER', moveOutData.water_reading])
  if (moveOutData.electric_reading !== '' && moveOutData.electric_reading != null) readings.push(['ELECTRIC', moveOutData.electric_reading])
  if (readings.length && bill.cutoff_id && tenant.room_id) {
    const { error: iErr } = await supabase.from('interim_readings').insert(readings.map(([utility, v]) => ({
      cutoff_id: bill.cutoff_id, room_id: tenant.room_id, utility, reading_date: actual, reading_value: round2(v),
      moving_out_tenant_id: tenant.id, note: `Move-out reading — ${tenant.name}`,
    })))
    if (iErr) throw fail('saving the move-out meter readings', iErr, 'Add the move-out readings in Billing > Move-out readings; the remaining tenants are billed wrongly until you do.')
    done.push('move-out readings saved')
  }

  if (moveOutData.amount_paid) {
    const { error: pErr } = await supabase.from('payments').insert({
      tenant_id: tenant.id, payment_date: actual, amount: moveOutData.amount_paid,
      pay_type: 'Other', notes: 'Final payment on move-out',
    })
    if (pErr) throw fail('recording the final payment', pErr, 'Record the payment in Collections.')
    done.push('final payment recorded')
  }

  const groups = new Map()
  for (const l of bill.lines) {
    if (!l.deposit_ids?.length || (l.kind !== 'credit' && l.kind !== 'forfeit')) continue
    const status = l.kind === 'forfeit' ? 'FORFEITED' : 'APPLIED'
    const note = settleNote(saved.id, l)
    const key = `${status}|${note}`
    if (!groups.has(key)) groups.set(key, { status, note, ids: [] })
    groups.get(key).ids.push(...l.deposit_ids)
  }
  for (const g of groups.values()) {
    try {
      await settleTenantDeposits(g.ids, g.status, g.note, tenant.id)
      done.push(`${g.ids.length} receipt(s) set to ${g.status}`)
    } catch (e) { throw fail(`setting receipt(s) ${g.ids.join(', ')} to ${g.status}`, e, 'Set the advance/deposit status manually.') }
  }

  const totals = computeTotals(normalizeLines(bill.lines))
  await logActivity({
    activity_type:        'Move Out',
    tenant_id:            tenant.id,
    tenant_name:          tenant.name,
    room_no:              tenant._room_no,
    bed_letter:           tenant._bed_letter,
    rate:                 tenant.rate,
    move_in_date:         tenant.move_in_date,
    move_out_date:        moveOutData.move_out_date,
    actual_move_out_date: actual,
    amount_paid:          moveOutData.amount_paid ? Number(moveOutData.amount_paid) : null,
    actor_id:             actorId || null,
    entity_type:          'TENANT',
    entity_id:            tenant.id,
    notes:                `Moved out from Room ${tenant._room_no} Bed ${tenant._bed_letter}`,
  })
  await logActivity({
    activity_type: 'Final Bill Issued',
    tenant_id:     tenant.id,
    tenant_name:   tenant.name,
    room_no:       tenant._room_no,
    bed_letter:    tenant._bed_letter,
    actor_id:      actorId || null,
    entity_type:   'TENANT',
    entity_id:     tenant.id,
    notes:         `Final bill #${saved.id}: ${totals.net_amount < 0 ? `refund due ${peso(-totals.net_amount)}` : `amount due ${peso(totals.net_amount)}`}`
                   + `${bill.early_termination ? (bill.forfeit_waived ? ' · early termination, forfeiture waived' : ' · early termination, advance/deposit forfeited') : ''}`,
    metadata:      { final_bill_id: saved.id, net_amount: totals.net_amount, early_termination: !!bill.early_termination, forfeit_waived: !!bill.forfeit_waived },
  })
  return { billId: saved.id, net_amount: totals.net_amount }
}

export async function fetchPaymentsForCutoff(cutoffId) {
  const { data, error } = await supabase
    .from('payments')
    .select('*')
    .eq('cutoff_id', cutoffId)
    .order('payment_date', { ascending: false })
  if (error) throw error
  return data
}

export async function fetchPaymentsForMonth(year, month) {
  const pad = n => String(n).padStart(2, '0')
  const start   = `${year}-${pad(month)}-01`
  const lastDay = new Date(year, month, 0).getDate()
  const end     = `${year}-${pad(month)}-${pad(lastDay)}`
  const { data, error } = await supabase
    .from('payments')
    .select('*')
    .gte('payment_date', start)
    .lte('payment_date', end)
    .order('payment_date', { ascending: false })
  if (error) throw error
  return data
}

// ── Activity Log ──────────────────────────────────────────────────────────────
async function logActivity(entry) {
  const { error } = await supabase.from('activity_log').insert(entry)
  if (error) console.warn('activity_log insert failed:', error.message)
}

export async function fetchActivityLog() {
  const { data, error } = await supabase
    .from('activity_log')
    .select('*')
    .order('recorded_at', { ascending: false })
    .limit(200)
  if (error) throw error
  return data
}

// Server-filtered by activity_type — fetchActivityLog() is capped at 200 rows
// across ALL types, which would undercount a specific type once other activity
// crowds it out.
export async function fetchActivityLogByType(activityType, sinceISO) {
  let q = supabase
    .from('activity_log')
    .select('*')
    .eq('activity_type', activityType)
    .order('recorded_at', { ascending: false })
  if (sinceISO) q = q.gte('recorded_at', sinceISO)
  const { data, error } = await q
  if (error) throw error
  return data
}

export async function fetchTenantHistory(tenantId) {
  const { data, error } = await supabase
    .from('activity_log')
    .select('*')
    .eq('tenant_id', tenantId)
    .order('recorded_at', { ascending: false })
    .limit(100)
  if (error) throw error
  return data
}

export async function logBedStatusChange(bed, newStatus, reservedName = null) {
  await logActivity({
    activity_type: 'Bed Status Changed',
    entity_type:   'BED',
    room_no:       bed.room_no,
    bed_letter:    bed.bed_letter,
    notes:         `Room ${bed.room_no} Bed ${bed.bed_letter}: ${(bed.status || 'VACANT')} → ${newStatus}${reservedName ? ` (${reservedName})` : ''}`,
    metadata: {
      room_no:       bed.room_no,
      bed_letter:    bed.bed_letter,
      old_status:    bed.status || 'VACANT',
      new_status:    newStatus,
      reserved_name: reservedName || null,
    },
  })
}

export async function logTenantMoveOutDateChange(tenant, newMoveOutDate) {
  await logActivity({
    activity_type: 'Move-out Date Changed',
    tenant_id:     tenant.id,
    tenant_name:   tenant.name,
    room_no:       tenant.room_no,
    bed_letter:    tenant.bed_letter,
    entity_type:   'TENANT',
    entity_id:     tenant.id,
    notes:         `Room ${tenant.room_no} Bed ${tenant.bed_letter}: move-out date ${tenant.move_out_date?.slice(0, 10) || '—'} → ${newMoveOutDate || '—'}`,
    metadata: {
      old_move_out_date: tenant.move_out_date?.slice(0, 10) || null,
      new_move_out_date: newMoveOutDate || null,
    },
  })
}

export { PROFILE_FIELD_LABELS }

function entryNoteParts(d) {
  if (!d) return []
  const parts = [
    ...d.added.map(v => `+${v}`),
    ...d.removed.map(v => `−${v}`),
    ...d.updated.map(u => `${u.old} → ${u.new}`),
  ]
  if (d.primary) parts.push(`primary ${d.primary.old ?? '—'} → ${d.primary.new}`)
  return parts
}

// Throws, unlike logActivity(): this is the only audit record of which profile
// fields an applied change (admin save or approved request) touched, so a failed
// insert must surface to the caller.
export async function logTenantProfileEdit(tenant, { fields = {}, contacts = null, emails = null }) {
  const parts = Object.entries(fields).map(([k, c]) =>
    `${PROFILE_FIELD_LABELS[k] || k}: ${c.old ?? '—'} → ${c.new ?? '—'}`)
  const cp = entryNoteParts(contacts)
  if (cp.length) parts.push(`Contacts: ${cp.join(', ')}`)
  const ep = entryNoteParts(emails)
  if (ep.length) parts.push(`Emails: ${ep.join(', ')}`)

  const { error } = await supabase.from('activity_log').insert({
    activity_type: 'Tenant Profile Updated',
    tenant_id:     tenant.id,
    tenant_name:   tenant.name,
    room_no:       tenant.room_no,
    bed_letter:    tenant.bed_letter,
    entity_type:   'TENANT',
    entity_id:     tenant.id,
    notes:         `Room ${tenant.room_no} Bed ${tenant.bed_letter}: ${parts.join('; ')}`,
    metadata:      { changes: fields, contacts, emails },
  })
  if (error) throw error
}

// ── Rooms ─────────────────────────────────────────────────────────────────────

export async function fetchRooms() {
  const { data, error } = await supabase
    .from('rooms')
    .select('id, room_no, room_type')
    .order('room_no')
  if (error) throw error
  return data
}

// ── Maintenance Tickets ───────────────────────────────────────────────────────

export async function fetchTickets({ roomId, status } = {}) {
  let q = supabase
    .from('maintenance_tickets')
    .select(`
      *,
      rooms(room_no, room_type),
      tenants(id, name)
    `)
    .order('raised_at', { ascending: false })
  if (roomId) q = q.eq('room_id', roomId)
  if (status) q = q.eq('status', status)
  const { data, error } = await q
  if (error) throw error
  return data
}

export async function fetchProfileEmail(userId) {
  if (!userId) return null
  const { data, error } = await supabase
    .from('profiles').select('email').eq('id', userId).maybeSingle()
  if (error) throw error
  return data?.email || null
}

export async function addTicket({ roomId, tenantId, concern, remarks }) {
  const { data, error } = await supabase
    .from('maintenance_tickets')
    .insert({
      room_id:   roomId,
      tenant_id: tenantId || null,
      concern,
      remarks:   remarks || null,
    })
    .select(`*, rooms(room_no)`)
    .single()
  if (error) throw error

  // Log a REPAIR entry for this room
  await supabase.from('room_logs').insert({
    room_id:     roomId,
    event_type:  'REPAIR',
    description: concern,
  })

  // Log to activity
  await logActivity({
    activity_type: 'Ticket Raised',
    tenant_id:     tenantId || null,
    entity_type:   'TICKET',
    entity_id:     data.id,
    room_no:       data.rooms?.room_no || null,
    notes:         concern,
    metadata:      { concern, remarks: remarks || null, room_no: data.rooms?.room_no },
  })

  notifyAsync('maintenance_ticket', data.id)

  return data
}

export async function resolveTicket(id, resolutionNotes) {
  const { data: { user } } = await supabase.auth.getUser()
  const { data, error } = await supabase
    .from('maintenance_tickets')
    .update({
      status:           'RESOLVED',
      resolution_notes: resolutionNotes || null,
      resolved_by:      user.id,
      resolved_at:      new Date().toISOString(),
    })
    .eq('id', id)
    .select(`*, rooms(room_no)`)
    .single()
  if (error) throw error

  // Log to activity
  await logActivity({
    activity_type: 'Ticket Resolved',
    actor_id:      user.id,
    tenant_id:     data.tenant_id || null,
    entity_type:   'TICKET',
    entity_id:     id,
    room_no:       data.rooms?.room_no || null,
    notes:         resolutionNotes || `Ticket #${id} resolved`,
    metadata:      { concern: data.concern, resolution_notes: resolutionNotes, room_no: data.rooms?.room_no },
  })

  return data
}

export async function fetchTicketsForTenant(tenantId) {
  const { data, error } = await supabase
    .from('maintenance_tickets')
    .select(`*, rooms(room_no)`)
    .eq('tenant_id', tenantId)
    .order('raised_at', { ascending: false })
  if (error) throw error
  return data
}

// ── Tenant Transfers ──────────────────────────────────────────────────────────

/**
 * Execute a room transfer atomically:
 *   - Records the transfer
 *   - Creates interim readings for old room (for billing proration)
 *   - Moves tenant to new bed + updates rate
 *   - Marks old bed VACANT, new bed LEASED
 *   - Logs to activity
 *
 * tenant must include: { id, bed_id, room_id, room_no, bed_letter, name, rate }
 */
export async function processTransfer(tenant, transferData, actorId) {
  const { to_bed_id, transfer_date, new_rate, water_reading, electric_reading, to_water_reading, to_electric_reading, notes } = transferData

  // 1. Get destination bed + room
  const { data: newBed, error: nbErr } = await supabase
    .from('beds')
    .select('id, room_id, bed_letter, rooms(room_no)')
    .eq('id', to_bed_id)
    .single()
  if (nbErr) throw nbErr

  // 2. Insert transfer record
  const { data: xfer, error: xErr } = await supabase
    .from('tenant_transfers')
    .insert({
      tenant_id:        tenant.id,
      from_room_id:     tenant.room_id,
      from_bed_id:      tenant.bed_id,
      to_room_id:       newBed.room_id,
      to_bed_id,
      transfer_date,
      old_rate:         tenant.rate,
      new_rate:         new_rate || tenant.rate,
      water_reading:       water_reading       ? Number(water_reading)       : null,
      electric_reading:    electric_reading    ? Number(electric_reading)    : null,
      to_water_reading:    to_water_reading    ? Number(to_water_reading)    : null,
      to_electric_reading: to_electric_reading ? Number(to_electric_reading) : null,
      notes:               notes || null,
      status:           'COMPLETED',
      processed_by:     actorId || null,
    })
    .select()
    .single()
  if (xErr) throw xErr

  // 3. Record interim readings so billing can split each room's period correctly
  if (water_reading || electric_reading || to_water_reading || to_electric_reading) {
    const { data: cutoffs } = await supabase
      .from('cutoffs')
      .select('id')
      .eq('is_active', true)
      .limit(1)
    const cutoff = cutoffs?.[0]
    if (cutoff) {
      const readings = []

      // Old room: closing reading at transfer date (splits billing so only pre-transfer
      // consumption is charged to the transferred tenant in the old room)
      if (water_reading) readings.push({
        cutoff_id:            cutoff.id,
        room_id:              tenant.room_id,
        utility:              'WATER',
        reading_date:         transfer_date,
        reading_value:        Number(water_reading),
        moving_out_tenant_id: tenant.id,
        note:                 `Transfer out to Room ${newBed.rooms.room_no}`,
      })
      if (electric_reading) readings.push({
        cutoff_id:            cutoff.id,
        room_id:              tenant.room_id,
        utility:              'ELECTRIC',
        reading_date:         transfer_date,
        reading_value:        Number(electric_reading),
        moving_out_tenant_id: tenant.id,
        note:                 `Transfer out to Room ${newBed.rooms.room_no}`,
      })

      // New room: opening reading at transfer date (splits billing so consumption
      // BEFORE the tenant's arrival is charged only to existing occupants, and
      // consumption FROM their arrival is split with the transferred tenant)
      if (to_water_reading) readings.push({
        cutoff_id:            cutoff.id,
        room_id:              newBed.room_id,
        utility:              'WATER',
        reading_date:         transfer_date,
        reading_value:        Number(to_water_reading),
        moving_out_tenant_id: null,
        note:                 `Transfer-in from Room ${tenant.room_no}`,
      })
      if (to_electric_reading) readings.push({
        cutoff_id:            cutoff.id,
        room_id:              newBed.room_id,
        utility:              'ELECTRIC',
        reading_date:         transfer_date,
        reading_value:        Number(to_electric_reading),
        moving_out_tenant_id: null,
        note:                 `Transfer-in from Room ${tenant.room_no}`,
      })

      if (readings.length) {
        const { error: irErr } = await supabase.from('interim_readings').insert(readings)
        if (irErr) console.error('Interim reading insert failed:', irErr.message)
      }
    }
  }

  // 4. Update tenant: move to new bed, apply new rate, track previous location
  const { error: tErr } = await supabase
    .from('tenants')
    .update({
      bed_id:           to_bed_id,
      rate:             new_rate || tenant.rate,
      previous_bed_id:  tenant.bed_id,
      previous_room_id: tenant.room_id,
      transfer_date,
    })
    .eq('id', tenant.id)
  if (tErr) throw tErr

  // 5. Old bed → VACANT, new bed → LEASED
  await updateBedStatus(tenant.bed_id, 'VACANT')
  await updateBedStatus(to_bed_id, 'LEASED')

  // 6. Log activity
  await logActivity({
    activity_type: 'Room Transfer',
    actor_id:      actorId || null,
    tenant_id:     tenant.id,
    tenant_name:   tenant.name,
    entity_type:   'TRANSFER',
    entity_id:     xfer.id,
    room_no:       newBed.rooms.room_no,
    bed_letter:    newBed.bed_letter,
    rate:          new_rate || tenant.rate,
    move_in_date:  tenant.move_in_date || null,
    move_out_date: tenant.move_out_date || null,
    notes:         `Room ${tenant.room_no} → Room ${newBed.rooms.room_no}${new_rate && new_rate !== tenant.rate ? `, rate ₱${tenant.rate} → ₱${new_rate}` : ''}`,
    metadata: {
      from_room_no:    tenant.room_no,
      to_room_no:      newBed.rooms.room_no,
      from_bed_letter: tenant.bed_letter,
      to_bed_letter:   newBed.bed_letter,
      transfer_date,
      old_rate:        tenant.rate,
      new_rate:        new_rate || tenant.rate,
    },
  })

  return xfer
}

export async function updateTenantRate(tenantId, newRate, reason, meta, actorId) {
  const { data: current, error: cErr } = await supabase
    .from('tenants')
    .select('rate, is_active')
    .eq('id', tenantId)
    .single()
  if (cErr) throw cErr
  if (!current.is_active) throw new Error('Tenant is not active.')

  const { error } = await supabase.from('tenants').update({ rate: newRate }).eq('id', tenantId)
  if (error) throw error

  await logActivity({
    activity_type: 'Tenant Rate Corrected',
    entity_type:   'TENANT', entity_id: tenantId,
    tenant_id:     tenantId,
    tenant_name:   meta?.tenant_name,
    room_no:       meta?.room_no,
    bed_letter:    meta?.bed_letter,
    actor_id:      actorId,
    notes:         `${meta?.tenant_name || 'Tenant'} rate corrected: ₱${Number(current.rate).toLocaleString('en-PH')} → ₱${Number(newRate).toLocaleString('en-PH')}. Reason: ${reason}`,
    metadata: {
      changes: { rate: { old: current.rate, new: newRate } },
      reason,
    },
  })
}

// Admin-only direct correction (no approval path). Callers gate on isAdmin;
// RLS on tenants is the real enforcement.
export async function updateTenantMoveInDate(tenantId, newDate, reason, meta, actorId) {
  const { data: current, error: cErr } = await supabase
    .from('tenants')
    .select('move_in_date, move_out_date, is_active')
    .eq('id', tenantId)
    .single()
  if (cErr) throw cErr
  if (!current.is_active) throw new Error('Tenant is not active.')

  const valid = typeof newDate === 'string'
    && /^\d{4}-\d{2}-\d{2}$/.test(newDate)
    && !Number.isNaN(Date.parse(newDate))
    && new Date(newDate).toISOString().slice(0, 10) === newDate
  if (!valid) throw new Error('Please enter a valid move-in date.')

  const oldDate = current.move_in_date ? current.move_in_date.slice(0, 10) : null
  const moveOut = current.move_out_date ? current.move_out_date.slice(0, 10) : null
  if (moveOut && newDate >= moveOut) throw new Error('Move-in date must be before the move-out date.')
  if (newDate === oldDate) throw new Error('New move-in date must be different from the current one.')

  const { error } = await supabase.from('tenants').update({ move_in_date: newDate }).eq('id', tenantId)
  if (error) throw error

  await logActivity({
    activity_type: 'Tenant Move-in Date Corrected',
    entity_type:   'TENANT', entity_id: tenantId,
    tenant_id:     tenantId,
    tenant_name:   meta?.tenant_name,
    room_no:       meta?.room_no,
    bed_letter:    meta?.bed_letter,
    actor_id:      actorId,
    notes:         `${meta?.tenant_name || 'Tenant'} move-in date corrected: ${oldDate || '—'} → ${newDate}. Reason: ${reason}`,
    metadata: {
      changes: { move_in_date: { old: oldDate, new: newDate } },
      reason,
    },
  })
}

// ── Summary stats ─────────────────────────────────────────────────────────────
export async function fetchSummary() {
  const { data, error } = await supabase
    .from('occupancy_summary')
    .select('*')
  if (error) throw error
  return data
}

// ── Utilities (Water + Electric) ──────────────────────────────────────────────

export async function fetchCutoffs() {
  const { data, error } = await supabase
    .from('cutoffs')
    .select('*')
    .order('water_start', { ascending: false })
  if (error) throw error
  return data
}

export async function fetchUtilityBill(cutoffId) {
  const { data, error } = await supabase
    .from('v_utility_bill')
    .select('*')
    .eq('cutoff_id', cutoffId)
  if (error) throw error
  return data
}

// rows: [{ cutoff_id, room_id, utility, previous_reading, current_reading, rate }]
// consumption & amount are generated server-side.
// opts.log = false skips the activity-log line (used by field-level auto-save so it doesn't
// write one entry per edited field; only the explicit "Save All" logs).
export async function saveReadings(rows, opts = {}) {
  if (!rows.length) return
  const { error } = await supabase
    .from('meter_readings')
    .upsert(rows, { onConflict: 'cutoff_id,room_id,utility' })
  if (error) throw error
  if (opts.log === false) return
  const roomCount = new Set(rows.map(r => r.room_id)).size
  await logActivity({
    activity_type: 'Meter Readings Saved',
    entity_type:   'CUTOFF',
    entity_id:     rows[0].cutoff_id,
    notes:         `Saved meter readings for ${roomCount} room${roomCount !== 1 ? 's' : ''}.`,
  })
}

export async function openCutoff(p) {
  const { data, error } = await supabase.rpc('open_cutoff', {
    p_name:                   p.name,
    p_water_start:            p.water_start,
    p_water_end:              p.water_end,
    p_electric_start:         p.electric_start,
    p_electric_end:           p.electric_end,
    p_water_maynilad_rate:    p.water_maynilad_rate,
    p_water_bedspace_rate:    p.water_bedspace_rate,
    p_electric_meralco_rate:  p.electric_meralco_rate,
    p_electric_bedspace_rate: p.electric_bedspace_rate,
  })
  if (error) throw error
  await logActivity({
    activity_type: 'Cutoff Opened',
    entity_type:   'CUTOFF',
    entity_id:     data,
    notes: `"${p.name}" opened. Water ${p.water_start}–${p.water_end} @ ₱${p.water_bedspace_rate}/m³. Electric ${p.electric_start}–${p.electric_end} @ ₱${p.electric_bedspace_rate}/kWh.`,
  })
  return data
}

export async function updateCutoff(id, patch) {
  const { error } = await supabase.from('cutoffs').update(patch).eq('id', id)
  if (error) throw error
  await logActivity({
    activity_type: 'Cutoff Updated',
    entity_type:   'CUTOFF',
    entity_id:     id,
    notes:         'Billing period settings updated.',
  })
}

// Delete a cutoff (undo "open"). Cascades to its readings/areas/splits/one-time
// add-ons. Then reactivates the most recent remaining cutoff.
export async function deleteCutoff(id) {
  const { data: cutoff } = await supabase.from('cutoffs').select('name').eq('id', id).single()
  const { error } = await supabase.from('cutoffs').delete().eq('id', id)
  if (error) throw error
  const { data } = await supabase.from('cutoffs').select('id').order('water_start', { ascending: false }).limit(1)
  if (data && data[0]) {
    await supabase.from('cutoffs').update({ is_active: true }).eq('id', data[0].id)
  }
  await logActivity({
    activity_type: 'Cutoff Deleted',
    entity_type:   'CUTOFF',
    entity_id:     id,
    notes:         cutoff ? `Cutoff "${cutoff.name}" deleted.` : `Cutoff #${id} deleted.`,
  })
}

// ── Tenant Transfers (read) ───────────────────────────────────────────────────

export async function fetchTransfersForCutoff(cutoff) {
  let q = supabase
    .from('tenant_transfers')
    .select('*')
    .gte('transfer_date', cutoff.water_start)
    .eq('status', 'COMPLETED')
  // Only apply upper-bound filter when water_end is defined; an active (open)
  // period may not have water_end set yet — omitting the filter is safe because
  // computeBilling's own xDate >= wEnd guard handles future-dated transfers.
  if (cutoff.water_end) q = q.lt('transfer_date', cutoff.water_end)
  const { data, error } = await q
  if (error) throw error
  return data ?? []
}

// ── Interim (move-out) readings — for per-tenant billing segments ──────────────

export async function fetchInterimReadings(cutoffId) {
  const { data, error } = await supabase
    .from('interim_readings')
    .select('*')
    .eq('cutoff_id', cutoffId)
    .order('reading_date')
  if (error) throw error
  return data
}

export async function addInterimReading(r) {
  const { error } = await supabase.from('interim_readings').insert({
    cutoff_id:            r.cutoff_id,
    room_id:              r.room_id,
    utility:              r.utility,
    reading_date:         r.reading_date,
    reading_value:        r.reading_value,
    moving_out_tenant_id: r.moving_out_tenant_id || null,
    note:                 r.note || null,
  })
  if (error) throw error
  await logActivity({
    activity_type: 'Interim Reading Added',
    entity_type:   'INTERIM_READING',
    notes: `${r.utility} interim reading — Room ${r.room_id}, ${r.reading_date}, value: ${r.reading_value}${r.note ? ` (${r.note})` : ''}`,
  })
}

export async function deleteInterimReading(id) {
  const { data: ir } = await supabase.from('interim_readings').select('*').eq('id', id).single()
  const { error } = await supabase.from('interim_readings').delete().eq('id', id)
  if (error) throw error
  await logActivity({
    activity_type: 'Interim Reading Deleted',
    entity_type:   'INTERIM_READING',
    entity_id:     id,
    notes: ir
      ? `${ir.utility} interim reading deleted — Room ${ir.room_id}, ${ir.reading_date}, value: ${ir.reading_value}`
      : `Interim reading #${id} deleted.`,
  })
}

// ── Common-area readings (Lobby / Second Floor / Roof Deck / Commercial) ──────

export async function fetchAreaReadings(cutoffId) {
  const { data, error } = await supabase
    .from('area_readings')
    .select('*')
    .eq('cutoff_id', cutoffId)
  if (error) throw error
  return data
}

export async function upsertAreaReadings(rows) {
  if (!rows.length) return
  const { error } = await supabase
    .from('area_readings')
    .upsert(rows, { onConflict: 'cutoff_id,area_name,utility' })
  if (error) throw error
}

// ── Monthly report snapshots ──────────────────────────────────────────────────

const MONTHLY_REPORT_FIELD_LABELS = {
  occupancy_pct: 'Occupancy %', occupied_beds: 'Occupied beds', active_tenants: 'Active tenants',
  occupied_rooms: 'Occupied rooms', col_rent: 'Rent', col_water: 'Water', col_electric: 'Electricity',
  col_addons: 'Add-ons', col_total: 'Total collections', water_cost: 'Water cost',
  water_collections: 'Water collections', water_variance: 'Water variance', electric_cost: 'Electric cost',
  electric_collections: 'Electric collections', electric_variance: 'Electric variance', total_variance: 'Total variance',
}
const MONTHLY_REPORT_LOG_FIELDS = Object.keys(MONTHLY_REPORT_FIELD_LABELS)
const OCCUPANCY_LOG_FIELDS = ['occupancy_pct', 'occupied_beds', 'active_tenants', 'occupied_rooms']

function diffMonthlyReport(oldRow, newRow, fields) {
  const changes = {}
  fields.forEach(k => {
    const ov = oldRow?.[k] ?? null
    const nv = newRow?.[k] ?? null
    const oN = ov == null ? null : Number(ov)
    const nN = nv == null ? null : Number(nv)
    if (oN !== nN) changes[k] = { old: oN, new: nN }
  })
  return changes
}

function monthlyReportDiffNotes(periodName, changes) {
  const parts = Object.entries(changes).map(([k, c]) =>
    `${MONTHLY_REPORT_FIELD_LABELS[k] || k}: ${c.old ?? '—'} → ${c.new ?? '—'}`)
  return `${periodName || 'Monthly report'}: ${parts.join('; ')}`
}

export async function fetchMonthlyReports() {
  const { data, error } = await supabase
    .from('monthly_reports')
    .select('*')
    .order('period_date', { ascending: true })
  if (error) throw error
  return data
}

// actorId: pass the acting user's id (cutoff-open in Utilities.jsx, or the
// manual "Snapshot now" button in Reports.jsx) to record an activity_log diff
// of whichever fields this save actually changed.
export async function saveMonthlyReport(row, actorId = null) {
  const { data: existing } = await supabase
    .from('monthly_reports').select('*').eq('cutoff_id', row.cutoff_id).maybeSingle()
  const { data: saved, error } = await supabase
    .from('monthly_reports').upsert(row, { onConflict: 'cutoff_id' }).select('id').single()
  if (error) throw error
  if (!actorId) return
  const changes = diffMonthlyReport(existing, row, MONTHLY_REPORT_LOG_FIELDS)
  if (!Object.keys(changes).length) return
  await logActivity({
    activity_type: existing ? 'Monthly Report Snapshotted' : 'Monthly Report Created',
    entity_type:   'MONTHLY_REPORT',
    entity_id:     saved.id,
    actor_id:      actorId,
    notes:         monthlyReportDiffNotes(row.period_name, changes),
    metadata:      { cutoff_id: row.cutoff_id, period_name: row.period_name, changes },
  })
}

// Manual create/edit of a snapshot (backfill or override). Update by id, else insert.
export async function saveManualReport(row) {
  if (row.id) {
    const { id, ...patch } = row
    const { error } = await supabase.from('monthly_reports').update(patch).eq('id', id)
    if (error) throw error
  } else {
    const { error } = await supabase.from('monthly_reports').insert({ ...row, manual: true })
    if (error) throw error
  }
}

export async function deleteMonthlyReport(id) {
  const { error } = await supabase.from('monthly_reports').delete().eq('id', id)
  if (error) throw error
}

// Admin-triggered retroactive fix for day-weighted occupancy figures on past,
// non-manual months (Reports.jsx "Recompute occupancy %"). Callers must have
// already excluded manual=true rows and rows with no cutoff_id.
// rows: [{ id, cutoff_id, period_name, old: {...4 fields}, new: {...4 fields} }]
export async function recomputeOccupancyForReports(rows, actorId) {
  for (const r of rows) {
    const changes = diffMonthlyReport(r.old, r.new, OCCUPANCY_LOG_FIELDS)
    if (!Object.keys(changes).length) continue
    const { error } = await supabase.from('monthly_reports').update({
      occupancy_pct:  r.new.occupancy_pct,
      occupied_beds:  r.new.occupied_beds,
      active_tenants: r.new.active_tenants,
      occupied_rooms: r.new.occupied_rooms,
    }).eq('id', r.id)
    if (error) throw error
    await logActivity({
      activity_type: 'Monthly Report Recomputed',
      entity_type:   'MONTHLY_REPORT',
      entity_id:     r.id,
      actor_id:      actorId,
      notes:         monthlyReportDiffNotes(r.period_name, changes),
      metadata:      { cutoff_id: r.cutoff_id, period_name: r.period_name, changes },
    })
  }
}

// ── Add-ons / extra charges ───────────────────────────────────────────────────

export async function fetchAddons(cutoffId) {
  const { data, error } = await supabase
    .from('addons')
    .select('*')
    .or(`cutoff_id.is.null,cutoff_id.eq.${cutoffId}`)
  if (error) throw error
  return data
}

export async function saveAddon(row) {
  if (row.id) {
    const { id, ...patch } = row
    const { error } = await supabase.from('addons').update(patch).eq('id', id)
    if (error) throw error
    await logActivity({
      activity_type: 'Add-on Updated',
      tenant_id:     row.tenant_id || null,
      entity_type:   'ADDON',
      entity_id:     id,
      notes:         `"${row.label}" updated — ₱${row.amount}`,
    })
  } else {
    const { data, error } = await supabase.from('addons').insert(row).select('id').single()
    if (error) throw error
    await logActivity({
      activity_type: 'Add-on Saved',
      tenant_id:     row.tenant_id || null,
      entity_type:   'ADDON',
      entity_id:     data?.id,
      notes:         `"${row.label}" added — ₱${row.amount}${row.recurring ? ' (recurring)' : ' (one-time)'}`,
    })
  }
}

export async function deleteAddon(id) {
  const { data: addon } = await supabase.from('addons').select('*').eq('id', id).single()
  const { error } = await supabase.from('addons').delete().eq('id', id)
  if (error) throw error
  await logActivity({
    activity_type: 'Add-on Deleted',
    tenant_id:     addon?.tenant_id || null,
    entity_type:   'ADDON',
    entity_id:     id,
    notes:         addon ? `"${addon.label}" (₱${addon.amount}) deleted` : `Add-on #${id} deleted`,
  })
}

// ── Custom per-room utility split (overrides Method B for a cutoff) ────────────

export async function fetchSplits(cutoffId) {
  const { data, error } = await supabase
    .from('tenant_splits')
    .select('*')
    .eq('cutoff_id', cutoffId)
  if (error) throw error
  return data
}

// Replace the split for one (cutoff, room, utility): clear then insert.
export async function setRoomSplit(cutoffId, roomId, utility, rows) {
  const del = await supabase.from('tenant_splits')
    .delete().eq('cutoff_id', cutoffId).eq('room_id', roomId).eq('utility', utility)
  if (del.error) throw del.error
  if (rows && rows.length) {
    const { error } = await supabase.from('tenant_splits').insert(
      rows.map(r => ({ cutoff_id: cutoffId, room_id: roomId, utility,
                       tenant_id: r.tenant_id, weight_pct: r.weight_pct }))
    )
    if (error) throw error
  }
  await logActivity({
    activity_type: 'Room Split Updated',
    entity_type:   'SPLIT',
    notes: rows?.length
      ? `${utility} split for room ${roomId} set — ${rows.length} tenant${rows.length !== 1 ? 's' : ''}.`
      : `${utility} split for room ${roomId} cleared.`,
  })
}

// ── Tenant Contacts ───────────────────────────────────────────────────────────

export async function fetchTenantContacts(tenantId) {
  const { data, error } = await supabase
    .from('tenant_contacts')
    .select('*')
    .eq('tenant_id', tenantId)
    .order('is_primary', { ascending: false })
    .order('created_at')
  if (error) throw error
  return data
}

export async function addTenantContact(tenantId, { value, label, isPrimary = false }) {
  if (isPrimary) {
    await supabase.from('tenant_contacts').update({ is_primary: false }).eq('tenant_id', tenantId)
  }
  const { data, error } = await supabase
    .from('tenant_contacts')
    .insert({ tenant_id: tenantId, value, label: label || null, is_primary: isPrimary })
    .select()
    .single()
  if (error) throw error
  return data
}

export async function deleteTenantContact(id) {
  const { error } = await supabase.from('tenant_contacts').delete().eq('id', id)
  if (error) throw error
}

export async function setPrimaryContact(tenantId, contactId) {
  const { error: clearErr } = await supabase.from('tenant_contacts').update({ is_primary: false }).eq('tenant_id', tenantId)
  if (clearErr) throw clearErr
  const { error } = await supabase.from('tenant_contacts').update({ is_primary: true }).eq('id', contactId)
  if (error) throw error
}

export async function updateTenantContact(id, { value, label }) {
  const { error } = await supabase.from('tenant_contacts').update({ value, label: label || null }).eq('id', id)
  if (error) throw error
}

// ── Tenant Emails ─────────────────────────────────────────────────────────────

export async function fetchTenantEmails(tenantId) {
  const { data, error } = await supabase
    .from('tenant_emails')
    .select('*')
    .eq('tenant_id', tenantId)
    .order('is_primary', { ascending: false })
    .order('created_at')
  if (error) throw error
  return data
}

export async function addTenantEmail(tenantId, { value, label, isPrimary = false }) {
  if (isPrimary) {
    await supabase.from('tenant_emails').update({ is_primary: false }).eq('tenant_id', tenantId)
  }
  const { data, error } = await supabase
    .from('tenant_emails')
    .insert({ tenant_id: tenantId, value, label: label || null, is_primary: isPrimary })
    .select()
    .single()
  if (error) throw error
  return data
}

export async function deleteTenantEmail(id) {
  const { error } = await supabase.from('tenant_emails').delete().eq('id', id)
  if (error) throw error
}

export async function setPrimaryEmail(tenantId, emailId) {
  const { error: clearErr } = await supabase.from('tenant_emails').update({ is_primary: false }).eq('tenant_id', tenantId)
  if (clearErr) throw clearErr
  const { error } = await supabase.from('tenant_emails').update({ is_primary: true }).eq('id', emailId)
  if (error) throw error
}

export async function updateTenantEmail(id, { value, label }) {
  const { error } = await supabase.from('tenant_emails').update({ value, label: label || null }).eq('id', id)
  if (error) throw error
}

// ── Tenant Documents (Google Drive metadata) ──────────────────────────────────

export async function fetchTenantDocuments(tenantId) {
  const { data, error } = await supabase
    .from('tenant_documents')
    .select('*')
    .eq('tenant_id', tenantId)
    .order('uploaded_at', { ascending: false })
  if (error) throw error
  return data
}

export async function addTenantDocument(tenantId, { docType, filename, driveFileId, driveUrl, sizeBytes }) {
  const { data, error } = await supabase
    .from('tenant_documents')
    .insert({
      tenant_id:     tenantId,
      doc_type:      docType,
      filename,
      drive_file_id: driveFileId,
      drive_url:     driveUrl,
      size_bytes:    sizeBytes || null,
    })
    .select()
    .single()
  if (error) throw error
  return data
}

export async function deleteTenantDocument(id) {
  const { error } = await supabase.from('tenant_documents').delete().eq('id', id)
  if (error) throw error
}

// ── Property Management ───────────────────────────────────────────────────────

export async function fetchPropertySummary() {
  const [{ data: rooms, error: re }, { data: beds, error: be }, { data: tenants, error: te }] =
    await Promise.all([
      supabase.from('rooms').select('*').order('room_no'),
      supabase.from('beds').select('*'),
      supabase.from('tenants').select('id, rate, bed_id').is('actual_move_out_date', null),
    ])
  if (re) throw re
  if (be) throw be
  if (te) throw te

  return rooms.map(room => {
    const roomBeds   = beds.filter(b => b.room_id === room.id)
    const activeBeds = roomBeds.filter(b => b.status !== 'REMOVED')
    const leasedBeds = activeBeds.filter(b => b.status === 'LEASED')
    const leasedIds  = new Set(leasedBeds.map(b => b.id))
    const roomTenants = tenants.filter(t => leasedIds.has(t.bed_id))
    const lowerBeds  = activeBeds.filter(b => (b.bed_location || '').toUpperCase().includes('LOWER'))
    const upperBeds  = activeBeds.filter(b => (b.bed_location || '').toUpperCase().includes('UPPER'))
    return {
      ...room,
      beds:              roomBeds,
      current_bed_count: activeBeds.length,
      occupied_beds:     leasedBeds.length,
      tenant_count:      roomTenants.length,
      room_rate:         activeBeds.reduce((s, b) => s + (Number(b.default_rate) || 0), 0),
      actual_collected:  roomTenants.reduce((s, t) => s + (Number(t.rate) || 0), 0),
      lower_rate: lowerBeds.length ? Math.min(...lowerBeds.map(b => Number(b.default_rate) || 0)) : null,
      upper_rate: upperBeds.length ? Math.min(...upperBeds.map(b => Number(b.default_rate) || 0)) : null,
    }
  })
}

export async function updateRoomConfig(roomId, patch, actorId) {
  const { error } = await supabase.from('rooms').update(patch).eq('id', roomId)
  if (error) throw error
  await logActivity({
    activity_type: 'Room Config Updated',
    entity_type: 'ROOM', entity_id: roomId,
    actor_id: actorId,
    notes: `Room config updated: ${Object.entries(patch).map(([k, v]) => `${k}=${v}`).join(', ')}.`,
  })
}

export async function updateBedRate(bedId, rate, meta, actorId) {
  const { error } = await supabase.from('beds').update({ default_rate: rate }).eq('id', bedId)
  if (error) throw error
  await logActivity({
    activity_type: 'Bed Rate Updated',
    entity_type: 'BED', entity_id: bedId,
    room_no: meta?.room_no, bed_letter: meta?.bed_letter,
    actor_id: actorId,
    notes: `Bed ${meta?.bed_letter || bedId} in Room ${meta?.room_no || '?'}: rate set to ₱${Number(rate).toLocaleString('en-PH')}.`,
  })
}

export async function removeBed(bedId, meta, actorId) {
  const { error } = await supabase.from('beds').update({ status: 'REMOVED' }).eq('id', bedId)
  if (error) throw error
  await logActivity({
    activity_type: 'Bed Removed',
    entity_type: 'BED', entity_id: bedId,
    room_no: meta?.room_no, bed_letter: meta?.bed_letter,
    actor_id: actorId,
    notes: `Bed ${meta?.bed_letter || bedId} in Room ${meta?.room_no || '?'} marked REMOVED.`,
  })
}

export async function restoreBed(bedId, meta, actorId) {
  const { error } = await supabase.from('beds').update({ status: 'VACANT' }).eq('id', bedId)
  if (error) throw error
  await logActivity({
    activity_type: 'Bed Status Changed',
    entity_type: 'BED', entity_id: bedId,
    room_no: meta?.room_no, bed_letter: meta?.bed_letter,
    actor_id: actorId,
    notes: `Bed ${meta?.bed_letter || bedId} in Room ${meta?.room_no || '?'} restored to VACANT.`,
  })
}

// meta: { room_no, summary } — summary is the plain-English description shown
// in the modal's confirmation step, reused verbatim for room_logs/activity_log
// so the audit trail matches exactly what the admin confirmed.
export async function reconfigureRoom(roomId, { roomType, addBeds, removeBedIds, rateUpdates }, meta, actorId) {
  const { error } = await supabase.rpc('reconfigure_room', {
    p_room_id: roomId,
    p_room_type: roomType ?? null,
    p_add_beds: addBeds?.length ? addBeds : null,
    p_remove_bed_ids: removeBedIds?.length ? removeBedIds : null,
    p_rate_updates: rateUpdates?.length ? rateUpdates : null,
  })
  if (error) throw error

  const summary = meta?.summary || `Room ${meta?.room_no || roomId} reconfigured.`

  await supabase.from('room_logs').insert({
    room_id:     roomId,
    event_type:  'CONFIG_CHANGE',
    description: summary,
  })

  await logActivity({
    activity_type: 'Room Reconfigured',
    entity_type: 'ROOM', entity_id: roomId,
    room_no: meta?.room_no,
    actor_id: actorId,
    notes: summary,
    metadata: {
      room_no:      meta?.room_no,
      room_type:    roomType ?? null,
      beds_added:   addBeds?.length || 0,
      beds_removed: removeBedIds?.length || 0,
      rate_updates: rateUpdates?.length || 0,
    },
  })
}

// meta: { summary } — same convention as reconfigureRoom(): the confirm-step
// summary the admin saw is reused verbatim for room_logs/activity_log.
export async function createRoom(roomNo, roomType, floor, beds, meta, actorId) {
  const { data: roomId, error } = await supabase.rpc('create_room', {
    p_room_no:   roomNo,
    p_room_type: roomType || null,
    p_floor:     floor ?? null,
    p_beds:      beds,
  })
  if (error) throw error

  const summary = meta?.summary || `Room ${roomNo} created.`

  await supabase.from('room_logs').insert({
    room_id:     roomId,
    event_type:  'CONFIG_CHANGE',
    description: summary,
  })

  await logActivity({
    activity_type: 'Room Created',
    entity_type: 'ROOM', entity_id: roomId,
    room_no: roomNo,
    actor_id: actorId,
    notes: summary,
    metadata: {
      room_no:   roomNo,
      room_type: roomType || null,
      floor:     floor ?? null,
      bed_count: beds?.length || 0,
    },
  })

  return roomId
}

export async function retireRoom(roomId, newStatus, meta, actorId) {
  const { error } = await supabase.rpc('retire_room', {
    p_room_id:    roomId,
    p_new_status: newStatus || 'CONVERTED',
  })
  if (error) throw error

  const summary = meta?.summary || `Room ${meta?.room_no || roomId} retired.`

  await supabase.from('room_logs').insert({
    room_id:     roomId,
    event_type:  'STATUS_CHANGE',
    description: summary,
  })

  await logActivity({
    activity_type: 'Room Retired',
    entity_type: 'ROOM', entity_id: roomId,
    room_no: meta?.room_no,
    actor_id: actorId,
    notes: summary,
    metadata: {
      room_no:    meta?.room_no,
      new_status: newStatus || 'CONVERTED',
    },
  })
}

export async function fetchAddonTypes() {
  const { data, error } = await supabase
    .from('addon_types').select('*').eq('is_active', true).order('label')
  if (error) throw error
  return data
}

export async function saveAddonType(row, actorId) {
  const { id, ...fields } = row
  let saved
  if (id) {
    const { data, error } = await supabase.from('addon_types').update(fields).eq('id', id).select().single()
    if (error) throw error
    saved = data
  } else {
    const { data, error } = await supabase.from('addon_types').insert(fields).select().single()
    if (error) throw error
    saved = data
  }
  await logActivity({
    activity_type: id ? 'Add-on Type Updated' : 'Add-on Type Created',
    entity_type: 'ADDON_TYPE', entity_id: saved.id, actor_id: actorId,
    notes: `Add-on type "${fields.label}" (${fields.category}) ${id ? 'updated' : 'created'}.`,
  })
  return saved
}

export async function deactivateAddonType(id, label, actorId) {
  const { error } = await supabase.from('addon_types').update({ is_active: false }).eq('id', id)
  if (error) throw error
  await logActivity({
    activity_type: 'Add-on Type Deleted',
    entity_type: 'ADDON_TYPE', entity_id: id, actor_id: actorId,
    notes: `Add-on type "${label}" deactivated.`,
  })
}

export async function fetchAllAddons() {
  const { data, error } = await supabase
    .from('addons')
    .select(`id, tenant_id, cutoff_id, label, category, bill_on, amount, recurring, created_at,
             tenants(id, name, bed_id, beds!bed_id(bed_letter, room_id, rooms(room_no)))`)
    .order('created_at', { ascending: false })
  if (error) throw error
  return data
}

export async function addTenantAddon(row, actorId) {
  const { data, error } = await supabase.from('addons').insert(row).select('id').single()
  if (error) throw error
  await logActivity({
    activity_type: 'Add-on Saved',
    entity_type: 'ADDON', entity_id: data.id,
    tenant_id: row.tenant_id, actor_id: actorId,
    notes: `Add-on "${row.label}" ₱${Number(row.amount).toLocaleString('en-PH')} — ${row.recurring ? 'Recurring' : 'One-time'}.`,
  })
  return data
}

export async function removeTenantAddon(addonId, actorId) {
  const { data: addon } = await supabase
    .from('addons').select('label, amount, tenant_id').eq('id', addonId).single()
  const { error } = await supabase.from('addons').delete().eq('id', addonId)
  if (error) throw error
  await logActivity({
    activity_type: 'Add-on Deleted',
    entity_type: 'ADDON', entity_id: addonId,
    tenant_id: addon?.tenant_id, actor_id: actorId,
    notes: addon
      ? `Add-on "${addon.label}" ₱${Number(addon.amount).toLocaleString('en-PH')} deleted.`
      : `Add-on #${addonId} deleted.`,
  })
}

// ── Occupancy Simulator ─────────────────────────────────────────────────────
// Fully isolated: sim_rooms/sim_beds have no FK to rooms/beds/tenants/bills/
// payments, and nothing below ever reads or writes those tables.

export async function fetchSimSummary() {
  const { data, error } = await supabase
    .from('sim_rooms')
    .select('*, sim_beds(*)')
    .order('floor', { ascending: true })
    .order('room_no', { ascending: true })
  if (error) throw error
  return data
}

export async function updateSimBedRate(bedId, rate, actorId) {
  const { error } = await supabase
    .from('sim_beds')
    .update({ rate, updated_by: actorId })
    .eq('id', bedId)
  if (error) throw error
}

export async function updateSimBedOutOfOrder(bedId, isOutOfOrder, actorId) {
  const patch = { is_out_of_order: isOutOfOrder, updated_by: actorId }
  if (isOutOfOrder) patch.rate = null
  const { error } = await supabase.from('sim_beds').update(patch).eq('id', bedId)
  if (error) throw error
}

export async function replaceSimDataset(payload) {
  const { error } = await supabase.rpc('sim_replace_all', { p_rooms: payload })
  if (error) throw error
}
