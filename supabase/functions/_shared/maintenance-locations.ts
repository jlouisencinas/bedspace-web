// Common areas a maintenance ticket can target instead of a room. Pure data shared by the Vite client
// and the notify-email Edge Function. No imports, no Deno/browser globals.
// The codes are mirrored by the maintenance_tickets_location_check constraint
// (database/migrations/maintenance_common_areas.sql): adding one needs a migration too.
export const MAINTENANCE_LOCATIONS: ReadonlyArray<{ code: string; label: string }> = [
  { code: 'LOBBY',     label: 'LOBBY' },
  { code: 'FLOOR_2',   label: '2ND FLOOR' },
  { code: 'FLOOR_3',   label: '3RD FLOOR' },
  { code: 'FLOOR_4',   label: '4TH FLOOR' },
  { code: 'FLOOR_5',   label: '5TH FLOOR' },
  { code: 'FLOOR_6',   label: '6TH FLOOR' },
  { code: 'FLOOR_7',   label: '7TH FLOOR' },
  { code: 'KITCHEN',   label: 'KITCHEN' },
  { code: 'ROOF_DECK', label: 'ROOF DECK' },
]

const hasValue = (v: unknown) => v !== null && v !== undefined && String(v).trim() !== ''

export function isMaintenanceLocation(code: unknown): boolean {
  return typeof code === 'string' && MAINTENANCE_LOCATIONS.some(l => l.code === code)
}

export function maintenanceLocationLabel(code: unknown): string | null {
  if (typeof code !== 'string') return null
  return MAINTENANCE_LOCATIONS.find(l => l.code === code)?.label ?? null
}

export function ticketPlaceLabel({ roomNo, location }: { roomNo?: unknown; location?: unknown }): string {
  if (hasValue(roomNo)) return `Room ${String(roomNo).trim()}`
  if (hasValue(location)) return maintenanceLocationLabel(location) ?? String(location).trim()
  return '—'
}

export function validateTicketTarget({ roomId, location }: { roomId?: unknown; location?: unknown }): string | null {
  const hasRoom = hasValue(roomId)
  const hasLocation = hasValue(location)
  if (!hasRoom && !hasLocation) return 'Please select a room or common area.'
  if (hasRoom && hasLocation) return 'A ticket is for either a room or a common area, not both.'
  if (hasRoom && !(Number.isInteger(Number(roomId)) && Number(roomId) > 0)) return 'Invalid room.'
  if (hasLocation && !isMaintenanceLocation(location)) return `Unknown common area "${String(location)}".`
  return null
}
