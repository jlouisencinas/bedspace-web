// Pro-rated second-to-last-bill advance credit (docs/requirements.md §5): credit = min(advance x D / W, rent), the rest to the final bill.
import { describe, it, expect } from 'vitest'
import {
  proratedAdvanceCents, advanceCredits, advanceAdjustments, creditsToStore, assertCreditRows, priorCredits, buildCreditLines,
  buildFinalBillDraft, verifyBillAgainstDb, toCents,
} from './finalBill'
import { rentWaterProps, proratedNote } from './monthlyStatement'
import { buildPaymentMonitoring } from './collectionsSummary'
import { OCT, OCT_ACTIVE, SEP_ACTIVE, FEB27_ACTIVE, FEB28_ACTIVE, CUTOFFS } from './__fixtures__/cutoffs'
import { tenant, deposit } from './__fixtures__/tenants'
import { NOW, proratedAdvanceOut } from './__fixtures__/finalBill'

const nextDay = (c, d) => {
  const [y, m] = c.water_end.split('-')
  return `${y}-${m}-${String(d).padStart(2, '0')}`
}
const pro = (cutoff, advanceCents, d, rentCents = null) =>
  proratedAdvanceCents({ advanceCents, rentCents, waterStart: cutoff.water_start, waterEnd: cutoff.water_end, moveOut: nextDay(cutoff, d) })

describe('proratedAdvanceCents', () => {
  it('owner example: 5,000 advance, Oct window (31 days), out Nov 23 -> 3,709.68 credited, 1,290.32 left', () => {
    expect(pro(OCT, 500000, 23)).toEqual({ creditCents: 370968, days: 23, windowDays: 31 })
    expect(500000 - pro(OCT, 500000, 23).creditCents).toBe(129032)
  })

  it.each([
    [15, 241935, 258065], [1, 16129, 483871], [29, 467742, 32258],
  ])('31-day window, out on day %i -> %i / %i', (d, credit, rest) => {
    const r = pro(OCT, 500000, d)
    expect(r.creditCents).toBe(credit)
    expect(500000 - r.creditCents).toBe(rest)
  })

  it('30-day (Sep) and 28-day (Feb) second-to-last windows use their own day count', () => {
    expect(pro(SEP_ACTIVE, 500000, 20)).toEqual({ creditCents: 333333, days: 20, windowDays: 30 })
    expect(pro(FEB27_ACTIVE, 500000, 10)).toEqual({ creditCents: 178571, days: 10, windowDays: 28 })
    expect(500000 - pro(FEB27_ACTIVE, 500000, 10).creditCents).toBe(321429)
  })

  it('caps the credit at the period\'s rent', () => {
    expect(pro(OCT, 600000, 29, 500000).creditCents).toBe(500000)
    expect(pro(OCT, 600000, 23, 500000).creditCents).toBe(445161)
  })

  it('property: credit + remainder = advance, 0 <= credit <= advance, for every day of 28/29/30/31-day windows', () => {
    const windows = [[FEB27_ACTIVE, 28], [FEB28_ACTIVE, 29], [SEP_ACTIVE, 30], [OCT_ACTIVE, 31]]
    for (const [c, w] of windows) {
      for (const a of [1, 99, 300000, 450050, 500000, 600001, 675000, 1234567]) {
        for (let d = 1; d < w; d++) {
          const r = pro(c, a, d)
          expect(r.windowDays).toBe(w)
          expect(r.days).toBe(d)
          expect(r.creditCents).toBeGreaterThanOrEqual(0)
          expect(r.creditCents).toBeLessThanOrEqual(a)
          expect(Number.isInteger(r.creditCents)).toBe(true)
          expect(r.creditCents + (a - r.creditCents)).toBe(a)
        }
      }
    }
  })
})

