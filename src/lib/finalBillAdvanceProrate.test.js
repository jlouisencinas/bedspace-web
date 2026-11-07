// Legacy stored second-to-last advance credits (advance_credits rows written before the advance-window rule, e.g. Sep 2026
// or a partial pro-rated row): still printed, netted and honoured by the final bill. No new credit is ever computed live.
import { describe, it, expect } from 'vitest'
import {
  advanceCredits, advanceAdjustments, creditsToStore, assertCreditRows, priorCredits, buildCreditLines,
  buildFinalBillDraft, verifyBillAgainstDb, toCents,
} from './finalBill'
import { rentWaterProps, advanceNote } from './monthlyStatement'
import { buildPaymentMonitoring } from './collectionsSummary'
import { OCT, OCT_ACTIVE, CUTOFFS } from './__fixtures__/cutoffs'
import { tenant, deposit } from './__fixtures__/tenants'
import { NOW, proratedAdvanceOut } from './__fixtures__/finalBill'

describe('advanceCredits: stored rows only', () => {
  const t = (move_out_date = '2026-11-23') => tenant({ id: 1, rate: 5000, move_in_date: '2026-08-01', move_out_date })
  const adv = (id, amount, extra = {}) => deposit({ id, tenant_id: 1, kind: 'ADVANCE', amount, ref_no: String(6000 + id), ...extra })
  const args = (deposits, move_out_date, extra = {}) => ({ tenants: [t(move_out_date)], cutoff: OCT_ACTIVE, perTenant: [{ id: 1, rent: 5000 }], deposits, ...extra })

  it('no live credit on the active cutoff any more (the advance window reduces the rent instead)', () => {
    expect(advanceCredits(args([adv(41, 5000)])).size).toBe(0)
    expect(advanceCredits(args([adv(41, 5000)], '2026-11-15')).size).toBe(0)
    expect(advanceAdjustments(args([adv(41, 5000)])).size).toBe(0)
  })

  it('a stored row (full 5,000) still wins and reports what is left for the final bill', () => {
    const stored = [{ tenant_id: 1, cutoff_id: OCT.id, amount: 5000, ref_text: 'S.I# 6041', allocations: [{ deposit_id: 41, amount: 5000 }] }]
    expect(advanceCredits({ ...args([adv(41, 5000)]), stored }).get(1)).toEqual({
      amount: 5000, ref: 'S.I# 6041', allocations: [{ deposit_id: 41, amount: 5000 }], onFile: 5000, remaining: 0,
    })
  })

  it('a stored partial row keeps its amount whatever the move-out date is now', () => {
    const stored = [{ tenant_id: 1, cutoff_id: OCT.id, amount: 3709.68, ref_text: 'S.I# 6041', allocations: [{ deposit_id: 41, amount: 3709.68 }] }]
    expect(advanceCredits({ ...args([adv(41, 5000)], '2026-11-15'), cutoff: OCT, stored }).get(1)).toMatchObject({ amount: 3709.68, remaining: 1290.32 })
    expect(advanceAdjustments({ ...args([adv(41, 5000)]), cutoff: OCT, stored }).get(1)).toBe(3709.68)
  })

  it('creditsToStore stores nothing; assertCreditRows (G1 mirror) still checks the allocations', () => {
    expect(creditsToStore({ ...args([adv(41, 5000)]), cutoff: OCT })).toEqual([])
    expect(() => assertCreditRows([{ tenant_id: 1, amount: 3709.68, allocations: [{ deposit_id: 41, amount: 3709.68 }] }])).not.toThrow()
  })
})

describe('final bill credits exactly what a legacy stored row left', () => {
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

describe('printed statement with a legacy stored credit', () => {
  const row = { id: 1, name: 'Tenant 1', room_id: 11, room_no: '101', rent: 5000, water: 193.8, waterCons: 1.25, addons: [] }
  const props = (credit) => rentWaterProps({ t: row, cutoff: OCT, roomRow: {}, splits: [], credit, billNo: 'X-1', copyLabel: 'Tenant copy', billingDate: '2026-10-31' })

  it('the row keeps only the receipt ref; the note says what is applied and what remains; total = rent + water - credit', () => {
    const p = props({ amount: 3709.68, remaining: 1290.32, ref: 'S.I# 1234' })
    const line = p.charges.find(c => c.label === 'Less: Advanced Payment')
    expect(line.mid).toBe('S.I# 1234')
    expect(line.amount).toBe(-3709.68)
    expect(p.paymentNote).toBe('Advance applied now: Php 3,709.68. Remaining advance Php 1,290.32 will be credited on the final bill.')
    expect(toCents(p.total)).toBe(toCents(5000 + 193.8 - 3709.68))
    expect(advanceNote({ amount: 5000, remaining: 0 })).toBe('Advance applied now: Php 5,000.00.')
    expect(advanceNote(null)).toBe('')
  })
})

describe('legacy credit reconciles across the second-to-last and final bills (non-negotiable #1)', () => {
  it('Oct rent 5,000 + final rent 3,833.33 = advance 5,000 (3,709.68 + 1,290.32) + Oct due 1,290.32 + final due 2,543.01', () => {
    const t = tenant({ id: 130, rate: 5000, move_in_date: '2026-09-01', move_out_date: '2026-11-23' })
    const deposits = [deposit({ id: 931, tenant_id: 130, kind: 'ADVANCE', amount: 5000, ref_no: '5301' })]
    const perTenant = [{ id: 130, rent: 5000, water: 0, elec: 0 }]
    const f = proratedAdvanceOut()
    const adj = advanceAdjustments({ tenants: [t], cutoff: OCT, perTenant, deposits, stored: f.storedCredits })
    const [oct] = buildPaymentMonitoring(OCT, [t], perTenant, [], adj)
    expect(oct.adjustments).toBe(3709.68)
    expect(oct.outstanding).toBe(1290.32)

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
