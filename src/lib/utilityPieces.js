/**
 * src/lib/utilityPieces.js
 * ------------------------
 * Pure stay-anchored utility split for the move-out Final Bill. Imports only ./stay.
 *
 * Timeline convention (as billing.js): a reading "at position p" is the meter at the END of day p. A window's prev
 * is at position start-1, its curr at end-1 (end exclusive), an interim dated D at position D. A stay that begins on
 * day S has its start reading at position S-1 (or earlier: any earlier reading just widens the first piece, and the
 * days nobody was present are shared by the people who overlap that piece, as in billing.js).
 *
 * The room's consumption between two readings is priced at the bedspace rate of the cutoff each day falls in, rounded
 * to the cent per (reading-to-reading piece x pricing cutoff), then the cents are shared by day-weights with exact
 * integer arithmetic (BigInt): the shares always add up to the piece.
 */
import { dayNum, isoOfDay, windowOf, pricingInfoForDay } from './stay'

export const toHundredths = (v) => Math.round(Number(v) * 100)
const toMicro = (v) => Math.round(Number(v) * 1e6)

/** cents = round-half-up(consHundredths/100 * rate * num/den * 100), exact. */
export function centsOf(consHundredths, rate, num = 1, den = 1) {
  const n = BigInt(consHundredths) * BigInt(toMicro(rate)) * BigInt(num)
  const d = 1000000n * BigInt(den)
  return Number((2n * n + d) / (2n * d))
}

const gcd = (a, b) => (b === 0n ? a : gcd(b, a % b))
const lcmUpTo = (n) => { let l = 1n; for (let i = 2n; i <= BigInt(n); i++) l = (l / gcd(l, i)) * i; return l }

/**
 * Share `totalCents` over entries [{ key, w }] (weights, BigInt-able) plus an unbilled weight `vacantW`.
 * Each entry gets floor(total*w/W); the leftover cents go one each to the largest fractional remainders, ties to the
 * lowest key (tenant id), the unbilled share last. Returns { shares: Map(key -> cents), unbilledCents }.
 */
export function allocateCents(totalCents, entries, vacantW = 0n) {
  const T = BigInt(totalCents)
  if (T < 0n) throw new Error('allocateCents: negative total')
  const items = entries.map(e => ({ key: e.key, w: BigInt(e.w) }))
  const vac = BigInt(vacantW)
  const W = vac + items.reduce((s, e) => s + e.w, 0n)
  const shares = new Map(items.map(e => [e.key, 0]))
  if (W <= 0n) return { shares, unbilledCents: Number(T) }
  const rows = items.map(e => ({ key: e.key, q: (T * e.w) / W, r: (T * e.w) % W }))
  rows.push({ key: Infinity, q: (T * vac) / W, r: (T * vac) % W })
  let left = T - rows.reduce((s, r) => s + r.q, 0n)
  const order = [...rows].sort((a, b) => (a.r === b.r ? (a.key === b.key ? 0 : a.key < b.key ? -1 : 1) : a.r > b.r ? -1 : 1))
  for (const r of order) { if (left <= 0n) break; r.q += 1n; left -= 1n }
  let unbilled = 0
  for (const r of rows) { if (r.key === Infinity) unbilled = Number(r.q); else shares.set(r.key, Number(r.q)) }
  return { shares, unbilledCents: unbilled }
}

const RATE_FIELD = { WATER: 'water_bedspace_rate', ELECTRIC: 'electric_bedspace_rate' }
const START_FIELD = { WATER: 'water_start', ELECTRIC: 'electric_start' }

/**
 * Bedspace rate of a cutoff for a utility. A rate of 0/empty (the cutoff was opened before the provider bill) falls back
 * to the most recent EARLIER cutoff with a rate, and says so. Only the final bill uses this; normal Billing is unchanged.
 */
