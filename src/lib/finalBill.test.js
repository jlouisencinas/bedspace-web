import { describe, it, expect } from 'vitest'
import {
  toCents, round2, computeTotals, normalizeLines, billPosition, refText, normalizeReceiptRef, refKey, receiptRefsNeeded,
  missingReceiptRefs, applyReceiptRefs, spliceRefSegment, advanceCredits, creditsToStore, assertCreditRows, priorCredits,
  advanceCheck, buildCreditLines, rebuildCreditLines, nettablePayments, paymentLines, siblingGroup, siblingMismatch,
  reconcileBill, verifyBillAgainstDb, combineBillsForPrint, groupBillsForPrint, vacatedRecord, figuresChangedMessage,
  pendingMoveOutFor, mergeRecomputedLines, buildFinalBillDraft, bedRequestState, wholeRoomGroup,
} from './finalBill'
import { SEP, OCT, NOV, CUTOFFS, OCT_ACTIVE } from './__fixtures__/cutoffs'
import { tenant, deposit, payment } from './__fixtures__/tenants'
import { NOW, goldenWholeMonths, earlyWithPriorCredit } from './__fixtures__/finalBill'

describe('toCents / round2', () => {
  it.each([
    [1234.56, 123456], ['1234.56', 123456], [0.1 + 0.2, 30], [-0.015, -2], [0.015, 2], [-0, 0], [0, 0],
    ['abc', 0], [Infinity, 0], [NaN, 0], [null, 0],
  ])('toCents(%j) = %i', (v, c) => {
    expect(toCents(v)).toBe(c)
    expect(Object.is(toCents(v), -0)).toBe(false)
  })

  it('round2', () => {
    expect(round2(0.1 + 0.2)).toBe(0.3)
    expect(round2(10.004)).toBe(10)
    expect(round2(-6750)).toBe(-6750)
  })

  // BUG (follow-up, low): toCents multiplies the float by 100 before rounding, so some x.xx5 halves round down
  // (1.005 * 100 = 100.49999999999999 -> 100; 0.285 * 100 = 28.499999999999996 -> 28). Others are fine (2.675 * 100 = 267.5 -> 268).
  // Only matters for a computed float, never for a 2-decimal stored amount.
  it('rounds the x.xx5 halves whose x100 product is exact (2.675 -> 268, 0.015 -> 2)', () => {
    expect(toCents(2.675)).toBe(268)
    expect(toCents(0.015)).toBe(2)
  })
  it.fails('rounds 1.005 up to 101 cents', () => {
    expect(toCents(1.005)).toBe(101)
  })
  it.fails('rounds 0.285 up to 29 cents', () => {
    expect(toCents(0.285)).toBe(29)
  })
})

describe('computeTotals / normalizeLines', () => {
  it('totals are the exact sum of the stored lines; a forfeit counts in neither column', () => {
    const lines = [
      { amount: 1000, kind: 'charge' }, { amount: 200.5, kind: 'unsettled' }, { amount: -500, kind: 'credit' },
      { amount: 0, kind: 'forfeit', original: 6000 }, { amount: -300, kind: 'payment' },
    ]
    expect(computeTotals(lines)).toEqual({ total_charges: 1200.5, total_credits: 800, net_amount: 400.5 })
  })

  it('sums 0.10 three times to 0.30 exactly', () => {
    expect(computeTotals([0.1, 0.1, 0.1].map(amount => ({ amount, kind: 'charge' })))).toEqual({ total_charges: 0.3, total_credits: 0, net_amount: 0.3 })
  })

  it('normalizeLines rounds every amount to 2 decimals', () => {
    expect(normalizeLines([{ amount: 10.004 }, { amount: 0.1 + 0.2 }]).map(l => l.amount)).toEqual([10, 0.3])
  })
})

