/**
 * src/lib/stay.js
 * ---------------
 * Pure (no imports) stay classification and cutoff-coverage rules for the move-out Final Bill.
 * Windows are [start, end) in day numbers (ends exclusive, as in billing.js). Utilities are 'WATER' / 'ELECTRIC'.
 */

const MS_DAY = 86400000
const MON = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec']

export const dayNum = (iso) =>
  iso ? Math.floor(Date.parse(String(iso).slice(0, 10) + 'T00:00:00Z') / MS_DAY) : null
export const isoOfDay = (n) => new Date(n * MS_DAY).toISOString().slice(0, 10)
const iso10 = (v) => (v ? String(v).slice(0, 10) : null)

// Same month arithmetic as Utilities.jsx addMonths() (day clamped to the end of the month).
export function addMonthsISO(iso, n = 1) {
  if (!iso) return ''
  let [y, m, d] = iso.slice(0, 10).split('-').map(Number)
  let mi = (m - 1) + n
  y += Math.floor(mi / 12); mi = ((mi % 12) + 12) % 12
  const dim = new Date(y, mi + 1, 0).getDate(); if (d > dim) d = dim
  return `${y}-${String(mi + 1).padStart(2, '0')}-${String(d).padStart(2, '0')}`
}

const daysInMonthOf = (iso) => { const [y, m] = String(iso).slice(0, 10).split('-').map(Number); return new Date(Date.UTC(y, m, 0)).getUTCDate() }

/** Last day of the month containing the date. */
export function snapToMonthEnd(iso) {
  if (!iso) return ''
  const [y, m] = String(iso).slice(0, 10).split('-').map(Number)
  return `${y}-${String(m).padStart(2, '0')}-${String(daysInMonthOf(iso)).padStart(2, '0')}`
}

/** Planned move-out of a new lease: the last day of the month containing (move-in + N months - 1 day). */
export function leaseMoveOut(moveInISO, months) {
  if (!moveInISO || !(months >= 1)) return ''
  return snapToMonthEnd(isoOfDay(dayNum(addMonthsISO(moveInISO, months)) - 1))
}

/** Move In rule: the planned move-out of a NEW lease is after the move-in and the last day of a month. Returns an error message or null. */
export function newLeaseMoveOutProblem(moveInISO, moveOutISO) {
  const a = iso10(moveInISO), b = iso10(moveOutISO)
  if (!b) return 'A planned move-out date is required.'
  if (!a || b <= a) return `The planned move-out date (${b}) must be after the move-in date (${a || 'not set'}).`
  if (snapToMonthEnd(b) !== b) return `The planned move-out date (${b}) must be the last day of a month (${snapToMonthEnd(b)}). Choose the lease length in months instead.`
  return null
}

// Whole cents of rateC x days / windowDays, half up, integer arithmetic.
export const prorateCents = (rateC, days, windowDays) => (windowDays > 0 ? Math.floor((2 * rateC * days + windowDays) / (2 * windowDays)) : 0)

/**
 * Rent of a stay = n whole months flat + the excess days prorated. n is the largest integer >= 0 with
 * addMonthsISO(moveIn, n) <= moveOut. A move-out exactly on addMonthsISO(moveIn, n) (n >= 1) is n months, no excess.
 * Otherwise the excess runs from E = addMonthsISO(moveIn, n) through the move-out date inclusive, each calendar month's part
 * as days / that month's real number of days (Nov 30, Dec 31, Feb 28), rounded to the cent per month.
 * Returns { months, exact, totalCents, flatCents, excessCents, excessDays, segments[] } (null when the dates are unusable).
 */