export function resolveRate(cutoffs, cutoff, util) {
  const field = RATE_FIELD[util], sf = START_FIELD[util]
  const own = Number(cutoff[field]) || 0
  if (own > 0) return { rate: own, note: null, warning: null }
  const mine = dayNum(cutoff[sf]) ?? 0
  const earlier = (cutoffs || [])
    .filter(c => c.id !== cutoff.id && (dayNum(c[sf]) ?? 0) < mine && Number(c[field]) > 0)
    .sort((a, b) => ((dayNum(b[sf]) ?? 0) - (dayNum(a[sf]) ?? 0)) || ((dayNum(b.water_start) ?? 0) - (dayNum(a.water_start) ?? 0)))[0]
  if (earlier) {
    const flag = earlier[util === 'WATER' ? 'water_rate_override' : 'electric_rate_override']
    const how = flag === true ? ' (manual rate)' : flag === false ? ' (computed from the provider bill)' : ''
    return { rate: Number(earlier[field]), note: `rate from ${earlier.name}${how} - not set for ${cutoff.name}`, warning: `The ${util.toLowerCase()} rate of ${cutoff.name} is not set; the rate of ${earlier.name} was used.` }
  }
  return { rate: 0, note: null, warning: `No ${util.toLowerCase()} rate is set for ${cutoff.name} or any earlier cutoff; the line is 0.` }
}

const validNum = (v) => v != null && v !== '' && Number.isFinite(Number(v))

/**
 * Where does the stay's utility start? Precedence:
 *  MANUAL (typed by staff) > MOVE_IN_READING (an interim with moving_in_tenant_id = this tenant) >
 *  the latest reading in the room at or before the day before move-in, over interims (PREV_TENANT_MOVE_OUT), closed
 *  windows' closing readings (CUTOFF_CLOSING) and windows' opening readings (CUTOFF_PREV); a tie prefers the interim >
 *  CUTOFF_PREV of the cutoff that prices the move-in day (for electric inside the gap before a window opens: the next window).
 * Returns { value, pos, source, date, label, cutoff_id?, warnings[] } or { error }.
 */
export function resolveStartReading({ utility, roomId, tenant, moveInISO, cutoffs, rowsByCutoff, interimsAll = [], groupIds = [], override = null }) {
  const warnings = []
  const moveNum = dayNum(String(moveInISO).slice(0, 10))
  const label = utility === 'WATER' ? 'water' : 'electric'
  if (validNum(override)) {
    return { value: Number(override), pos: moveNum - 1, source: 'MANUAL', date: null, label: 'entered by staff', warnings }
  }
  const group = new Set(groupIds)
  const mine = interimsAll
    .filter(r => r.room_id === roomId && r.utility === utility && r.moving_in_tenant_id != null && r.moving_in_tenant_id === tenant.id)
    .sort((a, b) => b.id - a.id)[0]
  if (mine) {
    return { value: Number(mine.reading_value), pos: dayNum(mine.reading_date) - 1, source: 'MOVE_IN_READING', date: String(mine.reading_date).slice(0, 10), label: `move-in reading of ${String(mine.reading_date).slice(0, 10)}`, warnings }
  }

  const cands = []
  for (const r of interimsAll) {
    if (r.room_id !== roomId || r.utility !== utility || group.has(r.moving_out_tenant_id)) continue
    const p = dayNum(r.reading_date)
    if (p != null && p <= moveNum - 1) cands.push({ pos: p, rank: 3, id: r.id, value: Number(r.reading_value), source: 'PREV_TENANT_MOVE_OUT', date: String(r.reading_date).slice(0, 10), label: `previous tenant's move-out reading of ${String(r.reading_date).slice(0, 10)}` })
  }
  for (const c of cutoffs || []) {
    const row = rowsByCutoff?.get(c.id)
    const w = windowOf(c, utility)
    if (!row || !w) continue
    if (validNum(row.curr) && Number.isFinite(w.e) && w.e - 1 <= moveNum - 1 && Number(row.curr) > 0 && (!validNum(row.prev) || Number(row.curr) >= Number(row.prev))) {
      cands.push({ pos: w.e - 1, rank: 2, id: c.id, value: Number(row.curr), source: 'CUTOFF_CLOSING', date: isoOfDay(w.e - 1), cutoff_id: c.id, label: `${c.name} closing reading` })
    }
    if (validNum(row.prev) && w.s - 1 <= moveNum - 1) {
      cands.push({ pos: w.s - 1, rank: 1, id: c.id, value: Number(row.prev), source: 'CUTOFF_PREV', date: isoOfDay(w.s - 1), cutoff_id: c.id, label: `${c.name} opening reading` })
    }
  }
  cands.sort((a, b) => (b.pos - a.pos) || (b.rank - a.rank) || (b.id - a.id))
  let pick = cands[0]
  if (!pick) {
    const info = pricingInfoForDay(cutoffs, utility, moveNum)
    const row = info.cutoff ? rowsByCutoff?.get(info.cutoff.id) : null
    const w = info.cutoff ? windowOf(info.cutoff, utility) : null
    if (!info.cutoff || !row || !validNum(row.prev) || !w) {
      return { error: `No starting ${label} reading could be found for the stay. Enter it by hand.` }
    }
    pick = {
      pos: w.s - 1, value: Number(row.prev), source: 'CUTOFF_PREV', date: isoOfDay(w.s - 1), cutoff_id: info.cutoff.id,
      label: info.inWindow ? `${info.cutoff.name} opening reading`
        : `${info.cutoff.name} window opening reading (the stay began before that window opened)`,
    }
  }
  if (pick.source === 'PREV_TENANT_MOVE_OUT' && moveNum - pick.pos > 45) {
    warnings.push(`The previous tenant's ${label} reading is dated ${pick.date}, more than 45 days before the move-in; check that it is the right starting reading.`)
  }
  return { value: pick.value, pos: pick.pos, source: pick.source, date: pick.date, label: pick.label, cutoff_id: pick.cutoff_id, warnings }
}

