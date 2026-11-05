// Synthetic beds/tenants shaped like the Dashboard's beds / tenants rows, reduced to the fields the
// occupancy formula reads. Placeholder names, invented ids; nothing comes from production.

export function bed(bed_id, status, room_id = 1) {
  return { bed_id, room_id, status }
}

// Beds 1-4 sellable (1 and 2 LEASED), bed 5 OUT OF ORDER, bed 6 REMOVED.
export const BEDS = [
  bed(1, 'LEASED'), bed(2, 'LEASED'), bed(3, 'VACANT'), bed(4, 'VACANT', 2),
  bed(5, 'OUT OF ORDER', 2), bed(6, 'REMOVED', 2),
]

export function occTenant({ id, bed_id, move_in_date, move_out_date = null, actual_move_out_date = null, ...rest }) {
  return { id, name: `Tenant ${id}`, bed_id, move_in_date, move_out_date, actual_move_out_date, rate: 5000, ...rest }
}

// A on bed 1 all month, B on bed 2 from Nov 3, C on bed 3 moved out Nov 2 (inclusive last day).
export const TENANTS = [
  occTenant({ id: 'A', bed_id: 1, move_in_date: '2026-10-01' }),
  occTenant({ id: 'B', bed_id: 2, move_in_date: '2026-11-03' }),
  occTenant({ id: 'C', bed_id: 3, move_in_date: '2026-10-15', move_out_date: '2026-11-30', actual_move_out_date: '2026-11-02' }),
]

// A on bed 1 all month, D moved from bed 3 to bed 4 on Nov 3.
export const TRANSFER_TENANTS = [
  occTenant({ id: 'A', bed_id: 1, move_in_date: '2026-10-01' }),
  occTenant({ id: 'D', bed_id: 4, previous_bed_id: 3, transfer_date: '2026-11-03', move_in_date: '2026-10-01' }),
]
