import { describe, it, expect } from 'vitest'
import { computeBilling, splitRoomUtility, dayNum } from './billing'
import { OCT } from './__fixtures__/cutoffs'
import { tenant, billRow, interim } from './__fixtures__/tenants'

const C = (n) => Math.round(n * 100)
const row = (perTenant, id) => perTenant.find(t => t.id === id)

describe('splitRoomUtility (Method B)', () => {
  it('splits each day equally among the tenants present', () => {
    const s = dayNum('2026-10-01'), e = dayNum('2026-11-01')
    const res = splitRoomUtility([{ dateNum: s, reading: 0 }, { dateNum: e, reading: 31 }], [
      { id: 1, moveInNum: null, moveOutNum: null },
      { id: 2, moveInNum: dayNum('2026-10-17'), moveOutNum: null },
    ], 10, s, e)
    // 31 units x 10 = 310 over 31 days: 10/day; days 1-16 tenant 1 alone, days 17-31 shared.
    expect(res.amt[1]).toBeCloseTo(160 + 75, 9)
    expect(res.amt[2]).toBeCloseTo(75, 9)
    expect(res.roomAmt).toBe(310)
    expect(res.unbilled).toBe(0)
    expect(res.negative).toBe(false)
  })

  it('flags a segment whose reading went down', () => {
    const s = dayNum('2026-10-01'), e = dayNum('2026-11-01')
    const res = splitRoomUtility([{ dateNum: s, reading: 50 }, { dateNum: dayNum('2026-10-10'), reading: 40 }, { dateNum: e, reading: 60 }], [{ id: 1, moveInNum: null, moveOutNum: null }], 1, s, e)
    expect(res.negative).toBe(true)
    expect(res.roomCons).toBe(10)
  })
})

