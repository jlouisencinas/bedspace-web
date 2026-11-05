import { describe, it, expect } from 'vitest'
import {
  MAINTENANCE_LOCATIONS, isMaintenanceLocation, maintenanceLocationLabel, ticketPlaceLabel, validateTicketTarget,
} from './maintenance-locations.ts'

// Literal copy of the CHECK list in database/migrations/maintenance_common_areas.sql.
const SQL_CHECK_CODES = ['LOBBY', 'FLOOR_2', 'FLOOR_3', 'FLOOR_4', 'FLOOR_5', 'FLOOR_6', 'FLOOR_7', 'KITCHEN', 'ROOF_DECK']

describe('MAINTENANCE_LOCATIONS', () => {
  it('has the 9 common areas in the order the user gave them', () => {
    expect(MAINTENANCE_LOCATIONS.map(l => l.label)).toEqual([
      'LOBBY', '2ND FLOOR', '3RD FLOOR', '4TH FLOOR', '5TH FLOOR', '6TH FLOOR', '7TH FLOOR', 'KITCHEN', 'ROOF DECK',
    ])
  })
  it('has unique codes equal to the migration CHECK list', () => {
    const codes = MAINTENANCE_LOCATIONS.map(l => l.code)
    expect(new Set(codes).size).toBe(codes.length)
    expect(codes).toEqual(SQL_CHECK_CODES)
  })
  it('isMaintenanceLocation accepts only known codes', () => {
    expect(isMaintenanceLocation('KITCHEN')).toBe(true)
    expect(isMaintenanceLocation('kitchen')).toBe(false)
    expect(isMaintenanceLocation(null)).toBe(false)
  })
})

describe('maintenanceLocationLabel', () => {
  it('maps codes to labels', () => {
    expect(maintenanceLocationLabel('ROOF_DECK')).toBe('ROOF DECK')
    expect(maintenanceLocationLabel('FLOOR_2')).toBe('2ND FLOOR')
  })
  it('returns null for unknown or empty codes', () => {
    expect(maintenanceLocationLabel('nope')).toBeNull()
    expect(maintenanceLocationLabel(null)).toBeNull()
    expect(maintenanceLocationLabel('')).toBeNull()
  })
})

describe('ticketPlaceLabel', () => {
  it('room ticket -> Room <no>', () => {
    expect(ticketPlaceLabel({ roomNo: '702' })).toBe('Room 702')
  })
  it('common-area ticket -> its label', () => {
    expect(ticketPlaceLabel({ location: 'LOBBY' })).toBe('LOBBY')
  })
  it('unknown code falls back to the raw code', () => {
    expect(ticketPlaceLabel({ location: 'X' })).toBe('X')
  })
  it('nothing set -> dash', () => {
    expect(ticketPlaceLabel({})).toBe('—')
  })
  it('room wins when both are set', () => {
    expect(ticketPlaceLabel({ roomNo: '702', location: 'LOBBY' })).toBe('Room 702')
  })
})

describe('validateTicketTarget', () => {
  it('accepts exactly one valid target', () => {
    expect(validateTicketTarget({ roomId: 5 })).toBeNull()
    expect(validateTicketTarget({ location: 'KITCHEN' })).toBeNull()
  })
  it('rejects neither', () => {
    expect(validateTicketTarget({})).toBe('Please select a room or common area.')
  })
  it('rejects both', () => {
    expect(validateTicketTarget({ roomId: 5, location: 'KITCHEN' })).toEqual(expect.any(String))
  })
  it('rejects an unknown code', () => {
    expect(validateTicketTarget({ location: 'GARAGE' })).toEqual(expect.any(String))
  })
  it('rejects a non-integer room id', () => {
    expect(validateTicketTarget({ roomId: 'abc' })).toEqual(expect.any(String))
  })
})
