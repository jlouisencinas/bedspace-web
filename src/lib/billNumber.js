const ISO_MONTH = /^(\d{4})-(\d{2})/

// The cutoff's billing month is the month of its Rent + Water window (1st to month end), so the Electricity
// statement of the same cutoff (10th to 10th) carries the same month. No Date parsing: no timezone shift.
export function cutoffBillingMonth(cutoff) {
  const iso = cutoff?.water_start || cutoff?.electric_start
  const m = typeof iso === 'string' ? ISO_MONTH.exec(iso) : null
  if (!m) return null
  return { year: m[1], month: m[2] }
}

// Monthly statement Billing No.: "<room_no>-<YYYY>-<MM>", e.g. "301-2026-09". null when room or month is unknown.
export function monthlyBillNo(roomNo, cutoff) {
  const room = roomNo == null ? '' : String(roomNo).trim()
  if (!room) return null
  const ym = cutoffBillingMonth(cutoff)
  if (!ym) return null
  return `${room}-${ym.year}-${ym.month}`
}