describe('computeBilling', () => {
  it('requirements §6 example: 10434 -> 10541 (107 units) at 22 = 2,354.00, five tenants -> 470.80 each', () => {
    const tenants = [1, 2, 3, 4, 5].map(id => tenant({ id, bed: 'ABCDE'[id - 1] }))
    const { perRoom, perTenant } = computeBilling(OCT, [billRow({ water_prev: 10434, water_curr: 10541 })], [], tenants)
    expect(perRoom[0].water.roomAmt).toBe(2354)
    expect(perRoom[0].water.ok).toBe(true)
    for (const t of perTenant) {
      expect(C(t.water)).toBe(47080)
      expect(t.rent).toBe(5000)
    }
    expect(perTenant.map(t => t.bed)).toEqual(['A', 'B', 'C', 'D', 'E'])
  })

  it('mid-period move-in prorates rent by days present in the rent/water window', () => {
    const { perTenant } = computeBilling(OCT, [billRow({ water_prev: 0, water_curr: 1 })], [], [
      tenant({ id: 1 }), tenant({ id: 2, bed: 'B', move_in_date: '2026-10-02' }),
    ])
    expect(row(perTenant, 2).rent).toBeCloseTo(5000 * 30 / 31, 9)
    expect(row(perTenant, 1).rent).toBe(5000)
    // 1 unit x 22: Oct 1 tenant 1 alone, Oct 2-31 shared.
    expect(row(perTenant, 2).water).toBeCloseTo(22 * 15 / 31, 9)
    expect(row(perTenant, 1).water).toBeCloseTo(22 * 16 / 31, 9)
  })

  it('a final-billed leaver is a ghost: their share stays in the room sum, they get no billed row', () => {
    const tenants = [
      tenant({ id: 1, is_active: false, actual_move_out_date: '2026-10-22', _finalBilled: true, _finalBilledCutoffs: [OCT.id] }),
      tenant({ id: 2, bed: 'B' }), tenant({ id: 3, bed: 'C' }),
    ]
    const { perRoom, perTenant } = computeBilling(OCT, [billRow({ water_prev: 100, water_curr: 131, elec_prev: 6240, elec_curr: 6280 })],
      [interim({ utility: 'ELECTRIC', date: '2026-10-22', value: 6250 })], tenants)
    expect(perTenant.map(t => t.id)).toEqual([2, 3])
    // Electric: Oct 10-22 = 10 units (220.00) shared by 3; Oct 23 - Nov 9 = 30 units (660.00) shared by 2.
    expect(row(perTenant, 2).elec).toBeCloseTo(220 / 3 + 330, 9)
    expect(perRoom[0].electric.sum).toBeCloseTo(880, 9)
    expect(perRoom[0].electric.ok).toBe(true)
    // Water: 31 units (682.00) over 31 days, 22.00/day; the ghost is present Oct 1-22.
    expect(row(perTenant, 2).water).toBeCloseTo(22 * 22 / 3 + 9 * 11, 9)
    expect(perRoom[0].water.ok).toBe(true)
  })

  it('an inactive tenant without a final bill for this cutoff is not billed at all', () => {
    const { perTenant, perRoom } = computeBilling(OCT, [billRow({ water_prev: 0, water_curr: 31 })], [], [
      tenant({ id: 1, is_active: false, actual_move_out_date: '2026-10-10' }), tenant({ id: 2, bed: 'B' }),
    ])
    expect(perTenant.map(t => t.id)).toEqual([2])
    expect(row(perTenant, 2).water).toBeCloseTo(682, 9)
    expect(perRoom[0].water.ok).toBe(true)
  })

  it('transfer mid-period: utilities split across both rooms, rent at old + new rate', () => {
    const tenants = [
      tenant({ id: 30, room: 102, bed: 'A', rate: 6000, move_in_date: '2026-09-01' }),
      tenant({ id: 31, room: 101, bed: 'A' }),
      tenant({ id: 32, room: 102, bed: 'B' }),
    ]
    const transfers = [{ tenant_id: 30, from_room_id: 11, to_room_id: 12, transfer_date: '2026-10-16', old_rate: 5000, new_rate: 6000, water_reading: 115, electric_reading: null }]
    const { perRoom, perTenant } = computeBilling(OCT, [
      billRow({ room: 101, water_prev: 100, water_curr: 131 }),
      billRow({ room: 102, water_prev: 200, water_curr: 231 }),
    ], [], tenants, [], [], [], transfers)
    const t = row(perTenant, 30)
    expect(t.rent).toBeCloseTo((5000 * 15 + 6000 * 16) / 31, 9)
    expect(t.oldWater).toBeCloseTo(165, 9)
    expect(t.water).toBeCloseTo(165 + 176, 9)
    expect(row(perTenant, 31).water).toBeCloseTo(165 + 352, 9)
    expect(row(perTenant, 32).water).toBeCloseTo(330 + 176, 9)
    expect(t).toMatchObject({ room_no: '102', transferred: true, fromRoomNo: '101', waterPrev: 100, waterCurr: 115 })
    expect(perRoom.every(r => r.water.ok)).toBe(true)
  })

  it('fully vacant days are left unbilled and the room still reconciles', () => {
    const { perRoom, perTenant } = computeBilling(OCT, [billRow({ room: 103, water_prev: 0, water_curr: 31 })],
      [interim({ room: 103, utility: 'WATER', date: '2026-10-10', value: 10 })], [tenant({ id: 40, room: 103, move_in_date: '2026-10-16' })])
    expect(perRoom[0].water.unbilled).toBeCloseTo(220, 9)
    expect(row(perTenant, 40).water).toBeCloseTo(462, 9)
    expect(perRoom[0].water.ok).toBe(true)
    expect(row(perTenant, 40).rent).toBeCloseTo(5000 * 16 / 31, 9)
  })

  it('add-ons: recurring and this cutoff\'s one-time add-ons, split rent+water / electric', () => {
    const addons = [
      { tenant_id: 1, amount: 150, recurring: true, bill_on: null },
      { tenant_id: 1, amount: 75, recurring: false, cutoff_id: OCT.id, bill_on: 'ELECTRIC' },
      { tenant_id: 1, amount: 999, recurring: false, cutoff_id: 1, bill_on: 'RENT_WATER' },
    ]
    const { perTenant } = computeBilling(OCT, [billRow({})], [], [tenant({ id: 1 })], [], addons)
    expect(perTenant[0]).toMatchObject({ addonRentWater: 150, addonElectric: 75, total: 5000 + 225 })
  })

  it('a stay-billed tenant (planned one month, not a month end) has no billed row but still shares the room', () => {
    const { perTenant, perRoom, stayBilled } = computeBilling(OCT, [billRow({ water_prev: 0, water_curr: 31 })], [], [
      tenant({ id: 1 }), tenant({ id: 2, bed: 'B', move_in_date: '2026-10-02', move_out_date: '2026-11-02' }),
    ])
    expect(perTenant.map(t => t.id)).toEqual([1])
    expect(stayBilled).toEqual([{ id: 2, name: 'Tenant 2', room_no: '101', bed: 'B', rate: 5000, move_in: '2026-10-02', move_out: '2026-11-02' }])
    expect(perRoom[0].water.sum).toBeCloseTo(682, 9)
    expect(row(perTenant, 1).water).toBeCloseTo(22 + 30 * 11, 9)
  })

  it('a whole-room tenancy (same name on every active bed) is one row with the combined rent', () => {
    const { perTenant } = computeBilling(OCT, [billRow({ room: 102, water_prev: 0, water_curr: 31 })], [], [
      tenant({ id: 50, room: 102, bed: 'A', name: 'Tenant Whole' }), tenant({ id: 51, room: 102, bed: 'B', name: ' tenant whole ' }),
    ])
    expect(perTenant).toHaveLength(1)
    expect(perTenant[0]).toMatchObject({ id: 50, rent: 10000, wholeRoom: true })
    expect(perTenant[0].water).toBeCloseTo(682, 9)
  })

  it('commercial tenant: fixed rate plus area-reading water at the bedspace rate', () => {
    const shop = { id: 60, name: 'Shop Tenant', rate: 3000, is_active: true, beds: null, category: 'COMMERCIAL', unit_label: 'Shop 1' }
    const { perTenant } = computeBilling(OCT, [], [], [shop], [], [], [{ tenant_id: 60, utility: 'WATER', consumption: 10 }])
    expect(perTenant[0]).toMatchObject({ id: 60, rent: 3000, water: 220, special: true, room_no: 'Shop 1' })
  })

  it('custom split by weights', () => {
    const splits = [{ room_id: 11, utility: 'WATER', tenant_id: 1, weight_pct: 70 }, { room_id: 11, utility: 'WATER', tenant_id: 2, weight_pct: 30 }]
    const { perTenant, perRoom } = computeBilling(OCT, [billRow({ water_prev: 0, water_curr: 31 })], [], [tenant({ id: 1 }), tenant({ id: 2, bed: 'B' })], splits)
    expect(row(perTenant, 1).water).toBeCloseTo(477.4, 9)
    expect(row(perTenant, 2).water).toBeCloseTo(204.6, 9)
    expect(perRoom[0].water.ok).toBe(true)
  })

  it('a reading that goes down is never reported as reconciled', () => {
    const { perRoom } = computeBilling(OCT, [billRow({ water_prev: 100, water_curr: 131 })],
      [interim({ utility: 'WATER', date: '2026-10-10', value: 90 })], [tenant({ id: 1 })])
    expect(perRoom[0].water.ok).toBe(false)
  })

  // BUG (follow-up): billing.js works in float pesos; each printed statement line is rounded on its own, the printed total is
  // rounded from the unrounded sum. Here the lines print 4,838.71 + 10.65 = 4,849.36 but "Total amount due" prints 4,849.35.
  it.fails('statement lines (each rounded to the cent) add up to the rounded statement total', () => {
    const { perTenant } = computeBilling(OCT, [billRow({ water_prev: 0, water_curr: 1 })], [], [
      tenant({ id: 1 }), tenant({ id: 2, bed: 'B', move_in_date: '2026-10-02' }),
    ])
    const t = row(perTenant, 2)
    expect(C(t.rent) + C(t.water)).toBe(C(t.rent + t.water))
  })
})
