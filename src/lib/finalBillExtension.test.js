// Month-end second-to-last rule, the stay extension on the final bill, and the void & re-issue helpers (finalBill.js).
import { describe, it, expect } from 'vitest'
import {
  billPosition, advanceCredits, creditsToStore, advanceCarry, carryToStore, buildFinalBillDraft, mergeRecomputedLines, computedSourceOf, combineBillsForPrint, computeTotals, toCents,
  verifyBillAgainstDb, reissueDiff, reissueLines, asHeldForReissue, reissueReadings, reissuePlannedDate, mergeCoveredEntries, reissueBlocker,
} from './finalBill'
import { stayRent } from './stay'
import { NOON_CHOICE_MISSING } from './stayExtension'
import { SEP, OCT, NOV, CUTOFFS, OCT_ACTIVE } from './__fixtures__/cutoffs'
import { tenant, deposit } from './__fixtures__/tenants'
import { NOW, lateOneMonth, typedExtensionBill } from './__fixtures__/finalBill'

describe('billPosition: a month-end move-out has no second-to-last bill', () => {
  const t = (move_out_date) => tenant({ id: 1, move_in_date: '2026-08-01', move_out_date })
  it('out Nov 30: Oct is STANDARD, Nov is FINAL', () => {
    expect(billPosition(t('2026-11-30'), OCT)).toBe('STANDARD')
    expect(billPosition(t('2026-11-30'), NOV)).toBe('FINAL')
  })
  it('out Nov 15 / Nov 29: Oct is still SECOND_TO_LAST', () => {
    expect(billPosition(t('2026-11-15'), OCT)).toBe('SECOND_TO_LAST')
    expect(billPosition(t('2026-11-29'), OCT)).toBe('SECOND_TO_LAST')
  })
  it('the actual date wins over the planned one', () => {
    expect(billPosition({ ...t('2026-11-15'), actual_move_out_date: '2026-11-30' }, OCT)).toBe('STANDARD')
  })
})

describe('advance window with the month-end rule (active Oct)', () => {
  const adv = deposit({ id: 31, tenant_id: 1, kind: 'ADVANCE', amount: 5000, ref_no: '5031' })
  const args = (move_out_date, extra = {}) => ({
    tenants: [tenant({ id: 1, rate: 5000, move_in_date: '2026-08-01', move_out_date })], cutoff: OCT_ACTIVE,
    perTenant: [{ id: 1, rent: 5000 }], deposits: [adv], ...extra,
  })
  it('out Nov 30 -> no credit, no window; out Nov 15 -> credit 2,580.65 (16 of 31 days, Oct 16 to Oct 31), 2,419.35 left for the final bill', () => {
    expect(advanceCredits(args('2026-11-30')).size).toBe(0)
    expect(advanceCarry(args('2026-11-30')).size).toBe(0)
    expect(advanceCredits(args('2026-11-15')).get(1)).toMatchObject({ amount: 2580.65, remaining: 2419.35, window: { windowStart: '2026-10-16', carryDays: 16 } })
    expect(advanceCarry(args('2026-11-15')).get(1)).toMatchObject({ windowStart: '2026-10-16', carryDays: 16, carryCents: 258065 })
  })
  it('a stored row of a closed cutoff is still returned for that cutoff', () => {
    const stored = [{ tenant_id: 1, cutoff_id: SEP.id, amount: 4000, ref_text: 'S.I# 5031', allocations: [{ deposit_id: 31, amount: 4000 }] }]
    const m = advanceCredits({ ...args('2026-11-30'), cutoff: SEP, stored })
    expect(m.get(1)).toMatchObject({ amount: 4000, remaining: 1000 })
  })
  it('Open Cutoff stores nothing for a month-end leaver; out Nov 15 stores a window, then the credit from it', () => {
    expect(carryToStore(args('2026-11-30'))).toEqual([])
    expect(creditsToStore({ ...args('2026-11-30'), cutoff: OCT, carry: carryToStore(args('2026-11-30')) })).toEqual([])
    const carry = carryToStore(args('2026-11-15'))
    expect(carry).toHaveLength(1)
    expect(creditsToStore({ ...args('2026-11-15'), cutoff: OCT, carry })).toMatchObject([{ amount: 2580.65 }])
  })
  it('the month-end leaver\'s final bill credits the full advance (no earlier credit)', () => {
    const t = tenant({ id: 1, rate: 5000, move_in_date: '2026-08-01', move_out_date: '2026-11-30' })
    const d = buildFinalBillDraft({ tenant: t, tenants: [t], cutoffs: CUTOFFS, moveOutDate: '2026-11-30', now: NOW, deposits: new Map([[1, [adv]]]) })
    expect(d.lines.find(l => l.source === 'ADVANCE')).toMatchObject({ kind: 'credit', amount: -5000 })
    expect(d.check.status).toBe('NOT_CREDITED_BEFORE')
  })
})

