// Advance window (docs/requirements.md §5): the 1-month advance of a non-month-end leaver covers the W days (the cutoff's day
// count) ending on the move-out date. The second-to-last statement bills the full rent and credits the window's days inside
// the cutoff as `Less: Advance`; the final bill bills the days after the cutoff as rent - that credit and credits the rest.
import { describe, it, expect } from 'vitest'
import { advanceWindow, assertCarryRows, carryRentLines, creditPeriodText, finalPartText, windowRange } from './advanceWindow'
import {
  advanceCarry, advanceCredits, carryToStore, cutoffAdvance, creditsToStore, assertCreditRows, assertWindowCreditRows,
  buildFinalBillDraft, verifyBillAgainstDb, toCents,
} from './finalBill'
import { computeBilling } from './billing'
import { rentWaterProps, creditSubText } from './monthlyStatement'
import { buildPaymentMonitoring } from './collectionsSummary'
import { dayNum, isoOfDay, addMonthsISO } from './stay'
import { OCT, OCT_ACTIVE, SEP, SEP_ACTIVE, FEB27_ACTIVE, FEB28_ACTIVE } from './__fixtures__/cutoffs'
import { tenant, deposit, billRow } from './__fixtures__/tenants'
import { NOW, advanceWindowOut, WINDOW_CARRY_ROW, WINDOW_CREDIT_ROW } from './__fixtures__/finalBill'

const win = (cutoff, moveOutISO, rentCents = 500000) => advanceWindow({ moveOutISO, cutoff, rentCents })

describe('advanceWindow', () => {
  it('owner example: Oct cutoff (31 days), out Nov 11 -> window 12 Oct - 11 Nov; Oct part 20 days 3,225.81, Nov part 1,774.19', () => {
    expect(win(OCT_ACTIVE, '2026-11-11')).toEqual({
      windowStart: '2026-10-12', moveOut: '2026-11-11', cutoffDays: 31, carryDays: 20,
      carryCents: 322581, afterCents: 177419, monthRentCents: 500000,
    })
  })

  it.each([
    ['2026-11-01', '2026-10-02', 30, 483871, 16129],
    ['2026-11-05', '2026-10-06', 26, 419355, 80645],
    ['2026-11-15', '2026-10-16', 16, 258065, 241935],
    ['2026-11-29', '2026-10-30', 2, 32258, 467742],
  ])('Oct cutoff, out %s -> window from %s, %i Oct days, credit %i, remainder %i', (m, start, d, credit, rest) => {
    expect(win(OCT_ACTIVE, m)).toMatchObject({ windowStart: start, carryDays: d, carryCents: credit, afterCents: rest })
  })

  it('30-day (Sep) and 28-day (Feb) cutoffs use their own day count', () => {
    expect(win(SEP_ACTIVE, '2026-10-15')).toMatchObject({ windowStart: '2026-09-16', carryDays: 15, carryCents: 250000, afterCents: 250000, cutoffDays: 30 })
    expect(win(SEP_ACTIVE, '2026-10-01')).toMatchObject({ windowStart: '2026-09-02', carryDays: 29, carryCents: 483333, afterCents: 16667 })
    expect(win(FEB27_ACTIVE, '2027-03-15')).toMatchObject({ windowStart: '2027-02-16', carryDays: 13, carryCents: 232143, afterCents: 267857, cutoffDays: 28 })
  })

  it('no window: month-end move-out, window not starting inside the cutoff, outside the next window, bad rent', () => {
    expect(win(OCT_ACTIVE, '2026-11-30')).toBeNull()
    expect(win(SEP_ACTIVE, '2026-10-30')).toBeNull()
    expect(win(FEB27_ACTIVE, '2027-03-30')).toBeNull()
    expect(win(FEB27_ACTIVE, '2027-03-29')).toBeNull()
    expect(win(OCT_ACTIVE, '2026-10-20')).toBeNull()
    expect(win(OCT_ACTIVE, '2026-12-05')).toBeNull()
    expect(win(OCT_ACTIVE, '2026-11-11', 0)).toBeNull()
    expect(win(OCT_ACTIVE, '2026-11-11', 5000.5)).toBeNull()
  })

  it('property: credit + remainder = rent; window start = M - W + 1 = addMonths(M, -1) + 1 on calendar cutoffs (28/29/30/31 days)', () => {
    for (const [c, W] of [[FEB27_ACTIVE, 28], [FEB28_ACTIVE, 29], [SEP_ACTIVE, 30], [OCT_ACTIVE, 31]]) {
      const s = dayNum(c.water_start), e = dayNum(c.water_end), nextEnd = dayNum(addMonthsISO(c.water_end, 1))
      for (let m = e; m < e + 31; m++) {
        const old = dayNum(addMonthsISO(isoOfDay(m), -1)) + 1
        for (const R of [99, 300000, 450050, 500000, 675000, 1234567]) {
          const r = win(c, isoOfDay(m), R)
          expect(r != null).toBe(m < nextEnd - 1 && old > s && old < e)
          if (!r) continue
          expect(r.cutoffDays).toBe(W)
          expect(dayNum(r.windowStart)).toBe(m - W + 1)
          expect(dayNum(r.windowStart)).toBe(old)
          expect(r.carryDays).toBe(e - dayNum(r.windowStart))
          expect(r.carryCents + r.afterCents).toBe(R)
          expect(Number.isInteger(r.carryCents) && r.carryCents > 0 && r.carryCents < R).toBe(true)
        }
      }
    }
  })
})

