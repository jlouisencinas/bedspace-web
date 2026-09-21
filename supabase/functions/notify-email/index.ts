import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.43.5'
import { NOTIFICATION_TYPES } from '../_shared/notification-types.ts'
import { EVENT_HANDLERS, NotifyError, type Caller } from './events.ts'
import { cleanSubject, esc, isConfigured, sendInChunks, type Message } from './email.ts'

const SUPABASE_URL     = Deno.env.get('SUPABASE_URL')!
const SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
}
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...CORS, 'Content-Type': 'application/json' } })

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS })
  if (req.method !== 'POST') return json({ ok: false, error: 'method' }, 405)

  let body: any
  try { body = await req.json() } catch { return json({ ok: false, error: 'bad_json' }, 400) }

  try {
    const admin  = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, { auth: { persistSession: false } })
    const caller = await authenticate(admin, req)
    if (body?.action === 'test')  return await handleTest(admin, caller, body)
    if (body?.action === 'event') return await handleEvent(admin, caller, body)
    return json({ ok: false, error: 'invalid_action' }, 400)
  } catch (e) {
    if (e instanceof NotifyError) return json({ ok: false, error: e.code }, e.status)
    console.error('notify-email: unhandled', e)
    return json({ ok: false, error: 'unhandled' }, 500)
  }
})

async function authenticate(admin: any, req: Request): Promise<Caller> {
  const token = (req.headers.get('Authorization') ?? '').replace(/^Bearer\s+/i, '').trim()
  if (!token) throw new NotifyError('unauthenticated', 401)
  const { data, error } = await admin.auth.getUser(token)
  if (error || !data?.user) throw new NotifyError('unauthenticated', 401)
  const { data: profile } = await admin.from('profiles').select('role').eq('id', data.user.id).maybeSingle()
  return { id: data.user.id, email: data.user.email ?? '', role: profile?.role ?? null }
}

async function handleEvent(admin: any, caller: Caller, body: any) {
  const type = body.type
  if (typeof type !== 'string' || !NOTIFICATION_TYPES.some(t => t.id === type)) throw new NotifyError('invalid_type', 400)
  const recordId = body.recordId
  if (typeof recordId !== 'string' || !recordId || recordId.length > 64) throw new NotifyError('bad_record_id', 400)

  // Before the claim so an unconfigured deployment doesn't burn the once-only guard.
  if (!isConfigured()) {
    console.warn('notify-email: APPS_SCRIPT_URL/SECRET unset, skipping')
    return json({ ok: true, sent: 0, skipped: 'not_configured' })
  }

  const handler = EVENT_HANDLERS[type as keyof typeof EVENT_HANDLERS]
  const data = await handler.load({ admin, caller, recordId })

  const { data: claim, error: claimErr } = await admin
    .from('notification_log')
    .insert({ event_type: type, record_key: recordId })
    .select('id')
    .single()
  if (claimErr) {
    if (claimErr.code === '23505') return json({ ok: true, sent: 0, skipped: 'already_notified' })
    console.error('notify-email: claim failed', claimErr.code)
    throw new NotifyError('claim_failed', 500)
  }

  const setLog = async (patch: Record<string, unknown>) => {
    const { error } = await admin.from('notification_log').update(patch).eq('id', claim.id)
    if (error) console.error('notify-email: log update failed', error.code)
  }

  const { data: subs, error: subErr } = await admin
    .from('notification_subscriptions')
    .select('notification_recipients(email)')
    .eq('event_type', type)
  if (subErr) {
    console.error('notify-email: subscriptions query failed', subErr.code)
    await setLog({ status: 'failed', error: 'query_failed' })
    return json({ ok: false, error: 'query_failed' })
  }
  const recipients = dedupe((subs ?? []).flatMap((s: any) => {
    const r = s.notification_recipients
    return (Array.isArray(r) ? r : [r]).map((x: any) => x?.email)
  }))
  if (!recipients.length) {
    await setLog({ status: 'sent', recipient_count: 0 })
    return json({ ok: true, sent: 0 })
  }

  let msg: Message
  try {
    const built = handler.build(data)
    msg = { ...built, subject: cleanSubject(built.subject) }
  } catch (e) {
    console.error('notify-email: build failed', { type }, e)
    await setLog({ status: 'failed', error: 'build_failed' })
    return json({ ok: false, error: 'build_failed' })
  }

  const result = await sendInChunks(recipients, msg)
  if (!result.ok) {
    console.error('notify-email: send failed', { type, code: result.error, sent: result.sent, of: recipients.length })
    await setLog({ status: 'failed', recipient_count: result.sent, error: result.error })
    return json({ ok: false, error: result.error })
  }
  await setLog({ status: 'sent', recipient_count: recipients.length })
  warnLowQuota(result.quotaRemaining)
  return json({ ok: true, sent: recipients.length })
}

async function handleTest(admin: any, caller: Caller, body: any) {
  if (caller.role !== 'admin') throw new NotifyError('forbidden', 403)
  if (!isConfigured()) return json({ ok: false, error: 'not_configured' })

  let q = admin.from('notification_recipients').select('email')
  if (body.recipientId !== undefined && body.recipientId !== null) {
    if (!Number.isInteger(body.recipientId) || body.recipientId <= 0) throw new NotifyError('recipient_not_found', 404)
    q = q.eq('id', body.recipientId)
  }
  const { data, error } = await q
  if (error) { console.error('notify-email: test recipients query failed', error.code); return json({ ok: false, error: 'query_failed' }) }
  const recipients = dedupe((data ?? []).map((r: any) => r.email))
  if (!recipients.length) {
    return json({ ok: false, error: body.recipientId ? 'recipient_not_found' : 'no_recipients' })
  }

  const when = new Date().toISOString()
  const labels = NOTIFICATION_TYPES.map(t => t.label)
  const html = `<p>This is a <strong>test</strong> message from Bedspace Manager. If you can read it, email delivery is working.</p>
    <ul>
      <li>Triggered by: ${esc(caller.email)}</li>
      <li>Sent at: ${esc(when)}</li>
      <li>Recipients in this test: ${recipients.length}</li>
      <li>Notification types: ${esc(labels.join(', '))}</li>
    </ul>`
  const text = [
    'This is a TEST message from Bedspace Manager. If you can read it, email delivery is working.',
    `- Triggered by: ${caller.email}`,
    `- Sent at: ${when}`,
    `- Recipients in this test: ${recipients.length}`,
    `- Notification types: ${labels.join(', ')}`,
  ].join('\n')

  const result = await sendInChunks(recipients, { subject: '[TEST] Bedspace Manager notification setup', html, text })
  if (!result.ok) {
    console.error('notify-email: test send failed', { code: result.error, sent: result.sent, of: recipients.length })
    return json({ ok: false, error: result.error })
  }
  warnLowQuota(result.quotaRemaining)
  return json({ ok: true, sent: recipients.length, quotaRemaining: result.quotaRemaining })
}

function dedupe(emails: unknown[]): string[] {
  const out = new Set<string>()
  for (const e of emails) if (typeof e === 'string' && e.trim()) out.add(e.trim().toLowerCase())
  return [...out]
}

function warnLowQuota(remaining: number | undefined) {
  if (typeof remaining === 'number' && remaining < 20) console.warn('notify-email: Apps Script daily quota low', { remaining })
}
