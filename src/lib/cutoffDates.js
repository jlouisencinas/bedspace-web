// A cutoff's water_end is stored EXCLUSIVE (billing counts days < water_end), so "1st to end of month" is
// stored as 1st -> 1st of the next month. People read the window as ending on its last billed day, so screens
// show water windows through windowLastDay(water_end) (e.g. stored 2026-12-01 is shown as 2026-11-30).
// Pure, no imports. Electric windows (10th to 10th) are shown as stored.
export function windowLastDay(endExclusiveISO) {
  if (!endExclusiveISO) return ''
  const [y, m, d] = String(endExclusiveISO).slice(0, 10).split('-').map(Number)
  return new Date(Date.UTC(y, m - 1, d - 1)).toISOString().slice(0, 10)
}