describe('credit and window texts', () => {
  it('creditPeriodText: "20 days (Oct 12 to Oct 31)", singular "1 day (Oct 31)", Feb aware', () => {
    expect(creditPeriodText(win(OCT_ACTIVE, '2026-11-11'))).toBe('20 days (Oct 12 to Oct 31)')
    expect(creditPeriodText(WINDOW_CARRY_ROW)).toBe('20 days (Oct 12 to Oct 31)')
    expect(creditPeriodText({ windowStart: '2026-10-31', carryDays: 1, moveOut: '2026-11-30' })).toBe('1 day (Oct 31)')
    expect(creditPeriodText(win(SEP_ACTIVE, '2026-10-29'))).toBe('1 day (Sep 30)')
    expect(creditPeriodText(win(FEB27_ACTIVE, '2027-03-15'))).toBe('13 days (Feb 16 to Feb 28)')
  })
  it('finalPartText / windowRange', () => {
    expect(finalPartText(WINDOW_CARRY_ROW)).toBe('Nov 1 to Nov 11')
    expect(finalPartText(win(OCT_ACTIVE, '2026-11-01'))).toBe('Nov 1')
    expect(windowRange(WINDOW_CARRY_ROW)).toBe('12 Oct - 11 Nov')
  })
})

describe('assertCarryRows', () => {
  it('accepts an exact row and refuses a cutoff part that is not the half-up day share', () => {
    expect(() => assertCarryRows([WINDOW_CARRY_ROW])).not.toThrow()
    expect(() => assertCarryRows([{ ...WINDOW_CARRY_ROW, carry_amount: 3225.8 }])).toThrow(/does not match/)
    expect(() => assertCarryRows([{ ...WINDOW_CARRY_ROW, carry_days: 31 }])).toThrow(/does not match/)
  })
})