describe('billPosition', () => {
  const t = tenant({ id: 1, move_in_date: '2026-08-01', move_out_date: '2026-11-15' })
  it('FINAL / SECOND_TO_LAST / STANDARD', () => {
    expect(billPosition(t, NOV)).toBe('FINAL')
    expect(billPosition(t, OCT)).toBe('SECOND_TO_LAST')
    expect(billPosition(t, SEP)).toBe('STANDARD')
  })
  it('a stay of one or two periods has no second-to-last bill', () => {
    expect(billPosition({ ...t, move_in_date: '2026-10-05' }, OCT)).toBe('STANDARD')
  })
  it('follows the actual move-out date', () => {
    expect(billPosition({ ...t, actual_move_out_date: '2026-10-20' }, OCT)).toBe('FINAL')
    expect(billPosition({ ...t, move_out_date: null }, OCT)).toBe('STANDARD')
  })
})

describe('receipt numbers', () => {
  it('refText prefixes and joins', () => {
    expect(refText('ADVANCE', [{ ref_no: '1234' }, { ref_no: 'S.I# 99' }, { ref_no: '1234' }])).toBe('S.I# 1234 & S.I# 99')
    expect(refText('DEPOSIT', [{ ref_no: '121' }, { ref_no: 'TR# 133' }, { ref_no: '' }])).toBe('TR# 121 & TR# 133')
  })

  it.each([
    ['ADVANCE', 'S.I# 1234', '1234'], ['ADVANCE', 'SI No. 1234', '1234'], ['ADVANCE', '  #1234 ', '1234'],
    ['DEPOSIT', 'TR# 121', '121'], ['DEPOSIT', 'T.R. 121 & TR# 133', '121 & TR# 133'],
  ])('normalizeReceiptRef(%s, %j) = %j', (kind, raw, value) => {
    expect(normalizeReceiptRef(kind, raw)).toEqual({ value, error: null })
  })

  it.each([
    ['ADVANCE', 'TR# 5', 'That looks like a T.R#; the advance is documented by an S.I#.'],
    ['DEPOSIT', 'S.I# 5', 'That looks like an S.I#; the deposit is documented by a T.R#.'],
    ['ADVANCE', '', 'Enter the S.I# number.'],
    ['DEPOSIT', 'abc', 'The T.R# number must contain at least one digit.'],
    ['DEPOSIT', '1'.repeat(31), 'The T.R# number is too long (max 30 characters).'],
    ['ADVANCE', '12·3', "The S.I# number cannot contain '·' or control characters."],
  ])('normalizeReceiptRef(%s, %j) refuses', (kind, raw, error) => {
    expect(normalizeReceiptRef(kind, raw)).toEqual({ value: null, error })
  })

  it('refKey ignores case and spaces', () => {
    expect(refKey(' TR 121 ')).toBe('tr121')
  })

  it('receiptRefsNeeded / missingReceiptRefs / applyReceiptRefs', () => {
    const deposits = [
      deposit({ id: 1, tenant_id: 5, kind: 'ADVANCE', amount: 6000, ref_no: '' }),
      deposit({ id: 2, tenant_id: 5, kind: 'DEPOSIT', amount: 3000, ref_no: '500', reservation_payment_id: 77 }),
    ]
    const lines = [
      { label: 'Less: Advanced Payment', mid: 'no earlier credit on record', amount: -6000, kind: 'credit', source: 'ADVANCE', deposit_ids: [1] },
      { label: 'Less: Deposit Payment', mid: 'TR# 500', amount: -3000, kind: 'credit', source: 'DEPOSIT', deposit_ids: [2] },
    ]
    expect(receiptRefsNeeded(lines, deposits).map(r => [r.deposit_id, r.required, r.locked])).toEqual([[1, true, false], [2, false, true]])
    expect(missingReceiptRefs(lines, deposits)).toEqual(['S.I# of the advance receipt #1 (₱6,000.00): Enter the S.I# number.'])
    expect(missingReceiptRefs(lines, deposits, { 1: '4321' })).toEqual([])
    const out = applyReceiptRefs(lines, deposits, { 1: '4321', 2: '999' })
    expect(out[0].mid).toBe('S.I# 4321 · no earlier credit on record')
    expect(out[1].mid).toBe('TR# 500')
    expect(out.map(l => l.amount)).toEqual([-6000, -3000])
  })

  it('spliceRefSegment replaces only the receipt segment', () => {
    expect(spliceRefSegment('S.I# 1 · remaining ₱0.00', 'S.I# 2')).toBe('S.I# 2 · remaining ₱0.00')
  })
})

