import { createClient } from '@supabase/supabase-js'
import { notifyAsync } from './notify'
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
  return viewRes.data.map(b => ({ ...b, reserved_name: nameMap[b.bed_id] ?? null }))
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
  return data
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

  // 1. Insert tenant
  const { data: tenant, error: tErr } = await supabase
    .from('tenants')
    .insert({ bed_id: bedId, is_active: true, ...dbData })
    .select()
    .single()
  if (tErr) throw tErr

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

export async function processMoveOut(tenant, moveOutData) {
  // 1. Update tenant record
  const { error: tErr } = await supabase
    .from('tenants')
    .update({
      is_active:            false,
      move_out_date:        moveOutData.move_out_date || null,
      actual_move_out_date: moveOutData.actual_move_out_date || moveOutData.move_out_date,
    })
    .eq('id', tenant.id)
  if (tErr) throw tErr

  // 2. Mark bed as VACANT
  await updateBedStatus(tenant.bed_id, 'VACANT')

  // 3. Log payment if amount provided
  if (moveOutData.amount_paid) {
    await supabase.from('payments').insert({
      tenant_id:    tenant.id,
      payment_date: moveOutData.actual_move_out_date || new Date().toISOString().slice(0,10),
      amount:       moveOutData.amount_paid,
      pay_type:     'Other',
      notes:        'Final payment on move-out',
    })
  }

  // 4. Save move-out meter readings as interim readings
  if (moveOutData.water_reading || moveOutData.electric_reading) {
    const { data: cutoffs } = await supabase.from('cutoffs').select('id').eq('is_active', true).limit(1)
    const cutoffId = cutoffs?.[0]?.id
    if (cutoffId && tenant.room_id) {
      const readingDate = moveOutData.actual_move_out_date || moveOutData.move_out_date
      const readings = []
      if (moveOutData.water_reading) readings.push({
        cutoff_id:     cutoffId,
        room_id:       tenant.room_id,
        utility:       'WATER',
        reading_date:  readingDate,
        reading_value: Number(moveOutData.water_reading),
        note:          `Move-out reading — ${tenant.name}`,
      })
      if (moveOutData.electric_reading) readings.push({
        cutoff_id:     cutoffId,
        room_id:       tenant.room_id,
        utility:       'ELECTRIC',
        reading_date:  readingDate,
        reading_value: Number(moveOutData.electric_reading),
        note:          `Move-out reading — ${tenant.name}`,
      })
      if (readings.length) await supabase.from('interim_readings').insert(readings)
    }
  }

  // 5. Log activity
  await logActivity({
    activity_type:        'Move Out',
    tenant_id:            tenant.id,
    tenant_name:          tenant.name,
    room_no:              tenant._room_no,
    bed_letter:           tenant._bed_letter,
    rate:                 tenant.rate,
    move_in_date:         tenant.move_in_date,
    move_out_date:        moveOutData.move_out_date,
    actual_move_out_date: moveOutData.actual_move_out_date,
    amount_paid:          moveOutData.amount_paid,
    entity_type:          'TENANT',
    entity_id:            tenant.id,
    notes:                `Moved out from Room ${tenant._room_no} Bed ${tenant._bed_letter}`,
  })
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
export async function saveReadings(rows) {
  if (!rows.length) return
  const { error } = await supabase
    .from('meter_readings')
    .upsert(rows, { onConflict: 'cutoff_id,room_id,utility' })
  if (error) throw error
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

export async function fetchMonthlyReports() {
  const { data, error } = await supabase
    .from('monthly_reports')
    .select('*')
    .order('period_date', { ascending: true })
  if (error) throw error
  return data
}

export async function saveMonthlyReport(row) {
  const { error } = await supabase
    .from('monthly_reports')
    .upsert(row, { onConflict: 'cutoff_id' })
  if (error) throw error
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
