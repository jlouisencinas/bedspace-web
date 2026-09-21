import { NOTIFICATION_TYPES, type NotificationTypeId } from '../_shared/notification-types.ts'
import { APP_URL, clip, layout, type Message } from './email.ts'

export class NotifyError extends Error {
  code: string
  status: number
  constructor(code: string, status = 400) {
    super(code)
    this.code = code
    this.status = status
  }
}

export type Caller = { id: string; email: string; role: string | null }
export type LoadCtx = { admin: any; caller: Caller; recordId: string }

export const FRESHNESS_MS = 5 * 60 * 1000

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

function assertFresh(createdAt: string | null | undefined) {
  const ts = createdAt ? Date.parse(createdAt) : NaN
  if (!Number.isFinite(ts) || Date.now() - ts > FRESHNESS_MS) throw new NotifyError('stale_record', 409)
}

const link = (path: string) => APP_URL ? { url: `${APP_URL}${path}`, label: 'Review in Bedspace Manager' } : undefined

type Handler<D> = {
  load(ctx: LoadCtx): Promise<D>
  build(data: D): Message
}

const approvalRequest: Handler<any> = {
  async load({ admin, caller, recordId }) {
    if (!UUID_RE.test(recordId)) throw new NotifyError('bad_record_id', 400)
    const { data, error } = await admin
      .from('approval_requests')
      .select('id, requester_id, entity_type, entity_id, field_name, reason, status, created_at, new_value')
      .eq('id', recordId)
      .maybeSingle()
    if (error) { console.error('notify-email: approval load failed', error.code); throw new NotifyError('load_failed', 500) }
    if (!data) throw new NotifyError('record_not_found', 404)
    if (data.requester_id !== caller.id) throw new NotifyError('forbidden', 403)
    if (data.status !== 'PENDING') throw new NotifyError('not_pending', 409)
    assertFresh(data.created_at)
    const nv = data.new_value && typeof data.new_value === 'object' && !Array.isArray(data.new_value) ? data.new_value : {}
    return {
      raisedBy:   caller.email,
      entityType: data.entity_type,
      entityId:   data.entity_id,
      fieldName:  data.field_name,
      reason:     clip(data.reason),
      roomNo:     nv._room_no ?? null,
      tenantName: nv._tenant_name ?? null,
    }
  },
  build(d) {
    const rows: Array<[string, string]> = [
      ['Entity', `${d.entityType} #${d.entityId}`],
      ['Field', String(d.fieldName)],
    ]
    if (d.roomNo)     rows.push(['Room', String(d.roomNo)])
    if (d.tenantName) rows.push(['Tenant', String(d.tenantName)])
    rows.push(['Reason', d.reason])
    const { html, text } = layout(d.raisedBy, rows, link('/approvals'))
    return { subject: `New approval request: ${d.fieldName} — ${d.entityType}`, html, text }
  },
}

const maintenanceTicket: Handler<any> = {
  async load({ admin, caller, recordId }) {
    if (!/^\d{1,10}$/.test(recordId)) throw new NotifyError('bad_record_id', 400)
    // Mirrors the tickets_insert RLS policy: only admin/user roles can raise tickets.
    if (caller.role !== 'admin' && caller.role !== 'user') throw new NotifyError('forbidden', 403)
    const { data, error } = await admin
      .from('maintenance_tickets')
      .select('id, concern, remarks, status, raised_at, created_at, rooms(room_no), tenants(name)')
      .eq('id', Number(recordId))
      .maybeSingle()
    if (error) { console.error('notify-email: ticket load failed', error.code); throw new NotifyError('load_failed', 500) }
    if (!data) throw new NotifyError('record_not_found', 404)
    if (data.status !== 'PENDING') throw new NotifyError('not_pending', 409)
    assertFresh(data.raised_at ?? data.created_at)
    return {
      raisedBy:   caller.email,
      roomNo:     data.rooms?.room_no ?? null,
      concern:    clip(data.concern),
      remarks:    data.remarks ? clip(data.remarks) : null,
      tenantName: data.tenants?.name ?? null,
    }
  },
  build(d) {
    const rows: Array<[string, string]> = [
      ['Room', String(d.roomNo ?? '?')],
      ['Concern', d.concern],
    ]
    if (d.remarks)    rows.push(['Remarks', d.remarks])
    if (d.tenantName) rows.push(['Tenant', String(d.tenantName)])
    const { html, text } = layout(d.raisedBy, rows, link('/maintenance'))
    return { subject: `New maintenance ticket — Room ${d.roomNo ?? '?'}`, html, text }
  },
}

export const EVENT_HANDLERS: Record<NotificationTypeId, Handler<any>> = {
  approval_request:   approvalRequest,
  maintenance_ticket: maintenanceTicket,
}

for (const t of NOTIFICATION_TYPES) {
  if (!EVENT_HANDLERS[t.id]) throw new Error(`notify-email: no handler registered for type "${t.id}"`)
}
