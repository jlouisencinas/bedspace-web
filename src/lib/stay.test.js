import { describe, it, expect } from 'vitest'
import {
  dayNum, isoOfDay, addMonthsISO, snapToMonthEnd, leaseMoveOut, newLeaseMoveOutProblem, prorateCents, stayRent, stayMonths,
  isMonthEnd, classifyStay, isStayBilled, appStart, cutoffForDate, cutoffForUtilityDate, finalCutoffForUtility,
  expectedCutoffName, pricingInfoForDay, isCutoffClosed, computeCoverage, coveredEntries, finalBilledStamps,
  planReattachment, readingOnFileFor, cutoffDeleteBlocker, parseCovered,
} from './stay'
import { SEP, OCT, NOV, CUTOFFS } from './__fixtures__/cutoffs'

describe('day numbers', () => {
  it('dayNum / isoOfDay round-trip and ignore the time part', () => {
    expect(isoOfDay(dayNum('2026-11-05'))).toBe('2026-11-05')
    expect(dayNum('2026-11-05T23:59:00+08:00')).toBe(dayNum('2026-11-05'))
    expect(dayNum('2026-12-01') - dayNum('2026-11-01')).toBe(30)
    expect(dayNum(null)).toBeNull()
  })
})

describe('month arithmetic', () => {
  it.each([
    ['2026-01-31', 1, '2026-02-28'],
    ['2028-01-31', 1, '2028-02-29'],
    ['2026-03-31', -1, '2026-02-28'],
    ['2026-11-15', 2, '2027-01-15'],
    ['2026-10-02', 1, '2026-11-02'],
    ['2026-08-31', 3, '2026-11-30'],
  ])('addMonthsISO(%s, %i) = %s', (iso, n, out) => {
    expect(addMonthsISO(iso, n)).toBe(out)
  })

  it('snapToMonthEnd and isMonthEnd', () => {
    expect(snapToMonthEnd('2028-02-10')).toBe('2028-02-29')
    expect(snapToMonthEnd('2026-02-10')).toBe('2026-02-28')
    expect(snapToMonthEnd('2026-11-30')).toBe('2026-11-30')
    expect(isMonthEnd('2026-11-30')).toBe(true)
    expect(isMonthEnd('2026-11-29')).toBe(false)
    expect(addMonthsISO('', 1)).toBe('')
  })

  it('leaseMoveOut lands on a month end', () => {
    expect(leaseMoveOut('2026-10-15', 1)).toBe('2026-11-30')
    expect(leaseMoveOut('2026-10-01', 1)).toBe('2026-10-31')
    expect(leaseMoveOut('2026-10-01', 6)).toBe('2027-03-31')
    expect(leaseMoveOut('2026-10-01', 0)).toBe('')
    expect(leaseMoveOut('2026-11-20', 1)).toBe('2026-12-31')
  })

  it('newLeaseMoveOutProblem', () => {
    expect(newLeaseMoveOutProblem('2026-10-15', '2026-11-30')).toBeNull()
    expect(newLeaseMoveOutProblem('2026-10-15', '')).toBe('A planned move-out date is required.')
    expect(newLeaseMoveOutProblem('2026-10-15', '2026-10-15')).toMatch(/must be after the move-in date/)
    expect(newLeaseMoveOutProblem('2026-10-15', '2026-11-15')).toMatch(/must be the last day of a month \(2026-11-30\)/)
  })
})

describe('prorateCents (integer half-up)', () => {
  it.each([
    [675000, 17, 31, 370161],
    [675000, 16, 30, 360000],
    [10000, 1, 3, 3333],
    [20000, 1, 3, 6667],
    [1, 1, 2, 1],
    [3, 1, 2, 2],
    [500000, 31, 31, 500000],
    [500000, 0, 31, 0],
    [500000, 5, 0, 0],
  ])('prorateCents(%i, %i, %i) = %i', (rate, days, win, out) => {
    const r = prorateCents(rate, days, win)
    expect(r).toBe(out)
    expect(Number.isInteger(r)).toBe(true)
  })
})