export function stayRent(rateC, moveInISO, moveOutISO) {
  const a = iso10(moveInISO), b = iso10(moveOutISO)
  if (!a || !b || b < a) return null
  let n = 0
  while (n < 240 && addMonthsISO(a, n + 1) <= b) n++
  const flatCents = rateC * n
  if (n >= 1 && addMonthsISO(a, n) === b) return { months: n, exact: true, totalCents: flatCents, flatCents, excessCents: 0, excessDays: 0, segments: [] }
  const E = addMonthsISO(a, n)
  const segments = []
  let from = dayNum(E)
  const last = dayNum(b)
  while (from <= last) {
    const f = isoOfDay(from)
    const monthEnd = dayNum(snapToMonthEnd(f))
    const to = Math.min(last, monthEnd)
    const days = to - from + 1, monthDays = daysInMonthOf(f)
    segments.push({ from: f, to: isoOfDay(to), days, monthDays, cents: prorateCents(rateC, days, monthDays) })
    from = to + 1
  }
  const excessCents = segments.reduce((sum, x) => sum + x.cents, 0)
  return { months: n, exact: false, totalCents: flatCents + excessCents, flatCents, excessCents, excessDays: segments.reduce((sum, x) => sum + x.days, 0), segments }
}

/** Smallest whole number of months N (1..60) with addMonthsISO(moveIn, N) === end, else null. */
export function stayMonths(moveInISO, endISO) {
  const a = iso10(moveInISO), b = iso10(endISO)
  if (!a || !b || b <= a) return null
  for (let n = 1; n <= 60; n++) {
    const x = addMonthsISO(a, n)
    if (x === b) return n
    if (x > b) return null
  }
  return null
}

