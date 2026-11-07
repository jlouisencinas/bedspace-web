// Regression tests for the non-negotiables (docs/requirements.md §14). Keep this file green.
// "No two active tenants on one bed" is guaranteed by the DB index uniq_active_tenant_per_bed and "never delete billing records"
// by RLS; unit tests cannot reach either, so QA and the tester keep those checks.
import { describe, it, expect } from 'vitest'
import { computeBilling } from './billing'
import { buildPaymentMonitoring } from './collectionsSummary'
import { allocateCents, splitUtility, centsOf, toHundredths } from './utilityPieces'
import { computeTotals, toCents, buildFinalBillDraft, verifyBillAgainstDb, cutoffAdvance, carryToStore, creditsToStore } from './finalBill'
import { parseMoney, centsToInput } from './receiptLines'
import { prorateCents, dayNum, finalBilledStamps } from './stay'
import { pickStatements, rentWaterRows, electricityRows } from './monthlyStatement'
import { moveInEligibleBeds, deriveBedStatuses, isActiveTenantPerBedViolation } from './bedEligibility'
import { OCT, OCT_ACTIVE, CUTOFFS } from './__fixtures__/cutoffs'
import { SCENARIOS, seeded } from './__fixtures__/scenarios'
import { goldenWholeMonths, earlyWithPriorCredit, lateOneMonth, proratedAdvanceOut, advanceWindowOut, NOW } from './__fixtures__/finalBill'
import { payment, tenant, billRow, interim, deposit } from './__fixtures__/tenants'

const C = (n) => Math.round(n * 100)
const run = (s) => computeBilling(OCT, s.billRows, s.interims || [], s.tenants, [], s.addons || [], [], s.transfers || [])
const UTIL = { WATER: { key: 'water', amt: 'water', old: 'oldWater', prev: 'water_prev', curr: 'water_curr', rate: 'water_rate' },
  ELECTRIC: { key: 'electric', amt: 'elec', old: 'oldElec', prev: 'elec_prev', curr: 'elec_curr', rate: 'elec_rate' } }

// The amounts each billed row carries for one room (a transferred tenant's row holds both rooms' parts).
function billedInRoom(perTenant, room, u) {
  const out = []
  for (const t of perTenant) {
    if (t.transferred) {
      if (t.room_id === room.room_id) out.push(t[u.amt] - t[u.old])
      if (t.fromRoomNo === room.room_no) out.push(t[u.old])
    } else if (t.room_id === room.room_id) out.push(t[u.amt])
  }
  return out
}

