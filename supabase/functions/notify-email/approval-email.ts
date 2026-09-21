// Pure approval-email builders: no Deno globals, and no import of events.ts / email.ts / index.ts,
// so scripts/preview-approval-email.mjs can render them in Node. Erasable TypeScript only.
import {
  TONES, button, changesTable, cleanSubject, clip, decisionBlock, flat, fmtDateOnly, fmtManila, footerLine,
  heading, indented, intro, kvCard, line, noteBlock, pillLabel, pillRow, section, shell, stack, timeline,
  type ChangeRow, type KV, type Status,
} from './email-kit.ts'
import {
  ENTITY_LABELS, EMAIL_FIELDS, FIELD_LABELS, PHONE_FIELDS, PROFILE_FIELD_LABELS, ROOM_CONFIG_LABELS,
} from '../_shared/approval-labels.ts'

export type ApprovalRow = {
  id: string
  entity_type: string
  entity_id: string | number
  field_name: string
  old_value?: unknown
  new_value?: unknown
  reason?: string | null
  status?: string
  decision_notes?: string | null
  decided_at?: string | null
  created_at?: string | null
}

export type Lookups = { destBed?: { room_no: unknown; bed_letter: unknown } | null }

export type Ctx = {
  appUrl: string
  requesterEmail?: string | null
  deciderEmail?: string | null
  lookups?: Lookups
  sample?: boolean
}

export type Built = { subject: string; html: string; text: string }
export type Audience = 'admin' | 'requester'

type Limits = { rows: number; val: number; reason: number; list: number }
const NORMAL: Limits  = { rows: 25, val: 200, reason: 1000, list: 12 }
const COMPACT: Limits = { rows: 10, val: 120, reason: 500,  list: 6 }

export const HTML_MAX = 45000
export const TEXT_MAX = 8000

const isObj = (v: unknown): v is Record<string, any> => !!v && typeof v === 'object' && !Array.isArray(v)
// Null-prototype copy: a client-controlled key such as "constructor" must not read Object.prototype members.
const asObj = (v: unknown): Record<string, any> => Object.assign(Object.create(null), isObj(v) ? v : {})
const has = (v: unknown) => v !== null && v !== undefined && v !== ''

function show(v: unknown, max: number): string {
  if (!has(v)) return '—'
  if (typeof v === 'boolean') return v ? 'Yes' : 'No'
  if (typeof v === 'object') return line(JSON.stringify(v), max)
  return line(v, max)
}

// Exact for whole/two-decimal amounts; anything with finer precision is shown unrounded.
function peso(v: unknown): string {
  const n = Number(v)
  if (!has(v) || typeof v === 'boolean' || !Number.isFinite(n)) return show(v, 40)
  const exact2 = Math.abs(n * 100 - Math.round(n * 100)) < 1e-6
  const opts = exact2
    ? { minimumFractionDigits: Number.isInteger(n) ? 0 : 2, maximumFractionDigits: 2 }
    : { maximumFractionDigits: 8 }
  return `₱${n.toLocaleString('en-PH', opts)}`
}

export function maskPhone(v: unknown): string {
  const digits = String(v ?? '').replace(/\D/g, '')
  return digits.length < 4 ? '••••' : `•••• ••• ${digits.slice(-4)}`
}

export function maskEmail(v: unknown): string {
  const s = String(v ?? '')
  const at = s.lastIndexOf('@')
  if (at < 1) return '•••'
  return `${String.fromCodePoint(s.codePointAt(0)!)}•••${s.slice(at)}`
}

type Mask = (v: unknown) => string

// Masked output is still user-controlled (an email domain can be huge), so it is bounded like any other value.
const masked = (mask: Mask, v: unknown, max: number) => line(mask(v), max)

// Own keys only: a client-controlled key such as "constructor" must not resolve to Object.prototype members.
const labelFor = (map: Record<string, string>, key: string, fallback = 40) =>
  Object.hasOwn(map, key) ? map[key] : line(key, fallback)