/**
 * Order check of a move-out reading against the room's other interim readings of the same utility (the leavers' own are
 * ignored): lower than an EARLIER reading, or higher than a LATER reading saved in the SAME cutoff (the one this reading will be
 * saved against) is an error naming both readings; a higher-than-later reading in another cutoff is only a warning (stale or
 * future-dated readings there must not block). Returns { errors[], warnings[] }.
 */
export function checkReadingOrder({ utility, roomId, moveOutISO, value, finalCutoffId, interimsAll = [], groupIds = [] }) {
  const errors = [], warnings = []
  const staleLater = []  // later readings in OTHER cutoffs that are lower than this one: collapsed into one warning
  const day = dayNum(String(moveOutISO).slice(0, 10))
  const name = utility === 'WATER' ? 'Water' : 'Electric'
  const mine = toHundredths(value)
  for (const r of interimsAll) {
    if (r.room_id !== roomId || r.utility !== utility || groupIds.includes(r.moving_out_tenant_id)) continue
    const rd = dayNum(r.reading_date), other = toHundredths(r.reading_value)
    const when = String(r.reading_date).slice(0, 10)
    if (rd == null) continue
    if (rd < day && other > mine) {
      errors.push(`${name} reading ${value} (${String(moveOutISO).slice(0, 10)}) is lower than the earlier room reading ${Number(r.reading_value)} of ${when}. Check the reading.`)
    } else if (rd > day && other < mine) {
      const msg = `${name} reading ${value} (${String(moveOutISO).slice(0, 10)}) is higher than the later room reading ${Number(r.reading_value)} of ${when}`
      if (r.cutoff_id === finalCutoffId) errors.push(`${msg} in the same cutoff. Check the reading, or delete the wrong interim reading in Billing.`)
      else staleLater.push({ rd, when, value: Number(r.reading_value) })
    }
  }
  if (staleLater.length) {
    const latest = staleLater.reduce((a, b) => (b.rd > a.rd ? b : a))
    const n = staleLater.length
    warnings.push(`${name}: ${n} later reading${n === 1 ? '' : 's'} in ${n === 1 ? 'another cutoff' : 'other cutoffs'} ${n === 1 ? 'is' : 'are'} lower than this reading (latest ${latest.when}, value ${latest.value}); check ${n === 1 ? 'it' : 'them'} in Billing.`)
  }
  return { errors, warnings }
}

