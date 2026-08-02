/**
 * src/lib/billing.js
 * ------------------
 * Per-tenant utility billing via SEGMENT-based Method B (per-day equal split).
 *
 * A cutoff is sliced into segments by interim (move-out) readings. Each segment
 * has exact metered consumption (reading delta). Within a segment, each day's
 * cost is split equally among the tenants present that day. This:
 *   • charges a moved-out tenant only for the days they were present
 *   • makes remaining tenants absorb the post-move-out days
 *   • leaves fully-vacant days unbilled
 *   • reconciles exactly: Σ tenant amounts (+ unbilled) = room total
 */

const MS_DAY = 86400000
export const dayNum = (iso) =>
  iso ? Math.floor(Date.parse(String(iso).slice(0, 10) + 'T00:00:00Z') / MS_DAY) : null

const num = (v) => { const n = parseFloat(v); return isNaN(n) ? 0 : n }

// Is tenant present on day index d? (move-out inclusive; active → through period end)
function present(t, d, endExclusive) {
  const inD  = t.moveInNum == null ? -Infinity : t.moveInNum
  const outD = t.moveOutNum == null ? endExclusive - 1 : t.moveOutNum
  return d >= inD && d <= outD
}

/**
 * Split one room+utility over a cutoff window.
 * points: sorted [{ dateNum, reading }] = start, interims…, end
 * tenants: [{ id, moveInNum, moveOutNum }]
 * returns { amt:{id→amount}, cons:{id→consumption}, roomCons, roomAmt, unbilled }
 */
export function splitRoomUtility(points, tenants, rate, startNum, endNum) {
  const amt = {}, cons = {}
  tenants.forEach(t => { amt[t.id] = 0; cons[t.id] = 0 })
  let roomCons = 0, roomAmt = 0, unbilled = 0

  const n = points.length - 1
  for (let k = 1; k <= n; k++) {
    const prev = points[k - 1], cur = points[k]
    const segCons = num(cur.reading) - num(prev.reading)
    const segAmt  = segCons * rate
    roomCons += segCons; roomAmt += segAmt

    const segStart   = (k === 1) ? startNum : prev.dateNum + 1
    const segEndExcl = (k === n) ? endNum   : cur.dateNum + 1
    const days = segEndExcl - segStart
    if (days <= 0) continue

    const dAmt = segAmt / days
    const dCons = segCons / days
    // Tenants who overlap this segment at all (moveIn ≤ segEnd−1 AND moveOut ≥ segStart).
    // Used as fallback for days where no tenant is individually "present" (e.g. gap
    // between a move-out and the next move-in). This ensures no consumption goes
    // unbilled as long as the segment has at least one occupant.
    const segOccupants = tenants.filter(t => {
      const inD  = t.moveInNum  == null ? -Infinity : t.moveInNum
      const outD = t.moveOutNum == null ? endNum - 1 : t.moveOutNum
      return inD <= segEndExcl - 1 && outD >= segStart
    })
    for (let d = segStart; d < segEndExcl; d++) {
      const here = tenants.filter(t => present(t, d, endNum))
      const effective = here.length > 0 ? here : segOccupants
      if (effective.length === 0) { unbilled += dAmt; continue }
      const sA = dAmt / effective.length, sC = dCons / effective.length
      effective.forEach(t => { amt[t.id] += sA; cons[t.id] += sC })
    }
  }
  return { amt, cons, roomCons, roomAmt, unbilled }
}

/**
 * Build the full billing for a cutoff.
 *
 * cutoff:   { water_start, water_end, electric_start, electric_end, ... }
 * billRows: from fetchUtilityBill — per room: room_id, room_no, room_type,
 *           water_prev, water_curr, water_rate, elec_prev, elec_curr, elec_rate
 * interims: from fetchInterimReadings — { room_id, utility, reading_date, reading_value }
 * tenants:  from fetchTenants — id, name, rate, move_in_date, move_out_date,
 *           actual_move_out_date, is_active, beds{ bed_letter, room_id }
 *
 * Returns { perRoom: [...], perTenant: [...] }
 */
