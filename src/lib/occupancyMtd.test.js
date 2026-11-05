import { describe, it, expect } from 'vitest'
import { manilaMonthToDateWindow, occupancyTileFigures, formatPct1, formatNum1 } from './occupancyMtd'
import { computeDailyOccupancy } from '../../supabase/functions/_shared/occupancy.ts'
import { BEDS, TENANTS, TRANSFER_TENANTS, bed } from './__fixtures__/occupancy'

const NOV5 = new Date('2026-11-05T04:00:00Z')
const NOV1 = new Date('2026-11-01T04:00:00Z')
const round1 = n => Math.round(n * 10) / 10

describe('manilaMonthToDateWindow', () => {
  it('mid-month: 1st through today, tomorrow exclusive', () => {
    expect(manilaMonthToDateWindow(NOV5)).toEqual({
      todayISO: '2026-11-05', monthStartISO: '2026-11-01', tomorrowISO: '2026-11-06',
    })
  })

  it('just after Manila midnight on the 1st is already the new month', () => {
    expect(manilaMonthToDateWindow(new Date('2026-10-31T16:30:00Z'))).toEqual({
      todayISO: '2026-11-01', monthStartISO: '2026-11-01', tomorrowISO: '2026-11-02',
    })
  })

  it('just before Manila midnight is still the old month', () => {
    const w = manilaMonthToDateWindow(new Date('2026-10-31T15:59:00Z'))
    expect(w.todayISO).toBe('2026-10-31')
    expect(w.monthStartISO).toBe('2026-10-01')
  })

  it('year-end and leap day roll tomorrow over correctly', () => {
    expect(manilaMonthToDateWindow(new Date('2026-12-31T10:00:00Z')).tomorrowISO).toBe('2027-01-01')
    expect(manilaMonthToDateWindow(new Date('2028-02-29T10:00:00Z')).tomorrowISO).toBe('2028-03-01')
  })
})

describe('occupancyTileFigures', () => {
  it('main fixture on Nov 5: 10 bed-days over 5 days on 4 sellable beds', () => {
    const f = occupancyTileFigures({ beds: BEDS, tenants: TENANTS, now: NOV5 })
    expect(f.mtdPct).toBe(50)
    expect(f.mtdBedsAvg).toBe(2)
    expect(f.periodDays).toBe(5)
    expect(f.todayPct).toBe(50)
    expect(f.leasedNow).toBe(2)
    expect(f.sellableBeds).toBe(4)
    expect(f.hasBeds).toBe(true)
    expect(f.monthStartISO).toBe('2026-11-01')
    expect(f.todayISO).toBe('2026-11-05')
  })

  it('on the 1st the average covers one day (A and C occupied)', () => {
    const f = occupancyTileFigures({ beds: BEDS, tenants: TENANTS, now: NOV1 })
    expect(f.periodDays).toBe(1)
    expect(f.mtdPct).toBe(50)
    expect(f.mtdBedsAvg).toBe(2)
  })

  it('mid-month transfer splits bed-days across both beds without double counting', () => {
    const f = occupancyTileFigures({ beds: BEDS, tenants: TRANSFER_TENANTS, now: NOV5 })
    // A: 5 days on bed 1; D: Nov 1-2 on bed 3, Nov 3-5 on bed 4 -> 10 bed-days / 5 days / 4 beds
    expect(f.mtdPct).toBe(50)
    expect(f.mtdBedsAvg).toBe(2)
    const d = f.detail.filter(r => r.tenantId === 'D').map(r => [r.bedId, r.days])
    expect(d).toEqual([[3, 2], [4, 3]])
  })

  it('matches the Occupancy page weighted daily average for the same window', () => {
    const f = occupancyTileFigures({ beds: BEDS, tenants: TENANTS, now: NOV5 })
    const daily = computeDailyOccupancy(f.monthStartISO, f.tomorrowISO, BEDS, TENANTS)
    expect(f.mtdPct).toBe(round1(daily.average.occupancyPct))
  })

  it('no sellable beds: hasBeds false, zero figures, no throw', () => {
    const beds = [bed(1, 'REMOVED'), bed(2, 'OUT OF ORDER')]
    const f = occupancyTileFigures({ beds, tenants: TENANTS, now: NOV5 })
    expect(f.hasBeds).toBe(false)
    expect(f.mtdPct).toBe(0)
    expect(f.todayPct).toBe(0)
    expect(Number.isNaN(f.mtdBedsAvg)).toBe(false)
  })

  it('beds but no tenants: a real 0 and no detail rows', () => {
    const f = occupancyTileFigures({ beds: BEDS, tenants: [], now: NOV5 })
    expect(f.hasBeds).toBe(true)
    expect(f.mtdPct).toBe(0)
    expect(f.detail).toEqual([])
  })
})

describe('formatNum1', () => {
  it('always one decimal, so a whole average reads "2.0"', () => {
    expect(formatNum1(2)).toBe('2.0')
    expect(formatNum1(26.4)).toBe('26.4')
    expect(formatNum1(0)).toBe('0.0')
  })
})

describe('formatPct1', () => {
  it('one decimal', () => {
    expect(formatPct1(50)).toBe('50.0%')
    expect(formatPct1(87.25)).toBe('87.3%')
  })
})
