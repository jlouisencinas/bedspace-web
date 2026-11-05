import { describe, it, expect } from 'vitest'
import { deriveBedStatuses, moveInEligibleBeds, activeTenantOnBedMessage, isActiveTenantPerBedViolation } from './bedEligibility'

describe('bedEligibility', () => {
  it('deriveBedStatuses marks a bed with an active tenant LEASED', () => {
    expect(deriveBedStatuses([
      { bed_id: 1, status: 'RESERVED', tenant_id: 9 },
      { bed_id: 2, status: 'VACANT', tenant_id: null },
      { bed_id: 3, status: 'LEASED', tenant_id: 8 },
    ]).map(b => b.status)).toEqual(['LEASED', 'VACANT', 'LEASED'])
  })

  it('moveInEligibleBeds offers vacant/reserved beds without an active tenant', () => {
    const beds = [
      { bed_id: 1, status: 'VACANT' }, { bed_id: 2, status: 'RESERVED' }, { bed_id: 3, status: 'VACANT' },
      { bed_id: 4, status: 'OUT_OF_ORDER' }, { bed_id: 5, status: 'LEASED' },
    ]
    const tenants = [{ bed_id: 3, is_active: true }, { bed_id: 1, is_active: false }]
    expect(moveInEligibleBeds(beds, tenants).map(b => b.bed_id)).toEqual([1, 2])
    expect(moveInEligibleBeds(null, null)).toEqual([])
  })

  it('activeTenantOnBedMessage', () => {
    expect(activeTenantOnBedMessage('101', 'A', 'Tenant A')).toBe('Room 101 Bed A already has an active tenant (Tenant A). Move them out first, or fix the bed status.')
    expect(activeTenantOnBedMessage('101', 'A')).toBe('Room 101 Bed A already has an active tenant. Move them out first, or fix the bed status.')
  })

  it('isActiveTenantPerBedViolation recognises the uniq_active_tenant_per_bed error', () => {
    expect(isActiveTenantPerBedViolation({ code: '23505' })).toBe(true)
    expect(isActiveTenantPerBedViolation({ message: 'duplicate key value violates unique constraint "uniq_active_tenant_per_bed"' })).toBe(true)
    expect(isActiveTenantPerBedViolation({ code: '42501', message: 'permission denied' })).toBe(false)
    expect(isActiveTenantPerBedViolation(null)).toBe(false)
  })
})
