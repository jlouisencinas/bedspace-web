// Synthetic, anonymised rows shaped like fetchTenants() / fetchUtilityBill() / tenant_deposits / payments.
// Names are placeholders ("Tenant A"), rooms are invented numbers; nothing here comes from production.

export const ROOMS = {
  101: { room_id: 11, room_no: '101', room_type: 'BEDSPACE' },
  102: { room_id: 12, room_no: '102', room_type: 'BEDSPACE' },
  103: { room_id: 13, room_no: '103', room_type: 'BEDSPACE' },
}

export function tenant({
  id, name = `Tenant ${id}`, room = 101, bed = 'A', rate = 5000,
  move_in_date = '2026-08-01', move_out_date = null, actual_move_out_date = null, is_active = true, ...rest
}) {
  const r = ROOMS[room]
  return {
    id, name, rate, move_in_date, move_out_date, actual_move_out_date, is_active,
    bed_id: r ? r.room_id * 10 + bed.charCodeAt(0) - 64 : null,
    beds: r ? { bed_letter: bed, room_id: r.room_id, rooms: { room_no: r.room_no, room_type: r.room_type } } : null,
    ...rest,
  }
}

export function billRow({ room = 101, water_prev = 0, water_curr = 0, water_rate = 22, elec_prev = 0, elec_curr = 0, elec_rate = 22 }) {
  const r = ROOMS[room]
  return { room_id: r.room_id, room_no: r.room_no, room_type: r.room_type, water_prev, water_curr, water_rate, elec_prev, elec_curr, elec_rate }
}

export function interim({ room = 101, utility, date, value, ...rest }) {
  return { room_id: ROOMS[room].room_id, utility, reading_date: date, reading_value: value, ...rest }
}

export function deposit({ id, tenant_id, kind, amount, status = 'HELD', ref_no = '', ...rest }) {
  return { id, tenant_id, kind, amount, status, ref_no, received_date: '2026-08-01', payment_mode: 'CASH', reservation_payment_id: null, ...rest }
}

export function payment({ id, tenant_id, cutoff_id, category, amount, payment_date = '2026-10-20', pay_type = 'PAYMENT' }) {
  return { id, tenant_id, cutoff_id, category, amount, payment_date, pay_type }
}
