import { describe, it, expect } from 'vitest'
import {
  isValidISODate, fmtTargetDate, targetDateProblem, targetDateState, moveInDefaults, moveInDateNotice,
} from './reservation'

const TODAY = '2026-11-05'

describe('targetDateProblem (reserve / edit rule)', () => {
  it('requires a date', () => {
    expect(targetDateProblem('', TODAY)).toMatch(/enter the target move-in date/i)
    expect(targetDateProblem(null, TODAY)).toMatch(/enter the target move-in date/i)
    expect(targetDateProblem('   ', TODAY)).toMatch(/enter the target move-in date/i)
  })

  it('refuses a date that does not exist', () => {
    expect(targetDateProblem('2026-11-31', TODAY)).toMatch(/not a valid date/i)
    expect(targetDateProblem('2026-02-29', TODAY)).toMatch(/not a valid date/i)
    expect(targetDateProblem('20261120', TODAY)).toMatch(/not a valid date/i)
  })

  it('refuses a date before today', () => {
    expect(targetDateProblem('2026-11-04', TODAY)).toMatch(/cannot be before today/i)
  })

  it('accepts today and later', () => {
    expect(targetDateProblem('2026-11-05', TODAY)).toBeNull()
    expect(targetDateProblem('2027-01-10', TODAY)).toBeNull()
    expect(targetDateProblem('2028-02-29', TODAY)).toBeNull()
  })
})

describe('targetDateState', () => {
  it('NONE for a missing or invalid date', () => {
    expect(targetDateState(null, TODAY)).toEqual({ state: 'NONE', days: null })
    expect(targetDateState('2026-11-31', TODAY)).toEqual({ state: 'NONE', days: null })
  })

  it('TODAY / UPCOMING / OVERDUE with whole days', () => {
    expect(targetDateState('2026-11-05', TODAY)).toEqual({ state: 'TODAY', days: 0 })
    expect(targetDateState('2026-11-20', TODAY)).toEqual({ state: 'UPCOMING', days: 15 })
    expect(targetDateState('2026-11-02', TODAY)).toEqual({ state: 'OVERDUE', days: -3 })
  })

  it('counts across month and leap-year February boundaries', () => {
    expect(targetDateState('2026-12-02', '2026-11-28')).toEqual({ state: 'UPCOMING', days: 4 })
    expect(targetDateState('2028-03-01', '2028-02-28')).toEqual({ state: 'UPCOMING', days: 2 })
    expect(targetDateState('2027-03-01', '2027-02-28')).toEqual({ state: 'UPCOMING', days: 1 })
  })
})

describe('moveInDefaults', () => {
  it('RESERVED bed with name and target date', () => {
    const bed = { status: 'RESERVED', reserved_name: 'Sample, Tenant A', reserved_move_in_date: '2026-11-20' }
    expect(moveInDefaults(bed, TODAY)).toEqual({ name: 'Sample, Tenant A', moveInDate: '2026-11-20', targetDate: '2026-11-20' })
  })

  it('RESERVED bed without a target date falls back to today', () => {
    const bed = { status: 'RESERVED', reserved_name: 'Sample, Tenant B', reserved_move_in_date: null }
    expect(moveInDefaults(bed, TODAY)).toEqual({ name: 'Sample, Tenant B', moveInDate: TODAY, targetDate: null })
  })

  it('VACANT bed ignores stale reservation fields', () => {
    const bed = { status: 'VACANT', reserved_name: 'Stale Name', reserved_move_in_date: '2026-11-20' }
    expect(moveInDefaults(bed, TODAY)).toEqual({ name: '', moveInDate: TODAY, targetDate: null })
  })

  it('a past target date is still the default (staff change it; the notice shows)', () => {
    const bed = { status: 'RESERVED', reserved_name: 'Sample, Tenant C', reserved_move_in_date: '2026-10-30' }
    expect(moveInDefaults(bed, TODAY).moveInDate).toBe('2026-10-30')
  })

  it('no bed', () => {
    expect(moveInDefaults(null, TODAY)).toEqual({ name: '', moveInDate: TODAY, targetDate: null })
  })
})

describe('moveInDateNotice', () => {
  it('no notice when move-in is today and equals the target', () => {
    expect(moveInDateNotice(TODAY, TODAY, TODAY)).toBeNull()
    expect(moveInDateNotice(TODAY, null, TODAY)).toBeNull()
  })

  it('future move-in date', () => {
    const n = moveInDateNotice('2026-11-20', '2026-11-20', TODAY)
    expect(n).toMatch(/15 days after today/)
    expect(n).not.toMatch(/differs/)
  })

  it('past move-in date (singular day)', () => {
    expect(moveInDateNotice('2026-11-04', '2026-11-04', TODAY)).toMatch(/1 day before today/)
  })

  it('mentions the target when the move-in date differs from it', () => {
    const n = moveInDateNotice(TODAY, '2026-11-20', TODAY)
    expect(n).toMatch(/differs from the reservation's target move-in date \(Nov 20, 2026\)/)
    expect(n).not.toMatch(/after today|before today/)
  })

  it('nothing for an invalid move-in date', () => {
    expect(moveInDateNotice('', '2026-11-20', TODAY)).toBeNull()
  })
})

describe('helpers', () => {
  it('isValidISODate / fmtTargetDate', () => {
    expect(isValidISODate('2028-02-29')).toBe(true)
    expect(isValidISODate('2027-02-29')).toBe(false)
    expect(isValidISODate(undefined)).toBe(false)
    expect(fmtTargetDate('2026-11-20')).toBe('Nov 20, 2026')
    expect(fmtTargetDate(null)).toBe('')
  })
})