describe('stayRent: requirements §5 worked examples (rate 6,750)', () => {
  it.each([
    ['2026-10-15', '2026-11-30', 1035000, 1, false],
    ['2026-10-01', '2026-10-31', 675000, 0, false],
    ['2026-10-01', '2026-11-30', 1350000, 1, false],
    ['2026-10-15', '2026-12-31', 1720161, 2, false],
    ['2026-10-02', '2026-11-02', 675000, 1, true],
  ])('%s -> %s = %i cents', (a, b, total, months, exact) => {
    const r = stayRent(675000, a, b)
    expect(r.totalCents).toBe(total)
    expect(r.months).toBe(months)
    expect(r.exact).toBe(exact)
    expect(r.flatCents + r.excessCents).toBe(r.totalCents)
  })

  it('splits an excess that crosses a month end by month', () => {
    const r = stayRent(675000, '2026-10-20', '2026-12-05')
    expect(r.months).toBe(1)
    expect(r.segments).toEqual([
      { from: '2026-11-20', to: '2026-11-30', days: 11, monthDays: 30, cents: 247500 },
      { from: '2026-12-01', to: '2026-12-05', days: 5, monthDays: 31, cents: 108871 },
    ])
    expect(r.totalCents).toBe(675000 + 247500 + 108871)
  })

  it('returns null for unusable dates', () => {
    expect(stayRent(675000, '2026-11-30', '2026-10-15')).toBeNull()
    expect(stayRent(675000, null, '2026-10-15')).toBeNull()
  })
})

describe('stayMonths and classifyStay', () => {
  it('stayMonths', () => {
    expect(stayMonths('2026-10-02', '2026-11-02')).toBe(1)
    expect(stayMonths('2026-01-31', '2026-02-28')).toBe(1)
    expect(stayMonths('2026-10-15', '2026-11-30')).toBeNull()
    expect(stayMonths('2026-10-15', '2026-10-15')).toBeNull()
  })

  it('a planned one-month stay that is not a month end is STAY_BILLED', () => {
    expect(classifyStay({ moveIn: '2026-10-02', planned: '2026-11-02', actual: '2026-11-02', appStartISO: '2026-09-01' }))
      .toEqual({ kind: 'STAY_BILLED', months: 1, rentRule: 'FLAT_ONE_MONTH' })
    expect(classifyStay({ moveIn: '2026-10-02', planned: '2026-11-02', actual: '2026-10-20', appStartISO: '2026-09-01' }))
      .toEqual({ kind: 'STAY_BILLED', months: 1, rentRule: 'PRORATE_ALL_TOUCHED' })
  })

  it('a month-end planned date is never stay-billed', () => {
    expect(classifyStay({ moveIn: '2026-10-31', planned: '2026-11-30', actual: '2026-11-30', appStartISO: '2026-09-01' }).kind).toBe('WHOLE_MONTHS')
  })

  it('WHOLE_MONTHS after the app start, ODD before it', () => {
    expect(classifyStay({ moveIn: '2026-10-15', planned: '2026-11-30', actual: '2026-11-30', appStartISO: '2026-09-01' }))
      .toEqual({ kind: 'WHOLE_MONTHS', months: null, rentRule: 'N_X_RATE_MINUS_CLOSED' })
    expect(classifyStay({ moveIn: '2026-10-01', planned: '2027-03-31', actual: '2026-12-01', appStartISO: '2026-09-01' }).months).toBe(2)
    expect(classifyStay({ moveIn: '2026-05-01', planned: '2026-12-31', actual: '2026-11-15', appStartISO: '2026-09-01' }))
      .toEqual({ kind: 'ODD', months: null, rentRule: 'PRORATE_COVERED' })
  })

  it('isStayBilled only for active tenants', () => {
    expect(isStayBilled({ is_active: true, move_in_date: '2026-10-02', move_out_date: '2026-11-02' })).toBe(true)
    expect(isStayBilled({ is_active: false, move_in_date: '2026-10-02', move_out_date: '2026-11-02' })).toBe(false)
    expect(isStayBilled({ is_active: true, move_in_date: '2026-10-31', move_out_date: '2026-11-30' })).toBe(false)
    expect(isStayBilled(null)).toBe(false)
  })
})