describe('advanceCredits: the `Less: Advance` credit from the window', () => {
  const t = (extra = {}) => tenant({ id: 1, rate: 5000, move_in_date: '2026-08-01', move_out_date: '2026-11-11', ...extra })
  const adv = (id, amount, extra = {}) => deposit({ id, tenant_id: 1, kind: 'ADVANCE', amount, ref_no: String(6000 + id), ...extra })
  const args = (extra = {}) => ({ tenants: [t()], cutoff: OCT_ACTIVE, perTenant: [{ id: 1, rent: 5000 }], deposits: [adv(41, 5000)], ...extra })

  it('live on the active Oct cutoff, one 5,000 HELD advance, out Nov 11 -> 3,225.81 credited, 1,774.19 remaining', () => {
    expect(advanceCredits(args()).get(1)).toEqual({
      amount: 3225.81, ref: 'S.I# 6041', allocations: [{ deposit_id: 41, amount: 3225.81 }], onFile: 5000, remaining: 1774.19,
      window: { windowStart: '2026-10-12', cutoffDays: 31, carryDays: 20, moveOut: '2026-11-11', monthRentCents: 500000 },
    })
    expect(advanceCarry(args()).get(1)).toMatchObject({ windowStart: '2026-10-12', carryCents: 322581, stored: false })
  })

  it('two receipts (3,000 + 2,000) are used in id order up to the credit; the ref names both', () => {
    const c = advanceCredits(args({ deposits: [adv(42, 2000), adv(41, 3000)] })).get(1)
    expect(c.allocations).toEqual([{ deposit_id: 41, amount: 3000 }, { deposit_id: 42, amount: 225.81 }])
    expect(c).toMatchObject({ amount: 3225.81, ref: 'S.I# 6042 & S.I# 6041', remaining: 1774.19 })
  })

  it('an advance smaller than the window part is credited whole, nothing remains', () => {
    expect(advanceCredits(args({ deposits: [adv(41, 2000)] })).get(1)).toMatchObject({ amount: 2000, remaining: 0, onFile: 2000 })
  })

  it('a receipt without an S.I# gives an empty ref (the days text still prints)', () => {
    expect(advanceCredits(args({ deposits: [adv(41, 5000, { ref_no: '' })] })).get(1)).toMatchObject({ amount: 3225.81, ref: '' })
  })

  it('fallbacks: no receipt, whole-room, transfer, month-end, consumed by a stored Sep credit, final-billed, closed cutoff without rows', () => {
    expect(advanceCredits(args({ deposits: [] })).size).toBe(0)
    expect(advanceCredits(args({ perTenant: [{ id: 1, rent: 5000, wholeRoom: true }] })).size).toBe(0)
    expect(advanceCredits(args({ perTenant: [{ id: 1, rent: 5000, transferred: true }] })).size).toBe(0)
    expect(advanceCredits(args({ transfers: [{ tenant_id: 1, transfer_date: '2026-10-05' }] })).size).toBe(0)
    expect(advanceCredits(args({ tenants: [t({ move_out_date: '2026-11-30' })] })).size).toBe(0)
    expect(advanceCredits(args({ stored: [{ tenant_id: 1, cutoff_id: SEP.id, amount: 5000, allocations: [{ deposit_id: 41, amount: 5000 }] }] })).size).toBe(0)
    expect(advanceCredits(args({ finalBills: [{ tenant_id: 1, status: 'FINAL' }] })).size).toBe(0)
    expect(advanceCredits(args({ cutoff: OCT })).size).toBe(0)
  })

  it('stored rows on the closed cutoff win over a later move-out change; a legacy Sep row has no window', () => {
    const carry = [{ ...WINDOW_CARRY_ROW, tenant_id: 1 }]
    const stored = [{ ...WINDOW_CREDIT_ROW, tenant_id: 1, ref_text: 'S.I# 6041', allocations: [{ deposit_id: 41, amount: 3225.81 }] }]
    const moved = { tenants: [t({ move_out_date: '2026-11-25' })], cutoff: OCT, carry, stored }
    expect(advanceCredits(args(moved)).get(1)).toMatchObject({ amount: 3225.81, remaining: 1774.19, window: { windowStart: '2026-10-12', moveOut: '2026-11-11' } })
    // a stored window row without its credit row (failed between the two inserts): the credit is derived from the window
    expect(advanceCredits(args({ ...moved, stored: [] })).get(1)).toMatchObject({ amount: 3225.81, window: { carryDays: 20 } })
    const legacy = [{ tenant_id: 1, cutoff_id: SEP.id, amount: 4000, ref_text: 'S.I# 6041', allocations: [{ deposit_id: 41, amount: 4000 }] }]
    const l = advanceCredits(args({ cutoff: SEP, stored: legacy })).get(1)
    expect(l).toMatchObject({ amount: 4000, remaining: 1000 })
    expect(l.window).toBeUndefined()
  })
})