describe('second-to-last-bill advance credit', () => {
  const t = tenant({ id: 1, rate: 6000, move_in_date: '2026-08-01', move_out_date: '2026-11-15' })
  const adv = (id, amount, extra = {}) => deposit({ id, tenant_id: 1, kind: 'ADVANCE', amount, ref_no: String(5000 + id), ...extra })

  it('credits min(advance x 15/31 days, that period\'s rent) on the active cutoff', () => {
    const m = advanceCredits({ tenants: [t], cutoff: OCT_ACTIVE, perTenant: [{ id: 1, rent: 6000 }], deposits: [adv(11, 6000)] })
    expect(m.get(1)).toEqual({ amount: 2903.23, ref: 'S.I# 5011', allocations: [{ deposit_id: 11, amount: 2903.23 }], onFile: 6000, remaining: 3096.77, days: 15, windowDays: 31 })
    const part = advanceCredits({ tenants: [t], cutoff: OCT_ACTIVE, perTenant: [{ id: 1, rent: 2000.004 }], deposits: [adv(11, 6000)] })
    expect(part.get(1)).toMatchObject({ amount: 2000, remaining: 4000 })
  })

  it('allocates across receipts in id order', () => {
    const late = { ...t, move_out_date: '2026-11-29' }
    const m = advanceCredits({ tenants: [late], cutoff: OCT_ACTIVE, perTenant: [{ id: 1, rent: 5000 }], deposits: [adv(12, 2000), adv(11, 4000)] })
    expect(m.get(1).allocations).toEqual([{ deposit_id: 11, amount: 4000 }, { deposit_id: 12, amount: 1000 }])
    expect(m.get(1).ref).toBe('S.I# 5012 & S.I# 5011')
  })

  it('a stored row wins; a closed cutoff without one has none; an advance consumed elsewhere is not credited again', () => {
    const stored = [{ tenant_id: 1, cutoff_id: OCT.id, amount: 5500, ref_text: 'S.I# 5011', allocations: [{ deposit_id: 11, amount: 5500 }] }]
    expect(advanceCredits({ tenants: [t], cutoff: OCT, perTenant: [{ id: 1, rent: 6000 }], deposits: [adv(11, 6000)], stored }).get(1))
      .toMatchObject({ amount: 5500, onFile: 6000, remaining: 500 })
    expect(advanceCredits({ tenants: [t], cutoff: OCT, perTenant: [{ id: 1, rent: 6000 }], deposits: [adv(11, 6000)] }).size).toBe(0)
    const elsewhere = [{ tenant_id: 1, cutoff_id: SEP.id, amount: 6000, allocations: [{ deposit_id: 11, amount: 6000 }] }]
    expect(advanceCredits({ tenants: [t], cutoff: OCT_ACTIVE, perTenant: [{ id: 1, rent: 6000 }], deposits: [adv(11, 6000)], stored: elsewhere }).size).toBe(0)
  })

  it('creditsToStore: HELD receipts only, skips final-billed tenants, allocations add up', () => {
    const rows = creditsToStore({ tenants: [t], cutoff: OCT, perTenant: [{ id: 1, rent: 6000 }], deposits: [adv(11, 4000), adv(12, 2000, { status: 'APPLIED' })] })
    expect(rows).toEqual([{ tenant_id: 1, cutoff_id: OCT.id, amount: 1935.48, ref_text: 'S.I# 5011', allocations: [{ deposit_id: 11, amount: 1935.48 }] }])
    expect(creditsToStore({ tenants: [t], cutoff: OCT, perTenant: [{ id: 1, rent: 6000 }], deposits: [adv(11, 4000)], finalBills: [{ tenant_id: 1, status: 'FINAL' }] })).toEqual([])
  })

  it('assertCreditRows throws when allocations do not add up to the credit', () => {
    expect(() => assertCreditRows([{ tenant_id: 1, amount: 100, allocations: [{ amount: 99.99 }] }])).toThrow(/do not add up to the credit/)
    expect(() => assertCreditRows([{ tenant_id: 1, amount: 0.3, allocations: [{ amount: 0.1 }, { amount: 0.2 }] }])).not.toThrow()
  })
})

