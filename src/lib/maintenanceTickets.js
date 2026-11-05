import { ticketPlaceLabel } from '../../supabase/functions/_shared/maintenance-locations.ts'

// Select values that encode a ticket target: 'room:<id>' or 'loc:<CODE>'.
export function targetValue({ roomId, location } = {}) {
  if (roomId != null && roomId !== '') return `room:${roomId}`
  if (location) return `loc:${location}`
  return ''
}

export function parseTargetValue(value) {
  const none = { roomId: null, location: null }
  if (typeof value !== 'string') return none
  const room = /^room:(\d+)$/.exec(value)
  if (room) return { roomId: Number(room[1]), location: null }
  const loc = /^loc:([A-Z0-9_]+)$/.exec(value)
  if (loc) return { roomId: null, location: loc[1] }
  return none
}

export function ticketPlace(ticket) {
  return ticketPlaceLabel({ roomNo: ticket?.rooms?.room_no, location: ticket?.location })
}

export function ticketMatchesSearch(ticket, q) {
  const needle = String(q || '').trim().toLowerCase()
  if (!needle) return true
  return [ticket?.concern, ticket?.tenants?.name, ticketPlace(ticket)]
    .some(s => String(s || '').toLowerCase().includes(needle))
}

export function tenantsForTarget(tenants, { roomId } = {}) {
  if (roomId == null || roomId === '') return tenants
  return tenants.filter(t => String(t.beds?.room_id) === String(roomId))
}