describe('Open Cutoff rows: carryToStore then creditsToStore', () => {
  const t = (m) => tenant({ id: 1, rate: 5000, move_in_date: '2026-08-01', move_out_date: m })
  const adv = deposit({ id: 41, tenant_id: 1, kind: 'ADVANCE', amount: 5000, ref_no: '6041' })
  const at = (m, extra = {}) => ({ tenants: [t(m)], cutoff: OCT_ACTIVE, perTenant: [{ id: 1, rent: 5000 }], deposits: [adv], ...extra })
  const ROW15 = { tenant_id: 1, cutoff_id: OCT.id, move_out_date: '2026-11-15', window_start: '2026-10-16', cutoff_days: 31, carry_days: 16, month_rent: 5000, carry_amount: 2580.65 }

  it('window row for Nov 15, none for Nov 30, none when already stored or the receipt is not HELD', () => {
    expect(carryToStore(at('2026-11-15'))).toEqual([ROW15])
    expect(carryToStore(at('2026-11-30'))).toEqual([])
    expect(carryToStore(at('2026-11-15', { carry: [{ tenant_id: 1, cutoff_id: OCT.id }] }))).toEqual([])
    expect(carryToStore(at('2026-11-15', { deposits: [{ ...adv, status: 'APPLIED' }] }))).toEqual([])
  })

  it('credit rows come from the stored windows: amount = min(window part, HELD advance), HELD only, existing / final-billed skipped', () => {
    expect(creditsToStore(at('2026-11-15', { carry: [ROW15] }))).toEqual([
      { tenant_id: 1, cutoff_id: OCT.id, amount: 2580.65, ref_text: 'S.I# 6041', allocations: [{ deposit_id: 41, amount: 2580.65 }] },
    ])
    expect(creditsToStore(at('2026-11-15'))).toEqual([])
    expect(creditsToStore(at('2026-11-15', { carry: [ROW15], deposits: [{ ...adv, amount: 2000 }] }))[0].amount).toBe(2000)
    expect(creditsToStore(at('2026-11-15', { carry: [ROW15], deposits: [{ ...adv, status: 'APPLIED' }] }))).toEqual([])
    expect(creditsToStore(at('2026-11-15', { carry: [ROW15], stored: [{ tenant_id: 1, cutoff_id: OCT.id, amount: 2580.65, allocations: [] }] }))).toEqual([])
    expect(creditsToStore(at('2026-11-15', { carry: [ROW15], finalBills: [{ tenant_id: 1, status: 'FINAL' }] }))).toEqual([])
  })

  it('a retry after a failure between the inserts: windows already stored, only the credit is still written', () => {
    const args = at('2026-11-15', { carry: [{ ...ROW15, id: 9 }] })
    expect(carryToStore(args)).toEqual([])
    expect(creditsToStore(args)).toHaveLength(1)
  })

  it('assertCreditRows / assertWindowCreditRows refuse a row that does not add up or is not min(window part, HELD advance)', () => {
    const ok = { tenant_id: 1, cutoff_id: OCT.id, amount: 2580.65, allocations: [{ deposit_id: 41, amount: 2580.65 }] }
    expect(() => assertWindowCreditRows([ok], [ROW15], [adv])).not.toThrow()
    expect(() => assertWindowCreditRows([{ ...ok, amount: 2580.66 }], [ROW15], [adv])).toThrow(/not the lower of/)
    expect(() => assertWindowCreditRows([{ ...ok, amount: 2000 }], [ROW15], [adv])).toThrow(/not the lower of/)
    expect(() => assertWindowCreditRows([ok], [], [adv])).toThrow(/none recorded/)
    expect(() => assertCreditRows([{ ...ok, allocations: [{ deposit_id: 41, amount: 2580.64 }] }])).toThrow(/do not add up/)
  })
})

// Oct statement of the window tenant computed exactly as computeCutoffBilling does (computeBilling + cutoffAdvance).
function octStatement() {
  const t = tenant({ id: 140, name: 'Tenant Window', rate: 5000, move_in_date: '2026-09-01', move_out_date: '2026-11-11' })
  const deposits = [deposit({ id: 941, tenant_id: 140, kind: 'ADVANCE', amount: 5000, ref_no: '5401' })]
  const bill = [billRow({ room: 101, water_prev: 0, water_curr: 1.25, water_rate: 155.04 })]
  const result = computeBilling(OCT_ACTIVE, bill, [], [t], [], [], [], [])
  const adv = cutoffAdvance({ cutoff: OCT_ACTIVE, perTenant: result.perTenant, tenants: [t], advData: { deposits, finalBills: [], stored: [], carry: [] } })
  return { t, deposits, raw: result.perTenant, ...adv }
}

describe('cutoffAdvance (computeCutoffBilling)', () => {
  it('leaver row keeps the full rent; the credit is a separate entry with its window', () => {
    const { raw, perTenant, credits, carries } = octStatement()
    expect(perTenant).toBe(raw)
    expect(toCents(perTenant[0].rent)).toBe(500000)
    expect(perTenant[0].advanceCarry).toBeUndefined()
    expect(credits.get(140)).toMatchObject({ amount: 3225.81, remaining: 1774.19, ref: 'S.I# 5401' })
    expect(carries.get(140)).toMatchObject({ carryCents: 322581 })
  })
})