describe('priorCredits / advanceCheck / buildCreditLines', () => {
  const t = tenant({ id: 1, rate: 6000 })
  const deposits = [
    deposit({ id: 11, tenant_id: 1, kind: 'ADVANCE', amount: 6000, ref_no: '5011' }),
    deposit({ id: 12, tenant_id: 1, kind: 'DEPOSIT', amount: 6000, ref_no: '7011' }),
  ]
  const credited = [{ id: 1, tenant_id: 1, cutoff_id: OCT.id, amount: 6000, allocations: [{ deposit_id: 11, amount: 6000 }] }]

  it('counts a stored credit whose window ended before the move-out; ignores an orphan', () => {
    const p = priorCredits({ tenant: t, moveOut: '2026-11-15', deposits, storedCredits: credited, cutoffs: CUTOFFS })
    expect(p.creditedById.get(11)).toBe(600000)
    expect(p.name).toBe('Oct 2026')
    const orphan = priorCredits({ tenant: t, moveOut: '2026-10-20', deposits, storedCredits: credited, cutoffs: CUTOFFS })
    expect(orphan.creditedById.size).toBe(0)
    expect(orphan.ignored).toEqual([{ cutoff_id: OCT.id, name: 'Oct 2026', cents: 600000 }])
  })

  it('fails closed on a stored credit that matches none of the tenant\'s receipts', () => {
    const p = priorCredits({ tenant: t, moveOut: '2026-11-15', deposits, storedCredits: [{ tenant_id: 1, cutoff_id: OCT.id, amount: 100, allocations: [{ deposit_id: 999, amount: 100 }] }], cutoffs: CUTOFFS })
    expect(p.problem.code).toBe('ADVANCE_CREDIT_UNMATCHED')
    const lines = buildCreditLines(deposits, { prior: p, now: NOW })
    expect(lines.lines).toEqual([])
    expect(lines.check.status).toBe('BLOCKED')
  })

  it('normal move-out credits the remaining advance and the full deposit', () => {
    const p = priorCredits({ tenant: t, moveOut: '2026-11-15', deposits, storedCredits: credited, cutoffs: CUTOFFS })
    const { lines, check } = buildCreditLines(deposits, { prior: p, now: NOW })
    expect(lines.map(l => [l.label, l.amount, l.kind])).toEqual([['Less: Advanced Payment', 0, 'credit'], ['Less: Deposit Payment', -6000, 'credit']])
    expect(lines[0].mid).toBe('S.I# 5011 · already credited ₱6,000.00 on Oct 2026 · remaining ₱0.00 (credited here)')
    expect(check).toMatchObject({ status: 'FULLY_CREDITED_BEFORE', advance_total: 6000, credited_before: 6000, credited_here: 0, forfeited: 0 })
  })

  it('early termination forfeits both and charges back the earlier advance credit; a waiver removes both', () => {
    const p = priorCredits({ tenant: t, moveOut: '2026-11-15', deposits, storedCredits: credited, cutoffs: CUTOFFS })
    const forfeit = buildCreditLines(deposits, { earlyTermination: true, prior: p, now: NOW })
    expect(forfeit.lines.map(l => [l.label, l.amount, l.kind, l.original])).toEqual([
      ['Advance forfeited', 0, 'forfeit', 6000],
      ['Advance credited on second-to-last bill (forfeited)', 6000, 'charge', undefined],
      ['Deposit forfeited', 0, 'forfeit', 6000],
    ])
    expect(forfeit.check.status).toBe('FORFEITED')
    const waived = buildCreditLines(deposits, { earlyTermination: true, waived: true, prior: p, now: NOW })
    expect(waived.lines.some(l => l.kind === 'forfeit' || l.source === 'ADVANCE_CLAWBACK')).toBe(false)
  })

  it('advanceCheck statuses without a prior credit', () => {
    expect(advanceCheck({ deposits: [], now: NOW }).status).toBe('NO_ADVANCE')
    const c = advanceCheck({ deposits, now: NOW })
    expect(c.status).toBe('NOT_CREDITED_BEFORE')
    expect(c.text).toBe('No earlier advance credit on record (checked 30 Nov 2026 10:00); full advance ₱6,000.00 credited on this bill.')
  })

  it('rebuildCreditLines replaces credit lines and keeps payments last', () => {
    const lines = [{ label: 'Rent', amount: 100, kind: 'charge' }, { label: 'pay', amount: -50, kind: 'payment' }, { label: 'old', amount: -1, kind: 'credit', source: 'ADVANCE' }]
    const r = rebuildCreditLines(lines, deposits, { now: NOW })
    expect(r.lines.map(l => l.label)).toEqual(['Rent', 'Less: Advanced Payment', 'Less: Deposit Payment', 'pay'])
  })
})

