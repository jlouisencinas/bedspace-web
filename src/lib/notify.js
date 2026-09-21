import { supabase } from './supabase'

// Fire-and-forget — must never throw into the caller. A failure here must
// not block or surface as an error on the action that triggered it.
// The Edge Function loads the real row by id; nothing else is sent from here.
export function notifyAsync(type, recordId) {
  supabase.functions.invoke('notify-email', { body: { action: 'event', type, recordId: String(recordId) } })
    .then(({ error }) => { if (error) console.warn(`notify-email(${type}) failed:`, error.message) })
    .catch(err => console.warn(`notify-email(${type}) unreachable:`, err?.message))
}

// Admin UI. Resolves { ok, sent?, error?, quotaRemaining? } and never rejects.
// `sample` (with a recipientId) sends a fixed fictitious sample of an email type instead of the plain test.
export async function sendTestEmail(recipientId, sample) {
  try {
    const body = { action: 'test' }
    if (recipientId != null) body.recipientId = recipientId
    if (sample) body.sample = sample
    const { data, error } = await supabase.functions.invoke('notify-email', { body })
    if (error) {
      const parsed = await error.context?.json?.().catch(() => null)
      const fallback = error.context?.status === 401 ? 'unauthenticated' : 'unreachable'
      return { ok: false, error: typeof parsed?.error === 'string' ? parsed.error : fallback }
    }
    if (!data || typeof data !== 'object') return { ok: false, error: 'unreachable' }
    return data
  } catch {
    return { ok: false, error: 'unreachable' }
  }
}
