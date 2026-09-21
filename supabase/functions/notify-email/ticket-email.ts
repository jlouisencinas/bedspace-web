// Pure maintenance-ticket email builder: no Deno globals, and no import of events.ts / email.ts /
// index.ts, so scripts/preview-approval-email.mjs can render it in Node. Erasable TypeScript only.
import {
  button, cleanSubject, clip, fmtManila, footerLine, heading, indented, intro, kvCard, line, noteBlock,
  pillRow, shell, stack, flat, type KV,
} from './email-kit.ts'

export type TicketData = {
  id: string | number
  raisedBy?: string | null
  roomNo?: unknown
  tenantName?: unknown
  concern?: unknown
  remarks?: unknown
  raisedAt?: string | null
}

export type TicketCtx = { appUrl: string; sample?: boolean }
export type TicketBuilt = { subject: string; html: string; text: string }

const has = (v: unknown) => v !== null && v !== undefined && String(v).trim() !== ''

const SAMPLE_NOTE = 'This is a sample email with fictitious data. No real ticket exists.'
const FOOTER = 'You receive this because your address is subscribed to “Maintenance tickets”. Admins can change this in Notification Settings.'
const NO_REMARKS = 'No remarks provided'

const refOf = (id: string | number) => `MT-${String(id).replace(/\D/g, '').slice(0, 10)}`

export function buildTicketEmail(t: TicketData, ctx: TicketCtx): TicketBuilt {
  const raisedBy = line(t.raisedBy || 'Unknown user', 120)
  const room = has(t.roomNo) ? line(t.roomNo, 20) : ''
  const concern = has(t.concern) ? line(t.concern, 200) : '—'
  const tenant = has(t.tenantName) ? line(t.tenantName, 80) : 'Staff-raised'
  const remarks = has(t.remarks) ? clip(String(t.remarks).trim(), 1000) : NO_REMARKS
  const raised = fmtManila(t.raisedAt)
  const ref = refOf(t.id)
  const url = ctx.appUrl ? `${ctx.appUrl}/maintenance` : ''

  const title = `New maintenance ticket: ${line(concern, 80)}`
  const introText = `${raisedBy} raised a ticket${room ? ` for Room ${room}` : ''}.`
  const summary: KV[] = [
    { label: 'Room', value: room || '—' },
    { label: 'Tenant', value: tenant },
    { label: 'Concern', value: concern },
    { label: 'Raised by', value: raisedBy },
    { label: 'Raised', value: raised },
  ]

  const body = stack([
    ctx.sample && noteBlock('Sample', SAMPLE_NOTE, 'neutral'),
    pillRow('PENDING', ref, '● PENDING'),
    { html: heading(title), gap: 12 },
    { html: intro(introText), gap: 8 },
    { html: kvCard(summary), gap: 20 },
    noteBlock('Remarks', remarks, 'neutral'),
    url && { html: button(url, 'View ticket'), gap: 24, align: 'center' },
  ])

  const html = shell({
    title,
    preheader: `${ctx.sample ? 'Sample: ' : ''}${room ? `Room ${room} · ` : ''}${line(concern, 80)} — raised by ${raisedBy}`,
    headerLabel: 'Maintenance',
    bodyHtml: body,
    footerHtml: footerLine(FOOTER),
  })

  const text = [
    title,
    introText,
    '',
    ...(ctx.sample ? [`Sample: ${SAMPLE_NOTE}`, ''] : []),
    'TICKET',
    `Reference: ${ref}`,
    'Status: PENDING',
    ...summary.map(r => `${flat(r.label)}: ${flat(r.value)}`),
    '',
    'REMARKS',
    indented(remarks),
    '',
    url ? `View ticket: ${url}` : 'Open Bedspace Manager → Maintenance to view this ticket.',
    '',
    '--',
    FOOTER,
  ].join('\n')

  const lead = [room && `Room ${line(room, 35)}`, line(concern, 40)].filter(Boolean).join(' · ')
  return { subject: cleanSubject(`${ctx.sample ? '[SAMPLE] ' : ''}[New ticket] ${lead}`), html, text }
}
