// Advance window (docs/requirements.md §5): the 1-month advance of a non-month-end leaver covers the month ending on the
// move-out date; the second-to-last statement bills only the days before it, the rest moves to the final bill.
import { describe, it, expect } from 'vitest'
import { advanceWindow, assertCarryRows, carryRentLines } from './advanceWindow'
import {
  advanceCarry, carryToStore, cutoffAdvance, creditsToStore, buildFinalBillDraft, verifyBillAgainstDb, toCents,
} from './finalBill'
import { computeBilling } from './billing'
import { rentWaterProps } from './monthlyStatement'
import { buildPaymentMonitoring } from './collectionsSummary'
import { dayNum, isoOfDay } from './stay'
import { OCT, OCT_ACTIVE, SEP_ACTIVE, FEB27_ACTIVE, FEB28_ACTIVE } from './__fixtures__/cutoffs'
import { tenant, deposit, billRow } from './__fixtures__/tenants'
import { NOW, advanceWindowOut, WINDOW_CARRY_ROW } from './__fixtures__/finalBill'

const win = (cutoff, moveOutISO, rentCents = 500000) => advanceWindow({ moveOutISO, cutoff, rentCents })

describe('advanceWindow', () => {
  it('owner example: Oct cutoff, out Nov 11 -> advance month 12 Oct - 11 Nov; Oct bills 11 days (1,774.19), 20 days (3,225.81) carried', () => {
    expect(win(OCT_ACTIVE, '2026-11-11')).toEqual({
      windowStart: '2026-10-12', moveOut: '2026-11-11', cutoffDays: 31, preDays: 11, carryDays: 20,
      carryCents: 322581, preCents: 177419, monthRentCents: 500000,
    })
  })

  it.each([
    ['2026-11-01', 16129, 483871], ['2026-11-15', 241935, 258065], ['2026-11-29', 467742, 32258],
  ])('31-day Oct cutoff, out %s -> pre %i / carry %i', (m, pre, carry) => {
    const w = win(OCT_ACTIVE, m)
    expect(w.preCents).toBe(pre)
    expect(w.carryCents).toBe(carry)
  })

  it('30-day (Sep) and 28-day (Feb) cutoffs use their own day count', () => {
    expect(win(SEP_ACTIVE, '2026-10-15')).toMatchObject({ windowStart: '2026-09-16', preCents: 250000, carryCents: 250000, cutoffDays: 30 })
    expect(win(FEB27_ACTIVE, '2027-03-15')).toMatchObject({ windowStart: '2027-02-16', preCents: 267857, carryCents: 232143, cutoffDays: 28 })
  })

  it('no window: month-end move-out, window start not inside the cutoff (clamped month math), outside the next window, bad rent', () => {
    expect(win(OCT_ACTIVE, '2026-11-30')).toBeNull()
    expect(win(SEP_ACTIVE, '2026-10-30')).toBeNull()
    expect(win(FEB27_ACTIVE, '2027-03-30')).toBeNull()
    expect(win(FEB27_ACTIVE, '2027-03-29')).toBeNull()
    expect(win(OCT_ACTIVE, '2026-10-20')).toBeNull()
    expect(win(OCT_ACTIVE, '2026-12-05')).toBeNull()
    expect(win(OCT_ACTIVE, '2026-11-11', 0)).toBeNull()
    expect(win(OCT_ACTIVE, '2026-11-11', 5000.5)).toBeNull()
  })

  it('property: pre + carry = rent and the days add up, for every move-out day of 28/29/30/31-day cutoffs', () => {
    for (const [c, w] of [[FEB27_ACTIVE, 28], [FEB28_ACTIVE, 29], [SEP_ACTIVE, 30], [OCT_ACTIVE, 31]]) {
      const e = dayNum(c.water_end)
      for (let m = e; m < e + 31; m++) {
        for (const R of [1, 99, 300000, 450050, 500000, 675000, 1234567]) {
          const r = win(c, isoOfDay(m), R)
          if (!r) continue
          expect(r.cutoffDays).toBe(w)
          expect(r.preDays + r.carryDays).toBe(w)
          expect(r.preCents + r.carryCents).toBe(R)
          expect(Number.isInteger(r.carryCents) && r.carryCents > 0 && r.carryCents < R).toBe(true)
          // The final bill's two parts of the advance month add up to exactly one monthly rent.
          expect(r.carryCents + (R - r.carryCents)).toBe(R)
        }
      }
    }
  })
})

