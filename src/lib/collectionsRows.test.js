import { describe, it, expect } from 'vitest'
import { buildCollectionRows, cutoffOutstanding, pickPastDueCandidates, resolveCutoffId, adjacentCutoffId, createPastDueRefresh } from './collectionsRows'
import { buildPaymentMonitoring, summarizeCollections } from './collectionsSummary'
import { tenant, payment } from './__fixtures__/tenants'
import { SEP, OCT, NOV } from './__fixtures__/cutoffs'

const bill = (id, o = {}) => ({ id, name: `Tenant ${id}`, room_no: '101', bed: 'A', rent: 0, water: 0, elec: 0, ...o })

describe('buildCollectionRows', () => {
  const t1 = tenant({ id: 1 })
  const perTenant = [bill(1, { rent: 3000, water: 200, addonRentWater: 100, elec: 500, addonElectric: 50 })]

  it('billed folds add-ons into rent+water / electricity; remaining equals billed with no payments', () => {
    const [r] = buildCollectionRows({ perTenant, tenants: [t1] })
    expect(r.billed).toEqual({ rw: 3300, elec: 550 })
    expect(r.paid).toEqual({ rw: 0, elec: 0 })
    expect(r.remaining).toEqual({ rw: 3300, elec: 550 })
    expect(r).toMatchObject({ name: 'Tenant 1', room_no: '101', bed_letter: 'A' })
  })

  it('an advance adjustment lowers billed rent+water and is not counted as paid', () => {
    const [r] = buildCollectionRows({ perTenant, tenants: [t1], adjustments: new Map([[1, 1000]]) })
    expect(r.billed.rw).toBe(2300)
    expect(r.paid.rw).toBe(0)
    expect(r.remaining.rw).toBe(2300)
  })

  it('payments settle each component; a VOID row reopens it', () => {
    const pays = [
      payment({ id: 1, tenant_id: 1, cutoff_id: 2, category: 'RENT_WATER', amount: 2000 }),
      payment({ id: 2, tenant_id: 1, cutoff_id: 2, category: 'RENT_WATER', amount: 1300 }),
      payment({ id: 3, tenant_id: 1, cutoff_id: 2, category: 'ELECTRICITY', amount: 550 }),
    ]
    const [paid] = buildCollectionRows({ perTenant, tenants: [t1], payments: pays })
    expect(paid.remaining).toEqual({ rw: 0, elec: 0 })
    const voided = [...pays, payment({ id: 4, tenant_id: 1, cutoff_id: 2, category: 'ELECTRICITY', amount: -550, pay_type: 'VOID' })]
    const [r] = buildCollectionRows({ perTenant, tenants: [t1], payments: voided })
    expect(r.paid.elec).toBe(0)
    expect(r.remaining.elec).toBe(550)
    expect(r.elecPays).toHaveLength(2)
  })

  it('overpayment never produces a negative remaining and leaves billed unchanged', () => {
    const [r] = buildCollectionRows({ perTenant, tenants: [t1], payments: [payment({ id: 1, tenant_id: 1, category: 'RENT_WATER', amount: 4000 })] })
    expect(r.remaining.rw).toBe(0)
    expect(r.billed.rw).toBe(3300)
    expect(r.paid.rw).toBe(4000)
  })

  it('sums in exact cents', () => {
    const [r] = buildCollectionRows({
      perTenant: [bill(1, { rent: 0.1, water: 0.2, elec: 0.7, addonElectric: 0.1 })],
      tenants: [t1],
      payments: [payment({ id: 1, tenant_id: 1, category: 'RENT_WATER', amount: 0.1 })],
    })
    expect(r.billed).toEqual({ rw: 0.3, elec: 0.8 })
    expect(r.remaining.rw).toBe(0.2)
  })

  it('active cutoff keeps only active tenants; closed cutoff keeps billed moved-out tenants and drops final-billed ghosts', () => {
    const tenants = [tenant({ id: 1 }), tenant({ id: 2, bed: 'B', is_active: false }), tenant({ id: 3, bed: 'C', is_active: false })]
    const pt = [bill(1, { rent: 1000 }), bill(2, { rent: 800 })]
    expect(buildCollectionRows({ perTenant: pt, tenants, includeInactive: false }).map(r => r.id)).toEqual([1])
    const closed = buildCollectionRows({ perTenant: pt, tenants, includeInactive: true })
    expect(closed.map(r => r.id)).toEqual([1, 2])
    expect(closed[1]).toMatchObject({ bed_letter: 'B', billed: { rw: 800, elec: 0 } })
  })

  it('active cutoff with no bill row for an active tenant shows billed 0 (unchanged behaviour)', () => {
    const [r] = buildCollectionRows({ perTenant: [], tenants: [t1] })
    expect(r.billed).toEqual({ rw: 0, elec: 0 })
  })
})