describe('advanceCredits with the pro-rated credit (active Oct)', () => {
  const t = (move_out_date = '2026-11-23') => tenant({ id: 1, rate: 5000, move_in_date: '2026-08-01', move_out_date })
  const adv = (id, amount, extra = {}) => deposit({ id, tenant_id: 1, kind: 'ADVANCE', amount, ref_no: String(6000 + id), ...extra })
  const args = (deposits, move_out_date, extra = {}) => ({ tenants: [t(move_out_date)], cutoff: OCT_ACTIVE, perTenant: [{ id: 1, rent: 5000 }], deposits, ...extra })

  it('owner example: out Nov 23, one 5,000 receipt -> 3,709.68 credited, 1,290.32 remaining, 23 of 31 days', () => {
    const c = advanceCredits(args([adv(41, 5000)])).get(1)
    expect(c).toMatchObject({ amount: 3709.68, remaining: 1290.32, onFile: 5000, days: 23, windowDays: 31, ref: 'S.I# 6041' })
    expect(c.allocations).toEqual([{ deposit_id: 41, amount: 3709.68 }])
    expect(toCents(c.amount) + toCents(c.remaining)).toBe(500000)
  })

  it('advance larger than the rent: pro-rate the whole advance, then cap at the rent', () => {
    expect(advanceCredits(args([adv(41, 6000)])).get(1)).toMatchObject({ amount: 4451.61, remaining: 1548.39 })
    expect(advanceCredits(args([adv(41, 6000)], '2026-11-29')).get(1)).toMatchObject({ amount: 5000, remaining: 1000 })
  })

  it('advance smaller than the rent: 3,000 x 23/31 = 2,225.81, 774.19 remaining', () => {
    expect(advanceCredits(args([adv(41, 3000)])).get(1)).toMatchObject({ amount: 2225.81, remaining: 774.19 })
  })

  it('two receipts are allocated in id order and the allocations sum to the credit', () => {
    const c = advanceCredits(args([adv(52, 4000), adv(51, 2000)])).get(1)
    expect(c.amount).toBe(4451.61)
    expect(c.allocations).toEqual([{ deposit_id: 51, amount: 2000 }, { deposit_id: 52, amount: 2451.61 }])
    expect(c.allocations.reduce((s, a) => s + toCents(a.amount), 0)).toBe(toCents(c.amount))
  })

  it('month-end move-out has no second-to-last credit; out Nov 15 credits 2,419.35', () => {
    expect(advanceCredits(args([adv(41, 5000)], '2026-11-30')).size).toBe(0)
    expect(advanceCredits(args([adv(41, 5000)], '2026-11-15')).get(1).amount).toBe(2419.35)
  })

  it('follows the actual move-out date', () => {
    const late = { ...t('2026-11-15'), actual_move_out_date: '2026-11-23' }
    expect(advanceCredits({ ...args([adv(41, 5000)]), tenants: [late] }).get(1).amount).toBe(3709.68)
  })

  it('a stored row (full 5,000, before pro-rating) still wins and is not re-prorated or labelled with days', () => {
    const stored = [{ tenant_id: 1, cutoff_id: OCT.id, amount: 5000, ref_text: 'S.I# 6041', allocations: [{ deposit_id: 41, amount: 5000 }] }]
    const c = advanceCredits({ ...args([adv(41, 5000)]), stored }).get(1)
    expect(c).toMatchObject({ amount: 5000, remaining: 0 })
    expect(c.days).toBeUndefined()
  })

  it('a stored pro-rated row keeps its day count while the date still reproduces it', () => {
    const stored = [{ tenant_id: 1, cutoff_id: OCT.id, amount: 3709.68, ref_text: 'S.I# 6041', allocations: [{ deposit_id: 41, amount: 3709.68 }] }]
    expect(advanceCredits({ ...args([adv(41, 5000)]), cutoff: OCT, stored }).get(1)).toMatchObject({ amount: 3709.68, remaining: 1290.32, days: 23, windowDays: 31 })
    expect(advanceCredits({ ...args([adv(41, 5000)], '2026-11-15'), cutoff: OCT, stored }).get(1).days).toBeUndefined()
  })

  it('creditsToStore stores the pro-rated amount with allocations that add up (G1)', () => {
    const rows = creditsToStore({ ...args([adv(41, 5000)]), cutoff: OCT })
    expect(rows).toEqual([{ tenant_id: 1, cutoff_id: OCT.id, amount: 3709.68, ref_text: 'S.I# 6041', allocations: [{ deposit_id: 41, amount: 3709.68 }] }])
    expect(() => assertCreditRows(rows)).not.toThrow()
  })

  it('Collections adjustments use the pro-rated credit', () => {
    expect(advanceAdjustments(args([adv(41, 5000)])).get(1)).toBe(3709.68)
  })
})

