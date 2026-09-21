import { NOTIFICATION_TYPES, type NotificationTypeId } from '../_shared/notification-types.ts'
import { buildDecisionEmail, buildRequestEmail, type Lookups } from './approval-email.ts'
import { buildTicketEmail } from './ticket-email.ts'
import { APP_URL, type Message } from './email.ts'

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

export type DirectMessage = { email: string; message: Message }

type Handler<D> = {
  load(ctx: LoadCtx): Promise<D>
  build(data: D): Message
  // Per-address messages sent on their own (not BCC'd with the subscriber list), regardless of subscriptions.
  direct?(data: D): DirectMessage[]
}

const APPROVAL_COLUMNS = 'id, requester_id, entity_type, entity_id, field_name, old_value, new_value, reason, status, decision_maker_id, decision_notes, decided_at, created_at'

// Same pattern the Apps Script mailer enforces on every recipient.
const EMAIL_RE = /^[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}$/

// The destination bed is stored as an id; resolve it so the email can say "Room 306 · Bed B".
async function loadLookups(admin: any, row: any): Promise<Lookups> {
  if (row.field_name !== 'transfer') return {}
  const toBedId = row.new_value?.to_bed_id
  if (toBedId === null || toBedId === undefined || String(toBedId).length > 20) return {}
  const { data, error } = await admin.from('beds').select('bed_letter, rooms(room_no)').eq('id', toBedId).maybeSingle()
  if (error) { console.warn('notify-email: destination bed lookup failed', error.code); return {} }
  const room = Array.isArray(data?.rooms) ? data.rooms[0] : data?.rooms
  return data ? { destBed: { room_no: room?.room_no ?? null, bed_letter: data.bed_letter } } : {}
}

// requester_email on the row is client-supplied, so the address comes from the auth service.
async function requesterAuthEmail(admin: any, requesterId: string): Promise<string | null> {
  const { data, error } = await admin.auth.admin.getUserById(requesterId)
  if (error) { console.warn('notify-email: requester lookup failed', error.status ?? error.code); return null }
  const email = data?.user?.email
  return typeof email === 'string' && email.length <= 254 && EMAIL_RE.test(email) ? email : null
}

const approvalRequest: Handler<any> = {
  async load({ admin, caller, recordId }) {
    if (!UUID_RE.test(recordId)) throw new NotifyError('bad_record_id', 400)
    const { data, error } = await admin.from('approval_requests').select(APPROVAL_COLUMNS).eq('id', recordId).maybeSingle()
    if (error) { console.error('notify-email: approval load failed', error.code); throw new NotifyError('load_failed', 500) }
    if (!data) throw new NotifyError('record_not_found', 404)
    if (data.requester_id !== caller.id) throw new NotifyError('forbidden', 403)
    if (data.status !== 'PENDING') throw new NotifyError('not_pending', 409)
    assertFresh(data.created_at)
    return { row: data, requesterEmail: caller.email, lookups: await loadLookups(admin, data) }
  },
  build(d) {
    return buildRequestEmail(d.row, { appUrl: APP_URL, requesterEmail: d.requesterEmail, lookups: d.lookups })
  },
}

// Decided_at is written by the deciding admin's browser clock, so allow a little skew forward.
const DECISION_FRESHNESS_MS = 10 * 60 * 1000
const DECISION_FUTURE_SKEW_MS = 2 * 60 * 1000

function assertDecisionFresh(decidedAt: string | null | undefined, createdAt: string | null | undefined) {
  const ts = decidedAt ? Date.parse(decidedAt) : NaN
  const created = createdAt ? Date.parse(createdAt) : NaN
  const now = Date.now()
  if (!Number.isFinite(ts) || now - ts > DECISION_FRESHNESS_MS || ts - now > DECISION_FUTURE_SKEW_MS) throw new NotifyError('stale_record', 409)
  if (Number.isFinite(created) && ts < created) throw new NotifyError('stale_record', 409)
}

// The message reflects the status at load time; a later reversal is not emailed (the claim is burned).
const approvalDecision: Handler<any> = {
  async load({ admin, caller, recordId }) {
    if (!UUID_RE.test(recordId)) throw new NotifyError('bad_record_id', 400)
    if (caller.role !== 'admin') throw new NotifyError('forbidden', 403)
    const { data, error } = await admin.from('approval_requests').select(APPROVAL_COLUMNS).eq('id', recordId).maybeSingle()
    if (error) { console.error('notify-email: approval load failed', error.code); throw new NotifyError('load_failed', 500) }
    if (!data) throw new NotifyError('record_not_found', 404)
    if (data.status !== 'APPROVED' && data.status !== 'REJECTED') throw new NotifyError('not_decided', 409)
    if (data.decision_maker_id !== caller.id) throw new NotifyError('forbidden', 403)
    assertDecisionFresh(data.decided_at, data.created_at)

    const requesterEmail = data.requester_id === caller.id ? caller.email : await requesterAuthEmail(admin, data.requester_id)
    if (!requesterEmail) console.warn('notify-email: requester has no usable email, skipping their copy')
    return {
      row: data,
      requesterEmail,
      deciderEmail: caller.email,
      // Deciding your own request: they already know the outcome.
      notifyRequester: !!requesterEmail && data.requester_id !== caller.id,
      lookups: await loadLookups(admin, data),
    }
  },
  build(d) {
    return buildDecisionEmail(d.row, { appUrl: APP_URL, requesterEmail: d.requesterEmail, deciderEmail: d.deciderEmail, lookups: d.lookups }, 'admin')
  },
  direct(d) {
    if (!d.notifyRequester) return []
    return [{
      email: d.requesterEmail,
      message: buildDecisionEmail(d.row, { appUrl: APP_URL, requesterEmail: d.requesterEmail, deciderEmail: d.deciderEmail, lookups: d.lookups }, 'requester'),
    }]
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
      id:         data.id,
      raisedBy:   caller.email,
      roomNo:     data.rooms?.room_no ?? null,
      concern:    data.concern,
      remarks:    data.remarks,
      tenantName: data.tenants?.name ?? null,
      raisedAt:   data.raised_at ?? data.created_at,
    }
  },
  build(d) {
    return buildTicketEmail(d, { appUrl: APP_URL })
  },
}

export const EVENT_HANDLERS: Record<NotificationTypeId, Handler<any>> = {
  approval_request:   approvalRequest,
  approval_decision:  approvalDecision,
  maintenance_ticket: maintenanceTicket,
}

for (const t of NOTIFICATION_TYPES) {
  if (!EVENT_HANDLERS[t.id]) throw new Error(`notify-email: no handler registered for type "${t.id}"`)
}