describe('payment netting', () => {
  const pays = [
    payment({ id: 1, tenant_id: 1, cutoff_id: 3, category: 'RENT_WATER', amount: 1000 }),
    payment({ id: 2, tenant_id: 1, cutoff_id: 3, category: 'ELECTRICITY', amount: 500 }),
    payment({ id: 3, tenant_id: 1, cutoff_id: 3, category: 'OTHER', amount: 50 }),
    payment({ id: 4, tenant_id: 1, cutoff_id: 3, category: 'RENT_WATER', amount: -200, pay_type: 'VOID' }),
    payment({ id: 5, tenant_id: 1, cutoff_id: 2, category: 'RENT_WATER', amount: 6000 }),
    payment({ id: 6, tenant_id: 1, cutoff_id: null, category: 'OTHER', amount: 99 }),
  ]
  it('nets only the components the bill bills, honouring voids', () => {
    expect(nettablePayments(pays, [{ id: 3, water: true, electric: false }]).map(p => p.id)).toEqual([1, 3, 4])
    expect(paymentLines(pays, [{ id: 3, water: true, electric: false }], CUTOFFS)).toEqual([{
      label: 'Less: payment received', mid: 'Nov 2026 · Rent + Water + Other', amount: -850, kind: 'payment', source: 'PAYMENT', payment_ids: [1, 3, 4],
    }])
    expect(paymentLines(pays, [3], CUTOFFS)[0].amount).toBe(-1350)
  })
  it('nothing to net -> no line', () => {
    expect(paymentLines(pays, [1], CUTOFFS)).toEqual([])
    expect(paymentLines([payment({ id: 9, tenant_id: 1, cutoff_id: 3, category: 'RENT_WATER', amount: -5 })], [3], CUTOFFS)).toEqual([])
  })
})

describe('sibling beds and whole-room groups', () => {
  const a = tenant({ id: 1, bed: 'B', name: 'Tenant Pair', move_out_date: '2026-11-30' })
  const b = tenant({ id: 2, bed: 'A', name: ' tenant pair', move_out_date: '2026-11-30' })
  const c = tenant({ id: 3, bed: 'C', name: 'Tenant Pair', move_out_date: '2026-12-31' })
  it('siblingGroup: same name, room and planned date, in bed order', () => {
    expect(siblingGroup(a, [a, b, c]).map(t => t.id)).toEqual([2, 1])
    expect(siblingMismatch(a, [a, b, c]).map(t => t.id)).toEqual([3])
    expect(siblingGroup({ ...a, move_out_date: null }, [a, b]).map(t => t.id)).toEqual([1])
  })
  it('wholeRoomGroup', () => {
    expect(wholeRoomGroup(a, [a, b, c]).map(t => t.id)).toEqual([1, 2, 3])
  })
})