describe('1. a tenant\'s balance reconciles: billed = paid + adjustments + outstanding - credit (integer cents)', () => {
  it.each(SCENARIOS.map(s => [s.name, s]))('%s', (_, s) => {
    const { perTenant } = run(s)
    const pays = [], adj = new Map()
    perTenant.forEach((t, i) => {
      const due = t.rent + t.water + t.elec + (t.addonRentWater || 0) + (t.addonElectric || 0)
      const part = [due, due / 2, due + 100.01][i % 3]
      pays.push(payment({ id: 100 + i * 3, tenant_id: t.id, cutoff_id: OCT.id, category: 'RENT_WATER', amount: Math.round(part * 70) / 100 }))
      pays.push(payment({ id: 101 + i * 3, tenant_id: t.id, cutoff_id: OCT.id, category: 'ELECTRICITY', amount: Math.round(part * 30) / 100 }))
      pays.push(payment({ id: 102 + i * 3, tenant_id: t.id, cutoff_id: OCT.id, category: 'RENT_WATER', amount: -0.01, pay_type: 'VOID' }))
      if (i === 1) adj.set(t.id, 250.5)
    })
    const rows = buildPaymentMonitoring(OCT, s.tenants, perTenant, pays, adj)
    expect(rows.map(r => r.id)).toEqual(perTenant.map(t => t.id))
    for (const r of rows) {
      const t = perTenant.find(x => x.id === r.id)
      // Expected figures from the inputs, independent of buildPaymentMonitoring.
      const billedC = C(t.rent + t.water) + C(t.elec) + C((t.addonRentWater || 0) + (t.addonElectric || 0))
      const paidC = pays.filter(p => p.tenant_id === r.id).reduce((a, p) => a + C(p.amount), 0)
      const adjC = C(adj.get(r.id) || 0)
      const diffC = billedC - adjC - paidC
      expect(C(r.billed.total)).toBe(billedC)
      expect(C(r.paid.total)).toBe(paidC)
      expect(C(r.adjustments)).toBe(adjC)
      expect(C(r.outstanding)).toBe(Math.max(diffC, 0))
      expect(C(r.credit)).toBe(Math.max(-diffC, 0))
      expect(C(r.billed.total)).toBe(C(r.paid.total) + C(r.adjustments) + C(r.outstanding) - C(r.credit))
      for (const v of [r.billed.total, r.paid.total, r.adjustments, r.outstanding, r.credit]) {
        expect(Math.abs(v * 100 - Math.round(v * 100))).toBeLessThan(1e-6)
      }
    }
  })

  it('a final bill\'s totals are the exact sum of its stored lines, and it verifies against the data it was built from', () => {
    for (const f of [goldenWholeMonths(), earlyWithPriorCredit(), earlyWithPriorCredit({ waived: true }), lateOneMonth(), lateOneMonth({ afterNoon: false }), proratedAdvanceOut(), advanceWindowOut(), advanceWindowOut({ moveOutDate: '2026-11-05' }), advanceWindowOut({ moveOutDate: '2026-11-05', plannedOut: '2026-11-05' })]) {
      const d = buildFinalBillDraft(f)
      const sum = (pred) => d.lines.filter(pred).reduce((s, l) => s + toCents(l.amount), 0)
      expect(toCents(d.totals.net_amount)).toBe(sum(() => true))
      expect(toCents(d.totals.total_charges)).toBe(sum(l => l.kind !== 'credit' && l.kind !== 'payment' && l.kind !== 'forfeit'))
      expect(computeTotals(d.lines)).toEqual(d.totals)
      const v = verifyBillAgainstDb({
        bill: { cutoff_id: d.cutoff_id, covered_cutoffs: d.covered_cutoffs, early_termination: d.earlyTermination, lines: d.lines, details: d.details, ...d.totals },
        moveOut: f.moveOutDate, tenant: f.tenant, deposits: f.deposits.get(f.tenant.id), cutoffs: f.cutoffs,
        storedCredits: f.storedCredits || [], payments: f.payments?.get(f.tenant.id) || [], waived: f.waived?.get(f.tenant.id) ?? false, now: NOW,
      })
      expect(v.ok).toBe(true)
    }
  })

  it('advance window (owner example, out Nov 11): Oct full rent less the 20/31 credit, final bill Nov 1 - 11 = rent - credit; the advance is used once, to the cent', () => {
    const t = tenant({ id: 140, rate: 5000, move_in_date: '2026-09-01', move_out_date: '2026-11-11' })
    const advRec = deposit({ id: 941, tenant_id: 140, kind: 'ADVANCE', amount: 5000, ref_no: '5401' })
    const octRows = computeBilling(OCT_ACTIVE, [billRow({ room: 101, water_prev: 0, water_curr: 1.25, water_rate: 155.04 })], [], [t], [], [], [], []).perTenant
    const oct = cutoffAdvance({ cutoff: OCT_ACTIVE, perTenant: octRows, tenants: [t], advData: { deposits: [advRec], finalBills: [], stored: [], carry: [] } })
    const row = oct.perTenant[0]
    const credit = oct.credits.get(140)
    expect(C(row.rent)).toBe(500000)
    expect(C(credit.amount)).toBe(322581)
    expect(C(credit.amount) + C(credit.remaining)).toBe(500000)
    const paid = [payment({ id: 1, tenant_id: 140, cutoff_id: OCT.id, category: 'RENT_WATER', amount: 1000 })]
    const [pm] = buildPaymentMonitoring(OCT_ACTIVE, [t], oct.perTenant, paid, new Map([[140, credit.amount]]))
    expect(C(pm.billed.total)).toBe(519380)
    expect(C(pm.outstanding)).toBe(C(pm.billed.total) - C(pm.paid.total) - C(credit.amount))
    expect(C(pm.billed.total)).toBe(C(pm.paid.total) + C(pm.adjustments) + C(pm.outstanding) - C(pm.credit))

    const storedCarry = carryToStore({ tenants: [t], cutoff: OCT_ACTIVE, perTenant: octRows, deposits: [advRec] }).map((r, i) => ({ id: i + 1, ...r }))
    const storedCredits = creditsToStore({ tenants: [t], cutoff: OCT_ACTIVE, perTenant: octRows, deposits: [advRec], carry: storedCarry }).map((r, i) => ({ id: i + 1, ...r }))
    const d = buildFinalBillDraft({ ...advanceWindowOut(), storedCarry, storedCredits })
    const rentLines = d.lines.filter(l => l.source === 'RENT')
    expect(rentLines.map(l => [l.mid, C(l.amount)])).toEqual([['1 Nov - 11 Nov', 177419]])
    const advC = -C(d.lines.find(l => l.source === 'ADVANCE').amount)
    const depC = -C(d.lines.find(l => l.source === 'DEPOSIT').amount)
    expect(C(credit.amount) + advC).toBe(C(advRec.amount))
    expect(C(row.rent) + C(rentLines[0].amount)).toBe(677419)
    expect(C(credit.amount) + C(rentLines[0].amount)).toBe(500000)
    expect(C(d.totals.net_amount)).toBe(d.lines.reduce((s, l) => s + C(l.amount), 0))
    const billedC = C(pm.billed.total) + C(d.totals.total_charges)
    expect(billedC).toBe(C(pm.paid.total) + C(credit.amount) + advC + depC + C(pm.outstanding) + C(d.totals.net_amount))

    // Every day of the window [12 Oct, 11 Nov] is valued once at rent / 31: 20 days credited on Oct, 11 days billed on the final bill.
    const w0 = dayNum(storedCarry[0].window_start), e = dayNum(OCT.water_end), m = dayNum('2026-11-11')
    const days = [...Array(e - w0).keys()].map(i => w0 + i).concat([...Array(m - e + 1).keys()].map(i => e + i))
    expect(new Set(days).size).toBe(days.length)
    expect(days).toEqual([...Array(m - w0 + 1).keys()].map(i => w0 + i))
    expect([e - w0, m - e + 1, days.length]).toEqual([20, 11, 31])
    expect(C(rentLines[0].amount)).toBe(500000 - prorateCents(500000, 20, 31))
  })
})