describe('cutoff lookup', () => {
  it('appStart is the earliest water_start', () => {
    expect(appStart([NOV, SEP, OCT])).toBe('2026-09-01')
    expect(appStart([])).toBeNull()
  })

  it('cutoffForDate uses the water window, end exclusive', () => {
    expect(cutoffForDate(CUTOFFS, '2026-10-31').id).toBe(OCT.id)
    expect(cutoffForDate(CUTOFFS, '2026-11-01').id).toBe(NOV.id)
    expect(cutoffForDate(CUTOFFS, '2026-12-01')).toBeNull()
  })

  it('cutoffForUtilityDate uses the electric window for electricity', () => {
    expect(cutoffForUtilityDate(CUTOFFS, 'ELECTRIC', '2026-10-09').id).toBe(SEP.id)
    expect(cutoffForUtilityDate(CUTOFFS, 'ELECTRIC', '2026-10-10').id).toBe(OCT.id)
    expect(cutoffForUtilityDate(CUTOFFS, 'WATER', '2026-10-09').id).toBe(OCT.id)
  })

  it('finalCutoffForUtility: after the latest window bills against the latest cutoff', () => {
    expect(finalCutoffForUtility(CUTOFFS, 'WATER', '2026-12-15')).toEqual({ cutoff: NOV, beyondWindow: true })
    expect(finalCutoffForUtility(CUTOFFS, 'WATER', '2026-11-15')).toEqual({ cutoff: NOV, beyondWindow: false })
    expect(finalCutoffForUtility(CUTOFFS, 'ELECTRIC', '2026-09-05')).toEqual({ cutoff: null, beyondWindow: false })
  })

  it('expectedCutoffName: electric before the 10th belongs to the previous month', () => {
    expect(expectedCutoffName('ELECTRIC', '2027-01-05')).toBe('Dec 2026')
    expect(expectedCutoffName('ELECTRIC', '2027-01-10')).toBe('Jan 2027')
    expect(expectedCutoffName('WATER', '2027-01-05')).toBe('Jan 2027')
  })

  it('pricingInfoForDay: a gap day is priced at the following window, after the last window at the preceding one', () => {
    expect(pricingInfoForDay(CUTOFFS, 'ELECTRIC', dayNum('2026-09-05'))).toEqual({ cutoff: SEP, inWindow: false, dir: 'following' })
    expect(pricingInfoForDay(CUTOFFS, 'ELECTRIC', dayNum('2026-12-20'))).toEqual({ cutoff: NOV, inWindow: false, dir: 'preceding' })
    expect(pricingInfoForDay(CUTOFFS, 'ELECTRIC', dayNum('2026-10-20'))).toEqual({ cutoff: OCT, inWindow: true, dir: null })
  })

  it('isCutoffClosed: older than the active cutoff', () => {
    expect(isCutoffClosed(SEP, CUTOFFS)).toBe(true)
    expect(isCutoffClosed(OCT, CUTOFFS)).toBe(true)
    expect(isCutoffClosed(NOV, CUTOFFS)).toBe(false)
    expect(isCutoffClosed(NOV, CUTOFFS.map(c => ({ ...c, is_active: false })))).toBe(true)
  })
})

describe('computeCoverage', () => {
  it('a whole-months stay covers only the final cutoff when the earlier ones are closed', () => {
    const cov = computeCoverage({ cutoffs: CUTOFFS, moveInISO: '2026-10-15', moveOutISO: '2026-11-30', kind: 'WHOLE_MONTHS' })
    expect(cov.water.final.id).toBe(NOV.id)
    expect(cov.water.covered.map(c => c.id)).toEqual([NOV.id])
    expect(cov.electric.covered.map(c => c.id)).toEqual([NOV.id])
    expect(cov.coveredIds).toEqual([NOV.id])
    expect(cov.primaryCutoffId).toBe(NOV.id)
    expect(coveredEntries(cov)).toEqual([NOV.id])
  })

  it('a stay-billed stay covers every window it touched, per component', () => {
    const cov = computeCoverage({ cutoffs: CUTOFFS, moveInISO: '2026-10-02', moveOutISO: '2026-11-02', kind: 'STAY_BILLED' })
    expect(cov.water.covered.map(c => c.id)).toEqual([OCT.id, NOV.id])
    expect(cov.electric.covered.map(c => c.id)).toEqual([SEP.id, OCT.id])
    expect(cov.coveredIds).toEqual([1, 2, 3])
    expect(coveredEntries(cov)).toEqual([{ id: 1, water: false, electric: true }, 2, { id: 3, water: true, electric: false }])
    expect(cov.primaryCutoffId).toBe(NOV.id)
  })

  it('a date with no window holding it reports the missing cutoff', () => {
    const cov = computeCoverage({ cutoffs: [OCT, NOV], moveInISO: '2026-09-01', moveOutISO: '2026-10-05', kind: 'ODD' })
    expect(cov.electric.final).toBeNull()
    expect(cov.electric.missing).toEqual({ name: 'Sep 2026', date: '2026-10-05' })
  })
})

