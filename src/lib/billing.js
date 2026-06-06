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
    for (let d = segStart; d < segEndExcl; d++) {
      const here = tenants.filter(t => present(t, d, endNum))
      if (here.length === 0) { unbilled += dAmt; continue }
      const sA = dAmt / here.length, sC = dCons / here.length
      here.forEach(t => { amt[t.id] += sA; cons[t.id] += sC })
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

export function computeBilling(cutoff, billRows, interims, tenants, splits = [], addons = [], areaReadings = []) {
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
  const wStart = dayNum(cutoff.water_start),    wEnd = dayNum(cutoff.water_end)
  const eStart = dayNum(cutoff.electric_start), eEnd = dayNum(cutoff.electric_end)

  // Index tenants by room with day-numbers
  const tByRoom = {}
  tenants.forEach(t => {
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
  const ensure = (t) => (tenantAcc[t.id] ||= {
    id: t.id, name: t.name, bed: t.bed, room_id: null, room_no: null, room_type: null,
    rent: 0, water: 0, waterCons: 0, elec: 0, elecCons: 0, settled: !t.is_active,
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

    wt.forEach(t => { const a = ensure(t); a.room_id = br.room_id; a.room_no = br.room_no; a.room_type = br.room_type; a.water += wRes.amt[t.id]; a.waterCons += wRes.cons[t.id] })
    et.forEach(t => { const a = ensure(t); a.room_id = br.room_id; a.room_no = br.room_no; a.room_type = br.room_type; a.elec  += eRes.amt[t.id]; a.elecCons += eRes.cons[t.id] })

    const wSum = wt.reduce((s, t) => s + wRes.amt[t.id], 0)
    const eSum = et.reduce((s, t) => s + eRes.amt[t.id], 0)
    perRoom.push({
      room_id: br.room_id, room_no: br.room_no, room_type: br.room_type,
      water:    { roomAmt: wRes.roomAmt, roomCons: wRes.roomCons, sum: wSum, unbilled: wRes.unbilled, ok: Math.abs(wSum + wRes.unbilled - wRes.roomAmt) < 0.01, segments: wPts.length - 1 },
      electric: { roomAmt: eRes.roomAmt, roomCons: eRes.roomCons, sum: eSum, unbilled: eRes.unbilled, ok: Math.abs(eSum + eRes.unbilled - eRes.roomAmt) < 0.01, segments: ePts.length - 1 },
    })
  })

  // Rent for BED tenants (still active at month-end). Moved-out → 0.
  Object.values(tenantAcc).forEach(a => {
    const t = tenants.find(x => x.id === a.id)
    const moveOut = t && (t.actual_move_out_date || t.move_out_date)
    const stillActive = t && t.is_active && (!moveOut || dayNum(moveOut) >= wEnd - 1)
    a.rent = stillActive ? num(t.rate) : 0
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