describe('1b. a payment amount correction is void + re-record: never an update or delete, and it reconciles', () => {
  // Rows as correct_payment_amount (payments_correct_amount.sql) writes them: the original stays, a VOID row negates it,
  // a replacement carries the corrected amount on the same tenant/category/cutoff. A correction to 0 writes only the void row.
  const correctRows = (orig, newAmount, nextId) => [
    payment({ id: nextId, tenant_id: orig.tenant_id, cutoff_id: orig.cutoff_id, category: orig.category, amount: -orig.amount, pay_type: 'VOID', voids_payment_id: orig.id }),
    payment({ id: nextId + 1, tenant_id: orig.tenant_id, cutoff_id: orig.cutoff_id, category: orig.category, amount: newAmount, payment_date: orig.payment_date, si_no: orig.si_no, tr_no: orig.tr_no }),
  ].filter(r => r.amount !== 0)

  it('net paid per tenant/category/cutoff equals the corrected amount (0 = line voided) to the cent, the row count only grows, and the balance reconciles', () => {
    const s = SCENARIOS[0]
    const { perTenant } = run(s)
    const rnd = seeded(23)
    let pays = []
    perTenant.forEach((t, i) => {
      pays.push(payment({ id: 1000 + i * 2, tenant_id: t.id, cutoff_id: OCT.id, category: 'RENT_WATER', amount: Math.floor(rnd() * 900000 + 1) / 100 }))
      pays.push(payment({ id: 1001 + i * 2, tenant_id: t.id, cutoff_id: OCT.id, category: 'ELECTRICITY', amount: Math.floor(rnd() * 90000 + 1) / 100 }))
    })
    const before = pays.map(p => ({ ...p }))
    const expected = new Map()
    let nextId = 5000
    let zeroes = 0
    for (const orig of before) {
      const newAmount = rnd() < 0.3 ? 0 : Math.floor(rnd() * 900000 + 1) / 100
      if (newAmount === 0) zeroes++
      pays = pays.concat(correctRows(orig, newAmount, nextId))
      nextId += 2
      expected.set(`${orig.tenant_id}:${orig.category}`, C(newAmount))
    }
    expect(perTenant.length).toBeGreaterThan(0)
    expect(zeroes).toBeGreaterThan(0)
    expect(pays.length).toBe(before.length * 3 - zeroes)
    for (const b of before) expect(pays.find(p => p.id === b.id)).toEqual(b)
    for (const [key, cents] of expected) {
      const [tid, cat] = key.split(':')
      const net = pays.filter(p => p.tenant_id === Number(tid) && p.category === cat && p.cutoff_id === OCT.id).reduce((a, p) => a + C(p.amount), 0)
      expect(net).toBe(cents)
    }
    const rows = buildPaymentMonitoring(OCT, s.tenants, perTenant, pays, new Map())
    for (const r of rows) {
      const paidC = (expected.get(`${r.id}:RENT_WATER`) || 0) + (expected.get(`${r.id}:ELECTRICITY`) || 0)
      expect(C(r.paid.total)).toBe(paidC)
      expect(C(r.billed.total)).toBe(C(r.paid.total) + C(r.adjustments) + C(r.outstanding) - C(r.credit))
    }
  })
})

