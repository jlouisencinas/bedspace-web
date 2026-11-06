import { describe, it, expect } from 'vitest'
import { computePnL } from './pnl'
import { computeBilling } from './billing'
import { OCT } from './__fixtures__/cutoffs'
import { tenant, billRow } from './__fixtures__/tenants'

const cutoff = {
  ...OCT,
  water_main_amount: 5000, water_main_consumption: 250, water_maynilad_rate: 18, water_bedspace_rate: 22,
  electric_main_amount: 3000, electric_main_consumption: 0, electric_meralco_rate: 12, electric_bedspace_rate: 22,
}
// Room 101 is billed (two tenants); room 103 has nobody (management room: its consumption is overhead).
const billRows = [
  billRow({ room: 101, water_prev: 10434, water_curr: 10541, elec_prev: 6240, elec_curr: 6340 }),
  billRow({ room: 103, water_prev: 0, water_curr: 30, elec_prev: 0, elec_curr: 50 }),
]
const tenants = [tenant({ id: 1 }), tenant({ id: 2, bed: 'B' })]
const areas = [
  { utility: 'WATER', consumption: 10, rate_type: 'STANDARD' },
  { utility: 'WATER', consumption: 5, rate_type: 'BEDSPACE' },
  { utility: 'ELECTRIC', consumption: 20, rate_type: 'STANDARD' },
  { utility: 'ELECTRIC', consumption: 8, rate_type: 'BEDSPACE' },
]

describe('computePnL', () => {
  const pnl = computePnL(cutoff, billRows, [], tenants, areas)

  it('standard rate = provider bill / consumption, else the stored provider rate', () => {
    expect(pnl.WATER.standard).toBe(20)
    expect(pnl.ELECTRIC.standard).toBe(12)
  })

  it('room collections tie to the billed room sums of computeBilling', () => {
    const { perRoom } = computeBilling(cutoff, billRows, [], tenants)
    expect(pnl.WATER.roomCollections).toBeCloseTo(perRoom[0].water.sum, 9)
    expect(pnl.WATER.roomCollections).toBeCloseTo(107 * 22, 9)
    expect(pnl.ELECTRIC.roomCollections).toBeCloseTo(100 * 22, 9)
  })

  it('unbilled rooms and common areas are overhead at the standard rate; commercial at the bedspace rate', () => {
    expect(pnl.WATER.overhead).toBeCloseTo(30 * 20 + 10 * 20, 9)
    expect(pnl.WATER.commercial).toBeCloseTo(5 * 22, 9)
    expect(pnl.ELECTRIC.overhead).toBeCloseTo(50 * 12 + 20 * 12, 9)
  })

  it('commercial water is a collection, commercial electric is still pending', () => {
    expect(pnl.WATER.commercialCollected).toBeCloseTo(110, 9)
    expect(pnl.WATER.variance).toBeCloseTo(2354 + 110 - 5000, 9)
    expect(pnl.ELECTRIC.commercialCollected).toBe(0)
    expect(pnl.ELECTRIC.variance).toBeCloseTo(2200 - 3000, 9)
    expect(pnl.totalVariance).toBeCloseTo(pnl.WATER.variance + pnl.ELECTRIC.variance, 9)
  })

  it('variance = amount to be collected per the submeters − provider cost, never payments', () => {
    const { perRoom } = computeBilling(cutoff, billRows, [], tenants)
    const billedWater = perRoom.reduce((s, r) => s + (r.water?.sum || 0), 0)
    const billedElec = perRoom.reduce((s, r) => s + (r.electric?.sum || 0), 0)

    expect(pnl.WATER.toCollect).toBeCloseTo(billedWater + pnl.WATER.commercialCollected, 9)
    expect(pnl.WATER.toCollect).toBeCloseTo(pnl.WATER.roomCollections + 110, 9)
    expect(pnl.ELECTRIC.toCollect).toBeCloseTo(billedElec, 9)
    expect(pnl.ELECTRIC.toCollect).toBe(pnl.ELECTRIC.roomCollections)
    expect(pnl.WATER.variance).toBe(pnl.WATER.toCollect - pnl.WATER.cost)
    expect(pnl.ELECTRIC.variance).toBe(pnl.ELECTRIC.toCollect - pnl.ELECTRIC.cost)
    expect(pnl.WATER.collections).toBe(pnl.WATER.toCollect)

    // Tenants who have paid nothing vs. paid in full: the P&L is the same (it takes no payments input).
    const paidTenants = tenants.map(t => ({ ...t, amount_paid: 99999, payments: [{ amount: 99999 }], balance: 0 }))
    const unpaidTenants = tenants.map(t => ({ ...t, amount_paid: 0, payments: [], balance: 5000 }))
    const paid = computePnL(cutoff, billRows, [], paidTenants, areas)
    const unpaid = computePnL(cutoff, billRows, [], unpaidTenants, areas)
    for (const u of ['WATER', 'ELECTRIC']) {
      expect(paid[u].toCollect).toBe(pnl[u].toCollect)
      expect(unpaid[u].toCollect).toBe(pnl[u].toCollect)
      expect(paid[u].variance).toBe(pnl[u].variance)
      expect(unpaid[u].variance).toBe(pnl[u].variance)
    }
  })
})
