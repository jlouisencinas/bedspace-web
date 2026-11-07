import { describe, it, expect } from 'vitest'
import { filterBillingRows } from './billingSearch'

const ROWS = [
  { id: 1, name: 'Test Tenant Alpha', room_no: '101', fromRoomNo: null, bed: 'A1' },
  { id: 2, name: 'Test Tenant Bravo', room_no: 'B2', fromRoomNo: undefined, bed: 'B1' },
  { id: 3, name: 'Sample Occupant C', room_no: 102, fromRoomNo: '101', bed: 'C1', transferred: true },
  { id: 4, name: 'Sample Occupant D', room_no: 101, fromRoomNo: null, bed: null, settled: true },
]
const ids = rows => rows.map(r => r.id)

describe('filterBillingRows', () => {
  it('returns the same array reference for an empty, blank or missing query', () => {
    expect(filterBillingRows(ROWS, '')).toBe(ROWS)
    expect(filterBillingRows(ROWS, '   ')).toBe(ROWS)
    expect(filterBillingRows(ROWS, undefined)).toBe(ROWS)
  })

  it('matches the name case-insensitively', () => {
    expect(ids(filterBillingRows(ROWS, 'test tenant alpha'))).toEqual([1])
    expect(ids(filterBillingRows(ROWS, 'TEST TENANT ALPHA'))).toEqual([1])
    expect(ids(filterBillingRows(ROWS, 'Test Tenant Alpha'))).toEqual([1])
  })

  it('ignores leading, trailing and repeated spaces', () => {
    expect(ids(filterBillingRows(ROWS, '  tenant   alpha '))).toEqual([1])
  })

  it('matches a string room and a numeric room_no', () => {
    expect(ids(filterBillingRows(ROWS, '101'))).toEqual([1, 3, 4])
    expect(ids(filterBillingRows([{ id: 9, name: 'X', room_no: 101, bed: 'A1' }], '101'))).toEqual([9])
    expect(ids(filterBillingRows(ROWS, 'b2'))).toEqual([2])
  })

  it('finds a transferred tenant by either room', () => {
    expect(ids(filterBillingRows(ROWS, '102'))).toEqual([3])
    expect(ids(filterBillingRows(ROWS, '101'))).toContain(3)
  })

  it('matches the bed, and a null bed or room never matches "null"/"undefined"', () => {
    expect(ids(filterBillingRows(ROWS, 'a1'))).toEqual([1])
    expect(filterBillingRows(ROWS, 'null')).toEqual([])
    expect(filterBillingRows(ROWS, 'undefined')).toEqual([])
  })

  it('requires every token to match (name and room)', () => {
    expect(ids(filterBillingRows(ROWS, 'tenant 101'))).toEqual([1])
    expect(ids(filterBillingRows(ROWS, 'occupant 101'))).toEqual([3, 4])
  })

  it('keeps a moved-out (settled) row searchable', () => {
    expect(ids(filterBillingRows(ROWS, 'occupant d'))).toEqual([4])
  })

  it('returns [] when nothing matches', () => {
    expect(filterBillingRows(ROWS, 'zzz-no-such')).toEqual([])
  })

  it('does not mutate the input and keeps the original order', () => {
    const before = ROWS.map(r => ({ ...r }))
    const out = filterBillingRows(ROWS, 'sample')
    expect(ids(out)).toEqual([3, 4])
    expect(ROWS).toEqual(before)
    expect(ids(ROWS)).toEqual([1, 2, 3, 4])
  })
})

describe('filterBillingRows substring tokens', () => {
  it('a short token matches anywhere in the text (substring, not whole word)', () => {
    expect(ids(filterBillingRows(ROWS, 'test tenant a'))).toEqual([1, 2])
  })
})

describe('filterBillingRows on one-month-stay rows (no fromRoomNo)', () => {
  const STAY = [
    { id: 11, name: 'Stay Guest One', room_no: '101', bed: 'B', rate: 500000, move_in: '2026-10-02', move_out: '2026-11-02' },
    { id: 12, name: 'Stay Guest Two', room_no: 'B2', bed: 'C', rate: 500000, move_in: '2026-10-05', move_out: '2026-11-05' },
  ]
  it('matches name, room and bed without a fromRoomNo field', () => {
    expect(ids(filterBillingRows(STAY, 'guest one'))).toEqual([11])
    expect(ids(filterBillingRows(STAY, 'b2'))).toEqual([12])
    expect(filterBillingRows(STAY, '')).toBe(STAY)
    expect(filterBillingRows(STAY, 'undefined')).toEqual([])
  })
})