describe('2. a room\'s metered consumption equals the total billed across its tenants', () => {
  describe.each(SCENARIOS.map(s => [s.name, s]))('%s', (_, s) => {
    for (const U of ['WATER', 'ELECTRIC']) {
      const u = UTIL[U]
      // The ghost share and the vacant amount are hand-computed in the scenario, so a share missing from a billed row fails here.
      const ghostOf = () => s.ghost?.[U] ?? 0
      const unbilledOf = () => s.unbilled?.[U] ?? 0

      it(`${U}: billed rows + ghost share + unbilled = consumption x rate (pesos) and the room is marked reconciled`, () => {
        const { perRoom, perTenant } = run(s)
        for (const br of s.billRows) {
          const r = perRoom.find(x => x.room_id === br.room_id)[u.key]
          const billed = billedInRoom(perTenant, br, u).reduce((a, b) => a + b, 0)
          const metered = (br[u.curr] - br[u.prev]) * br[u.rate]
          expect(r.ok).toBe(true)
          expect(Math.abs(r.unbilled - unbilledOf())).toBeLessThan(1e-6)
          expect(Math.abs(r.sum - (billed + ghostOf()))).toBeLessThan(1e-6)
          expect(Math.abs(billed + ghostOf() + unbilledOf() - metered)).toBeLessThan(1e-6)
        }
      })

      const exact = s.centsExact[U] ? it : it.fails
      exact(`${U}: the same holds with every share rounded to the cent as printed`, () => {
        const { perTenant } = run(s)
        for (const br of s.billRows) {
          const billed = billedInRoom(perTenant, br, u)
          const metered = centsOf(toHundredths(br[u.curr]) - toHundredths(br[u.prev]), br[u.rate])
          expect(billed.reduce((a, v) => a + C(v), 0) + C(ghostOf()) + C(unbilledOf())).toBe(metered)
        }
      })
    }
  })

  it('allocateCents: shares + unbilled === total for a fixed table of 500 seeded inputs', () => {
    const rnd = seeded()
    for (let i = 0; i < 500; i++) {
      const total = Math.floor(rnd() * 10_000_000)
      const entries = Array.from({ length: 1 + Math.floor(rnd() * 8) }, (_, k) => ({ key: k + 1, w: Math.floor(rnd() * 1000) }))
      const vacant = BigInt(rnd() < 0.3 ? Math.floor(rnd() * 500) : 0)
      const { shares, unbilledCents } = allocateCents(total, entries, vacant)
      const sum = [...shares.values()].reduce((a, b) => a + b, 0)
      expect(sum + unbilledCents).toBe(total)
      for (const v of shares.values()) expect(Number.isInteger(v) && v >= 0).toBe(true)
    }
  })

  it('splitUtility: across move-out pieces and two pricing cutoffs, tenant cents + unbilled === room cents', () => {
    const rnd = seeded(7)
    const start = dayNum('2026-09-30'), end = dayNum('2026-11-20')
    for (let i = 0; i < 60; i++) {
      const startValue = 1000 + Math.floor(rnd() * 10000) / 100
      const knownReadings = []
      let v = startValue
      for (const d of ['2026-10-12', '2026-10-25', '2026-11-03']) { v += Math.floor(rnd() * 2000) / 100; knownReadings.push({ pos: dayNum(d), value: v, label: d }) }
      const endValue = v + Math.floor(rnd() * 2000) / 100
      const participants = Array.from({ length: 1 + Math.floor(rnd() * 4) }, (_, k) => {
        const a = start + 1 + Math.floor(rnd() * 30), b = a + Math.floor(rnd() * 40)
        return { id: k + 1, moveInNum: rnd() < 0.5 ? null : a, moveOutNum: rnd() < 0.5 ? null : Math.min(b, end) }
      })
      const res = splitUtility({ utility: 'ELECTRIC', startReading: { value: startValue, pos: start, label: 's' }, endReading: { value: endValue, pos: end, label: 'e' }, knownReadings, cutoffs: CUTOFFS, participants })
      expect(res.errors).toEqual([])
      const billed = [...res.byTenant.values()].reduce((a, t) => a + t.cents, 0)
      expect(billed + res.unbilledCents).toBe(res.roomCents)
    }
  })
})

