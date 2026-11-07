/**
 * src/lib/advanceWindow.js
 * ------------------------
 * Pure. The one-month advance of a leaver whose move-out is not a month end covers the ONE MONTH ENDING on the move-out
 * date, counted backwards with the move-out day billed: [addMonths(M, -1) + 1 day, M]. On the second-to-last statement
 * (cutoff window [s, e), e exclusive) only the days before that window are billed; the rest of that cutoff's rent (the
 * carry) moves to the final bill, which bills it plus the part after the cutoff (month rent - carry, so the window is
 * exactly one monthly rent) and credits the whole advance against them. Integer cents; only the carry is rounded
 * (half-up, prorateCents), the other parts are by subtraction. docs/requirements.md §5.
 */
import { dayNum, isoOfDay, addMonthsISO, prorateCents, snapToMonthEnd } from './stay'

const MONTH_NAMES = ['January','February','March','April','May','June','July','August','September','October','November','December']
const iso10 = (v) => (v ? String(v).slice(0, 10) : null)
const cents = (v) => { const n = Number(v); return Number.isFinite(n) ? Math.sign(n) * Math.round(Math.abs(n) * 100) + 0 : 0 }
const dayMonth = (n) => { const [, m, d] = isoOfDay(n).split('-'); return `${d} ${MONTH_NAMES[+m - 1]}` }

/**
 * The advance window of a second-to-last statement, or null when the rule does not apply (move-out not in the next
 * window, on its last day (month-end rule), window start not strictly inside the cutoff, or a carry of 0 / the whole rent).
 * Returns { windowStart, moveOut, cutoffDays, preDays, carryDays, carryCents, preCents, monthRentCents }.
 */
export function advanceWindow({ moveOutISO, cutoff, rentCents }) {
  const M = iso10(moveOutISO)
  if (!M || !cutoff?.water_start || !cutoff?.water_end || !Number.isInteger(rentCents) || rentCents <= 0) return null
  const s = dayNum(cutoff.water_start), e = dayNum(cutoff.water_end), m = dayNum(M)
  const nextEnd = dayNum(addMonthsISO(iso10(cutoff.water_end), 1))
  if (m < e || m >= nextEnd - 1) return null
  const w0 = dayNum(addMonthsISO(M, -1)) + 1
  if (!(w0 > s && w0 < e)) return null
  const cutoffDays = e - s, preDays = w0 - s, carryDays = e - w0
  const carryCents = prorateCents(rentCents, carryDays, cutoffDays)
  if (carryCents <= 0 || carryCents >= rentCents) return null
  return { windowStart: isoOfDay(w0), moveOut: M, cutoffDays, preDays, carryDays, carryCents, preCents: rentCents - carryCents, monthRentCents: rentCents }
}

/** Throws unless every rent_carryovers row is internally exact (the carry is the half-up day share of the month rent). */
export function assertCarryRows(rows) {
  for (const r of rows || []) {
    const R = cents(r.month_rent), C = cents(r.carry_amount)
    const ok = Number.isInteger(r.cutoff_days) && Number.isInteger(r.carry_days) && r.carry_days > 0 && r.carry_days < r.cutoff_days
      && R > 0 && C > 0 && C < R && C === prorateCents(R, r.carry_days, r.cutoff_days)
      && dayNum(r.window_start) != null && dayNum(r.move_out_date) != null
    if (!ok) throw new Error(`Advance window for tenant #${r.tenant_id}: the carried rent (${r.carry_amount}) does not match ${r.carry_days} of ${r.cutoff_days} days of ${r.month_rent}. Nothing was recorded.`)
  }
}

const rentLine = (label, mid, c) => ({ label, mid, amount: c / 100, kind: 'charge', source: 'RENT', computed: c / 100 })

/**
 * Final-bill rent lines from a stored rent_carryovers row. When the rent ends on the date the row was frozen for: the carried
 * part of the cutoff (carry_amount) + the rest of the advance month (month_rent - carry_amount); both use the frozen month rent.
 * Otherwise (early move-out, or the contract date moved after the freeze) the days actually stayed from window_start through
 * rentEndISO are prorated plainly (carry days over the cutoff's days, later days over each calendar month) and `warning` is set.
 * Returns { lines, exact, warning }.
 */
export function carryRentLines({ row, rentEndISO }) {
  const R = cents(row.month_rent), C = cents(row.carry_amount)
  const W = Number(row.cutoff_days), carryDays = Number(row.carry_days)
  const w0 = dayNum(row.window_start), e = w0 + carryDays
  const frozen = iso10(row.move_out_date), end = iso10(rentEndISO), endN = dayNum(end)
  if (end === frozen) {
    return {
      lines: [
        rentLine(`Rent Period (${carryDays} of ${W} days)`, `${dayMonth(w0)} - ${dayMonth(e - 1)}`, C),
        rentLine('Rent Period (completes the 1-month advance)', `${dayMonth(e)} - ${dayMonth(endN)}`, R - C),
      ],
      exact: true, warning: null,
    }
  }
  const lines = []
  const days = Math.max(0, Math.min(endN, e - 1) - w0 + 1)
  if (days > 0) lines.push(rentLine(`Rent Period (${days} of ${W} days)`, `${dayMonth(w0)} - ${dayMonth(w0 + days - 1)}`, days === carryDays ? C : prorateCents(R, days, W)))
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
    warning: `The advance window was recorded at Open Cutoff for a move-out on ${frozen}, but the rent now ends on ${end}: the rent from ${dayMonth(w0)} is prorated by days through ${end}, so the advance no longer covers exactly one month. Check the rent lines.`,
  }
}