/** Local calendar date (toISOString() is UTC, a day behind in the Philippines before 08:00). */
export function localToday() {
  const d = new Date()
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

export const isMonthEnd = (iso) => !!iso && snapToMonthEnd(iso) === String(iso).slice(0, 10)

/**
 * kind STAY_BILLED  planned stay is exactly one month AND the planned move-out is not a calendar month end (the old
 *                   same-date-next-month leases; leases created with the month-end rule use the normal flow). Rent is ONE flat monthly rate billed only on the final bill
 *                   (FLAT_ONE_MONTH when the actual stay is also one month; PRORATE_ALL_TOUCHED, day-prorated over
 *                   every window the stay touched, when it ended early or late).
 * kind WHOLE_MONTHS any other stay that began on or after the first cutoff of the app (appStartISO) and ended after it began:
 *                   rent = n whole months flat + the excess days prorated (stayRent), minus rent already billed on closed
 *                   statements. `months` is the whole months of the ACTUAL stay when it is a whole number, else null.
 * kind ODD          everything else (pre-app move-ins): day-prorated over the covered windows.
 */
export function classifyStay({ moveIn, planned, actual, appStartISO }) {
  const nP = stayMonths(moveIn, planned)
  const nA = stayMonths(moveIn, actual)
  if (nP === 1 && !isMonthEnd(planned)) {
    return nA === 1
      ? { kind: 'STAY_BILLED', months: 1, rentRule: 'FLAT_ONE_MONTH' }
      : { kind: 'STAY_BILLED', months: 1, rentRule: 'PRORATE_ALL_TOUCHED' }
  }
  if (appStartISO && iso10(moveIn) >= iso10(appStartISO) && iso10(actual) > iso10(moveIn)) {
    return { kind: 'WHOLE_MONTHS', months: nA, rentRule: 'N_X_RATE_MINUS_CLOSED' }
  }
  return { kind: 'ODD', months: nA, rentRule: 'PRORATE_COVERED' }
}

// An ACTIVE tenant whose planned stay is exactly one month: billed on the final bill only (never by planned date of an inactive tenant).
export const isStayBilled = (t) => !!t && !!t.is_active && stayMonths(t.move_in_date, t.move_out_date) === 1 && !isMonthEnd(t.move_out_date)

export function appStart(cutoffs) {
  const starts = (cutoffs || []).map(c => iso10(c.water_start)).filter(Boolean).sort()
  return starts[0] || null
}

const winOf = (c, util) => {
  const s = dayNum(util === 'ELECTRIC' ? c.electric_start : c.water_start)
  if (s == null) return null
  const eRaw = dayNum(util === 'ELECTRIC' ? c.electric_end : c.water_end)
  return { s, e: eRaw == null ? Infinity : eRaw }
}
export const windowOf = winOf

// Cutoffs whose window for `util` contains the day; when several do (two cutoffs can store the same electric window),
// prefer the one whose water window also contains it, else the most recent water_start.
function containing(cutoffs, util, day) {
  const hits = (cutoffs || []).filter(c => { const w = winOf(c, util); return w && day >= w.s && day < w.e })
  if (hits.length <= 1) return hits[0] || null
  const wDay = (c) => { const w = winOf(c, 'WATER'); return w && day >= w.s && day < w.e }
  const pref = hits.filter(wDay)
  const pool = pref.length ? pref : hits
  return [...pool].sort((a, b) => (dayNum(b.water_start) ?? 0) - (dayNum(a.water_start) ?? 0))[0]
}

/** The cutoff whose rent/water window contains the date (the existing water rule). */
export function cutoffForDate(cutoffs, dateISO) {
  const d = dayNum(dateISO)
  if (d == null) return null
  return (cutoffs || []).find(c => c.water_start && c.water_end && d >= dayNum(c.water_start) && d < dayNum(c.water_end)) || null
}

export function cutoffForUtilityDate(cutoffs, util, dateISO) {
  const d = dayNum(dateISO)
  if (d == null) return null
  if (util === 'WATER') return cutoffForDate(cutoffs, dateISO)
  return containing(cutoffs, util, d)
}

/**
 * The cutoff a move-out on this date bills and saves its reading against, for one utility: the one whose window holds the date; a date
 * AFTER the end of the latest window uses that latest cutoff (beyondWindow: no next cutoff has to be opened just to bill a move-out).
 * A date with a later window but none holding it (the gap before an electric window) has no cutoff. Returns { cutoff, beyondWindow }.
 */
export function finalCutoffForUtility(cutoffs, util, dateISO) {
  const hit = cutoffForUtilityDate(cutoffs, util, dateISO)
  if (hit) return { cutoff: hit, beyondWindow: false }
  const d = dayNum(dateISO)
  if (d == null) return { cutoff: null, beyondWindow: false }
  const withWin = (cutoffs || []).map(c => ({ c, w: winOf(c, util) })).filter(x => x.w)
  if (!withWin.length || withWin.some(x => x.w.s > d)) return { cutoff: null, beyondWindow: false }
  const latest = withWin.sort((a, b) => (b.w.s - a.w.s) || ((dayNum(b.c.water_start) ?? 0) - (dayNum(a.c.water_start) ?? 0)))[0]
  return d >= latest.w.e ? { cutoff: latest.c, beyondWindow: true } : { cutoff: null, beyondWindow: false }
}

/** "Nov 2026": the cutoff a staff member has to open for a missing window (electric before the 10th belongs to the previous month). */
export function expectedCutoffName(util, dateISO) {
  const [y, m, d] = String(dateISO).slice(0, 10).split('-').map(Number)
  let yy = y, mm = m
  if (util === 'ELECTRIC' && d < 10) { mm -= 1; if (mm < 1) { mm = 12; yy -= 1 } }
  return `${MON[mm - 1]} ${yy}`
}

/**
 * Info about the cutoff that prices a day: the one whose window holds it; a day outside every window (the gap
 * between two electric windows) is priced at the nearest FOLLOWING window, else the nearest preceding one.
 * Returns { cutoff, inWindow, dir } with dir 'following' | 'preceding' | null.
 */
export function pricingInfoForDay(cutoffs, util, day) {
  const hit = containing(cutoffs, util, day)
  if (hit) return { cutoff: hit, inWindow: true, dir: null }
  const withWin = (cutoffs || []).map(c => ({ c, w: winOf(c, util) })).filter(x => x.w)
  const following = withWin.filter(x => x.w.s > day).sort((a, b) => a.w.s - b.w.s || (dayNum(b.c.water_start) ?? 0) - (dayNum(a.c.water_start) ?? 0))[0]
  if (following) return { cutoff: following.c, inWindow: false, dir: 'following' }
  const preceding = withWin.filter(x => x.w.e <= day).sort((a, b) => b.w.s - a.w.s || (dayNum(b.c.water_start) ?? 0) - (dayNum(a.c.water_start) ?? 0))[0]
  if (preceding) return { cutoff: preceding.c, inWindow: false, dir: 'preceding' }
  return { cutoff: null, inWindow: false, dir: null }
}
export const pricingCutoffForDay = (cutoffs, util, day) => pricingInfoForDay(cutoffs, util, day).cutoff

/** Closed = not the active cutoff and older than it (with no active cutoff every cutoff is closed). */
export function isCutoffClosed(c, cutoffs) {
  const active = (cutoffs || []).find(x => x.is_active)
  if (!active) return true
  return !c.is_active && (dayNum(c.water_start) ?? 0) < (dayNum(active.water_start) ?? 0)
}

/**
 * Which cutoffs does the final bill cover, per utility?
 *  final    the cutoff whose OWN window holds the move-out date, or the latest cutoff when the date is after its window
 *           (beyondWindow; always covered, active or not); missing only for a date with a later window but none holding it
 *  covered  STAY_BILLED: every cutoff whose window overlaps the stay (the tenant never appeared on a statement)
 *           other kinds: final plus earlier overlapping windows that are not closed
 *  coveredIds sorted union over both utilities; primaryCutoffId = the water final (the bill's cutoff_id as before)
 */
export function computeCoverage({ cutoffs, moveInISO, moveOutISO, kind }) {
  const mi = dayNum(iso10(moveInISO)), mo = dayNum(iso10(moveOutISO))
  const out = {}
  for (const util of ['WATER', 'ELECTRIC']) {
    const { cutoff: final, beyondWindow } = finalCutoffForUtility(cutoffs, util, moveOutISO)
    const overlapping = (cutoffs || []).filter(c => {
      const w = winOf(c, util)
      return w && mo != null && mi != null && w.s <= mo && w.e > mi
    })
    let covered
    if (kind === 'STAY_BILLED') {
      covered = [...overlapping]
      if (final && !beyondWindow && !covered.some(c => c.id === final.id)) covered.push(final)
    } else if (beyondWindow && !overlapping.some(c => c.id === final.id)) {
      // The stay began after the latest window: that cutoff only supplies the rate and holds the saved reading, the stay never touched it.
      covered = []
    } else {
      covered = final ? [final] : []
      const fw = final ? winOf(final, util) : null
      if (fw) {
        for (const c of overlapping) {
          if (c.id === final.id) continue
          const w = winOf(c, util)
          if (w.s < fw.s && !isCutoffClosed(c, cutoffs)) covered.push(c)
        }
      }
    }
    covered.sort((a, b) => (winOf(a, util).s - winOf(b, util).s) || (a.id - b.id))
    out[util === 'WATER' ? 'water' : 'electric'] = {
      final: final || null,
      beyondWindow,
      missing: final ? null : { name: expectedCutoffName(util, moveOutISO), date: iso10(moveOutISO) },
      covered,
    }
  }
  const coveredIds = [...new Set([...out.water.covered, ...out.electric.covered].map(c => c.id))].sort((a, b) => a - b)
  const waterIds = new Set(out.water.covered.map(c => c.id)), elecIds = new Set(out.electric.covered.map(c => c.id))
  const components = coveredIds.map(id => ({ id, water: waterIds.has(id), electric: elecIds.has(id) }))
  return { ...out, coveredIds, components, primaryCutoffId: out.water.final?.id ?? null }
}

/**
 * The stored form of final_bills.covered_cutoffs (a jsonb array, no schema change): a plain id = water AND electric (also every
 * legacy bill), or { id, water, electric } when only one component is billed on the final bill.
 */
export function coveredEntries(cov) {
  return cov.components.map(c => (c.water && c.electric ? c.id : { id: c.id, water: c.water, electric: c.electric }))
}

/**
 * Per-tenant stamps from the non-void final bills ({ tenant_id, cutoff_id, covered_cutoffs }): Map(tenantId -> { both, water,
 * electric }) of cutoff id arrays. A bill with no entries (bill #7, legacy) falls back to its cutoff_id as water AND electric.
 * excludeBillId: leave that bill out (the bill being re-issued: its tenant is not their own ghost while the new draft is built).
 */
export function finalBilledStamps(bills, { excludeBillId = null } = {}) {
  const byTenant = new Map()
  for (const b of bills || []) {
    if (excludeBillId != null && b.id === excludeBillId) continue
    let entries = parseCovered(b.covered_cutoffs)
    if (b.cutoff_id != null && !entries.some(e => e.id === b.cutoff_id)) entries = parseCovered([...entries, b.cutoff_id])
    if (!entries.length) continue
    const cur = byTenant.get(b.tenant_id) || new Map()
    if (b.created_at && (!cur.at || Date.parse(b.created_at) > Date.parse(cur.at))) cur.at = b.created_at
    for (const e of entries) {
      const m = cur.get(e.id) || { water: false, electric: false }
      m.water ||= e.water; m.electric ||= e.electric
      cur.set(e.id, m)
    }
    byTenant.set(b.tenant_id, cur)
  }
  const out = new Map()
  for (const [tid, m] of byTenant) {
    const ids = [...m.keys()].sort((a, b) => a - b)
    out.set(tid, {
      both: ids.filter(id => m.get(id).water && m.get(id).electric),
      water: ids.filter(id => m.get(id).water),
      electric: ids.filter(id => m.get(id).electric),
      ...(m.at ? { at: m.at } : {}),
    })
  }
  return out
}

/**
 * Re-attach step after a new cutoff exists (idempotent, pure plan). A move-out dated after the then latest window saved its reading against
 * that older cutoff. Once a cutoff's window holds the date: the reading moves to it, and the final bills it belongs to get that cutoff added for
 * that component only, so the leaver is a non-billed ghost for those days and the roommates pay only their own share. Bill lines stay frozen.
 * A reading belongs to a bill only through its moving_out_tenant_id: that tenant is the bill's tenant, a sibling in the bill's group, or a tenant whose
 * own bill's group names this bill's tenant (a retried bed's list can be partial), with the same room and date (processMoveOutWithBill always sets it). A stale, transfer or manual row of that room and date never moves. Only non-void bills with
 * details.stay qualify: bill #7 and other legacy bills never move a reading or change coverage.
 *   interims = interim_readings rows; bills = [{ id, tenant_id, status, room_id, move_out_date, covered_cutoffs, details }]
 * Returns { moves: [{ interim, to, duplicate, duplicateId, billIds, familyIds }], bills: [{ id, covered_cutoffs }] }.
 */
export function planReattachment({ cutoffs, interims, bills }) {
  const live = (bills || []).filter(b => b.status !== 'VOID' && b.details?.stay)
  const family = (b) => new Set([b.tenant_id, ...(b.details.stay.group?.tenant_ids || [])])
  // A retried bed's own group list can be partial, so the link holds when either bill's group names the other tenant.
  const billsOfRow = (r) => {
    const day = iso10(r.reading_date), t = r.moving_out_tenant_id
    if (t == null) return []
    const here = live.filter(b => b.room_id === r.room_id && iso10(b.move_out_date) === day)
    const own = here.filter(b => b.tenant_id === t)
    return here.filter(b => family(b).has(t) || own.some(o => family(o).has(b.tenant_id)))
  }
  const moves = []
  const startOf = (c, util) => winOf(c, util)?.s ?? -Infinity
  for (const r of interims || []) {
    const day = iso10(r.reading_date)
    const linked = billsOfRow(r)
    if (!linked.length) continue
    const target = cutoffForUtilityDate(cutoffs, r.utility, day)
    if (!target || target.id === r.cutoff_id) continue
    const attached = (cutoffs || []).find(c => c.id === r.cutoff_id)
    if (!attached) continue
    const w = winOf(attached, r.utility), d = dayNum(day)
    if ((w && d >= w.s && d < w.e) || startOf(target, r.utility) <= startOf(attached, r.utility)) continue
    // A copy counts only if it is linked to the same tenant or group: an unrelated tenant's or a manual row is not this reading.
    const familyIds = [...new Set([r.moving_out_tenant_id, ...linked.flatMap(b => [...family(b)])])]
    const dup = (interims || []).find(x => x.id !== r.id && x.cutoff_id === target.id && x.room_id === r.room_id && x.utility === r.utility
      && iso10(x.reading_date) === day && Number(x.reading_value) === Number(r.reading_value) && familyIds.includes(x.moving_out_tenant_id))
    moves.push({ interim: r, to: target.id, duplicate: !!dup, duplicateId: dup?.id ?? null, billIds: linked.map(b => b.id), familyIds })
  }
  const billsOut = []
  for (const b of live) {
    const day = iso10(b.move_out_date)
    const entries = parseCovered(b.covered_cutoffs)
    let changed = false
    for (const [util, key] of [['WATER', 'water'], ['ELECTRIC', 'electric']]) {
      if (!(interims || []).some(r => r.utility === util && billsOfRow(r).some(x => x.id === b.id))) continue
      const target = cutoffForUtilityDate(cutoffs, util, day)
      if (!target) continue
      let e = entries.find(x => x.id === target.id)
      if (e?.[key]) continue
      if (!e) { e = { id: target.id, water: false, electric: false }; entries.push(e) }
      e[key] = true
      changed = true
    }
    if (changed) {
      billsOut.push({ id: b.id, covered_cutoffs: entries.sort((x, y) => x.id - y.id).map(x => (x.water && x.electric ? x.id : { id: x.id, water: x.water, electric: x.electric })) })
    }
  }
  return { moves, bills: billsOut }
}

/**
 * Is this move-out reading already saved for this tenant or a sibling in the group? rows = interim rows of the same room, utility, date and value.
 * An unrelated tenant leaving the same day at the same reading saves their own row (an equal date and value is a zero-day, zero-usage segment).
 */
export function readingOnFileFor(rows, familyIds) {
  const family = new Set(familyIds)
  return (rows || []).some(r => family.has(r.moving_out_tenant_id))
}

/**
 * Why this cutoff cannot be deleted, or null. Deleting it would cascade away a moved reading and leave a dangling coverage id: refused when a
 * non-void final bill references it (cutoff_id or covered_cutoffs), or a reading in it belongs to a tenant with a non-void final bill.
 *   bills = [{ id, tenant_id, status, cutoff_id, covered_cutoffs }]; interims = that cutoff's interim_readings rows
 */
export function cutoffDeleteBlocker({ cutoffId, bills, interims }) {
  const live = (bills || []).filter(b => b.status !== 'VOID')
  const hit = live.find(b => b.cutoff_id === cutoffId || parseCovered(b.covered_cutoffs).some(e => e.id === cutoffId))
    || live.find(b => (interims || []).some(r => r.moving_out_tenant_id != null && r.moving_out_tenant_id === b.tenant_id))
  return hit ? `This cutoff is part of final bill #${hit.id} and cannot be deleted. Edit its rate or name instead.` : null
}

/** Normalizes stored covered_cutoffs entries to [{ id, water, electric }] sorted by id (a plain number = both). */
export function parseCovered(entries) {
  const byId = new Map()
  for (const e of Array.isArray(entries) ? entries : []) {
    const id = typeof e === 'object' && e !== null ? e.id : e
    if (id == null || !Number.isFinite(Number(id))) continue
    const cur = byId.get(Number(id)) || { id: Number(id), water: false, electric: false }
    if (typeof e === 'object' && e !== null) { cur.water ||= !!e.water; cur.electric ||= !!e.electric } else { cur.water = true; cur.electric = true }
    byId.set(cur.id, cur)
  }
  return [...byId.values()].sort((a, b) => a.id - b.id)
}