describe('2b. printing a selection or re-issuing a final bill never moves a roommate figure', () => {
  // A leaver (id 1) final-billed for Oct, two roommates. Stamps come from the final bills, as fetchTenants() builds them.
  const billRows = [billRow({ water_prev: 100, water_curr: 131, elec_prev: 6240, elec_curr: 6280 })]
  const interims = [interim({ utility: 'ELECTRIC', date: '2026-10-22', value: 6250 }), interim({ utility: 'WATER', date: '2026-10-22', value: 120 })]
  const people = () => [tenant({ id: 1, is_active: false, actual_move_out_date: '2026-10-22' }), tenant({ id: 2, bed: 'B' }), tenant({ id: 3, bed: 'C' })]
  const stamped = (bills, opts) => {
    const m = finalBilledStamps(bills, opts)
    return people().map(t => { const x = m.get(t.id); return x ? { ...t, _finalBilled: true, _finalBilledCutoffs: x.both, _finalBilledWater: x.water, _finalBilledElectric: x.electric } : t })
  }
  const compute = (tenants) => computeBilling(OCT, billRows, interims, tenants, [], [], [], [])
  const old = { id: 26, tenant_id: 1, status: 'FINAL', cutoff_id: OCT.id, covered_cutoffs: [OCT.id] }
  const neu = { id: 31, tenant_id: 1, status: 'FINAL', cutoff_id: OCT.id, covered_cutoffs: [OCT.id] }

  it('a held statement (?skip=) leaves the others and the room reconciliation exactly as computed', () => {
    const { perTenant, perRoom } = compute(stamped([old]))
    for (const rows of [rentWaterRows(perTenant), electricityRows(perTenant)]) {
      const picked = pickStatements(rows, { skip: [2] })
      expect(picked.map(x => x.t.id)).toEqual(rows.filter(r => r.id !== 2).map(r => r.id))
      for (const { t, pos } of picked) expect(rows[pos]).toBe(t)
    }
    expect(perRoom[0].water.ok && perRoom[0].electric.ok).toBe(true)
  })

  it('swapping the final bill for its re-issue (same coverage) keeps the roommate amounts and the room sums', () => {
    const before = compute(stamped([old]))
    const after = compute(stamped([{ ...old, status: 'VOID' }, neu].filter(b => b.status === 'FINAL')))
    const pick = (r) => r.perTenant.map(t => [t.id, C(t.rent), C(t.water), C(t.elec)])
    expect(pick(after)).toEqual(pick(before))
    expect(after.perRoom.map(r => [C(r.water.sum), C(r.electric.sum), r.water.ok, r.electric.ok])).toEqual(before.perRoom.map(r => [C(r.water.sum), C(r.electric.sum), r.water.ok, r.electric.ok]))
    // While the new draft is built the old bill is left out of the stamps, so the leaver is no ghost there; the saved state never is.
    expect(pick(compute(stamped([old], { excludeBillId: 26 })))).not.toEqual(pick(before))
  })
})