const maskFor = (key: string): Mask | null =>
  (PHONE_FIELDS as readonly string[]).includes(key) ? maskPhone
  : (EMAIL_FIELDS as readonly string[]).includes(key) ? maskEmail
  : null

// A masked value can hide a real change; say so instead of showing two identical cells.
function maskedPair(cur: unknown, req: unknown, mask: Mask | null, max: number): [string, string] {
  if (!mask) return [show(cur, max), show(req, max)]
  const c = has(cur) ? masked(mask, cur, max) : '—'
  const r = has(req) ? masked(mask, req, max) : '—'
  return [c, c === r && String(cur ?? '') !== String(req ?? '') ? `${r} (changed)` : r]
}

function entryLines(list: unknown, mask: Mask, lim: Limits): string[] {
  if (!Array.isArray(list)) return [show(list, lim.val)]
  if (!list.length) return ['None']
  const lines = list.slice(0, lim.list).map(e => {
    const o = asObj(e)
    return `${masked(mask, o.value, lim.val)}${has(o.label) ? ` ${line(o.label, 30)}` : ''}${o.isPrimary ? ' (Primary)' : ''}`
  })
  if (list.length > lim.list) lines.push(`+${list.length - lim.list} more`)
  return lines
}

function entryListRow(labelText: string, before: unknown, after: unknown, mask: Mask, lim: Limits): ChangeRow {
  const b = entryLines(before, mask, lim)
  const a = entryLines(after, mask, lim)
  if (b.join('\n') === a.join('\n')) a.push('(changed)')
  return { label: labelText, current: b.join('\n'), requested: a.join('\n') }
}

const dateOnly = (v: unknown) => line(fmtDateOnly(v), 40)
const dateOrNotSet = (v: unknown) => (has(v) ? dateOnly(v) : 'Not set')
const roomBed = (room: unknown, bed: unknown) =>
  [has(room) && `Room ${line(room, 20)}`, has(bed) && `Bed ${line(bed, 10)}`].filter(Boolean).join(' · ')

const publicKeys = (o: Record<string, any>) => Object.keys(o).filter(k => !k.startsWith('_'))

type ProfileParts = { fieldKeys: string[]; moveOut: boolean; contacts: boolean; emails: boolean }
function profileParts(nv: Record<string, any>): ProfileParts {
  return {
    fieldKeys: publicKeys(asObj(nv.fields)),
    moveOut:   'move_out_date' in nv,
    contacts:  has(nv.contacts),
    emails:    has(nv.emails),
  }
}

export function topicFor(row: ApprovalRow): string {
  const nv = asObj(row.new_value)
  if (row.field_name === 'tenant_profile') {
    const p = profileParts(nv)
    const total = p.fieldKeys.length + (p.moveOut ? 1 : 0) + (p.contacts ? 1 : 0) + (p.emails ? 1 : 0)
    if (total === 1) {
      if (p.contacts) return 'Contact numbers change'
      if (p.emails) return 'Email addresses change'
      if (p.moveOut) return 'Planned Move-out Date change'
      return `${labelFor(PROFILE_FIELD_LABELS, p.fieldKeys[0])} change`
    }
    return total ? `Profile update (${total} changes)` : 'Profile update'
  }
  return labelFor(FIELD_LABELS, row.field_name)
}

export type Description = {
  rows: ChangeRow[]
  topic: string
  action: string
  tenant: KV
  roomBed: KV
}

