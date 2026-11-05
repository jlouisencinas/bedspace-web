import { describe, it, expect } from 'vitest'
import { windowLastDay } from './cutoffDates'

describe('windowLastDay (exclusive water_end -> last billed day)', () => {
  it.each([
    ['2026-12-01', '2026-11-30'],
    ['2027-01-01', '2026-12-31'],
    ['2028-03-01', '2028-02-29'],
    ['2026-11-10T00:00:00+08:00', '2026-11-09'],
    ['', ''],
    [null, ''],
  ])('%j -> %j', (end, last) => {
    expect(windowLastDay(end)).toBe(last)
  })
})