describe('approval helpers', () => {
  it('vacatedRecord throws unless confirmed', () => {
    expect(() => vacatedRecord(null)).toThrow(/Nothing was changed/)
    expect(vacatedRecord({ confirmed: true }, 'admin@example.invalid', NOW)).toEqual({ confirmed: true, by: 'admin@example.invalid', at: NOW.toISOString() })
  })
  it('figuresChangedMessage compares cents', () => {
    expect(figuresChangedMessage({ label: 'Bed A', shown: 100.004, now: 100 })).toBeNull()
    expect(figuresChangedMessage({ label: 'Bed A', shown: -50, now: -50.01 })).toBe('The figures changed since you opened this review (Bed A: shown -₱50.00, now -₱50.01). Reopen the review and approve again. Nothing was changed.')
  })
  it('pendingMoveOutFor finds a pending request covering a tenant or a sibling', () => {
    const reqs = [
      { id: 1, status: 'PENDING', field_name: 'move_out', entity_id: 5, new_value: { _siblings: [{ _tenant_id: 6 }] } },
      { id: 2, status: 'APPROVED', field_name: 'move_out', entity_id: 7 },
      { id: 3, status: 'PENDING', field_name: 'rate', entity_id: 8 },
    ]
    expect(pendingMoveOutFor(reqs, [6]).map(r => r.id)).toEqual([1])
    expect(pendingMoveOutFor(reqs, [7, 8])).toEqual([])
  })
  it('bedRequestState', () => {
    expect(bedRequestState({ tenantActive: true })).toBe('ACTIVE')
    expect(bedRequestState({ tenantActive: false, applied: { ok: true, requestId: 9 }, requestId: '9' })).toBe('APPLIED_HERE')
    expect(bedRequestState({ tenantActive: false, applied: { ok: true, requestId: 8 }, requestId: 9 })).toBe('OUT_ELSEWHERE')
  })
  it('mergeRecomputedLines replaces unedited computed lines and keeps staff edits', () => {
    const lines = [
      { label: 'Rent', amount: 100, computed: 100, kind: 'charge', source: 'RENT' },
      { label: 'Add: Water (cu. m)', amount: 55, computed: 50, kind: 'charge', source: 'WATER' },
      { label: 'Add: Electricity (per kWh)', amount: 70, computed: 70, kind: 'charge', source: 'ELECTRIC' },
    ]
    const fresh = { lines: [
      { label: 'Rent', amount: 100, computed: 100, kind: 'charge', source: 'RENT' },
      { label: 'Add: Water (cu. m)', amount: 52, computed: 52, kind: 'charge', source: 'WATER' },
      { label: 'Add: Electricity (per kWh)', amount: 73.34, computed: 73.34, kind: 'charge', source: 'ELECTRIC' },
    ], details: { water: 'w', electric: 'e', stay: 's' } }
    const r = mergeRecomputedLines({ lines, fresh })
    expect(r.lines.map(l => l.amount)).toEqual([100, 55, 73.34])
    expect(r.diffs).toEqual(['Electricity: requested ₱70.00, will apply ₱73.34 (recomputed from the database now).'])
    expect(r.warnings).toEqual(['Water was edited by staff and is kept at ₱55.00; the database now computes ₱52.00.'])
    expect(r.details).toEqual({ electric: 'e', stay: 's' })
  })
})

