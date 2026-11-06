import { describe, it, expect } from 'vitest'
import { buildCollectionRows, cutoffOutstanding, pickPastDueCandidates } from './collectionsRows'
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
