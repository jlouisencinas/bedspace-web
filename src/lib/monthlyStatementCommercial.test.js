import { describe, it, expect } from 'vitest'
import { rentWaterProps, electricityProps } from './monthlyStatement'

const cutoff = { water_start: '2030-03-01', water_end: '2030-04-01', electric_start: '2030-02-10', electric_end: '2030-03-10' }
const base = { id: 7, name: 'Synthetic Shop', room_no: 'Unit X', room_id: null, special: true, category: 'COMMERCIAL',
  rent: 1000, water: 0, waterCons: 0, elec: 0, elecCons: 0, addons: [], addonRentWater: 0, addonElectric: 0 }
const rw = (t) => rentWaterProps({ t, cutoff, roomRow: null, splits: [], credit: null, billNo: 'X-1' })

describe('rentWaterProps: commercial statements always carry the Water row', () => {
  it('COMMERCIAL at 0 water: Monthly Rent then Water 0.00 / P0, total = rent', () => {
    const p = rw(base)
    expect(p.charges.map(c => c.label)).toEqual(['Monthly Rent', 'Add: Water (cu. m)'])
    expect(p.charges[1].amount).toBe(0)
    expect(p.charges[1].mid).toBe('0.00')
    expect(p.total).toBe(1000)
  })
  it('COMMERCIAL with water: rent, water, add-on order and total unchanged', () => {
    const p = rw({ ...base, water: 150.5, waterCons: 1,
      addons: [{ label: 'Signage', amount: 200, recurring: true, bill_on: 'RENT_WATER' }], addonRentWater: 200 })
    expect(p.charges.map(c => c.label)).toEqual(['Monthly Rent', 'Add: Water (cu. m)', 'Add: Signage'])
    expect(p.charges[1].amount).toBe(150.5)
    expect(p.total).toBe(1350.5)
  })
  it('PARKING_ONLY and OTHER at 0 water keep rent only; a bed tenant always has the Water row', () => {
    expect(rw({ ...base, category: 'PARKING_ONLY' }).charges.map(c => c.label)).toEqual(['Monthly Rent'])
    expect(rw({ ...base, category: 'OTHER' }).charges.map(c => c.label)).toEqual(['Monthly Rent'])
    expect(rw({ ...base, special: false, category: undefined, room_id: 3 }).charges.map(c => c.label))
      .toEqual(['Monthly Rent', 'Add: Water (cu. m)'])
  })
})

describe('electricityProps: commercial unchanged', () => {
  it('COMMERCIAL with 0 electric has no Electricity row', () => {
    const p = electricityProps({ t: base, cutoff, roomRow: null, splits: [], billNo: 'X-1' })
    expect(p.charges).toEqual([])
    expect(p.total).toBe(0)
  })
})