describe('buildFinalBillDraft (golden cases)', () => {
  it('requirements §5: Oct 15 -> Nov 30 at 6,750 with the Oct statement closed', () => {
    const d = buildFinalBillDraft(goldenWholeMonths())
    expect(d.stay).toEqual({ kind: 'WHOLE_MONTHS', months: null, rentRule: 'N_X_RATE_MINUS_CLOSED' })
    expect(d.lines.map(l => [l.label, l.mid, l.amount, l.kind, l.source])).toEqual([
      ['Rent (1 month + 16 of 30 days = ₱10,350.00, less ₱3,701.61 billed on closed statements)', '15 October - 30 November', 6648.39, 'charge', 'RENT'],
      ['Add: Water (cu. m)', '10.00', 230, 'charge', 'WATER'],
      ['Add: Electricity (per kWh)', '10.00', 240, 'charge', 'ELECTRIC'],
      ['Less: Advanced Payment', 'S.I# 5001 · no earlier credit on record', -6750, 'credit', 'ADVANCE'],
      ['Less: Deposit Payment', 'TR# 7001', -6750, 'credit', 'DEPOSIT'],
    ])
    expect(d.totals).toEqual({ total_charges: 7118.39, total_credits: 13500, net_amount: -6381.61 })
    expect(d.details.stay.closed_rent).toBe(3701.61)
    expect(d.cutoff_id).toBe(NOV.id)
    expect(d.covered_cutoffs).toEqual([NOV.id])
    expect(d.earlyTermination).toBe(false)
    expect(d.blocking).toEqual([])
    expect(d.errors).toEqual([])
    expect(d.warnings).toEqual([])
  })

  it('early termination with an earlier advance credit: forfeit + charge-back + payments netted', () => {
    const d = buildFinalBillDraft(earlyWithPriorCredit())
    expect(d.earlyTermination).toBe(true)
    expect(d.lines.map(l => [l.label, l.amount, l.kind])).toEqual([
      ['Rent (2 months + 15 of 30 days = ₱15,000.00, less ₱12,000.00 billed on closed statements)', 3000, 'charge'],
      ['Add: Water (cu. m)', 0, 'charge'],
      ['Add: Electricity (per kWh)', 0, 'charge'],
      ['Advance forfeited', 0, 'forfeit'],
      ['Advance credited on second-to-last bill (forfeited)', 6000, 'charge'],
      ['Deposit forfeited', 0, 'forfeit'],
      ['Less: payment received', -1000, 'payment'],
    ])
    expect(d.totals).toEqual({ total_charges: 9000, total_credits: 1000, net_amount: 8000 })
    expect(d.warnings).toEqual([
      'No water reading entered; the water line is 0.', 'No electric reading entered; the electric line is 0.',
      'The water readings of Nov 2026 have no row for this room.', 'The electric readings of Nov 2026 have no row for this room.',
    ])
  })

  it('a waiver credits the deposit and the remaining (zero) advance instead', () => {
    const d = buildFinalBillDraft(earlyWithPriorCredit({ waived: true }))
    expect(d.totals.net_amount).toBe(3000 - 6000 - 1000)
    expect(d.check.status).toBe('FULLY_CREDITED_BEFORE')
  })
})

