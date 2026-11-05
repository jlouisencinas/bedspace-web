import { describe, it, expect } from 'vitest'
import { buildPaymentMonitoring, summarizeCollections } from './collectionsSummary'
import { payment } from './__fixtures__/tenants'

const billed = [
  { id: 1, name: 'Tenant 1', room_no: '101', bed: 'A', rent: 5000, water: 470.8, elec: 300.25, addonRentWater: 150, addonElectric: 0 },
  { id: 2, name: 'Tenant 2', room_no: '101', bed: 'B', rent: 5000, water: 470.8, elec: 300.25 },
  { id: 3, name: 'Tenant 3', room_no: '102', bed: 'A', rent: 6000, water: 0, elec: 0 },
]
const pays = [
  payment({ id: 1, tenant_id: 1, cutoff_id: 2, category: 'RENT_WATER', amount: 5620.8, payment_date: '2026-10-25' }),
  payment({ id: 2, tenant_id: 1, cutoff_id: 2, category: 'ELECTRICITY', amount: 300.25, payment_date: '2026-11-12' }),
  payment({ id: 3, tenant_id: 2, cutoff_id: 2, category: 'RENT_WATER', amount: 3000, payment_date: '2026-10-28' }),
  payment({ id: 4, tenant_id: 2, cutoff_id: 2, category: 'RENT_WATER', amount: -1000, payment_date: '2026-11-02', pay_type: 'VOID' }),
  payment({ id: 5, tenant_id: 3, cutoff_id: 2, category: null, amount: 6500, payment_date: '2026-10-05' }),
]

describe('buildPaymentMonitoring', () => {
  const rows = buildPaymentMonitoring(null, null, billed, pays, new Map([[2, 1000]]))
  const byId = new Map(rows.map(r => [r.id, r]))

  it('splits billed into rent+water / electric / add-ons', () => {
    expect(byId.get(1).billed).toEqual({ rentWater: 5470.8, electric: 300.25, addons: 150, total: 5921.05 })
  })

  it('fully paid, partly paid with a void and an adjustment, overpaid as a credit', () => {
    expect(byId.get(1)).toMatchObject({ outstanding: 0, credit: 0, lastPaymentDate: '2026-11-12' })
    expect(byId.get(2)).toMatchObject({ adjustments: 1000, outstanding: 2771.05, credit: 0, lastPaymentDate: '2026-10-28' })
    expect(byId.get(2).paid).toEqual({ rentWater: 2000, electric: 0, other: 0, total: 2000 })
    expect(byId.get(3)).toMatchObject({ outstanding: 0, credit: 500 })
    expect(byId.get(3).paid.other).toBe(6500)
  })

  it('summarizeCollections: collected percent is of billed minus adjustments', () => {
    expect(summarizeCollections(rows)).toEqual({
      totalBilled: 17692.1, totalPaid: 14421.05, totalAdjustments: 1000, totalOutstanding: 2771.05,
      pctCollected: 86, unpaidCount: 1, tenantCount: 3,
    })
    expect(summarizeCollections([])).toMatchObject({ totalBilled: 0, pctCollected: 0, tenantCount: 0 })
  })
})