export function describeRequest(row: ApprovalRow, lookups: Lookups = {}, lim: Limits = NORMAL): Description {
  const ov = asObj(row.old_value)
  const nv = asObj(row.new_value)
  const f = row.field_name
  const out: ChangeRow[] = []
  const add = (label: string, current: string, requested: string) => out.push({ label, current, requested })
  const sv = (v: unknown) => show(v, lim.val)

  if (f === 'tenant_profile') {
    const ofields = asObj(ov.fields)
    const nfields = asObj(nv.fields)
    for (const k of publicKeys(nfields)) {
      const [c, r] = maskedPair(ofields[k], nfields[k], maskFor(k), lim.val)
      add(labelFor(PROFILE_FIELD_LABELS, k), c, r)
    }
    if ('move_out_date' in nv) add('Planned Move-out Date', dateOrNotSet(ov.move_out_date), dateOrNotSet(nv.move_out_date))
    if (has(nv.contacts)) out.push(entryListRow('Contact Numbers', ov.contacts, nv.contacts, maskPhone, lim))
    if (has(nv.emails))   out.push(entryListRow('Email Addresses', ov.emails, nv.emails, maskEmail, lim))
  } else if (f === 'move_out') {
    add('Tenant status', 'Active', 'Moved out')
    add('Planned move-out', dateOrNotSet(ov.move_out_date), dateOrNotSet(nv.move_out_date))
    if (has(nv.actual_move_out_date)) add('Actual move-out date', '—', dateOnly(nv.actual_move_out_date))
    if (has(nv.amount_paid)) add('Amount paid', '—', peso(nv.amount_paid))
  } else if (f === 'transfer') {
    const cur = roomBed(ov.room_no ?? nv._room_no, ov.bed_letter ?? nv._bed_letter)
    const dest = lookups.destBed
      ? roomBed(lookups.destBed.room_no, lookups.destBed.bed_letter)
      : has(nv.to_bed_id) ? `Bed #${line(nv.to_bed_id, 20)}` : '—'
    add('Bed', cur || 'Current bed', dest)
    if (has(ov.rate) || has(nv.new_rate)) add('Rate', has(ov.rate) ? `${peso(ov.rate)}/mo` : '—', has(nv.new_rate) ? `${peso(nv.new_rate)}/mo` : '—')
    if (has(nv.transfer_date))     add('Transfer date', '—', dateOnly(nv.transfer_date))
    if (has(nv.water_reading))     add('Water reading', '—', sv(nv.water_reading))
    if (has(nv.electric_reading))  add('Electric reading', '—', sv(nv.electric_reading))
    if (has(nv.notes))             add('Notes', '—', sv(nv.notes))
  } else if (f === 'room_config') {
    for (const k of publicKeys(nv)) add(labelFor(ROOM_CONFIG_LABELS, k), sv(ov[k]), sv(nv[k]))
  } else if (f === 'bed_rate') {
    add('Default rate', has(ov.default_rate) ? peso(ov.default_rate) : '—', has(nv.default_rate) ? peso(nv.default_rate) : '—')
  } else if (f === 'remove_bed') {
    add('Bed status', sv(ov.status), sv(nv.status ?? 'REMOVED'))
  } else if (f === 'interim_reading_delete') {
    const room = nv._room_no ?? ov.room_no
    const util = nv.utility ?? ov.utility
    const date = nv.reading_date ?? ov.reading_date
    const val  = nv.reading_value ?? ov.reading_value
    const detail = [
      'Exists',
      [has(room) && `Room ${line(room, 20)}`, has(util) && line(util, 40)].filter(Boolean).join(' · '),
      has(date) && `Date: ${dateOnly(date)}`,
      has(val) && `Reading: ${line(val, 40)}`,
    ].filter(Boolean).join('\n')
    add('Meter reading', detail, 'Delete')
  } else if (f === 'tenant_details') {
    if (nv.move_out_date !== undefined) add('Move-out date', dateOrNotSet(ov.move_out_date), dateOrNotSet(nv.move_out_date))
    if (nv.contact_no !== undefined) { const [c, r] = maskedPair(ov.contact_no, nv.contact_no, maskPhone, lim.val); add('Contact number', c, r) }
    if (nv.email !== undefined)      { const [c, r] = maskedPair(ov.email, nv.email, maskEmail, lim.val); add('Email address', c, r) }
  } else if (f === 'move_out_date') {
    add('Move-out date', dateOrNotSet(ov.move_out_date), dateOrNotSet(nv.move_out_date))
  } else if (f === 'add_addon') {
    const parts = [has(nv.label) && `"${line(nv.label, 60)}"`, has(nv.amount) && peso(nv.amount), nv.recurring ? 'Recurring' : 'One-time']
    add('Add-on', '—', parts.filter(Boolean).join(' · '))
  } else if (f === 'delete_addon') {
    add('Add-on', has(nv._addon_id) ? `#${line(nv._addon_id, 20)}` : '—', 'Delete')
  }

  if (!out.length) {
    const ovv = ov[f]
    const nvv = has(nv[f]) ? nv[f] : Object.fromEntries(publicKeys(nv).map(k => [k, nv[k]]))
    add(labelFor(FIELD_LABELS, f), sv(ovv), sv(isObj(nvv) && !Object.keys(nvv).length ? null : nvv))
  }

  let rows = out
  if (out.length > lim.rows) {
    rows = out.slice(0, lim.rows)
    rows.push({ label: `+${out.length - lim.rows} more`, current: 'Open Bedspace Manager to see all changes.', requested: '—' })
  }

  const name = nv._tenant_name
  return {
    rows,
    topic: topicFor(row),
    action: labelFor(FIELD_LABELS, f, 60),
    tenant: has(name)
      ? { label: 'Tenant', value: line(name, 80) }
      : { label: 'Target', value: line(`${labelFor(ENTITY_LABELS, String(row.entity_type), 20)} #${row.entity_id}`, 80) },
    roomBed: { label: 'Room / bed', value: roomBed(nv._room_no, nv._bed_letter) || '—' },
  }
}

