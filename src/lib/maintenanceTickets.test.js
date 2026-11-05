import { describe, it, expect } from 'vitest'
import { targetValue, parseTargetValue, ticketPlace, ticketMatchesSearch, tenantsForTarget } from './maintenanceTickets'
import { TICKET_TENANTS, ROOM_TICKET, COMMON_AREA_TICKET } from './__fixtures__/maintenanceTickets'

describe('parseTargetValue / targetValue', () => {
  it('parses a room value', () => {
    expect(parseTargetValue('room:12')).toEqual({ roomId: 12, location: null })
  })
  it('parses a common-area value', () => {
    expect(parseTargetValue('loc:LOBBY')).toEqual({ roomId: null, location: 'LOBBY' })
  })
  it.each(['', 'room:abc', 'foo', null, undefined])('malformed %j -> both null', v => {
    expect(parseTargetValue(v)).toEqual({ roomId: null, location: null })
  })
  it('round-trips both forms', () => {
    expect(parseTargetValue(targetValue({ roomId: 12 }))).toEqual({ roomId: 12, location: null })
    expect(parseTargetValue(targetValue({ location: 'ROOF_DECK' }))).toEqual({ roomId: null, location: 'ROOF_DECK' })
    expect(targetValue({})).toBe('')
  })
})

describe('ticketPlace', () => {
  it('shows Room <no> for a room ticket and the label for a common area', () => {
    expect(ticketPlace(ROOM_TICKET)).toBe('Room 702')
    expect(ticketPlace(COMMON_AREA_TICKET)).toBe('LOBBY')
  })
})

describe('tenantsForTarget', () => {
  it('room -> only that room\'s tenants', () => {
    expect(tenantsForTarget(TICKET_TENANTS, { roomId: 1 }).map(t => t.id)).toEqual([101, 102])
  })
  it('common area -> all active tenants', () => {
    expect(tenantsForTarget(TICKET_TENANTS, { location: 'LOBBY' })).toHaveLength(3)
  })
  it('no selection -> all active tenants', () => {
    expect(tenantsForTarget(TICKET_TENANTS, {})).toHaveLength(3)
  })
})

describe('ticketMatchesSearch', () => {
  it('matches a common-area label case-insensitively', () => {
    expect(ticketMatchesSearch(COMMON_AREA_TICKET, 'lobby')).toBe(true)
  })
  it('matches a room number', () => {
    expect(ticketMatchesSearch(ROOM_TICKET, '702')).toBe(true)
  })
  it('matches a tenant-name fragment', () => {
    expect(ticketMatchesSearch(ROOM_TICKET, 'alph')).toBe(true)
  })
  it('does not match an unrelated string', () => {
    expect(ticketMatchesSearch(ROOM_TICKET, 'zzz-unrelated')).toBe(false)
    expect(ticketMatchesSearch(COMMON_AREA_TICKET, 'zzz-unrelated')).toBe(false)
  })
})
