// Synthetic tenants and maintenance tickets shaped like fetchTenants() / fetchTickets() rows.
export const TICKET_TENANTS = [
  { id: 101, name: 'Test Tenant Alpha', is_active: true, beds: { room_id: 1 } },
  { id: 102, name: 'Test Tenant Bravo', is_active: true, beds: { room_id: 1 } },
  { id: 103, name: 'Test Tenant Charlie', is_active: true, beds: { room_id: 2 } },
]

export const ROOM_TICKET = {
  id: 1, room_id: 1, location: null, concern: 'Leaking faucet', status: 'PENDING',
  rooms: { room_no: '702', room_type: 'Male' }, tenants: { id: 101, name: 'Test Tenant Alpha' },
}

export const COMMON_AREA_TICKET = {
  id: 2, room_id: null, location: 'LOBBY', concern: 'Broken light', status: 'PENDING',
  rooms: null, tenants: null,
}