const refOf = (id: string) => `AR-${String(id).replace(/[^0-9a-f]/gi, '').slice(0, 8).toLowerCase()}`

function subjectFor(tag: string, row: ApprovalRow, topic: string, sample?: boolean) {
  const nv = asObj(row.new_value)
  const lead = has(nv._room_no) ? `Room ${line(nv._room_no, 35)}`
    : has(nv._tenant_name) ? line(nv._tenant_name, 40)
    : labelFor(ENTITY_LABELS, String(row.entity_type))
  return cleanSubject(`${sample ? '[SAMPLE] ' : ''}[${tag}] ${lead} · ${line(topic, 40)}`)
}

type TextArgs = {
  title: string
  intro: string
  sampleNote?: string
  ref: string
  status: string
  summary: KV[]
  changesTitle: string
  headers: [string, string, string]
  rows: ChangeRow[]
  reason: string
  decision?: { rows: KV[]; closing: string }
  cta: { label: string; url: string } | null
  ctaFallback: string
  footer: string
}

function renderText(a: TextArgs): string {
  const lines: string[] = [a.title, a.intro, '']
  if (a.sampleNote) lines.push(a.sampleNote, '')
  lines.push('REQUEST', `Reference: ${a.ref}`, `Status: ${a.status}`, ...a.summary.map(r => `${flat(r.label)}: ${flat(r.value)}`), '')
  lines.push(a.changesTitle)
  for (const r of a.rows) lines.push(flat(r.label),`  ${a.headers[1]}: ${flat(r.current)}`, `  ${a.headers[2]}: ${flat(r.requested)}`)
  lines.push('')
  if (a.reason) lines.push('REASON GIVEN BY REQUESTER', indented(a.reason), '')
  if (a.decision) {
    lines.push('DECISION', ...a.decision.rows.map(r => `${r.label}: ${flat(r.value)}`), a.decision.closing, '')
  }
  lines.push(a.cta ? `${a.cta.label}: ${a.cta.url}` : a.ctaFallback, '', '--', a.footer)
  return lines.join('\n')
}

const SAMPLE_NOTE = 'Sample: this is a sample email with fictitious data. No real request exists.'

