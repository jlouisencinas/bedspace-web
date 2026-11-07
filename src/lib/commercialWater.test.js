import { describe, it, expect } from 'vitest'
import { commercialWaterIssues, carriedAreaReading, areaPrevMismatch } from './commercialWater'

describe('commercialWaterIssues (Billing warning)', () => {
  it('flags only COMMERCIAL tenants with no water consumption', () => {
    const perTenant = [
      { id: 1, name: 'Shop Tenant A', special: true, category: 'COMMERCIAL', waterCons: 0 },
      { id: 2, name: 'Shop Tenant B', special: true, category: 'COMMERCIAL', waterCons: 5 },
      { id: 3, name: 'Parker C', special: true, category: 'PARKING_ONLY', waterCons: 0 },
      { id: 4, name: 'Bed Tenant D', special: false, waterCons: 0 },
    ]
    expect(commercialWaterIssues(perTenant)).toEqual([{ id: 1, name: 'Shop Tenant A', kind: 'ZERO' }])
  })
  it('a negative consumption counts as an issue; empty input is fine', () => {
    expect(commercialWaterIssues([{ id: 9, name: 'Shop Z', category: 'COMMERCIAL', waterCons: -3 }]).map(x => x.id)).toEqual([9])
    expect(commercialWaterIssues(undefined)).toEqual([])
  })
})

const prior = [{ area_name: 'Commercial', utility: 'WATER', previous_reading: 1200, current_reading: 1350.5 }]

describe('carriedAreaReading (Utilities carry-forward)', () => {
  it('keeps a saved row unchanged', () => {
    const found = { area_name: 'Commercial', utility: 'WATER', previous_reading: 1350.5, current_reading: 1400 }
    expect(carriedAreaReading(found, prior, 'Commercial', 'WATER')).toEqual({ previous_reading: 1350.5, current_reading: 1400 })
  })
  it('no row yet: both fields take the prior cutoff actual reading (consumption 0)', () => {
    expect(carriedAreaReading(undefined, prior, 'Commercial', 'WATER')).toEqual({ previous_reading: 1350.5, current_reading: 1350.5 })
  })
  it('no prior row (none at all, or only for another area/utility): 0/0', () => {
    expect(carriedAreaReading(undefined, [], 'Commercial', 'WATER')).toEqual({ previous_reading: 0, current_reading: 0 })
    expect(carriedAreaReading(undefined, prior, 'Lobby', 'WATER')).toEqual({ previous_reading: 0, current_reading: 0 })
    expect(carriedAreaReading(undefined, prior, 'Commercial', 'ELECTRIC')).toEqual({ previous_reading: 0, current_reading: 0 })
  })
})

describe('areaPrevMismatch (Previous does not continue from the last cutoff)', () => {
  it('true when the saved Previous differs from the prior actual reading', () => {
    expect(areaPrevMismatch({ previous_reading: 1500, current_reading: 1500 }, prior, 'Commercial', 'WATER')).toBe(true)
  })
  it('false when equal (also as a string, within cents)', () => {
    expect(areaPrevMismatch({ previous_reading: 1350.5 }, prior, 'Commercial', 'WATER')).toBe(false)
    expect(areaPrevMismatch({ previous_reading: '1350.50' }, prior, 'Commercial', 'WATER')).toBe(false)
  })
  it('false with no prior row or no saved row', () => {
    expect(areaPrevMismatch({ previous_reading: 1500 }, [], 'Commercial', 'WATER')).toBe(false)
    expect(areaPrevMismatch(undefined, prior, 'Commercial', 'WATER')).toBe(false)
  })
})