describe('printed second-to-last statement (Less: Advance)', () => {
  const cutoff = OCT_ACTIVE
  const props = (row, credit) => rentWaterProps({ t: row, cutoff, roomRow: {}, splits: [], credit, billNo: 'X-1', copyLabel: 'Tenant copy', billingDate: '2026-10-31' })
  const base = { id: 1, name: 'Tenant 1', room_id: 11, room_no: '101', rent: 5000, water: 193.8, waterCons: 1.25, addons: [] }
  const credit = (extra = {}) => ({
    amount: 3225.81, remaining: 1774.19, onFile: 5000, ref: 'S.I# 1234',
    window: { windowStart: '2026-10-12', cutoffDays: 31, carryDays: 20, moveOut: '2026-11-11', monthRentCents: 500000 }, ...extra,
  })

  it('owner example: Monthly Rent 1 Oct - 31 Oct 5,000, water, Less: Advance S.I# | 20 days (Oct 12 to Oct 31) -3,225.81', () => {
    const p = props({ ...base, water: 193.45 }, credit())
    expect(p.charges.map(c => [c.label, c.mid, c.amount])).toEqual([
      ['Monthly Rent', '1 Oct - 31 Oct', 5000],
      ['Add: Water (cu. m)', '1.25', 193.45],
      ['Less: Advance', 'S.I# 1234 | 20 days (Oct 12 to Oct 31)', -3225.81],
    ])
    expect(p.charges[2].amountText).toBe('-₱3,225.81')
    expect(toCents(p.total)).toBe(196764)
    expect(p.paymentNote).toBe('Remaining advance Php 1,774.19 will be credited on the final bill (Nov 1 to Nov 11).')
  })

  it('with the app water (193.80) the total is 1,967.99; the credit computed by advanceCredits prints the same row', () => {
    const { perTenant, credits } = octStatement()
    const p = props({ ...perTenant[0], room_no: '101' }, credits.get(140))
    expect(toCents(p.total)).toBe(196799)
    expect(p.charges.find(c => c.label === 'Less: Advance').mid).toBe('S.I# 5401 | 20 days (Oct 12 to Oct 31)')
  })

  it('print layout: the credit cell is two short small lines (ref, days) so it never widens the row; legacy row unchanged', () => {
    const worst = props(base, credit({ ref: 'S.I# 1234 & S.I# 1235', amount: 4354.84 })).charges.find(c => c.label === 'Less: Advance')
    expect(worst).toMatchObject({ midLines: ['S.I# 1234 & S.I# 1235', '20 days (Oct 12 to Oct 31)'], small: true, amountText: '-₱4,354.84' })
    expect(worst.mid).toBe('S.I# 1234 & S.I# 1235 | 20 days (Oct 12 to Oct 31)')
    expect(Math.max(...worst.midLines.map(l => l.length))).toBeLessThanOrEqual(26)
    expect(props(base, credit({ ref: '' })).charges.find(c => c.label === 'Less: Advance').midLines).toEqual(['20 days (Oct 12 to Oct 31)'])
    const legacy = props(base, { amount: 5000, remaining: 0, ref: 'S.I# 1234' }).charges.find(c => c.label === 'Less: Advanced Payment')
    expect(legacy.midLines).toBeUndefined()
    expect(legacy.small).toBeUndefined()
  })

  it('missing S.I#: only the days text; nothing remaining: no note; add-ons are in the total', () => {
    expect(props(base, credit({ ref: '' })).charges.find(c => c.label === 'Less: Advance').mid).toBe('20 days (Oct 12 to Oct 31)')
    expect(props(base, credit({ amount: 2000, remaining: 0 })).paymentNote).toBeUndefined()
    const withAddon = props({ ...base, addonRentWater: 100, addons: [{ id: 1, label: 'Fan', amount: 100, recurring: true }] }, credit())
    expect(toCents(withAddon.total)).toBe(toCents(5000 + 193.8 + 100 - 3225.81))
  })

  it('a plain statement has no credit row and no note; a legacy credit prints Less: Advanced Payment', () => {
    const plain = props(base)
    expect(plain.charges.some(c => c.label.startsWith('Less:'))).toBe(false)
    expect(plain.paymentNote).toBeUndefined()
    const legacy = props(base, { amount: 5000, remaining: 0, ref: 'S.I# 1234' })
    expect(legacy.charges.find(c => c.label === 'Less: Advanced Payment')).toMatchObject({ mid: 'S.I# 1234', amount: -5000 })
    expect(legacy.paymentNote).toBe('Advance applied now: Php 5,000.00.')
  })

  it('creditSubText: on-screen days of the credit, empty for a legacy credit', () => {
    expect(creditSubText(credit())).toBe('20 days, Oct 12 to Oct 31')
    expect(creditSubText({ amount: 1 })).toBe('')
  })
})

