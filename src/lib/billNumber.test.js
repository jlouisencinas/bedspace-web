import { describe, it, expect } from 'vitest'
import { monthlyBillNo, cutoffBillingMonth } from './billNumber'

const SEP = { name: 'Sep 2026', water_start: '2026-09-01', water_end: '2026-09-30', electric_start: '2026-09-10', electric_end: '2026-10-10' }

describe('monthlyBillNo', () => {
  it('room 301 on the Sep 2026 cutoff -> 301-2026-09', () => {
    expect(monthlyBillNo('301', SEP)).toBe('301-2026-09')
  })

  it('zero-pads single-digit months and keeps 12', () => {
    expect(monthlyBillNo('301', { water_start: '2026-01-01' })).toBe('301-2026-01')
    expect(monthlyBillNo('301', { water_start: '2026-12-01' })).toBe('301-2026-12')
  })

  it('uses the billing month (water_start), not the electricity reading date', () => {
    expect(monthlyBillNo('301', { water_start: '2026-09-01', electric_end: '2026-10-10' })).toBe('301-2026-09')
  })

  it('trims the room, accepts a numeric room and keeps non-numeric rooms verbatim', () => {
    expect(monthlyBillNo(' 301 ', SEP)).toBe('301-2026-09')
    expect(monthlyBillNo(301, SEP)).toBe('301-2026-09')
    expect(monthlyBillNo('5A', SEP)).toBe('5A-2026-09')
  })

  it('falls back to electric_start when water_start is null', () => {
    expect(monthlyBillNo('301', { water_start: null, electric_start: '2026-09-10' })).toBe('301-2026-09')
  })

  it('returns null when no usable date or no room', () => {
    expect(monthlyBillNo('301', { water_start: null, electric_start: null })).toBeNull()
    expect(monthlyBillNo('301', {})).toBeNull()
    expect(monthlyBillNo('301', null)).toBeNull()
    expect(monthlyBillNo('', SEP)).toBeNull()
    expect(monthlyBillNo('   ', SEP)).toBeNull()
    expect(monthlyBillNo(null, SEP)).toBeNull()
    expect(monthlyBillNo(undefined, SEP)).toBeNull()
  })

  it('crosses the year boundary correctly', () => {
    expect(monthlyBillNo('301', { water_start: '2026-12-01' })).toBe('301-2026-12')
    expect(monthlyBillNo('301', { water_start: '2027-01-01' })).toBe('301-2027-01')
  })

  it('is deterministic: same input, same string, no list involved', () => {
    expect(monthlyBillNo('301', SEP)).toBe(monthlyBillNo('301', { ...SEP }))
  })
})

describe('cutoffBillingMonth', () => {
  it('returns year and month strings, or null', () => {
    expect(cutoffBillingMonth(SEP)).toEqual({ year: '2026', month: '09' })
    expect(cutoffBillingMonth({ water_start: 'garbage' })).toBeNull()
  })
})