describe('3. no two active tenants on one bed (pure-logic part)', () => {
  const rnd = seeded(3)
  it('moveInEligibleBeds never offers a bed that has an active tenant; deriveBedStatuses marks it LEASED', () => {
    for (let i = 0; i < 200; i++) {
      const beds = Array.from({ length: 6 }, (_, k) => ({ bed_id: k + 1, status: ['VACANT', 'RESERVED', 'LEASED', 'OUT_OF_ORDER'][Math.floor(rnd() * 4)], tenant_id: null }))
      const tenants = Array.from({ length: 4 }, (_, k) => ({ id: k + 1, bed_id: 1 + Math.floor(rnd() * 6), is_active: rnd() < 0.6 }))
      const occupied = new Set(tenants.filter(t => t.is_active).map(t => t.bed_id))
      for (const b of moveInEligibleBeds(beds, tenants)) expect(occupied.has(b.bed_id)).toBe(false)
      const withTenant = beds.map(b => ({ ...b, tenant_id: occupied.has(b.bed_id) ? 1 : null }))
      for (const b of deriveBedStatuses(withTenant)) if (occupied.has(b.bed_id)) expect(b.status).toBe('LEASED')
    }
  })
  it('the Postgres unique-index violation is recognised', () => {
    expect(isActiveTenantPerBedViolation({ code: '23505', message: 'duplicate key value violates unique constraint "uniq_active_tenant_per_bed"' })).toBe(true)
  })
})

describe('4. money math is exact (integer cents, no float residue)', () => {
  it('toCents and parseMoney map every 2-decimal amount to its exact cents', () => {
    for (let c = 0; c <= 2_000_000; c += 997) {
      expect(toCents(c / 100)).toBe(c)
      expect(toCents(-c / 100) + c).toBe(0)
      expect(parseMoney(centsToInput(c))).toBe(c)
    }
    expect(toCents(0.1 + 0.2)).toBe(30)
    expect(parseMoney('0.30')).toBe(30)
  })

  it('summing cents then converting equals converting then summing, to the centavo', () => {
    const rnd = seeded(11)
    for (let i = 0; i < 300; i++) {
      const amounts = Array.from({ length: 2 + Math.floor(rnd() * 30) }, () => Math.floor(rnd() * 1_000_000) / 100)
      const floatSum = amounts.reduce((a, b) => a + b, 0)
      const centSum = amounts.reduce((a, b) => a + toCents(b), 0)
      expect(toCents(floatSum)).toBe(centSum)
      expect(toCents(computeTotals(amounts.map(amount => ({ amount, kind: 'charge' }))).net_amount)).toBe(centSum)
    }
  })

  it('prorateCents and centsOf are integers, half-up exact on x.xx5 halves', () => {
    expect(prorateCents(1, 1, 2)).toBe(1)
    expect(prorateCents(101, 1, 2)).toBe(51)
    expect(centsOf(50, 0.01)).toBe(1)
    expect(centsOf(1, 0.5)).toBe(1)
    const rnd = seeded(5)
    for (let i = 0; i < 500; i++) {
      const rate = Math.floor(rnd() * 1_000_000), win = 1 + Math.floor(rnd() * 31), days = Math.floor(rnd() * (win + 1))
      const p = prorateCents(rate, days, win)
      expect(Number.isInteger(p)).toBe(true)
      expect(p >= 0 && p <= rate).toBe(true)
      expect(Math.abs(p - rate * days / win)).toBeLessThanOrEqual(0.5)
      const c = centsOf(Math.floor(rnd() * 100000), Math.floor(rnd() * 10000) / 100, days, win)
      expect(Number.isInteger(c)).toBe(true)
    }
    expect(prorateCents(675000, 31, 31)).toBe(675000)
  })
})
