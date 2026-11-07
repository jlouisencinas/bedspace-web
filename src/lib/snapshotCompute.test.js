// Monthly snapshot collections follow the statements: a second-to-last leaver's rent is the reduced (pre) amount.
import { describe, it, expect } from 'vitest'
import { computeSnapshot } from './snapshotCompute'
import { toCents } from './finalBill'
import { OCT, OCT_ACTIVE } from './__fixtures__/cutoffs'
import { tenant, deposit, billRow } from './__fixtures__/tenants'
import { WINDOW_CARRY_ROW } from './__fixtures__/finalBill'

const leaver = tenant({ id: 140, rate: 5000, move_in_date: '2026-09-01', move_out_date: '2026-11-11' })
const stayer = tenant({ id: 141, bed: 'B', rate: 4000, move_in_date: '2026-09-01' })
const tenants = [leaver, stayer]
const beds = [{ bed_id: leaver.bed_id, room_id: 11, status: 'LEASED' }, { bed_id: stayer.bed_id, room_id: 11, status: 'LEASED' }]
const bill = [billRow({ room: 101, water_prev: 0, water_curr: 2.5, water_rate: 155.04 })]
const advData = (extra = {}) => ({
  deposits: [deposit({ id: 941, tenant_id: 140, kind: 'ADVANCE', amount: 5000, ref_no: '5401' })], finalBills: [], stored: [], carry: [], ...extra,
})
const snap = (cutoff, adv) => computeSnapshot(cutoff, beds, bill, [], tenants, [], [], [], adv)

describe('computeSnapshot: advance window', () => {
  it('active Oct (Snapshot now): rent = 1,774.19 (leaver pre) + 4,000 (stayer), total reduced by the 3,225.81 carry', () => {
    const full = snap(OCT_ACTIVE, null)
    const s = snap(OCT_ACTIVE, advData())
    expect(toCents(full.col_rent)).toBe(900000)
    expect(toCents(s.col_rent)).toBe(577419)
    expect(toCents(full.col_total) - toCents(s.col_total)).toBe(322581)
    expect(toCents(s.col_water)).toBe(toCents(full.col_water))
  })

  it('closed Oct at Open Cutoff reads the stored rent_carryovers row (and nothing without it)', () => {
    expect(toCents(snap(OCT, advData({ carry: [WINDOW_CARRY_ROW] })).col_rent)).toBe(577419)
    expect(toCents(snap(OCT, advData()).col_rent)).toBe(900000)
  })

  it('occupancy figures are unchanged by the advance data', () => {
    const a = snap(OCT_ACTIVE, null), b = snap(OCT_ACTIVE, advData())
    for (const k of ['total_beds', 'sellable', 'occupied_beds', 'active_tenants', 'occupied_rooms', 'total_rooms', 'occupancy_pct']) expect(b[k]).toBe(a[k])
  })
})