describe('cutoffOutstanding', () => {
  it('sums what is still owed; an overpaid tenant does not offset another', () => {
    const rows = buildCollectionRows({
      perTenant: [bill(1, { rent: 300 }), bill(2, { rent: 500 })],
      tenants: [tenant({ id: 1 }), tenant({ id: 2, bed: 'B' })],
      payments: [payment({ id: 1, tenant_id: 2, category: 'RENT_WATER', amount: 900 })],
    })
    expect(cutoffOutstanding(rows)).toEqual({ rw: 300, elec: 0, total: 300, unpaidCount: 1 })
    expect(cutoffOutstanding([])).toEqual({ rw: 0, elec: 0, total: 0, unpaidCount: 0 })
  })
})

describe('pickPastDueCandidates', () => {
  const AUG = { ...SEP, id: 11, name: 'Aug 2026', water_start: '2026-08-01' }
  const JUL = { ...SEP, id: 12, name: 'Jul 2026', water_start: '2026-07-01' }
  const NO_WINDOW = { ...SEP, id: 13, name: 'Draft', water_start: null }

  it('the newest closed cutoffs with a window, active excluded', () => {
    expect(pickPastDueCandidates([NOV, JUL, OCT, NO_WINDOW, SEP, AUG], 3).map(c => c.name)).toEqual(['Oct 2026', 'Sep 2026', 'Aug 2026'])
    expect(pickPastDueCandidates([NOV])).toEqual([])
    expect(pickPastDueCandidates([])).toEqual([])
  })
})

describe('reconciliation (§14 balance rule)', () => {
  const tenants = [tenant({ id: 1 }), tenant({ id: 2, bed: 'B' }), tenant({ id: 3, bed: 'C' })]
  const perTenant = [
    bill(1, { rent: 5000, water: 470.8, elec: 300.25, addonRentWater: 150 }),
    bill(2, { rent: 5000, water: 470.8, elec: 300.25, addonElectric: 25.5 }),
    bill(3, { rent: 6000, water: 120.4, elec: 80.15 }),
  ]
  const adjustments = new Map([[2, 1000]])
  const payments = [
    payment({ id: 1, tenant_id: 1, category: 'RENT_WATER', amount: 5620.8 }),
    payment({ id: 2, tenant_id: 1, category: 'ELECTRICITY', amount: 100 }),
    payment({ id: 3, tenant_id: 2, category: 'RENT_WATER', amount: 3000 }),
    payment({ id: 4, tenant_id: 2, category: 'RENT_WATER', amount: -1000, pay_type: 'VOID' }),
    payment({ id: 5, tenant_id: 3, category: 'ELECTRICITY', amount: 80.15 }),
  ]
  const rows = buildCollectionRows({ perTenant, tenants, payments, adjustments })

  it('billed = paid + adjustments + outstanding - credit, in cents', () => {
    const c = n => Math.round(n * 100)
    const grossC = perTenant.reduce((s, t) => s + c(t.rent) + c(t.water) + c(t.elec) + c(t.addonRentWater || 0) + c(t.addonElectric || 0), 0)
    const paidC = rows.reduce((s, r) => s + c(r.paid.rw) + c(r.paid.elec), 0)
    const adjC = c(1000)
    const outC = c(cutoffOutstanding(rows).total)
    const creditC = rows.reduce((s, r) => s + Math.max(c(r.paid.rw) - c(r.billed.rw), 0) + Math.max(c(r.paid.elec) - c(r.billed.elec), 0), 0)
    expect(grossC).toBe(paidC + adjC + outC - creditC)
  })

  it('matches Payment Monitoring outstanding for the same cutoff', () => {
    const pm = summarizeCollections(buildPaymentMonitoring(null, tenants, perTenant, payments, adjustments))
    const out = cutoffOutstanding(rows)
    expect(out.total).toBe(pm.totalOutstanding)
    expect(out.unpaidCount).toBe(pm.unpaidCount)
  })
})