describe('covered_cutoffs storage', () => {
  it('parseCovered normalises plain ids and per-component entries', () => {
    expect(parseCovered([3, { id: 2, water: true }, { id: 2, electric: true }, 'x', null])).toEqual([
      { id: 2, water: true, electric: true },
      { id: 3, water: true, electric: true },
    ])
    expect(parseCovered(null)).toEqual([])
  })

  it('finalBilledStamps falls back to cutoff_id for legacy bills', () => {
    const m = finalBilledStamps([
      { tenant_id: 7, cutoff_id: 2, covered_cutoffs: null, created_at: '2026-10-20T10:00:00Z' },
      { tenant_id: 8, cutoff_id: 3, covered_cutoffs: [2, { id: 3, water: true, electric: false }] },
    ])
    expect(m.get(7)).toEqual({ both: [2], water: [2], electric: [2], at: '2026-10-20T10:00:00Z' })
    expect(m.get(8)).toEqual({ both: [2], water: [2, 3], electric: [2] })
  })

  it('finalBilledStamps leaves out the bill being re-issued', () => {
    const bills = [{ id: 26, tenant_id: 74, cutoff_id: 2, covered_cutoffs: [2] }]
    expect(finalBilledStamps(bills, { excludeBillId: 26 }).has(74)).toBe(false)
    expect(finalBilledStamps(bills).get(74)).toEqual({ both: [2], water: [2], electric: [2] })
    expect(finalBilledStamps(bills, { excludeBillId: 27 }).has(74)).toBe(true)
  })

  it('readingOnFileFor', () => {
    expect(readingOnFileFor([{ moving_out_tenant_id: 5 }], [4, 5])).toBe(true)
    expect(readingOnFileFor([{ moving_out_tenant_id: 9 }], [4, 5])).toBe(false)
  })
})

describe('cutoffDeleteBlocker', () => {
  const bills = [{ id: 7, tenant_id: 70, status: 'FINAL', cutoff_id: 2, covered_cutoffs: [2, { id: 3, water: true, electric: false }] }]
  it('refuses a cutoff a non-void final bill references', () => {
    expect(cutoffDeleteBlocker({ cutoffId: 3, bills, interims: [] })).toBe('This cutoff is part of final bill #7 and cannot be deleted. Edit its rate or name instead.')
  })
  it('refuses a cutoff holding such a bill\'s move-out reading', () => {
    expect(cutoffDeleteBlocker({ cutoffId: 4, bills, interims: [{ moving_out_tenant_id: 70 }] })).toMatch(/final bill #7/)
  })
  it('ignores void bills and unrelated readings', () => {
    expect(cutoffDeleteBlocker({ cutoffId: 3, bills: bills.map(b => ({ ...b, status: 'VOID' })), interims: [] })).toBeNull()
    expect(cutoffDeleteBlocker({ cutoffId: 4, bills, interims: [{ moving_out_tenant_id: null }] })).toBeNull()
  })
})

describe('planReattachment', () => {
  const DEC = { id: 4, name: 'Dec 2026', is_active: true, water_start: '2026-12-01', water_end: '2027-01-01', electric_start: '2026-12-10', electric_end: '2027-01-10' }
  const reading = { id: 50, cutoff_id: NOV.id, room_id: 11, utility: 'WATER', reading_date: '2026-12-05', reading_value: 510, moving_out_tenant_id: 70 }
  const bill = { id: 7, tenant_id: 70, status: 'FINAL', room_id: 11, move_out_date: '2026-12-05', covered_cutoffs: [NOV.id], details: { stay: { group: { tenant_ids: [70] } } } }

  it('moves a beyond-window reading into the new cutoff and adds that component to the bill', () => {
    const plan = planReattachment({ cutoffs: [...CUTOFFS, DEC], interims: [reading], bills: [bill] })
    expect(plan.moves).toEqual([{ interim: reading, to: DEC.id, duplicate: false, duplicateId: null, billIds: [7], familyIds: [70] }])
    expect(plan.bills).toEqual([{ id: 7, covered_cutoffs: [NOV.id, { id: DEC.id, water: true, electric: false }] }])
  })

  it('is idempotent once the reading sits in the cutoff that holds its date', () => {
    const plan = planReattachment({ cutoffs: [...CUTOFFS, DEC], interims: [{ ...reading, cutoff_id: DEC.id }], bills: [{ ...bill, covered_cutoffs: [NOV.id, { id: DEC.id, water: true, electric: false }] }] })
    expect(plan).toEqual({ moves: [], bills: [] })
  })

  it('never moves readings of legacy (no details.stay) or void bills', () => {
    expect(planReattachment({ cutoffs: [...CUTOFFS, DEC], interims: [reading], bills: [{ ...bill, details: null }] })).toEqual({ moves: [], bills: [] })
    expect(planReattachment({ cutoffs: [...CUTOFFS, DEC], interims: [reading], bills: [{ ...bill, status: 'VOID' }] })).toEqual({ moves: [], bills: [] })
  })
})