describe('final bill: stay extension', () => {
  it('one-month stay, out 3 days late after noon: flat rent to the contract date + 4 nights; utilities unaffected by the rule', () => {
    const late = buildFinalBillDraft(lateOneMonth({ afterNoon: true }))
    const byNoon = buildFinalBillDraft(lateOneMonth({ afterNoon: false }))
    expect(late.blocking).toEqual([])
    expect(late.errors).toEqual([])
    expect(late.lines.filter(l => l.source === 'RENT').map(l => [l.label, l.mid, l.amount])).toEqual([['Rent (1 month, flat)', '02 October - 02 November', 10000]])
    expect(late.lines[1]).toMatchObject({ source: 'EXTENSION', amount: 2000, mid: '4 nights', rate: 500 })
    expect(byNoon.lines[1]).toMatchObject({ source: 'EXTENSION', amount: 1500, mid: '3 nights' })
    const util = (d) => d.lines.filter(l => l.source === 'WATER' || l.source === 'ELECTRIC').map(l => toCents(l.amount))
    expect(util(late)).toEqual(util(byNoon))
    expect(util(late).reduce((a, b) => a + b, 0)).toBeGreaterThan(0)
    expect(late.details.extension).toEqual({ contract_date: '2026-11-02', actual_date: '2026-11-05', after_noon: true, nights: 4, rate: 500, amount: 2000 })
    expect(late.stay).toEqual({ kind: 'STAY_BILLED', months: 1, rentRule: 'FLAT_ONE_MONTH' })
    expect(late.details.water.curr).toBe(104)
    expect(late.earlyTermination).toBe(false)
  })

  it('whole months: rent = stayRent(move-in, contract) less closed statements, + 2 nights by noon', () => {
    const t = tenant({ id: 130, rate: 6000, move_in_date: '2026-09-01', move_out_date: '2026-10-31' })
    const cutoffs = [SEP, OCT_ACTIVE]
    const d = buildFinalBillDraft({ tenant: t, tenants: [t], cutoffs, moveOutDate: '2026-11-02', now: NOW, vacatedAfterNoon: false })
    expect(d.stay.kind).toBe('WHOLE_MONTHS')
    const closedC = 600000
    expect(toCents(d.lines.find(l => l.source === 'RENT').amount)).toBe(stayRent(600000, '2026-09-01', '2026-10-31').totalCents - closedC)
    expect(d.lines.find(l => l.source === 'EXTENSION')).toMatchObject({ amount: 1000, mid: '2 nights' })
  })

  it('without the 12:00 PM choice the draft is blocked and has no extension line', () => {
    const d = buildFinalBillDraft(lateOneMonth({ afterNoon: null }))
    expect(d.blocking).toContain(NOON_CHOICE_MISSING)
    expect(d.lines.some(l => l.source === 'EXTENSION')).toBe(false)
  })

  it('on the contract date: no extension, nothing blocks', () => {
    const f = lateOneMonth({ afterNoon: null })
    const d = buildFinalBillDraft({ ...f, moveOutDate: '2026-11-02' })
    expect(d.lines.some(l => l.source === 'EXTENSION')).toBe(false)
    expect(d.blocking).toEqual([])
  })

  it('totals stay the exact sum of the lines and the bill verifies against its data', () => {
    const f = lateOneMonth()
    const d = buildFinalBillDraft(f)
    expect(toCents(d.totals.net_amount)).toBe(d.lines.reduce((s, l) => s + toCents(l.amount), 0))
    const v = verifyBillAgainstDb({
      bill: { cutoff_id: d.cutoff_id, covered_cutoffs: d.covered_cutoffs, early_termination: d.earlyTermination, lines: d.lines, details: d.details, ...d.totals },
      moveOut: f.moveOutDate, tenant: f.tenant, deposits: f.deposits.get(120), cutoffs: f.cutoffs, payments: [], now: NOW,
    })
    expect(v.errors).toEqual([])
    expect(v.ok).toBe(true)
  })

  it('mergeRecomputedLines: an unedited EXTENSION follows the database; an edited one is kept with a warning', () => {
    const fresh = { lines: [{ label: 'Rent', amount: 100, computed: 100, kind: 'charge', source: 'RENT' }, { label: 'Ext', amount: 2000, computed: 2000, kind: 'charge', source: 'EXTENSION' }], details: { extension: { nights: 4 } } }
    const req = (amount) => [{ label: 'Rent', amount: 100, computed: 100, kind: 'charge', source: 'RENT' }, { label: 'Ext', amount, computed: 1500, kind: 'charge', source: 'EXTENSION' }]
    const r = mergeRecomputedLines({ lines: req(1500), details: { extension: { nights: 3 } }, fresh })
    expect(r.lines.map(l => l.amount)).toEqual([100, 2000])
    expect(r.diffs).toEqual(['Stay extension: requested ₱1,500.00, will apply ₱2,000.00 (recomputed from the database now).'])
    expect(r.details.extension).toEqual({ nights: 4 })
    const e = mergeRecomputedLines({ lines: req(1800), fresh })
    expect(e.lines.map(l => l.amount)).toEqual([100, 1800])
    expect(e.warnings).toEqual(['Stay extension was edited by staff and is kept at ₱1,800.00; the database now computes ₱2,000.00.'])
  })

  it('mergeRecomputedLines: a request with a hand-typed "Stay Extension" rent line (#26 pattern) is never charged twice', () => {
    const req = typedExtensionBill().lines
    const fresh = { lines: buildFinalBillDraft(lateOneMonth()).lines, details: { extension: { nights: 4 }, water: 'w', electric: 'e', stay: 's' } }
    const r = mergeRecomputedLines({ lines: req, fresh })
    const charged = (src) => r.lines.filter(l => l.kind === 'charge' && (computedSourceOf(l) === src)).reduce((s, l) => s + toCents(l.amount), 0)
    expect(charged('EXTENSION')).toBe(200000)
    expect(charged('RENT')).toBe(1000000)
    expect(r.lines.filter(l => /extension/i.test(l.label)).map(l => l.source)).toEqual(['EXTENSION'])
    expect(toCents(computeTotals(r.lines).total_charges) - charged('WATER') - charged('ELECTRIC')).toBe(1200000)
    expect(r.replacedTyped).toEqual([{ label: 'Stay Extension', amount: 2000 }])
    expect(r.diffs[0]).toBe('"Stay Extension" (₱2,000.00, typed by staff) is replaced by the computed stay extension.')
  })

  it('mergeRecomputedLines: a typed "Unsettled" extension is replaced as well; without a computed extension it stays', () => {
    const base = typedExtensionBill().lines.filter(l => !/extension/i.test(l.label))
    const req = [...base.slice(0, 3), { label: 'Add: Unsettled extension 4 nights', mid: '', amount: 2000, kind: 'unsettled' }, ...base.slice(3)]
    const fresh = { lines: buildFinalBillDraft(lateOneMonth()).lines, details: {} }
    const r = mergeRecomputedLines({ lines: req, fresh })
    expect(r.lines.filter(l => /extension/i.test(l.label)).map(l => [l.source, l.amount])).toEqual([['EXTENSION', 2000]])
    expect(r.replacedTyped.map(x => x.amount)).toEqual([2000])
    const none = mergeRecomputedLines({ lines: req, fresh: { lines: fresh.lines.filter(l => l.source !== 'EXTENSION'), details: {} } })
    expect(none.replacedTyped).toEqual([])
    expect(none.lines.some(l => l.kind === 'unsettled')).toBe(true)
  })

  it('mergeRecomputedLines: an old request without the line gets it right after the rent', () => {
    const fresh = { lines: [{ label: 'Rent', amount: 100, computed: 100, kind: 'charge', source: 'RENT' }, { label: 'Ext', amount: 500, computed: 500, kind: 'charge', source: 'EXTENSION' }], details: {} }
    const lines = [{ label: 'Rent', amount: 100, computed: 100, kind: 'charge', source: 'RENT' }, { label: 'Add: Water (cu. m)', amount: 5, kind: 'charge', source: 'WATER' }]
    expect(mergeRecomputedLines({ lines, fresh }).lines.map(l => l.label)).toEqual(['Rent', 'Ext'])
  })

  it('combineBillsForPrint: two beds of 500 -> one EXTENSION 1,000.00; the net is the sum of the nets', () => {
    const b = (id) => ({ id, lines: [
      { label: 'Rent', mid: 'x', amount: 1000, kind: 'charge', source: 'RENT' },
      { label: 'Stay extension (1 night x ₱500.00, 03 Nov, vacated by 12:00 PM)', mid: '1 night', rate: 500, amount: 500, kind: 'charge', source: 'EXTENSION' },
    ] })
    const c = combineBillsForPrint([{ bed: 'A', bill: b(1) }, { bed: 'B', bill: b(2) }])
    expect(c.lines.filter(l => l.source === 'EXTENSION')).toEqual([{ label: 'Stay extension (1 night x ₱500.00, 03 Nov, vacated by 12:00 PM)', mid: '2 nights', rate: 500, amount: 1000, kind: 'charge', source: 'EXTENSION' }])
    expect(c.net_amount).toBe(3000)
    expect(c.perBed.map(x => x.extension)).toEqual([500, 500])
    expect(c.bedNote).toContain('stay extension ₱500.00')
  })
})