const inclusive = (p, a, b) => (p.moveInNum == null || p.moveInNum <= b) && (p.moveOutNum == null || p.moveOutNum >= a)

/**
 * Split one room+utility between a start reading and an end reading over the days start.pos+1 .. end.pos.
 *   startReading / endReading { value, pos, label }   knownReadings [{ pos, value, label }] (interior ones only)
 *   rowsByCutoff Map(cutoffId -> { prev, curr })      participants [{ id, moveInNum|null, moveOutNum|null }]
 * Output: byTenant Map(id -> { cents, cons, lines[] }), unbilledCents, roomCons, roomCents, points, warnings[], errors[].
 * Invariant: sum of all tenant cents + unbilledCents = roomCents exactly (roomCents = sum of the pieces' rounded totals).
 */
export function splitUtility({ utility, startReading, endReading, knownReadings = [], cutoffs, rowsByCutoff, participants }) {
  const warnings = [], errors = []
  const out = (extra = {}) => ({ byTenant: new Map(), unbilledCents: 0, roomCons: 0, roomCents: 0, points: [], warnings, errors, ...extra })
  const uName = utility === 'WATER' ? 'Water' : 'Electric'
  const s = startReading, e = endReading
  if (e.pos <= s.pos) {
    errors.push(`${uName}: the move-out date (${isoOfDay(e.pos)}) is not after the starting reading (${s.label}, ${isoOfDay(s.pos)}).`)
    return out()
  }
  const info = new Map()
  const infoOf = (d) => { if (!info.has(d)) info.set(d, pricingInfoForDay(cutoffs, utility, d)); return info.get(d) }
  for (let d = s.pos + 1; d <= e.pos; d++) {
    if (!infoOf(d).cutoff) { errors.push(`${uName}: no cutoff exists to price ${isoOfDay(d)}.`); return out() }
  }

  let points = [
    { pos: s.pos, value: Number(s.value), label: s.label },
    ...knownReadings.filter(k => k.pos > s.pos && k.pos < e.pos).sort((a, b) => a.pos - b.pos).map(k => ({ pos: k.pos, value: Number(k.value), label: k.label })),
    { pos: e.pos, value: Number(e.value), label: e.label },
  ]
  for (let d = s.pos + 2; d <= e.pos; d++) {
    const before = infoOf(d - 1).cutoff, after = infoOf(d).cutoff
    if (before.id === after.id) continue
    const p = d - 1
    if (points.some(x => x.pos === p)) continue
    const rowA = rowsByCutoff?.get(after.id), rowB = rowsByCutoff?.get(before.id)
    const next = rowA && validNum(rowA.prev) ? Number(rowA.prev) : null
    const closing = rowB && validNum(rowB.curr) && Number(rowB.curr) > 0 && (!validNum(rowB.prev) || Number(rowB.curr) >= Number(rowB.prev)) ? Number(rowB.curr) : null
    if (next != null && closing != null && toHundredths(next) !== toHundredths(closing)) {
      warnings.push(`${uName}: the ${after.name} opening reading (${next}) and the ${before.name} closing reading (${closing}) disagree at ${isoOfDay(p)}.`)
    }
    const lo = [...points].reverse().find(x => x.pos < p), hi = points.find(x => x.pos > p)
    const fits = (v) => v >= lo.value && v <= hi.value
    const choice = [[next, `${after.name} opening reading`], [closing, `${before.name} closing reading`]].find(([v]) => v != null && fits(v))
    if (choice) points = [...points, { pos: p, value: choice[0], label: choice[1], boundary: true }].sort((a, b) => a.pos - b.pos)
    else warnings.push(`${uName}: no usable meter reading exists at the change from ${before.name} to ${after.name} (${isoOfDay(p)}); the consumption between ${lo.label} and ${hi.label} is split by days between the two rates.`)
  }

  const nPart = participants.length
  const L = lcmUpTo(Math.max(nPart, 1))
  const acc = new Map(participants.map(p => [p.id, { cents: 0, cons: 0, byCutoff: new Map() }]))
  let unbilledCents = 0, roomCons = 0, roomCents = 0

  for (let k = 1; k < points.length; k++) {
    const a = points[k - 1], b = points[k]
    const consH = toHundredths(b.value) - toHundredths(a.value)
    if (consH < 0) {
      errors.push(`${uName} reading ${b.value} (${b.label}) is lower than the earlier reading ${a.value} (${a.label}). Check the readings.`)
      continue
    }
    const segDays = b.pos - a.pos
    roomCons += consH / 100
    let d = a.pos + 1
    while (d <= b.pos) {
      const inf = infoOf(d)
      let end = d
      while (end + 1 <= b.pos && infoOf(end + 1).cutoff.id === inf.cutoff.id) end++
      const runDays = end - d + 1
      const rr = resolveRate(cutoffs, inf.cutoff, utility)
      if (consH > 0 && rr.warning && !warnings.includes(rr.warning)) warnings.push(rr.warning)
      const total = centsOf(consH, rr.rate, runDays, segDays)
      roomCents += total
      const occupants = participants.filter(p => inclusive(p, d, end))
      const w = new Map(participants.map(p => [p.id, 0n]))
      let vacant = 0n
      for (let day = d; day <= end; day++) {
        let here = participants.filter(p => inclusive(p, day, day))
        if (!here.length) here = occupants
        if (!here.length) { vacant += L; continue }
        const share = L / BigInt(here.length)
        for (const p of here) w.set(p.id, w.get(p.id) + share)
      }
      const { shares, unbilledCents: un } = allocateCents(total, participants.map(p => ({ key: p.id, w: w.get(p.id) })), vacant)
      unbilledCents += un
      const W = BigInt(runDays) * L
      let gapInRun = 0, gapDir = null
      for (let day = d; day <= end; day++) { const g = infoOf(day); if (!g.inWindow) { gapInRun++; gapDir ||= g.dir } }
      const runCons = (consH / 100) * (runDays / segDays)
      for (const p of participants) {
        const t = acc.get(p.id)
        const cents = shares.get(p.id) || 0
        const cons = runCons * (Number(w.get(p.id)) / Number(W))
        t.cents += cents; t.cons += cons
        const cur = t.byCutoff.get(inf.cutoff.id) || { cutoff_id: inf.cutoff.id, rate: rr.rate, rateNote: rr.note, cents: 0, cons: 0, fromDay: d, toDay: end, gapDays: 0, gapNote: null }
        cur.cents += cents; cur.cons += cons; cur.toDay = end
        if (gapInRun > 0) {
          cur.gapDays += gapInRun
          cur.gapNote = gapDir === 'preceding'
            ? `${cur.gapDays} day(s) fall after the last ${utility.toLowerCase()} window and are priced at ${inf.cutoff.name}`
            : `${cur.gapDays} day(s) fall between two ${utility.toLowerCase()} windows and are priced at ${inf.cutoff.name}`
        }
        t.byCutoff.set(inf.cutoff.id, cur)
      }
      d = end + 1
    }
  }

  const lastCutoff = infoOf(e.pos).cutoff
  const byTenant = new Map()
  for (const p of participants) {
    const t = acc.get(p.id)
    let lines = [...t.byCutoff.values()].filter(l => l.cents !== 0 || l.cons > 1e-9)
    if (!lines.length) {
      const rr = resolveRate(cutoffs, lastCutoff, utility)
      lines = [{ cutoff_id: lastCutoff.id, rate: rr.rate, rateNote: rr.note, cents: 0, cons: 0, fromDay: s.pos + 1, toDay: e.pos, gapDays: 0, gapNote: null }]
    }
    byTenant.set(p.id, { cents: t.cents, cons: t.cons, lines })
  }
  return { byTenant, unbilledCents, roomCons, roomCents, points, warnings, errors }
}