type Rendered = { html: string; text: string }

function renderRequest(row: ApprovalRow, ctx: Ctx, lim: Limits): Rendered & { topic: string } {
  const d = describeRequest(row, ctx.lookups, lim)
  const requester = line(ctx.requesterEmail || 'Unknown user', 120)
  const ref = refOf(row.id)
  const title = `Approval needed: ${d.topic}`
  const submitted = fmtManila(row.created_at)
  const introText = `${requester} submitted a change that needs your review.`
  const summary: KV[] = [d.tenant, d.roomBed, { label: 'Action', value: d.action }, { label: 'Requested by', value: requester }, { label: 'Submitted', value: submitted }]
  const reason = has(row.reason) ? clip(row.reason, lim.reason) : ''
  const url = ctx.appUrl ? `${ctx.appUrl}/approvals` : ''
  const footer = 'You receive this because your address is subscribed to “Approval requests”. Admins can change this in Notification Settings.'
  const sampleNote = ctx.sample ? SAMPLE_NOTE : ''

  const body = stack([
    sampleNote && noteBlock('Sample', 'This is a sample email with fictitious data. No real request exists.', 'neutral'),
    pillRow('PENDING', ref),
    { html: heading(title), gap: 12 },
    { html: intro(introText), gap: 8 },
    { html: kvCard(summary), gap: 20 },
    { html: section('Changes requested', changesTable(d.rows, { headers: ['Field', 'Current', 'Requested'], requestedBg: '#FEF8ED', requestedColor: '#292420' })), gap: 20 },
    reason && noteBlock('Reason given by requester', reason, 'warning'),
    url && { html: button(url, 'Review request'), gap: 24, align: 'center' },
  ])

  const html = shell({
    title,
    preheader: `${ctx.sample ? 'Sample: ' : ''}${requester} requests: ${d.topic}${d.tenant.label === 'Tenant' ? ` for ${d.tenant.value}` : ''}`,
    headerLabel: 'Approvals',
    bodyHtml: body,
    footerHtml: footerLine(footer),
  })
  const text = renderText({
    title, intro: introText, sampleNote, ref, status: pillLabel('PENDING').replace(/^\S+\s/, ''),
    summary, changesTitle: 'CHANGES', headers: ['Field', 'Current', 'Requested'], rows: d.rows, reason,
    cta: url ? { label: 'Review request', url } : null,
    ctaFallback: 'Open Bedspace Manager → Approvals to review this request.',
    footer,
  })
  return { html, text, topic: d.topic }
}