describe('void & re-issue helpers', () => {
  it('reissueDiff: typed "Stay Extension" on a rent line vs the computed EXTENSION -> no net change, reported as replaced', () => {
    const old = typedExtensionBill()
    const lines = [
      { label: 'Rent (1 month, flat)', amount: 10000, kind: 'charge', source: 'RENT' },
      { label: 'Stay extension (4 nights x ₱500.00, 03 Nov - 05 Nov, vacated after 12:00 PM)', amount: 2000, kind: 'charge', source: 'EXTENSION' },
      ...old.lines.slice(2),
    ]
    const d = reissueDiff(old, { lines }, { recomputed: [{ amount: 600, kind: 'charge', source: 'WATER' }] })
    expect(d.net).toEqual({ old: -4585.85, new: -4585.85, change: 0 })
    expect(d.rows.map(r => [r.key, r.old, r.new, r.change])).toEqual([
      ['RENT', 10000, 10000, 0], ['EXTENSION', 2000, 2000, 0], ['WATER', 620.15, 620.15, 0], ['ELECTRIC', 2794, 2794, 0],
      ['ADVANCE', -10000, -10000, 0], ['DEPOSIT', -10000, -10000, 0],
    ])
    expect(d.rows.find(r => r.key === 'WATER').recomputed).toBe(600)
    expect(d.rows.find(r => r.key === 'ELECTRIC').recomputed).toBe(0)
    expect(d.replaced).toEqual([{ label: 'Stay Extension ', amount: 2000 }])
  })

  it('reissueLines: rent, extension AND utilities recomputed by default; typed extension dropped, typed lines carried, fresh credits', () => {
    const old = typedExtensionBill()
    old.lines.splice(4, 0, { label: 'Add: Unsettled key replacement', mid: '', amount: 150, kind: 'unsettled' })
    const fresh = buildFinalBillDraft(lateOneMonth()).lines
    const fu = fresh.filter(l => l.source === 'WATER' || l.source === 'ELECTRIC')
    const sumC = (ls) => ls.reduce((a, l) => a + toCents(l.amount), 0)
    expect(sumC(fu)).not.toBe(toCents(620.15 + 2794))
    const r = reissueLines({ oldLines: old.lines, freshLines: fresh })
    expect(r.lines.map(l => [l.source ?? l.kind, l.amount])).toEqual([
      ['RENT', 10000], ['EXTENSION', 2000], ...fu.map(l => [l.source, l.amount]), ['unsettled', 150], ['ADVANCE', -10000], ['DEPOSIT', -10000],
    ])
    expect(r.kept).toEqual({ WATER: false, ELECTRIC: false })
    expect(r.dropped.map(l => l.label)).toEqual(['Stay Extension '])
    expect(toCents(computeTotals(r.lines).net_amount)).toBe(toCents(10000 + 2000 + 150 - 20000) + sumC(fu))
    const k = reissueLines({ oldLines: old.lines, freshLines: fresh, keepUtilities: true })
    expect(k.lines.filter(l => l.source === 'WATER' || l.source === 'ELECTRIC').map(l => l.amount)).toEqual([620.15, 2794])
    expect(k.kept).toEqual({ WATER: true, ELECTRIC: true })
    expect(computeTotals(k.lines).net_amount).toBe(-4435.85)
  })

  it('reissueLines: a typed "Unsettled" extension is dropped too, but only when the computed extension exists', () => {
    const old = typedExtensionBill()
    old.lines.splice(1, 1, { label: 'Add: Unsettled stay extension 4 nights', mid: '', amount: 2000, kind: 'unsettled' })
    const fresh = buildFinalBillDraft(lateOneMonth()).lines
    const r = reissueLines({ oldLines: old.lines, freshLines: fresh })
    expect(r.dropped.map(l => l.kind)).toEqual(['unsettled'])
    expect(r.lines.filter(l => /extension/i.test(l.label)).map(l => [l.source, l.amount])).toEqual([['EXTENSION', 2000]])
    const noExt = reissueLines({ oldLines: old.lines, freshLines: fresh.filter(l => l.source !== 'EXTENSION') })
    expect(noExt.dropped).toEqual([])
    expect(noExt.lines.some(l => l.kind === 'unsettled' && /extension/i.test(l.label))).toBe(true)
  })

  it('asHeldForReissue: only the receipts that bill settled are HELD again', () => {
    const deps = [
      deposit({ id: 1, tenant_id: 9, kind: 'ADVANCE', amount: 100, status: 'APPLIED', settled_note: 'Final bill #26: applied on final bill' }),
      deposit({ id: 2, tenant_id: 9, kind: 'DEPOSIT', amount: 100, status: 'FORFEITED', settled_note: 'Final bill #26: forfeited (early termination)' }),
      deposit({ id: 3, tenant_id: 9, kind: 'DEPOSIT', amount: 100, status: 'APPLIED', settled_note: 'Final bill #2: applied on final bill' }),
      deposit({ id: 4, tenant_id: 9, kind: 'ADVANCE', amount: 100, status: 'REFUNDED', settled_note: 'Final bill #26: applied on final bill' }),
    ]
    expect(asHeldForReissue(deps, 26).map(d => d.status)).toEqual(['HELD', 'HELD', 'APPLIED', 'REFUNDED'])
  })

  it('reissueReadings: the saved move-out reading of that tenant and date, else the bill\'s own', () => {
    const bill = typedExtensionBill()
    const interims = [
      { id: 5, moving_out_tenant_id: 120, utility: 'WATER', reading_date: '2026-11-05', reading_value: 105 },
      { id: 6, moving_out_tenant_id: 121, utility: 'ELECTRIC', reading_date: '2026-11-05', reading_value: 999 },
    ]
    expect(reissueReadings({ bill, interims })).toEqual({ water: 105, electric: 1100, sources: { water: 'INTERIM', electric: 'BILL' } })
  })

  it('reissuePlannedDate: the extension record, else the request, else the tenant row', () => {
    const bill = typedExtensionBill()
    expect(reissuePlannedDate({ bill: { ...bill, details: { extension: { contract_date: '2026-11-01' } } }, request: { old_value: { move_out_date: '2026-11-02' } } })).toBe('2026-11-01')
    expect(reissuePlannedDate({ bill, request: { old_value: { move_out_date: '2026-11-02' } }, tenant: { move_out_date: '2026-11-05' } })).toBe('2026-11-02')
    expect(reissuePlannedDate({ bill, tenant: { move_out_date: '2026-11-02' } })).toBe('2026-11-02')
  })

  it('mergeCoveredEntries keeps a cutoff a later reading re-attach added, per component', () => {
    expect(mergeCoveredEntries([2, { id: 3, water: true, electric: false }], [{ id: 3, water: false, electric: true }])).toEqual([2, 3])
    expect(mergeCoveredEntries([], [{ id: 3, water: true, electric: false }])).toEqual([{ id: 3, water: true, electric: false }])
  })

  it('reissueBlocker: admin, FINAL, refund not paid, tenant out, single bed', () => {
    const bill = typedExtensionBill(), out = { is_active: false }
    expect(reissueBlocker({ bill, tenant: out, isAdmin: true })).toBeNull()
    expect(reissueBlocker({ bill, tenant: out, isAdmin: false })).toMatch(/Only an admin/)
    expect(reissueBlocker({ bill: { ...bill, status: 'VOID' }, tenant: out, isAdmin: true })).toMatch(/Only a FINAL bill/)
    expect(reissueBlocker({ bill: { ...bill, refund_status: 'PAID' }, tenant: out, isAdmin: true })).toMatch(/already paid/)
    expect(reissueBlocker({ bill, tenant: { is_active: true }, isAdmin: true })).toMatch(/active again/)
    expect(reissueBlocker({ bill: { ...bill, details: { stay: { group: { tenant_ids: [1, 2] } } } }, tenant: out, isAdmin: true })).toBe('Bills of several beds: re-issue is per bed and not supported yet.')
  })
})