describe('final bill with the stored window and credit', () => {
  const rent = (d) => d.lines.filter(l => l.source === 'RENT').map(l => [l.label, l.mid, l.amount])
  const verify = (f, d) => verifyBillAgainstDb({
    bill: { cutoff_id: d.cutoff_id, covered_cutoffs: d.covered_cutoffs, early_termination: d.earlyTermination, lines: d.lines, details: d.details, ...d.totals },
    moveOut: f.moveOutDate, tenant: f.tenant, deposits: f.deposits.get(140), cutoffs: f.cutoffs, storedCredits: f.storedCredits, payments: [], now: NOW,
  })

  it('out Nov 11: rent 1 Nov - 11 Nov 1,774.19, advance -1,774.19 (rest after the Oct credit), deposit -5,000', () => {
    const f = advanceWindowOut()
    const d = buildFinalBillDraft(f)
    expect(d.blocking).toEqual([])
    expect(rent(d)).toEqual([['Rent Period (completes the 1-month advance)', '1 Nov - 11 Nov', 1774.19]])
    expect(d.details.stay.rent_summary).toBe('advance window 12 Oct - 11 Nov')
    expect(d.lines.find(l => l.source === 'ADVANCE')).toMatchObject({ kind: 'credit', amount: -1774.19 })
    expect(d.lines.find(l => l.source === 'DEPOSIT')).toMatchObject({ kind: 'credit', amount: -5000 })
    expect(d.check).toMatchObject({ status: 'PARTLY_CREDITED_BEFORE', advance_total: 5000, credited_before: 3225.81, credited_here: 1774.19 })
    expect(toCents(d.totals.net_amount)).toBe(d.lines.reduce((s, l) => s + toCents(l.amount), 0))
    expect(d.details.stay.advance_window).toMatchObject({ cutoff_id: 2, window_start: '2026-10-12', carry_amount: 3225.81, month_rent: 5000, exact: true })
    expect(verify(f, d).ok).toBe(true)
  })

  it('a rate changed after the freeze: the Nov part still uses the frozen rent (5,000 - 3,225.81)', () => {
    expect(rent(buildFinalBillDraft(advanceWindowOut({ rate: 6000 }))).map(r => r[2])).toEqual([1774.19])
  })

  it('without the stored window the final bill bills the stay rent as before', () => {
    const d = buildFinalBillDraft({ ...advanceWindowOut(), storedCarry: [] })
    expect(d.details.stay.advance_window).toBeUndefined()
    expect(rent(d).some(r => r[0].includes('completes the 1-month advance'))).toBe(false)
  })

  it('contract date moved to Nov 5 after the freeze: the days after the cutoff are prorated plainly (5/30 = 833.33), warning, remaining advance credited', () => {
    const f = advanceWindowOut({ moveOutDate: '2026-11-05', plannedOut: '2026-11-05' })
    const d = buildFinalBillDraft(f)
    expect(rent(d)).toEqual([['Rent Period (5 of 30 days)', '01 November - 05 November', 833.33]])
    expect(d.warnings.some(w => w.includes('advance window was recorded'))).toBe(true)
    expect(d.details.stay.advance_window.exact).toBe(false)
    expect(d.lines.find(l => l.source === 'ADVANCE').amount).toBe(-1774.19)
    expect(verify(f, d).ok).toBe(true)
  })

  it('early termination (out Nov 5, contract Nov 11): same prorated rent; the existing forfeit rule applies (Oct credit clawed back)', () => {
    const f = advanceWindowOut({ moveOutDate: '2026-11-05' })
    const d = buildFinalBillDraft(f)
    expect(rent(d).map(r => r[2])).toEqual([833.33])
    expect(d.check.status).toBe('FORFEITED')
    expect(d.lines.find(l => l.source === 'ADVANCE_CLAWBACK').amount).toBe(3225.81)
    expect(verify(f, d).ok).toBe(true)
  })

  it('stay extension (out Nov 13 after noon): the window ends at the contract date, the nights are the EXTENSION line', () => {
    const d = buildFinalBillDraft(advanceWindowOut({ moveOutDate: '2026-11-13', afterNoon: true }))
    expect(rent(d).map(r => r[2])).toEqual([1774.19])
    expect(d.lines.some(l => l.source === 'EXTENSION')).toBe(true)
    expect(d.warnings.some(w => w.includes('advance window was recorded'))).toBe(false)
  })

  it('carryRentLines: exact -> one line rent - credit; contract date moved later -> days after the cutoff prorated, warning', () => {
    const exact = carryRentLines({ row: WINDOW_CARRY_ROW, rentEndISO: '2026-11-11' })
    expect(exact).toMatchObject({ exact: true, warning: null })
    expect(exact.lines.map(l => [l.mid, l.amount])).toEqual([['1 Nov - 11 Nov', 1774.19]])
    const later = carryRentLines({ row: WINDOW_CARRY_ROW, rentEndISO: '2026-11-20' })
    expect(later.exact).toBe(false)
    expect(later.lines.map(l => l.amount)).toEqual([3333.33])
    expect(later.warning).toMatch(/2026-11-11/)
  })
})