// Custom split: distribute the metered room total by tenant weights instead of
// per-day Method B. Returns the same shape as splitRoomUtility.
function splitByWeights(points, roomTenants, rate, weightById) {
  let roomCons = 0
  for (let k = 1; k < points.length; k++) roomCons += num(points[k].reading) - num(points[k - 1].reading)
  const roomAmt = roomCons * rate
  const totalW = roomTenants.reduce((s, t) => s + (num(weightById[t.id]) || 0), 0)
  const amt = {}, cons = {}
  roomTenants.forEach(t => {
    const w = totalW > 0 ? (num(weightById[t.id]) || 0) / totalW : 0
    amt[t.id] = roomAmt * w; cons[t.id] = roomCons * w
  })
  const used = roomTenants.reduce((s, t) => s + amt[t.id], 0)
  return { amt, cons, roomCons, roomAmt, unbilled: roomAmt - used }
}

export function computeBilling(cutoff, billRows, interims, tenants, splits = [], addons = [], areaReadings = [], transfers = []) {
  // Custom splits indexed by room|utility → { tenant_id: weight_pct }
  const splitMap = {}
  splits.forEach(s => {
    const k = `${s.room_id}|${s.utility}`
    ;(splitMap[k] ||= {})[s.tenant_id] = s.weight_pct
  })
  const distribute = (points, roomTenants, rate, sNum, eNum, roomId, utility) => {
    const w = splitMap[`${roomId}|${utility}`]
    return w ? splitByWeights(points, roomTenants, rate, w)
             : splitRoomUtility(points, roomTenants, rate, sNum, eNum)
  }
  // For open (active) periods where water_end / electric_end is not yet set, fall back
  // to tomorrow so overlaps() and splitRoomUtility() work correctly. Without a finite
  // end, overlaps() evaluates `moveInNum <= null - 1 = -1` and drops every tenant.
  const tomorrowNum = Math.floor(Date.now() / MS_DAY) + 1
  const wStart = dayNum(cutoff.water_start),    wEnd = dayNum(cutoff.water_end)    ?? tomorrowNum
  const eStart = dayNum(cutoff.electric_start), eEnd = dayNum(cutoff.electric_end) ?? tomorrowNum

  // Index tenants by room with day-numbers.
  // Only active tenants appear in billing — settled/moved-out tenants still hold
  // their old bed_id FK after move-out, which would otherwise pull them into the
  // wrong billing period. Their billing is handled at the time of move-out.
  const tByRoom = {}
  tenants.forEach(t => {
    if (!t.is_active) return
    const roomId = t.beds?.room_id
    if (!roomId) return
    const moveIn  = t.move_in_date
    const moveOut = t.actual_move_out_date || t.move_out_date
    const rec = {
      id: t.id, name: t.name, rate: num(t.rate), is_active: t.is_active,
      bed: t.beds?.bed_letter || '',
      moveInNum:  dayNum(moveIn),
      moveOutNum: dayNum(moveOut),  // null = still active
    }
    ;(tByRoom[roomId] ||= []).push(rec)
  })

  // Transfer-aware: when a tenant moved rooms within this billing window, split their
  // presence across old and new room so each room's water/electric billing sees them.
  transfers.forEach(xfer => {
    const xDate = dayNum(xfer.transfer_date)
    if (!xDate || xDate <= wStart || xDate >= wEnd) return

    // In new room: tenant starts from transfer date, not original move-in
    const newRecs = tByRoom[xfer.to_room_id] || []
    const newRec  = newRecs.find(r => r.id === xfer.tenant_id)
    if (newRec) newRec.moveInNum = xDate

    // In old room: tenant was present up to (and including) day before transfer
    const alreadyInOld = (tByRoom[xfer.from_room_id] || []).some(r => r.id === xfer.tenant_id)
    if (!alreadyInOld) {
      ;(tByRoom[xfer.from_room_id] ||= []).push({
        id:         xfer.tenant_id,
        name:       newRec?.name || '',
        rate:       num(xfer.old_rate),
        is_active:  false,
        bed:        '',
        moveInNum:  null,       // present from period start (or their move-in date)
        moveOutNum: xDate - 1,  // last day in old room
        _isTransfer: true,
      })
    }
  })

  // Interim readings grouped by room+utility
  const interByRoom = {}
  interims.forEach(ir => {
    const key = `${ir.room_id}|${ir.utility}`
    ;(interByRoom[key] ||= []).push({ dateNum: dayNum(ir.reading_date), reading: num(ir.reading_value) })
  })

  // Tenants overlapping a window
  const overlaps = (t, s, e) =>
    (t.moveInNum == null || t.moveInNum <= e - 1) &&
    (t.moveOutNum == null || t.moveOutNum >= s)

  const buildPoints = (roomId, utility, s, e, startR, endR) => {
    const pts = [{ dateNum: s, reading: startR }]
    const mids = (interByRoom[`${roomId}|${utility}`] || [])
      .filter(p => p.dateNum > s && p.dateNum < e)
      .sort((a, b) => a.dateNum - b.dateNum)
    pts.push(...mids)
    pts.push({ dateNum: e, reading: endR })
    return pts
  }

  const perRoom = []
  const tenantAcc = {}  // id → { water, waterCons, elec, elecCons }

  // Real-tenant lookup so _isTransfer virtual entries don't corrupt name/bed/settled
  const tenantById = {}
  tenants.forEach(t => { tenantById[t.id] = t })

  const ensure = (t) => {
    if (tenantAcc[t.id]) return tenantAcc[t.id]
    const real = tenantById[t.id]
    return (tenantAcc[t.id] = {
      id: t.id,
      name:  real?.name             || t.name,
      bed:   real?.beds?.bed_letter || t.bed,
      room_id: null, room_no: null, room_type: null,
      rent: 0, water: 0, waterCons: 0, elec: 0, elecCons: 0,
      oldWater: 0, oldWaterCons: 0, oldElec: 0, oldElecCons: 0,
      waterPrev: null, waterCurr: null, elecPrev: null, elecCurr: null,
      fromRoomNo: null,
      transferred: false,
      wholeRoom:   false,
      settled: real ? !real.is_active : !t.is_active,
    })
  }

  // ── Whole-room rental detection ─────────────────────────────────────────────
  // If every currently-active occupant in a room shares the same name they are
  // one person renting the entire room. Collapse to a single billing row so the
  // full room utility and combined rent appear on one line.
  const wholeRoomRates = {}  // roomId → { tenantId, combinedRate }
  Object.keys(tByRoom).forEach(roomIdStr => {
    const roomId = Number(roomIdStr)
    const recs   = tByRoom[roomId]
    const active = recs.filter(r => !r._isTransfer && r.moveOutNum == null)
    if (active.length < 2) return
    const uniq = new Set(active.map(r => (tenantById[r.id]?.name || '').trim().toLowerCase()))
    if (uniq.size !== 1) return  // different names → normal per-bed billing
    const primary = active[0]
    wholeRoomRates[roomId] = {
      tenantId:     primary.id,
      combinedRate: active.reduce((s, r) => s + num(tenantById[r.id]?.rate), 0),
    }
    // Remove all but the primary so utility split gives them 100% of the room
    tByRoom[roomId] = recs.filter(r => r.id === primary.id || r._isTransfer)
  })

  billRows.forEach(br => {
    const roomTenants = tByRoom[br.room_id] || []

    // WATER
    const wt = roomTenants.filter(t => overlaps(t, wStart, wEnd))
    const wPts = buildPoints(br.room_id, 'WATER', wStart, wEnd, num(br.water_prev), num(br.water_curr))
    const wRes = distribute(wPts, wt, num(br.water_rate), wStart, wEnd, br.room_id, 'WATER')

    // ELECTRIC
    const et = roomTenants.filter(t => overlaps(t, eStart, eEnd))
    const ePts = buildPoints(br.room_id, 'ELECTRIC', eStart, eEnd, num(br.elec_prev), num(br.elec_curr))
    const eRes = distribute(ePts, et, num(br.elec_rate), eStart, eEnd, br.room_id, 'ELECTRIC')

    // Skip room-info update for _isTransfer virtual entries so they don't overwrite the
    // tenant's current (new) room — room info is corrected in the post-process below.
    wt.forEach(t => { const a = ensure(t); if (!t._isTransfer) { a.room_id = br.room_id; a.room_no = br.room_no; a.room_type = br.room_type; a.waterPrev = br.water_prev; a.waterCurr = br.water_curr } a.water += wRes.amt[t.id]; a.waterCons += wRes.cons[t.id]; if (t._isTransfer) { a.oldWater += wRes.amt[t.id]; a.oldWaterCons += wRes.cons[t.id] } })
    et.forEach(t => { const a = ensure(t); if (!t._isTransfer) { a.room_id = br.room_id; a.room_no = br.room_no; a.room_type = br.room_type; a.elecPrev = br.elec_prev; a.elecCurr = br.elec_curr } a.elec  += eRes.amt[t.id]; a.elecCons += eRes.cons[t.id]; if (t._isTransfer) { a.oldElec += eRes.amt[t.id]; a.oldElecCons += eRes.cons[t.id] } })

    const wSum = wt.reduce((s, t) => s + wRes.amt[t.id], 0)
    const eSum = et.reduce((s, t) => s + eRes.amt[t.id], 0)
    perRoom.push({
      room_id: br.room_id, room_no: br.room_no, room_type: br.room_type,
      water:    { roomAmt: wRes.roomAmt, roomCons: wRes.roomCons, sum: wSum, unbilled: wRes.unbilled, ok: Math.abs(wSum + wRes.unbilled - wRes.roomAmt) < 0.01, segments: wPts.length - 1 },
      electric: { roomAmt: eRes.roomAmt, roomCons: eRes.roomCons, sum: eSum, unbilled: eRes.unbilled, ok: Math.abs(eSum + eRes.unbilled - eRes.roomAmt) < 0.01, segments: ePts.length - 1 },
    })
  })

  // Ensure transferred tenants display under their current (new) room, not the old one.
  // Also override meter readings so billing shows the old-room context (period-start reading
  // → transfer reading) — matching exactly what was entered in the transfer modal.
  transfers.forEach(xfer => {
    const a = tenantAcc[xfer.tenant_id]
    if (!a) return
    const real = tenantById[xfer.tenant_id]
    if (!real?.beds?.room_id) return

    // ── Room: pin to new room ──────────────────────────────────────────────────
    const newBill = billRows.find(b => b.room_id === real.beds.room_id)
    if (newBill) {
      a.room_id   = newBill.room_id
      a.room_no   = newBill.room_no
      a.room_type = newBill.room_type
    } else if (!a.room_id) {
      a.room_id   = real.beds.room_id
      a.room_no   = real.beds.rooms?.room_no   ?? '?'
      a.room_type = real.beds.rooms?.room_type ?? ''
    }

    // ── Readings: show old-room period-start → transfer reading ───────────────
    // This makes the meter reading the user entered in the transfer modal visible
    // in billing. Water (m³) and Elec (kWh) amounts already include both the old
    // and new room portions; the readings here represent the old-room segment.
    const fromBill = billRows.find(b => b.room_id === xfer.from_room_id)
    if (fromBill) {
      a.fromRoomNo = fromBill.room_no
      if (xfer.water_reading    != null) { a.waterPrev = fromBill.water_prev; a.waterCurr = xfer.water_reading }
      if (xfer.electric_reading != null) { a.elecPrev  = fromBill.elec_prev;  a.elecCurr  = xfer.electric_reading }
    }

    a.transferred = true   // flag for UI badge
  })

  // Rent: prorated for mid-period move-ins; transfer splits rent across old+new room.
  // Moved-out tenants → 0 (they settle on move-out).
  Object.values(tenantAcc).forEach(a => {
    const t = tenants.find(x => x.id === a.id)
    if (!t) return

    const moveOut = t.actual_move_out_date || t.move_out_date
    const movedOut = !t.is_active || (moveOut && dayNum(moveOut) < wEnd - 1)
    if (movedOut) { a.rent = 0; return }

    const periodDays = wEnd - wStart

    // Transferred within this billing window: split rent at old rate + new rate
    const xfer = transfers.find(x =>
      x.tenant_id === a.id &&
      dayNum(x.transfer_date) > wStart &&
      dayNum(x.transfer_date) < wEnd
    )
    if (xfer) {
      const xDate  = dayNum(xfer.transfer_date)
      const moveIn = dayNum(t.move_in_date)
      // Days in old room (from period start or their move-in, to day before transfer)
      const oldStart = Math.max(moveIn ?? wStart, wStart)
      const oldDays  = Math.max(0, xDate - oldStart)
      // Days in new room (from transfer day to period end)
      const newDays  = Math.max(0, wEnd - xDate)
      a.rent = num(xfer.old_rate) * (oldDays / periodDays)
             + num(xfer.new_rate || t.rate) * (newDays / periodDays)
      return
    }

    // Whole-room rental: use the combined rate of all same-name beds
    const wr = wholeRoomRates[a.room_id]
    const effectiveRate = (wr && wr.tenantId === a.id) ? wr.combinedRate : num(t.rate)
    if (wr && wr.tenantId === a.id) a.wholeRoom = true

    // Mid-period move-in: prorate by days present
    const moveIn = dayNum(t.move_in_date)
    if (moveIn != null && moveIn > wStart) {
      const daysPresent = Math.max(0, wEnd - moveIn)
      a.rent = effectiveRate * (daysPresent / periodDays)
    } else {
      a.rent = effectiveRate
    }
  })

  // ── Special / non-bed tenants (commercial, parking-only) ───────────────────
  const wBed = num(cutoff.water_bedspace_rate), eBed = num(cutoff.electric_bedspace_rate)
  tenants.filter(t => t.is_active && !t.beds?.room_id).forEach(t => {
    const a = (tenantAcc[t.id] ||= {
      id: t.id, name: t.name, bed: '', room_id: null,
      room_no: t.unit_label || '—', room_type: t.category || 'OTHER',
      rent: 0, water: 0, waterCons: 0, elec: 0, elecCons: 0, settled: false,
      special: true, category: t.category || 'OTHER',
    })
    a.rent = num(t.rate)
    // Commercial utilities come from area readings linked to this tenant
    if (t.category === 'COMMERCIAL') {
      areaReadings.filter(ar => ar.tenant_id === t.id).forEach(ar => {
        const c = ar.consumption !== undefined ? num(ar.consumption)
                : (num(ar.current_reading) - num(ar.previous_reading))
        if (ar.utility === 'WATER') { a.waterCons += c; a.water += c * wBed }
        else { a.elecCons += c; a.elec += c * eBed }
      })
    }
  })

  // ── Add-ons (recurring, or one-time for this cutoff) ───────────────────────
  const addonByTenant = {}
  addons.forEach(ad => {
    if (!(ad.recurring || ad.cutoff_id === cutoff.id)) return
    ;(addonByTenant[ad.tenant_id] ||= []).push(ad)
  })
  Object.values(tenantAcc).forEach(a => {
    const list = addonByTenant[a.id] || []
    a.addons = list
    a.addonRentWater = list.filter(x => x.bill_on !== 'ELECTRIC').reduce((s, x) => s + num(x.amount), 0)
    a.addonElectric  = list.filter(x => x.bill_on === 'ELECTRIC').reduce((s, x) => s + num(x.amount), 0)
    a.total = a.rent + a.water + a.elec + a.addonRentWater + a.addonElectric
  })

  const perTenant = Object.values(tenantAcc).sort((x, y) =>
    (x.special ? 1 : 0) - (y.special ? 1 : 0) ||
    (parseInt(x.room_no) || 0) - (parseInt(y.room_no) || 0) ||
    String(x.bed).localeCompare(String(y.bed)))

  return { perRoom, perTenant }
}
