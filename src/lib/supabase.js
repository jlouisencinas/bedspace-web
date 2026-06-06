import { createClient } from '@supabase/supabase-js'

const url = import.meta.env.VITE_SUPABASE_URL
const key = import.meta.env.VITE_SUPABASE_ANON_KEY

export const isMissingConfig = !url || !key

// Only create the client when credentials exist
export const supabase = isMissingConfig ? null : createClient(url, key)

// ── Beds ──────────────────────────────────────────────────────────────────────
export async function fetchBeds() {
  const { data, error } = await supabase
    .from('beds_with_tenant')
    .select('*')
    .order('room_no')
    .order('bed_letter')
  if (error) throw error
  return data
}

export async function updateBedStatus(bedId, status) {
  const { error } = await supabase
    .from('beds')
    .update({ status })
    .eq('id', bedId)
  if (error) throw error
}

// ── Tenants ───────────────────────────────────────────────────────────────────
export async function fetchTenants() {
  const { data, error } = await supabase
    .from('tenants')
    .select(`*, beds(bed_letter, bed_location, room_id, rooms(room_no, room_type))`)
    .order('created_at', { ascending: false })
  if (error) throw error
  return data
}

export async function addTenant(bedId, tenantData) {
  // Strip helper fields used only for logging — not real DB columns
  const { _room_no, _bed_letter, ...dbData } = tenantData

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
  await logActivity({
    tenant_name:   dbData.name,
    room_no:       _room_no,
    bed_letter:    _bed_letter,
    rate:          dbData.rate,
    move_in_date:  dbData.move_in_date,
    activity_type: 'Move In',
  })

  return tenant
}

export async function processMoveOut(tenant, moveOutData) {
  // 1. Update tenant record
  const { error: tErr } = await supabase
    .from('tenants')
    .update({
      is_active:           false,
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

  // 4. Log activity
  await logActivity({
    tenant_name:         tenant.name,
    room_no:             tenant._room_no,
    bed_letter:          tenant._bed_letter,
    rate:                tenant.rate,
    move_in_date:        tenant.move_in_date,
    move_out_date:       moveOutData.move_out_date,
    actual_move_out_date: moveOutData.actual_move_out_date,
    amount_paid:         moveOutData.amount_paid,
    activity_type:       'Move Out',
  })
}

export async function recordPayment(tenantId, paymentData) {
  // 1. Insert into payment history
  const { error: pErr } = await supabase
    .from('payments')
    .insert({ tenant_id: tenantId, ...paymentData })
  if (pErr) throw pErr

  // 2. Update the last-pay date directly on the tenant row
  //    (mirrors the Google Sheets columns LAST PAYMENT DATE 10th / EOM)
  const colMap = { '10th': 'last_pay_10th', 'EOM': 'last_pay_eom' }
  const col = colMap[paymentData.pay_type]
  if (col) {
    const { error: tErr } = await supabase
      .from('tenants')
      .update({ [col]: paymentData.payment_date })
      .eq('id', tenantId)
    if (tErr) throw tErr
  }
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

// ── Activity Log ──────────────────────────────────────────────────────────────
async function logActivity(entry) {
  await supabase.from('activity_log').insert(entry)
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
  return data
}

export async function updateCutoff(id, patch) {
  const { error } = await supabase.from('cutoffs').update(patch).eq('id', id)
  if (error) throw error
}

// Delete a cutoff (undo "open"). Cascades to its readings/areas/splits/one-time
// add-ons. Then reactivates the most recent remaining cutoff.
export async function deleteCutoff(id) {
  const { error } = await supabase.from('cutoffs').delete().eq('id', id)
  if (error) throw error
  const { data } = await supabase.from('cutoffs').select('id').order('water_start', { ascending: false }).limit(1)
  if (data && data[0]) {
    await supabase.from('cutoffs').update({ is_active: true }).eq('id', data[0].id)
  }
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
}

export async function deleteInterimReading(id) {
  const { error } = await supabase.from('interim_readings').delete().eq('id', id)
  if (error) throw error
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
  } else {
    const { error } = await supabase.from('addons').insert(row)
    if (error) throw error
  }
}

export async function deleteAddon(id) {
  const { error } = await supabase.from('addons').delete().eq('id', id)
  if (error) throw error
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
}