describe('reconciles across the second-to-last statement and the final bill (non-negotiable #1)', () => {
  it('Oct full rent less the credit + final bill: the advance is used once in full, each window day is billed once', () => {
    const { t, deposits, raw, perTenant, credits } = octStatement()
    const [oct] = buildPaymentMonitoring(OCT_ACTIVE, [t], perTenant, [], new Map([...credits].map(([id, c]) => [id, c.amount])))
    expect(toCents(oct.billed.total)).toBe(519380)
    expect(toCents(oct.adjustments)).toBe(322581)
    expect(toCents(oct.outstanding)).toBe(196799)

    const carry = carryToStore({ tenants: [t], cutoff: OCT_ACTIVE, perTenant: raw, deposits }).map((r, i) => ({ id: i + 1, ...r }))
    const { id: _id, ...expected } = WINDOW_CARRY_ROW
    expect(carry.map(({ id: _x, ...r }) => r)).toEqual([expected])
    const creditRows = creditsToStore({ tenants: [t], cutoff: OCT_ACTIVE, perTenant: raw, deposits, carry })
    expect(creditRows).toEqual([{ tenant_id: 140, cutoff_id: 2, amount: 3225.81, ref_text: 'S.I# 5401', allocations: [{ deposit_id: 941, amount: 3225.81 }] }])

    const f = { ...advanceWindowOut(), storedCarry: carry, storedCredits: creditRows.map((r, i) => ({ id: i + 1, ...r })) }
    const d = buildFinalBillDraft(f)
    const rentC = d.lines.filter(l => l.source === 'RENT').reduce((s, l) => s + toCents(l.amount), 0)
    const advC = -toCents(d.lines.find(l => l.source === 'ADVANCE').amount)
    const depC = -toCents(d.lines.find(l => l.source === 'DEPOSIT').amount)

    expect(toCents(oct.adjustments) + advC).toBe(toCents(deposits[0].amount))
    expect(toCents(perTenant[0].rent) + rentC).toBe(677419)
    const billedC = toCents(oct.billed.total) + toCents(d.totals.total_charges)
    expect(billedC).toBe(toCents(oct.adjustments) + advC + depC + toCents(oct.outstanding) + toCents(d.totals.net_amount))

    // Window [12 Oct, 11 Nov]: 20 days credited on Oct + 11 days on the final bill = 31 = W, each once; the two parts are one rent.
    const w0 = dayNum(WINDOW_CARRY_ROW.window_start), e = dayNum(OCT.water_end), m = dayNum('2026-11-11')
    expect([e - w0, m - e + 1]).toEqual([20, 11])
    expect(m - w0 + 1).toBe(31)
    expect(toCents(oct.adjustments) + rentC).toBe(500000)
  })
})