describe('final bill credits exactly the carried remainder', () => {
  it('buildCreditLines: stored 3,709.68 on Oct + a 5,000 HELD advance -> -1,290.32, PARTLY_CREDITED_BEFORE', () => {
    const f = proratedAdvanceOut()
    const deposits = f.deposits.get(130)
    const prior = priorCredits({ tenant: f.tenant, moveOut: f.moveOutDate, deposits, storedCredits: f.storedCredits, cutoffs: CUTOFFS })
    const { lines, check } = buildCreditLines(deposits, { prior, now: NOW })
    expect(lines.map(l => [l.label, l.amount, l.kind])).toEqual([['Less: Advanced Payment', -1290.32, 'credit']])
    expect(lines[0].mid).toBe('S.I# 5301 · already credited ₱3,709.68 on Oct 2026 · remaining ₱1,290.32 (credited here)')
    expect(check).toMatchObject({ status: 'PARTLY_CREDITED_BEFORE', advance_total: 5000, credited_before: 3709.68, credited_here: 1290.32 })
  })

  it('golden final bill: rent Nov 1-23 3,833.33, advance -1,290.32, net 2,543.01; verifies against the DB data', () => {
    const f = proratedAdvanceOut()
    const d = buildFinalBillDraft(f)
    expect(d.blocking).toEqual([])
    expect(d.lines.find(l => l.source === 'RENT').amount).toBe(3833.33)
    expect(d.lines.find(l => l.source === 'ADVANCE').amount).toBe(-1290.32)
    expect(d.totals).toEqual({ total_charges: 3833.33, total_credits: 1290.32, net_amount: 2543.01 })
    const v = verifyBillAgainstDb({
      bill: { cutoff_id: d.cutoff_id, covered_cutoffs: d.covered_cutoffs, early_termination: d.earlyTermination, lines: d.lines, details: d.details, ...d.totals },
      moveOut: f.moveOutDate, tenant: f.tenant, deposits: f.deposits.get(130), cutoffs: f.cutoffs, storedCredits: f.storedCredits, payments: [], waived: false, now: NOW,
    })
    expect(v.ok).toBe(true)
  })
})

describe('printed second-to-last statement', () => {
  const row = { id: 1, name: 'Tenant 1', room_id: 11, room_no: '101', rent: 5000, water: 193.8, waterCons: 1.25, addons: [] }
  const props = (credit) => rentWaterProps({ t: row, cutoff: OCT, roomRow: {}, splits: [], credit, billNo: 'X-1', copyLabel: 'Tenant copy', billingDate: '2026-10-31' })

  it('shows the credited amount, the day count and the remainder; total = rent + water - credit', () => {
    const p = props({ amount: 3709.68, remaining: 1290.32, ref: 'S.I# 1234', days: 23, windowDays: 31 })
    const line = p.charges.find(c => c.label === 'Less: Advanced Payment')
    expect(line.mid).toBe('S.I# 1234 · credited ₱3,709.68 on this bill (pro-rated 23 of 31 days) · remaining ₱1,290.32 for the final bill')
    expect(line.amount).toBe(-3709.68)
    expect(toCents(p.total)).toBe(toCents(5000 + 193.8 - 3709.68))
  })

  it('a day count that does not reproduce the amount prints "(pro-rated)" only; no day count prints no note', () => {
    expect(proratedNote({ amount: 5000, remaining: 1000, days: 29, windowDays: 31 })).toBe(' (pro-rated)')
    expect(proratedNote({ amount: 5000, remaining: 0 })).toBe('')
    const old = props({ amount: 5000, remaining: 0, ref: 'S.I# 1234' }).charges.find(c => c.label === 'Less: Advanced Payment')
    expect(old.mid).toBe('S.I# 1234 · credited ₱5,000.00 on this bill · remaining ₱0.00 for the final bill')
  })
})

describe('balance reconciles across the second-to-last and final bills (non-negotiable #1)', () => {
  it('Oct rent 5,000 + final rent 3,833.33 = advance 5,000 (3,709.68 + 1,290.32) + Oct due 1,290.32 + final due 2,543.01', () => {
    const t = tenant({ id: 130, rate: 5000, move_in_date: '2026-09-01', move_out_date: '2026-11-23' })
    const deposits = [deposit({ id: 931, tenant_id: 130, kind: 'ADVANCE', amount: 5000, ref_no: '5301' })]
    const perTenant = [{ id: 130, rent: 5000, water: 0, elec: 0 }]
    const adj = advanceAdjustments({ tenants: [t], cutoff: OCT_ACTIVE, perTenant, deposits })
    const [oct] = buildPaymentMonitoring(OCT_ACTIVE, [t], perTenant, [], adj)
    expect(oct.adjustments).toBe(3709.68)
    expect(oct.outstanding).toBe(1290.32)

    const stored = creditsToStore({ tenants: [t], cutoff: OCT, perTenant, deposits })
    const f = { ...proratedAdvanceOut(), storedCredits: stored.map((s, i) => ({ id: i + 1, ...s })) }
    const d = buildFinalBillDraft(f)
    const rentC = toCents(d.lines.find(l => l.source === 'RENT').amount)
    const advC = -toCents(d.lines.find(l => l.source === 'ADVANCE').amount)

    expect(toCents(oct.adjustments) + advC).toBe(toCents(deposits[0].amount))
    const billedC = toCents(oct.billed.total) + rentC
    expect(billedC).toBe(883333)
    expect(billedC).toBe(toCents(oct.adjustments) + advC + toCents(oct.outstanding) + toCents(d.totals.net_amount))
    expect(toCents(d.totals.net_amount)).toBe(254301)
  })
})