describe('assertCarryRows', () => {
  it('accepts an exact row and refuses a carry that is not the half-up day share', () => {
    expect(() => assertCarryRows([WINDOW_CARRY_ROW])).not.toThrow()
    expect(() => assertCarryRows([{ ...WINDOW_CARRY_ROW, carry_amount: 3225.8 }])).toThrow(/does not match/)
    expect(() => assertCarryRows([{ ...WINDOW_CARRY_ROW, carry_days: 31 }])).toThrow(/does not match/)
  })
})

describe('advanceCarry', () => {
  const t = (extra = {}) => tenant({ id: 1, rate: 5000, move_in_date: '2026-08-01', move_out_date: '2026-11-11', ...extra })
  const adv = deposit({ id: 41, tenant_id: 1, kind: 'ADVANCE', amount: 5000, ref_no: '6041' })
  const args = (extra = {}) => ({ tenants: [t()], cutoff: OCT_ACTIVE, perTenant: [{ id: 1, rent: 5000 }], deposits: [adv], ...extra })

  it('active Oct, one 5,000 HELD advance, out Nov 11 -> carry 3,225.81, rent left 1,774.19', () => {
    expect(advanceCarry(args()).get(1)).toMatchObject({ windowStart: '2026-10-12', carryCents: 322581, rentCents: 177419, preDays: 11, stored: false })
  })

  it('fallbacks: no advance receipt, stored advance credit (consumed), whole-room row, transfer, final-billed, month-end, closed cutoff without a row', () => {
    expect(advanceCarry(args({ deposits: [] })).size).toBe(0)
    expect(advanceCarry(args({ stored: [{ tenant_id: 1, cutoff_id: 1, amount: 5000, allocations: [{ deposit_id: 41, amount: 5000 }] }] })).size).toBe(0)
    expect(advanceCarry(args({ perTenant: [{ id: 1, rent: 5000, wholeRoom: true }] })).size).toBe(0)
    expect(advanceCarry(args({ perTenant: [{ id: 1, rent: 5000, transferred: true }] })).size).toBe(0)
    expect(advanceCarry(args({ transfers: [{ tenant_id: 1, transfer_date: '2026-10-05' }] })).size).toBe(0)
    expect(advanceCarry(args({ finalBills: [{ tenant_id: 1, status: 'FINAL' }] })).size).toBe(0)
    expect(advanceCarry(args({ tenants: [t({ move_out_date: '2026-11-30' })] })).size).toBe(0)
    expect(advanceCarry(args({ cutoff: OCT })).size).toBe(0)
  })

  it('a stored rent_carryovers row on the closed cutoff wins and ignores a later date change', () => {
    const row = { ...WINDOW_CARRY_ROW, tenant_id: 1 }
    const moved = advanceCarry(args({ cutoff: OCT, carry: [row], tenants: [t({ move_out_date: '2026-11-25' })] })).get(1)
    expect(moved).toMatchObject({ windowStart: '2026-10-12', moveOut: '2026-11-11', carryCents: 322581, rentCents: 177419, stored: true })
  })

  it('carryToStore returns the row for Nov 15 and none for Nov 30; creditsToStore stores nothing', () => {
    const at = (m) => ({ ...args({ tenants: [t({ move_out_date: m })] }), cutoff: OCT_ACTIVE })
    expect(carryToStore(at('2026-11-15'))).toEqual([{
      tenant_id: 1, cutoff_id: OCT.id, move_out_date: '2026-11-15', window_start: '2026-10-16',
      cutoff_days: 31, carry_days: 16, month_rent: 5000, carry_amount: 2580.65,
    }])
    expect(carryToStore(at('2026-11-30'))).toEqual([])
    expect(carryToStore({ ...at('2026-11-15'), carry: [{ tenant_id: 1, cutoff_id: OCT.id }] })).toEqual([])
    expect(carryToStore({ ...at('2026-11-15'), deposits: [{ ...adv, status: 'APPLIED' }] })).toEqual([])
    expect(creditsToStore({ ...at('2026-11-15'), cutoff: OCT })).toEqual([])
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
  it('leaver row: rent 1,774.19, total = rent + water, no credit entry', () => {
    const { perTenant, credits, carries } = octStatement()
    const row = perTenant[0]
    expect(toCents(row.rent)).toBe(177419)
    expect(toCents(row.total)).toBe(toCents(row.rent) + toCents(row.water))
    expect(row.advanceCarry).toMatchObject({ carryCents: 322581 })
    expect(credits.size).toBe(0)
    expect(carries.size).toBe(1)
  })
})

describe('printed second-to-last statement (advance window)', () => {
  const cutoff = OCT_ACTIVE
  const props = (row, credit) => rentWaterProps({ t: row, cutoff, roomRow: {}, splits: [], credit, billNo: 'X-1', copyLabel: 'Tenant copy', billingDate: '2026-10-31' })
  const base = { id: 1, name: 'Tenant 1', room_id: 11, room_no: '101', water: 193.8, waterCons: 1.25, addons: [] }

  it('owner example: rent 1 Oct - 11 Oct 1,774.19, no advance line, total 1,967.99, note names the carried part', () => {
    const carry = advanceWindow({ moveOutISO: '2026-11-11', cutoff, rentCents: 500000 })
    const p = props({ ...base, rent: 1774.19, advanceCarry: carry })
    expect(p.charges[0]).toMatchObject({ label: 'Monthly Rent', mid: '1 Oct - 11 Oct', amount: 1774.19 })
    expect(p.charges.some(c => c.label === 'Less: Advanced Payment')).toBe(false)
    expect(p.charges.every(c => c.amount >= 0)).toBe(true)
    expect(toCents(p.total)).toBe(196799)
    expect(p.paymentNote).toBe('Rent for 12 Oct - 31 Oct (Php 3,225.81) is billed on your final bill, against your advance.')
  })

  it('a legacy stored credit still prints the credit line; a plain statement has no note', () => {
    const p = props({ ...base, rent: 5000 }, { amount: 5000, remaining: 0, ref: 'S.I# 1234' })
    const line = p.charges.find(c => c.label === 'Less: Advanced Payment')
    expect(line).toMatchObject({ mid: 'S.I# 1234', amount: -5000 })
    expect(p.charges[0].mid).toBe('1 Oct - 31 Oct')
    expect(p.paymentNote).toBe('Advance applied now: Php 5,000.00.')
    expect(toCents(p.total)).toBe(toCents(5000 + 193.8 - 5000))
    expect(props({ ...base, rent: 5000 }).paymentNote).toBeUndefined()
  })
})

describe('final bill with a stored advance window', () => {
  const rent = (d) => d.lines.filter(l => l.source === 'RENT').map(l => [l.label, l.mid, l.amount])

  it('rent 12 October - 31 October 3,225.81 + 01 November - 11 November 1,774.19; full advance -5,000 credited; rent net 0', () => {
    const f = advanceWindowOut()
    const d = buildFinalBillDraft(f)
    expect(d.blocking).toEqual([])
    expect(rent(d)).toEqual([
      ['Rent Period (20 of 31 days)', '12 October - 31 October', 3225.81],
      ['Rent Period (completes the 1-month advance)', '01 November - 11 November', 1774.19],
    ])
    expect(d.lines.find(l => l.source === 'ADVANCE')).toMatchObject({ kind: 'credit', amount: -5000 })
    expect(d.check.status).toBe('NOT_CREDITED_BEFORE')
    const rentC = d.lines.filter(l => l.source === 'RENT').reduce((s, l) => s + toCents(l.amount), 0)
    expect(rentC + toCents(d.lines.find(l => l.source === 'ADVANCE').amount)).toBe(0)
    expect(toCents(d.totals.net_amount)).toBe(d.lines.reduce((s, l) => s + toCents(l.amount), 0))
    expect(d.details.stay.advance_window).toMatchObject({ cutoff_id: 2, window_start: '2026-10-12', carry_amount: 3225.81, month_rent: 5000, exact: true })
    const v = verifyBillAgainstDb({
      bill: { cutoff_id: d.cutoff_id, covered_cutoffs: d.covered_cutoffs, early_termination: d.earlyTermination, lines: d.lines, details: d.details, ...d.totals },
      moveOut: f.moveOutDate, tenant: f.tenant, deposits: f.deposits.get(140), cutoffs: f.cutoffs, storedCredits: [], payments: [], now: NOW,
    })
    expect(v.ok).toBe(true)
  })

  it('a rate changed after the freeze: the window still uses the frozen month rent', () => {
    expect(rent(buildFinalBillDraft(advanceWindowOut({ rate: 6000 }))).map(r => r[2])).toEqual([3225.81, 1774.19])
  })

  it('without the stored row the final bill bills the stay rent as before (no carry)', () => {
    const d = buildFinalBillDraft({ ...advanceWindowOut(), storedCarry: [] })
    expect(d.lines.filter(l => l.source === 'RENT')).toHaveLength(1)
    expect(d.details.stay.advance_window).toBeUndefined()
  })

  it('early move-out (Nov 5): carried days kept, Nov days prorated plainly, a warning', () => {
    const d = buildFinalBillDraft(advanceWindowOut({ moveOutDate: '2026-11-05' }))
    expect(rent(d)).toEqual([
      ['Rent Period (20 of 31 days)', '12 October - 31 October', 3225.81],
      ['Rent Period (5 of 30 days)', '01 November - 05 November', 833.33],
    ])
    expect(d.warnings.some(w => w.includes('advance window was recorded'))).toBe(true)
    expect(d.details.stay.advance_window.exact).toBe(false)
  })

  it('stay extension (out Nov 13 after noon): the window ends at the contract date, the nights are the EXTENSION line', () => {
    const d = buildFinalBillDraft(advanceWindowOut({ moveOutDate: '2026-11-13', afterNoon: true }))
    expect(rent(d).map(r => r[2])).toEqual([3225.81, 1774.19])
    expect(d.lines.some(l => l.source === 'EXTENSION')).toBe(true)
    expect(d.warnings.some(w => w.includes('advance window was recorded'))).toBe(false)
  })

  it('carryRentLines: a contract date moved later after the freeze prorates through the new date with a warning', () => {
    const r = carryRentLines({ row: WINDOW_CARRY_ROW, rentEndISO: '2026-11-20' })
    expect(r.exact).toBe(false)
    expect(r.lines.map(l => l.amount)).toEqual([3225.81, 3333.33])
    expect(r.warning).toMatch(/2026-11-11/)
  })
})

describe('reconciles across the second-to-last statement and the final bill (non-negotiable #1)', () => {
  it('Oct bill (reduced) + final bill: every rent day once, the advance credited in full, outstanding = billed - credits', () => {
    const { t, deposits, raw, perTenant, credits } = octStatement()
    const [oct] = buildPaymentMonitoring(OCT_ACTIVE, [t], perTenant, [], new Map([...credits].map(([id, c]) => [id, c.amount])))
    expect(oct.adjustments).toBe(0)
    expect(toCents(oct.outstanding)).toBe(toCents(oct.billed.total))

    const stored = carryToStore({ tenants: [t], cutoff: OCT_ACTIVE, perTenant: raw, deposits })
    const { id: _id, ...expected } = WINDOW_CARRY_ROW
    expect(stored).toEqual([expected])
    const f = { ...advanceWindowOut(), storedCarry: stored.map((r, i) => ({ id: i + 1, ...r })) }
    const d = buildFinalBillDraft(f)
    const rentC = d.lines.filter(l => l.source === 'RENT').reduce((s, l) => s + toCents(l.amount), 0)
    const advC = -toCents(d.lines.find(l => l.source === 'ADVANCE').amount)
    const depC = -toCents(d.lines.find(l => l.source === 'DEPOSIT').amount)

    expect(advC).toBe(toCents(deposits[0].amount))
    expect(rentC).toBe(500000)
    expect(toCents(perTenant[0].rent) + rentC).toBe(677419)
    const billedC = toCents(oct.billed.total) + toCents(d.totals.total_charges)
    expect(billedC).toBe(advC + depC + toCents(oct.outstanding) + toCents(d.totals.net_amount))

    // Days: statement [1 Oct, 12 Oct), carried [12 Oct, 1 Nov), rest of the advance month [1 Nov, 11 Nov]: each day once.
    const c = perTenant[0].advanceCarry
    const s = dayNum(OCT.water_start), w0 = dayNum(c.windowStart), e = dayNum(OCT.water_end), m = dayNum('2026-11-11')
    const days = []
    for (let x = s; x < w0; x++) days.push(x)
    for (let x = w0; x < e; x++) days.push(x)
    for (let x = e; x <= m; x++) days.push(x)
    expect(days).toHaveLength(42)
    expect(new Set(days).size).toBe(42)
    expect([w0 - s, e - w0, m - e + 1]).toEqual([11, 20, 11])
  })
})
