// Single source of truth for notification types. Imported by both the Vite client and the
// Deno Edge Function, so keep this file pure data: no imports, no Deno/browser globals.
export const NOTIFICATION_TYPES = [
  { id: 'approval_request',   label: 'Approval requests',   description: 'A user submits a change that needs admin approval.' },
  { id: 'approval_decision',  label: 'Approval decisions',  description: 'An admin approves or rejects a request. The staff member who raised it is always emailed separately and cannot be turned off here.' },
  { id: 'maintenance_ticket', label: 'Maintenance tickets', description: 'A new maintenance ticket is raised.' },
] as const

export type NotificationTypeId = typeof NOTIFICATION_TYPES[number]['id']
