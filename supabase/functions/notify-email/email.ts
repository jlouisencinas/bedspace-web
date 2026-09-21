// The pure helpers live in email-kit.ts (no Deno globals) so Node can import them; re-exported so
// existing imports of this module keep working.
import { esc, clip, cleanSubject } from './email-kit.ts'
export { esc, clip, cleanSubject }

export const APPS_SCRIPT_URL    = Deno.env.get('APPS_SCRIPT_URL')
export const APPS_SCRIPT_SECRET = Deno.env.get('APPS_SCRIPT_SECRET')

const RAW_APP_URL = (Deno.env.get('APP_URL') ?? '').trim().replace(/\/+$/, '')
export const APP_URL = /^(https:\/\/|http:\/\/localhost(:\d+)?(\/|$))/.test(RAW_APP_URL) ? RAW_APP_URL : ''

export const isConfigured = () => !!(APPS_SCRIPT_URL && APPS_SCRIPT_SECRET)

export type Message = { subject: string; html: string; text: string }

export type SendResult = { ok: boolean; error?: string; quotaRemaining?: number }

export async function sendViaAppsScript(recipients: string[], msg: Message): Promise<SendResult> {
  let res: Response
  let raw: string
  try {
    // redirect:'follow' is intentional: Apps Script runs doPost on the /exec POST, then answers
    // 302 to a googleusercontent echo URL that must be fetched as GET. Never re-POST or retry.
    res = await fetch(APPS_SCRIPT_URL!, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ secret: APPS_SCRIPT_SECRET, recipients, subject: msg.subject, html: msg.html, text: msg.text }),
      redirect: 'follow',
      signal: AbortSignal.timeout(25_000),
    })
    raw = await res.text()
  } catch (e) {
    const name = (e as Error)?.name
    return { ok: false, error: name === 'TimeoutError' || name === 'AbortError' ? 'timeout' : 'unreachable' }
  }

  let parsed: any
  try { parsed = JSON.parse(raw) } catch {
    console.error('notify-email: mailer returned non-JSON', {
      status: res.status,
      body: raw.slice(0, 200),
      hint: 'Web app access must be "Anyone", the URL must end in /exec, and a New version must be deployed.',
    })
    return { ok: false, error: 'non_json_response' }
  }
  if (!parsed || typeof parsed !== 'object') return { ok: false, error: 'non_json_response' }
  if (parsed.ok === true) return { ok: true, quotaRemaining: typeof parsed.quotaRemaining === 'number' ? parsed.quotaRemaining : undefined }
  return {
    ok: false,
    error: typeof parsed.error === 'string' ? parsed.error : 'send_failed',
    quotaRemaining: typeof parsed.quotaRemaining === 'number' ? parsed.quotaRemaining : undefined,
  }
}

// Must not exceed MAX_RECIPIENTS in apps-script/bedspace-mailer.gs.
const CHUNK_SIZE = 20

export type ChunkedResult = SendResult & { sent: number }

// One message per chunk, stopping at the first failure. `sent` counts recipients in chunks that
// were accepted before the failure, so the caller can record an accurate partial delivery.
export async function sendInChunks(recipients: string[], msg: Message): Promise<ChunkedResult> {
  let sent = 0
  let quotaRemaining: number | undefined
  for (let i = 0; i < recipients.length; i += CHUNK_SIZE) {
    const chunk = recipients.slice(i, i + CHUNK_SIZE)
    const r = await sendViaAppsScript(chunk, msg)
    if (r.quotaRemaining !== undefined) quotaRemaining = r.quotaRemaining
    if (!r.ok) return { ok: false, error: r.error, quotaRemaining, sent }
    sent += chunk.length
  }
  return { ok: true, quotaRemaining, sent }
}