function renderDecision(row: ApprovalRow, ctx: Ctx, audience: Audience, lim: Limits): Rendered & { topic: string } {
  const approved = row.status === 'APPROVED'
  const status: Status = approved ? 'APPROVED' : 'REJECTED'
  const verb = approved ? 'Approved' : 'Rejected'
  const tone = approved ? 'success' : 'danger'
  const d = describeRequest(row, ctx.lookups, lim)
  const requester = line(ctx.requesterEmail || 'Unknown user', 120)
  const decider = line(ctx.deciderEmail || 'an admin', 120)
  const ref = refOf(row.id)
  const title = `${verb}: ${d.topic}`
  const submitted = fmtManila(row.created_at)
  const decidedAt = fmtManila(row.decided_at)
  const introText = audience === 'requester'
    ? `Your request was ${verb.toLowerCase()}.`
    : `${decider} ${verb.toLowerCase()} a request from ${requester}.`
  const summary: KV[] = [d.tenant, d.roomBed, { label: 'Action', value: d.action }]
  // The text part has no timeline, so it lists the same facts as plain lines.
  const textSummary: KV[] = [
    ...summary,
    { label: 'Requested by', value: audience === 'requester' ? 'you (you submitted this request)' : requester },
    { label: 'Submitted', value: submitted },
  ]
  const reason = has(row.reason) ? clip(row.reason, lim.reason) : ''
  const note = has(row.decision_notes) && String(row.decision_notes).trim() ? clip(String(row.decision_notes).trim(), lim.reason) : 'No note provided'
  const decision = {
    rows: [
      { label: 'Outcome', value: verb },
      { label: 'Decided by', value: decider },
      { label: 'Decided at', value: decidedAt },
      { label: 'Note from admin', value: note },
    ],
    closing: approved ? 'The change has been applied.' : 'No changes were made.',
  }
  const url = ctx.appUrl ? `${ctx.appUrl}${audience === 'admin' ? '/approvals' : '/'}` : ''
  const ctaLabel = audience === 'admin' ? 'View in Bedspace Manager' : 'Open Bedspace Manager'
  const footer = audience === 'admin'
    ? 'You receive this because your address is subscribed to “Approval decisions”. The staff member who raised the request receives their own copy. Admins can change this in Notification Settings.'
    : 'You receive this because you submitted this request.'
  const headers: [string, string, string] = approved ? ['Field', 'Before', 'Now'] : ['Field', 'Current', 'Requested']
  const sampleNote = ctx.sample ? SAMPLE_NOTE : ''

  const body = stack([
    sampleNote && noteBlock('Sample', 'This is a sample email with fictitious data. No real request exists.', 'neutral'),
    pillRow(status, ref),
    { html: heading(title), gap: 12 },
    { html: intro(introText), gap: 8 },
    { html: timeline({ submitted, decided: decidedAt, outcome: tone }), gap: 20 },
    kvCard(summary),
    { html: section('What was requested', changesTable(d.rows, approved
      ? { headers, requestedBg: TONES.success.bg, requestedColor: '#292420' }
      : { headers, requestedBg: TONES.danger.bg, requestedColor: '#292420', requestedWeight: '400' })), gap: 20 },
    reason && noteBlock('Reason given by requester', reason, 'warning'),
    decisionBlock({ tone, ...decision }),
    url && { html: button(url, ctaLabel), gap: 24, align: 'center' },
  ])

  const html = shell({
    title,
    preheader: audience === 'requester'
      ? `${ctx.sample ? 'Sample: ' : ''}Your request was ${verb.toLowerCase()}: ${d.topic}`
      : `${ctx.sample ? 'Sample: ' : ''}${verb} by ${decider}: ${d.topic}`,
    headerLabel: 'Approvals',
    bodyHtml: body,
    footerHtml: footerLine(footer),
  })
  const text = renderText({
    title, intro: introText, sampleNote, ref, status: verb.toUpperCase(),
    summary: textSummary, changesTitle: 'WHAT WAS REQUESTED', headers, rows: d.rows, reason, decision,
    cta: url ? { label: ctaLabel, url } : null,
    ctaFallback: audience === 'admin' ? 'Open Bedspace Manager → Approvals.' : 'Open Bedspace Manager.',
    footer,
  })
  return { html, text, topic: d.topic }
}

// Re-render once with fewer rows and shorter values if the message is near the mailer's limits.
function withSizeGuard(render: (lim: Limits) => Rendered & { topic: string }) {
  const first = render(NORMAL)
  if (first.html.length <= HTML_MAX && first.text.length <= TEXT_MAX) return first
  return render(COMPACT)
}

export function buildRequestEmail(row: ApprovalRow, ctx: Ctx): Built {
  const r = withSizeGuard(lim => renderRequest(row, ctx, lim))
  return { subject: subjectFor('Approval needed', row, r.topic, ctx.sample), html: r.html, text: r.text }
}

export function buildDecisionEmail(row: ApprovalRow, ctx: Ctx, audience: Audience): Built {
  const r = withSizeGuard(lim => renderDecision(row, ctx, audience, lim))
  return { subject: subjectFor(row.status === 'APPROVED' ? 'Approved' : 'Rejected', row, r.topic, ctx.sample), html: r.html, text: r.text }
}
