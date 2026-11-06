import { describe, it, expect } from 'vitest'
import { extensionNights, extensionLine, extensionDetails, extensionNote, nightsWarning, hasExtension, STAY_EXTENSION_NIGHTLY } from './stayExtension'
import { toCents } from './finalBill'

describe('stay extension nights (P500 per night, checkout 12:00 PM)', () => {
  it.each([
    ['2026-11-02', '2026-11-03', false, 1],
    ['2026-11-02', '2026-11-03', true, 2],
    ['2026-11-02', '2026-11-05', false, 3],
    ['2026-11-02', '2026-11-05', true, 4],
    ['2026-11-02', '2026-11-02', true, 0],
    ['2026-11-02', '2026-11-01', true, 0],
    [null, '2026-11-05', true, 0],
    ['2026-11-30', '2026-12-02', false, 2],
  ])('contract %s, moved out %s, after noon %s -> %i nights', (contractISO, actualISO, afterNoon, n) => {
    expect(extensionNights({ contractISO, actualISO, afterNoon })).toBe(n)
  })

  it('hasExtension only after the contract date', () => {
    expect(hasExtension({ contractISO: '2026-11-02', actualISO: '2026-11-03' })).toBe(true)
    expect(hasExtension({ contractISO: '2026-11-02', actualISO: '2026-11-02' })).toBe(false)
    expect(hasExtension({ contractISO: null, actualISO: '2026-11-02' })).toBe(false)
  })
})

describe('extensionLine', () => {
  it('4 nights -> 2,000.00 in exact cents, source EXTENSION, computed marker set', () => {
    const l = extensionLine({ contractISO: '2026-11-02', actualISO: '2026-11-05', afterNoon: true })
    expect(l).toEqual({
      label: 'Stay extension (4 nights x ₱500.00, 03 Nov - 05 Nov, vacated after 12:00 PM)',
      mid: '4 nights', rate: 500, amount: 2000, kind: 'charge', source: 'EXTENSION', computed: 2000,
    })
    expect(toCents(l.amount)).toBe(4 * STAY_EXTENSION_NIGHTLY * 100)
  })
  it('by 12:00 PM the day after the contract date is one night of P500', () => {
    const l = extensionLine({ contractISO: '2026-11-02', actualISO: '2026-11-03', afterNoon: false })
    expect([l.amount, l.mid, l.label]).toEqual([500, '1 night', 'Stay extension (1 night x ₱500.00, 03 Nov, vacated by 12:00 PM)'])
  })
  it('no line without an extension or before the 12:00 PM choice is made', () => {
    expect(extensionLine({ contractISO: '2026-11-02', actualISO: '2026-11-02', afterNoon: true })).toBeNull()
    expect(extensionLine({ contractISO: '2026-11-02', actualISO: '2026-11-05', afterNoon: null })).toBeNull()
  })
  it('details and the printed note', () => {
    const ext = extensionDetails({ contractISO: '2026-11-02', actualISO: '2026-11-05', afterNoon: false })
    expect(ext).toEqual({ contract_date: '2026-11-02', actual_date: '2026-11-05', after_noon: false, nights: 3, rate: 500, amount: 1500 })
    expect(extensionNote(ext)).toBe('Stay extension: 3 nights after the contract move-out date 2-Nov-2026 (moved out 5-Nov-2026, vacated by 12:00 PM) at ₱500.00 per night = ₱1,500.00. Checkout is 12:00 PM; staying past 12:00 PM counts as another night. Rent is charged up to the contract move-out date.')
    expect(extensionNote(null)).toBeNull()
  })
  it('warns above 7 nights, no cap', () => {
    expect(nightsWarning(8)).toMatch(/^8 nights of stay extension/)
    expect(nightsWarning(7)).toBeNull()
    expect(extensionLine({ contractISO: '2026-11-02', actualISO: '2026-12-02', afterNoon: false }).amount).toBe(15000)
  })
})