describe('S.I# / T.R# on payments carry no money', () => {
  it('billed / paid / remaining are identical with and without refs', () => {
    const tenants = [tenant({ id: 1 }), tenant({ id: 2, bed: 'B' })]
    const perTenant = [bill(1, { rent: 3000, water: 120.5, elec: 410.25 }), bill(2, { rent: 2500, elec: 99.99 })]
    const plain = [
      payment({ id: 1, tenant_id: 1, category: 'RENT_WATER', amount: 2000 }),
      payment({ id: 2, tenant_id: 1, category: 'ELECTRICITY', amount: 410.25 }),
      payment({ id: 3, tenant_id: 2, category: 'RENT_WATER', amount: 2500 }),
    ]
    const withRefs = plain.map((p, i) => ({ ...p, si_no: `90000${i}`, tr_no: i === 1 ? null : `80000${i}` }))
    const strip = rows => rows.map(r => ({ id: r.id, billed: r.billed, paid: r.paid, remaining: r.remaining }))
    const a = buildCollectionRows({ perTenant, tenants, payments: plain })
    const b = buildCollectionRows({ perTenant, tenants, payments: withRefs })
    expect(strip(b)).toEqual(strip(a))
    expect(cutoffOutstanding(b)).toEqual(cutoffOutstanding(a))
  })
})

describe('late payment of a past-due cutoff is counted once', () => {
  it('a payment with cutoff_id = the closed cutoff clears that cutoff only', () => {
    const tenants = [tenant({ id: 1 })]
    const perTenantA = [bill(1, { rent: 2800, water: 200 })]
    const perTenantB = [bill(1, { rent: 2800, water: 200 })]
    const allPays = [payment({ id: 1, tenant_id: 1, cutoff_id: OCT.id, category: 'RENT_WATER', amount: 3000, payment_date: '2026-11-05' })]
    const forCutoff = id => allPays.filter(p => p.cutoff_id === id)
    const rowsA = buildCollectionRows({ perTenant: perTenantA, tenants, payments: forCutoff(OCT.id), includeInactive: true })
    const rowsB = buildCollectionRows({ perTenant: perTenantB, tenants, payments: forCutoff(NOV.id) })
    expect(cutoffOutstanding(rowsA).total).toBe(0)
    expect(cutoffOutstanding(rowsB).total).toBe(3000)
    const paidC = [...rowsA, ...rowsB].reduce((s, r) => s + Math.round(r.paid.rw * 100) + Math.round(r.paid.elec * 100), 0)
    expect(paidC).toBe(300000)
  })
})

describe('per-tenant reconciliation with a void, a partial and an overpayment', () => {
  it('billed - adjustments = paid + outstanding - overpayment, per tenant, never netted across tenants', () => {
    const tenants = [tenant({ id: 1 }), tenant({ id: 2, bed: 'B' }), tenant({ id: 3, bed: 'C' })]
    const perTenant = [
      bill(1, { rent: 4000, water: 150.35, elec: 220.1 }),
      bill(2, { rent: 4000, water: 150.35, elec: 220.1 }),
      bill(3, { rent: 3500, water: 90, elec: 75.55 }),
    ]
    const adjustments = new Map([[3, 500]])
    const payments = [
      payment({ id: 1, tenant_id: 1, category: 'RENT_WATER', amount: 4150.35, si_no: '101' }),
      payment({ id: 2, tenant_id: 1, category: 'ELECTRICITY', amount: 220.1, tr_no: '201' }),
      payment({ id: 3, tenant_id: 1, category: 'ELECTRICITY', amount: -220.1, pay_type: 'VOID', voids_payment_id: 2 }),
      payment({ id: 4, tenant_id: 2, category: 'RENT_WATER', amount: 1000 }),
      payment({ id: 5, tenant_id: 3, category: 'RENT_WATER', amount: 5000, si_no: '102', tr_no: '202' }),
    ]
    const rows = buildCollectionRows({ perTenant, tenants, payments, adjustments })
    const c = n => Math.round(n * 100)
    for (const r of rows) {
      const b = perTenant.find(t => t.id === r.id)
      const billedC = c(b.rent) + c(b.water) + c(b.elec) - c(adjustments.get(r.id) || 0)
      const paidC = c(r.paid.rw) + c(r.paid.elec)
      const outC = c(r.remaining.rw) + c(r.remaining.elec)
      const overC = Math.max(c(r.paid.rw) - c(r.billed.rw), 0) + Math.max(c(r.paid.elec) - c(r.billed.elec), 0)
      expect(billedC).toBe(paidC + outC - overC)
      expect(r.remaining.rw).toBeGreaterThanOrEqual(0)
      expect(r.remaining.elec).toBeGreaterThanOrEqual(0)
    }
    expect(rows.find(r => r.id === 1).remaining).toEqual({ rw: 0, elec: 220.1 })
    expect(rows.find(r => r.id === 3).remaining.rw).toBe(0)
    expect(c(cutoffOutstanding(rows).total)).toBe(22010 + 315035 + 22010 + 7555)
  })
})