describe('reconcileBill / verifyBillAgainstDb', () => {
  const asBill = (d) => ({ cutoff_id: d.cutoff_id, covered_cutoffs: d.covered_cutoffs, early_termination: d.earlyTermination, lines: d.lines, details: d.details, ...d.totals })
  const ctx = (f) => ({ moveOut: f.moveOutDate, tenant: f.tenant, deposits: f.deposits.get(f.tenant.id), cutoffs: f.cutoffs, storedCredits: f.storedCredits || [], payments: f.payments?.get(f.tenant.id) || [], now: NOW })

  it('a fresh draft verifies against the same data', () => {
    for (const f of [goldenWholeMonths(), earlyWithPriorCredit()]) {
      const v = verifyBillAgainstDb({ bill: asBill(buildFinalBillDraft(f)), ...ctx(f) })
      expect(v.errors).toEqual([])
      expect(v.stale).toEqual([])
      expect(v.ok).toBe(true)
    }
  })

  it('a credit larger than its receipts is an error', () => {
    const f = goldenWholeMonths()
    const bill = asBill(buildFinalBillDraft(f))
    bill.lines = bill.lines.map(l => (l.source === 'DEPOSIT' ? { ...l, amount: -7000 } : l))
    const r = reconcileBill({ bill, ...ctx(f) })
    expect(r.errors).toContain('"Less: Deposit Payment" is ₱7,000.00 but those receipts total ₱6,750.00.')
  })

  it('totals that do not match the lines are an error', () => {
    const f = goldenWholeMonths()
    const bill = { ...asBill(buildFinalBillDraft(f)), net_amount: -6381.6 }
    expect(reconcileBill({ bill, ...ctx(f) }).errors).toContain('The request\'s net_amount (₱-6,381.60) does not match its lines (₱-6,381.61).')
  })

  it('a receipt that changed since the draft makes the bill stale and the corrected lines follow the database', () => {
    const f = goldenWholeMonths()
    const bill = asBill(buildFinalBillDraft(f))
    const deposits = f.deposits.get(100).map(d => (d.kind === 'DEPOSIT' ? { ...d, amount: 6000 } : d))
    const v = verifyBillAgainstDb({ bill, ...ctx(f), deposits })
    expect(v.ok).toBe(false)
    expect(v.stale).toEqual(['Deposit: requested credit ₱6,750.00, will apply credit ₱6,000.00.'])
    expect(v.lines.find(l => l.source === 'DEPOSIT').amount).toBe(-6000)
  })
})

describe('print combination', () => {
  const bill = (id, lines, extra = {}) => ({ id, status: 'FINAL', move_out_date: '2026-11-30', lines, ...extra })
  const linesA = [
    { label: 'Rent', mid: 'x', amount: 1000.1, kind: 'charge', source: 'RENT' },
    { label: 'Add: Water (cu. m)', mid: '1.50', rate: 23, amount: 34.5, kind: 'charge', source: 'WATER' },
    { label: 'Less: Deposit Payment', mid: 'TR# 1', amount: -500, kind: 'credit', source: 'DEPOSIT', deposit_ids: [1] },
  ]
  const linesB = [
    { label: 'Rent', mid: 'x', amount: 1000.2, kind: 'charge', source: 'RENT' },
    { label: 'Add: Water (cu. m)', mid: '0.50', rate: 23, amount: 11.5, kind: 'charge', source: 'WATER' },
    { label: 'Unsettled', mid: '', amount: 0.1, kind: 'unsettled' },
    { label: 'Less: Deposit Payment', mid: 'TR# 2', amount: -500, kind: 'credit', source: 'DEPOSIT', deposit_ids: [2] },
  ]

  it('combineBillsForPrint sums per line type in cents; the net is the exact sum of the beds', () => {
    const c = combineBillsForPrint([{ bed: 'A', bill: bill(12, linesA) }, { bed: 'B', bill: bill(13, linesB) }])
    expect(c.lines.map(l => [l.label, l.mid, l.amount])).toEqual([
      ['Rent', 'x', 2000.3],
      ['Add: Water (cu. m)', '2.00', 46],
      ['Unsettled (Bed B)', '', 0.1],
      ['Less: Deposit Payment', 'TR# 1 & TR# 2', -1000],
    ])
    expect(c.net_amount).toBe(1046.4)
    expect(c.net_amount).toBe(computeTotals(c.lines).net_amount)
    expect(c.billIds).toEqual([12, 13])
  })

  it('groupBillsForPrint groups same name, room and date; a void bill stays alone', () => {
    const g = groupBillsForPrint([
      { name: 'Tenant Pair', room: '101', bed: 'B', bill: bill(13, []) },
      { name: 'tenant pair ', room: '101', bed: 'A', bill: bill(12, []) },
      { name: 'Tenant Pair', room: '101', bed: 'C', bill: bill(14, [], { status: 'VOID' }) },
    ])
    expect(g.map(u => [u.combined, u.items.map(i => i.bill.id)])).toEqual([[true, [12, 13]], [false, [14]]])
  })
})
