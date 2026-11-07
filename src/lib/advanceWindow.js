/**
 * src/lib/advanceWindow.js
 * ------------------------
 * Pure. The one-month advance of a leaver whose move-out is not a month end covers the W days ENDING on the move-out
 * date M (inclusive), W = the day count of the second-to-last cutoff (31 for Oct): [M - W + 1, M]. The second-to-last
 * statement (cutoff window [s, e), e exclusive) bills the full rent and credits the part of the window inside it
 * (rent x d / W, d = e - window start, half-up) as `Less: Advance`; the final bill credits the rest of the advance and
 * bills the days after the cutoff as rent - that credit, so the window costs exactly one monthly rent.
 * The table rent_carryovers (name historical) freezes the window at Open Cutoff: carry_days = d, carry_amount = the
 * cutoff-side part. Integer cents. docs/requirements.md §5.
 */
import { dayNum, isoOfDay, addMonthsISO, prorateCents, snapToMonthEnd } from './stay'

const MONTH_NAMES = ['January','February','March','April','May','June','July','August','September','October','November','December']
const MON3 = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec']
const iso10 = (v) => (v ? String(v).slice(0, 10) : null)
const cents = (v) => { const n = Number(v); return Number.isFinite(n) ? Math.sign(n) * Math.round(Math.abs(n) * 100) + 0 : 0 }
const dayMonth = (n) => { const [, m, d] = isoOfDay(n).split('-'); return `${d} ${MONTH_NAMES[+m - 1]}` }
const shortDay = (n) => { const [, m, d] = isoOfDay(n).split('-'); return `${+d} ${MON3[+m - 1]}` }
const monDay = (n) => { const [, m, d] = isoOfDay(n).split('-'); return `${MON3[+m - 1]} ${+d}` }
const span = (a, b) => (a === b ? monDay(a) : `${monDay(a)} to ${monDay(b)}`)
const range = (a, b) => (a === b ? shortDay(a) : `${shortDay(a)} - ${shortDay(b)}`)

/**
 * The advance window of a second-to-last statement, or null when the rule does not apply (move-out not in the next
 * window, on its last day (month-end rule), window start not strictly inside the cutoff, or a part of 0 / the whole rent).
 * Returns { windowStart, moveOut, cutoffDays, carryDays, carryCents, afterCents, monthRentCents } where carryCents is the
 * cutoff-side part (the credit basis) and afterCents = rent - carryCents (the days after the cutoff, on the final bill).
 */
export function advanceWindow({ moveOutISO, cutoff, rentCents }) {
  const M = iso10(moveOutISO)
  if (!M || !cutoff?.water_start || !cutoff?.water_end || !Number.isInteger(rentCents) || rentCents <= 0) return null
  const s = dayNum(cutoff.water_start), e = dayNum(cutoff.water_end), m = dayNum(M)
  const nextEnd = dayNum(addMonthsISO(iso10(cutoff.water_end), 1))
  if (m < e || m >= nextEnd - 1) return null
  const cutoffDays = e - s
  const w0 = m - cutoffDays + 1
  if (!(w0 > s && w0 < e)) return null
  const carryDays = e - w0
  const carryCents = prorateCents(rentCents, carryDays, cutoffDays)
  if (carryCents <= 0 || carryCents >= rentCents) return null
  return { windowStart: isoOfDay(w0), moveOut: M, cutoffDays, carryDays, carryCents, afterCents: rentCents - carryCents, monthRentCents: rentCents }
}

// Accepts a window info (advanceWindow / credit.window) or a rent_carryovers row.
const facts = (w) => {
  const w0 = dayNum(iso10(w.windowStart ?? w.window_start))
  const carryDays = Number(w.carryDays ?? w.carry_days)
  return { w0, carryDays, e: w0 + carryDays, m: dayNum(iso10(w.moveOut ?? w.move_out_date)) }
}

/** The statement's credit days: "20 days (Oct 12 to Oct 31)" / "1 day (Oct 31)". */
export function creditPeriodText(w) {
  const { w0, carryDays, e } = facts(w)
  return `${carryDays} ${carryDays === 1 ? 'day' : 'days'} (${span(w0, e - 1)})`
}

/** The days of the window after the cutoff (billed on the final bill): "Nov 1 to Nov 11" / "Nov 1". */
export function finalPartText(w) {
  const { e, m } = facts(w)
  return span(e, m)
}

/** The whole window: "12 Oct - 11 Nov". */
export function windowRange(w) {
  const { w0, m } = facts(w)
  return range(w0, m)
}

/** Throws unless every rent_carryovers row is internally exact (the cutoff-side part is the half-up day share of the month rent). */
export function assertCarryRows(rows) {
  for (const r of rows || []) {
    const R = cents(r.month_rent), C = cents(r.carry_amount)
    const ok = Number.isInteger(r.cutoff_days) && Number.isInteger(r.carry_days) && r.carry_days > 0 && r.carry_days < r.cutoff_days
      && R > 0 && C > 0 && C < R && C === prorateCents(R, r.carry_days, r.cutoff_days)
      && dayNum(r.window_start) != null && dayNum(r.move_out_date) != null
    if (!ok) throw new Error(`Advance window for tenant #${r.tenant_id}: the cutoff part (${r.carry_amount}) does not match ${r.carry_days} of ${r.cutoff_days} days of ${r.month_rent}. Nothing was recorded.`)
  }
}

const rentLine = (label, mid, c) => ({ label, mid, amount: c / 100, kind: 'charge', source: 'RENT', computed: c / 100 })

/**
 * Final-bill rent lines from a stored rent_carryovers row (the cutoff-side part was billed in full on the statement and
 * credited there). When the rent ends on the date the row was frozen for: ONE line for the days after the cutoff,
 * month_rent - carry_amount (frozen rent), so the window is exactly one monthly rent. Otherwise (the contract date moved
 * after the freeze) the days after the cutoff through rentEndISO are prorated plainly by calendar month and `warning` is set.
 * Returns { lines, exact, warning }.
 */
export function carryRentLines({ row, rentEndISO }) {
  const R = cents(row.month_rent), C = cents(row.carry_amount)
  const { e, m } = facts(row)
  const frozen = iso10(row.move_out_date), end = iso10(rentEndISO), endN = dayNum(end)
  if (end === frozen) {
    return { lines: [rentLine('Rent Period (completes the 1-month advance)', range(e, m), R - C)], exact: true, warning: null }
  }
  const lines = []
  let from = e
  while (from <= endN) {
    const monthEnd = snapToMonthEnd(isoOfDay(from))
    const to = Math.min(endN, dayNum(monthEnd))
    const n = to - from + 1, monthDays = Number(monthEnd.slice(8, 10))
    lines.push(rentLine(n < monthDays ? `Rent Period (${n} of ${monthDays} days)` : 'Rent Period', `${dayMonth(from)} - ${dayMonth(to)}`, prorateCents(R, n, monthDays)))
    from = to + 1
  }
  if (!lines.length) lines.push(rentLine('Rent Period', '', 0))
  return {
    lines, exact: false,
    warning: `The advance window was recorded at Open Cutoff for a move-out on ${frozen}, but the rent now ends on ${end}: the days after ${isoOfDay(e - 1)} are prorated by calendar month, so the advance no longer covers exactly one month. Check the rent lines.`,
  }
}