describe('resolveCutoffId / adjacentCutoffId', () => {
  const AUG = { ...SEP, id: 11, name: 'Aug 2026', water_start: '2026-08-01' }
  const list = [NOV, OCT, SEP, AUG]

  it('a known ?cutoff= id wins; otherwise the active cutoff', () => {
    expect(resolveCutoffId(list, String(OCT.id))).toBe(OCT.id)
    expect(resolveCutoffId(list, OCT.id)).toBe(OCT.id)
    expect(resolveCutoffId(list, '999')).toBe(NOV.id)
    expect(resolveCutoffId(list, 'abc')).toBe(NOV.id)
    expect(resolveCutoffId(list, '2.5')).toBe(NOV.id)
    expect(resolveCutoffId(list, NaN)).toBe(NOV.id)
    expect(resolveCutoffId(list, null)).toBe(NOV.id)
    expect(resolveCutoffId(list, '')).toBe(NOV.id)
  })

  it('no active cutoff -> the newest by water_start; empty list -> null', () => {
    expect(resolveCutoffId([AUG, SEP, OCT], null)).toBe(OCT.id)
    expect(resolveCutoffId([], '2')).toBeNull()
    expect(resolveCutoffId(null, null)).toBeNull()
  })

  it('older / newer neighbours by water_start, null at the ends or for an unknown id', () => {
    const shuffled = [SEP, NOV, AUG, OCT]
    expect(adjacentCutoffId(shuffled, OCT.id, 'older')).toBe(SEP.id)
    expect(adjacentCutoffId(shuffled, OCT.id, 'newer')).toBe(NOV.id)
    expect(adjacentCutoffId(shuffled, NOV.id, 'newer')).toBeNull()
    expect(adjacentCutoffId(shuffled, AUG.id, 'older')).toBeNull()
    expect(adjacentCutoffId(shuffled, 999, 'older')).toBeNull()
    expect(adjacentCutoffId([], 1, 'older')).toBeNull()
  })
})

describe('createPastDueRefresh (banner survives superseded loads)', () => {
  it('first load: wanted until a run finishes; a superseded run is ignored (StrictMode double effect)', () => {
    const r = createPastDueRefresh()
    expect(r.shouldRun()).toBe(true)
    const first = r.start()
    const second = r.start()
    expect(r.finish(first, true)).toBe(false)
    expect(r.shouldRun()).toBe(true)
    expect(r.finish(second, true)).toBe(true)
    expect(r.shouldRun()).toBe(false)
  })

  it('a failed run shows its error but keeps the refresh wanted, so the next load retries', () => {
    const r = createPastDueRefresh()
    expect(r.finish(r.start(), false)).toBe(true)
    expect(r.shouldRun()).toBe(true)
  })

  it('picker-only loads do not refresh once loaded; a save/undo/ref edit requests it again', () => {
    const r = createPastDueRefresh()
    r.finish(r.start(), true)
    expect(r.shouldRun()).toBe(false)
    r.request()
    expect(r.shouldRun()).toBe(true)
  })

  it('a request during an in-flight run invalidates it, so stale data never clears the new request', () => {
    const r = createPastDueRefresh()
    const old = r.start()
    r.request()
    expect(r.finish(old, true)).toBe(false)
    expect(r.shouldRun()).toBe(true)
    expect(r.finish(r.start(), true)).toBe(true)
    expect(r.shouldRun()).toBe(false)
  })
})
