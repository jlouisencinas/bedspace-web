// Billing scenarios for the non-negotiable regression tests: computeBilling(OCT, billRows, interims, tenants, [], addons, [], transfers).
// centsExact = does the room reconcile when every tenant's share is rounded to the cent (as printed)? false marks the known
// float-pesos drift in billing.js (see "Bugs surfaced" in the task's impl.md); those rows run as it.fails.
// ghost / unbilled = the hand-computed share (pesos) a final-billed ghost carries and the fully-vacant amount, per room of the
// scenario (only single-room scenarios have one); omitted = 0. They are independent of billing.js so a share dropped from a
// billed row cannot hide in them.
import { tenant, billRow, interim } from './tenants'

export const SCENARIOS = [
  {
    name: 'simple: five tenants the whole period (requirements §6)',
    billRows: [billRow({ water_prev: 10434, water_curr: 10541, elec_prev: 6000, elec_curr: 6100 })],
    tenants: [1, 2, 3, 4, 5].map(id => tenant({ id, bed: 'ABCDE'[id - 1] })),
    centsExact: { WATER: true, ELECTRIC: true },
  },
  {
    name: 'mid-period move-out: a final-billed ghost with an interim reading',
    billRows: [billRow({ water_prev: 100, water_curr: 131, elec_prev: 6240, elec_curr: 6280 })],
    interims: [interim({ utility: 'ELECTRIC', date: '2026-10-22', value: 6250 }), interim({ utility: 'WATER', date: '2026-10-22', value: 120 })],
    tenants: [
      tenant({ id: 1, is_active: false, actual_move_out_date: '2026-10-22', _finalBilled: true, _finalBilledCutoffs: [2] }),
      tenant({ id: 2, bed: 'B' }), tenant({ id: 3, bed: 'C' }),
    ],
    // Water Oct 1-22: 20 cu. m x 22 = 440.00 shared by 3; electric Oct 10-22: 10 kWh x 22 = 220.00 shared by 3.
    ghost: { WATER: 440 / 3, ELECTRIC: 220 / 3 },
    centsExact: { WATER: false, ELECTRIC: false },
  },
  {
    name: 'mid-period move-in',
    billRows: [billRow({ water_prev: 0, water_curr: 1, elec_prev: 0, elec_curr: 7 })],
    tenants: [tenant({ id: 1 }), tenant({ id: 2, bed: 'B', move_in_date: '2026-10-02' })],
    centsExact: { WATER: true, ELECTRIC: true },
  },
  {
    name: 'transfer between rooms mid-period',
    billRows: [billRow({ room: 101, water_prev: 100, water_curr: 131, elec_prev: 0, elec_curr: 62 }), billRow({ room: 102, water_prev: 200, water_curr: 231, elec_prev: 0, elec_curr: 31 })],
    tenants: [
      tenant({ id: 30, room: 102, bed: 'A', rate: 6000, move_in_date: '2026-09-01' }),
      tenant({ id: 31, room: 101, bed: 'A' }), tenant({ id: 32, room: 102, bed: 'B' }),
    ],
    transfers: [{ tenant_id: 30, from_room_id: 11, to_room_id: 12, transfer_date: '2026-10-16', old_rate: 5000, new_rate: 6000, water_reading: 115, electric_reading: 30 }],
    centsExact: { WATER: true, ELECTRIC: true },
  },
  {
    name: 'fully vacant days before a move-in',
    billRows: [billRow({ room: 103, water_prev: 0, water_curr: 31, elec_prev: 0, elec_curr: 31 })],
    interims: [interim({ room: 103, utility: 'WATER', date: '2026-10-10', value: 10 })],
    tenants: [tenant({ id: 40, room: 103, move_in_date: '2026-10-16' })],
    // Water Oct 1-10: 10 cu. m x 22, nobody overlaps that segment.
    unbilled: { WATER: 220 },
    centsExact: { WATER: true, ELECTRIC: true },
  },
  {
    name: 'odd centavo split: 100.00 over three tenants',
    billRows: [billRow({ water_prev: 0, water_curr: 100, water_rate: 1, elec_prev: 0, elec_curr: 100, elec_rate: 1 })],
    tenants: [tenant({ id: 1 }), tenant({ id: 2, bed: 'B' }), tenant({ id: 3, bed: 'C' })],
    addons: [{ tenant_id: 2, amount: 150, recurring: true }],
    centsExact: { WATER: false, ELECTRIC: false },
  },
]

// Deterministic pseudo-random numbers (fixed seed): the same table on every run, no Math.random().
export function seeded(seed = 20261105) {
  let s = seed >>> 0
  return () => { s = (Math.imul(s, 1664525) + 1013904223) >>> 0; return s / 2 ** 32 }
}
