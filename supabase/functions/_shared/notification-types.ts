// Single source of truth for notification types. Imported by both the Vite client and the
// Deno Edge Function, so keep this file pure data: no imports, no Deno/browser globals.
export const NOTIFICATION_TYPES = [
  { id: 'approval_request',   label: 'Approval requests',   description: 'A user submits a change that needs admin approval.' },
  { id: 'maintenance_ticket', label: 'Maintenance tickets', description: 'A new maintenance ticket is raised.' },
] as const

export type NotificationTypeId = typeof NOTIFICATION_TYPES[number]['id']
