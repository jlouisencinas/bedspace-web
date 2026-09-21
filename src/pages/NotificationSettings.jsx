import { useEffect, useState, useCallback } from 'react'
import { supabase } from '../lib/supabase'
import { useAuth } from '../lib/auth'
import { useToast } from '../components/Toast'
import { sendTestEmail } from '../lib/notify'
import { NOTIFICATION_TYPES } from '../../supabase/functions/_shared/notification-types.ts'
import { Mail, Trash2, Send } from 'lucide-react'

const EMAIL_RE = /^[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}$/
const KNOWN_TYPES = new Set(NOTIFICATION_TYPES.map(t => t.id))

const TEST_ERRORS = {
  not_configured:    "Email delivery isn't configured (Supabase secrets missing).",
  unauthorized:      'The mailer rejected the shared secret; check that MAILER_SECRET and APPS_SCRIPT_SECRET match.',
  non_json_response: `The mailer didn't return JSON; check the web app is deployed with access "Anyone", the URL ends in /exec, and a New version was deployed.`,
  quota_exceeded:    'Daily Gmail send quota reached.',
  no_recipients:     'Add a recipient first.',
  timeout:           "Couldn't reach the mailer.",
  unreachable:       "Couldn't reach the mailer.",
  recipient_not_found: 'That recipient no longer exists — refresh the list.',
  invalid_sample:    'That sample type is not recognised.',
  recipient_required: 'Samples can only be sent to a single recipient; use the Send button on a row.',
  bad_request:       'The mailer rejected the message (e.g. too many recipients).',
  forbidden:         'Only admins can send test emails.',
  unauthenticated:   'Session expired — sign in again.',
  unhandled:         'Unexpected server error; see Edge Function logs.',
}
const EMAIL_KINDS = [
  { value: '',                           label: 'Plain test email' },
  { value: 'approval_request',           label: 'Sample: approval request' },
  { value: 'approval_decision_approved', label: 'Sample: approval approved' },
  { value: 'approval_decision_rejected', label: 'Sample: approval rejected' },
  { value: 'maintenance_ticket',         label: 'Sample: maintenance ticket' },
]

const testErrorMessage = code => TEST_ERRORS[code] ?? `Test failed (${code}); see Edge Function logs.`

export default function NotificationSettings() {
  const { isAdmin, user: me } = useAuth()
  const [recipients, setRecipients] = useState([])
  const [loading,    setLoading]    = useState(true)
  const [savingId,   setSavingId]   = useState(null)
  const [email,      setEmail]      = useState('')
  const [addErr,     setAddErr]     = useState('')
  const [adding,     setAdding]     = useState(false)
  const [testing,    setTesting]    = useState(null)
  const [kind,       setKind]       = useState('')
  const { show, ToastEl } = useToast()

  const load = useCallback(async () => {
    setLoading(true)
    const { data, error } = await supabase
      .from('notification_recipients')
      .select('*, notification_subscriptions(event_type)')
      .order('created_at')
    if (!error) {
      setRecipients(data.map(r => ({
        ...r,
        subs: new Set((r.notification_subscriptions ?? []).map(s => s.event_type).filter(t => KNOWN_TYPES.has(t))),
      })))
    }
    setLoading(false)
  }, [])

  useEffect(() => { load() }, [load])

  async function addRecipient(e) {
    e.preventDefault(); setAddErr('')
    const trimmed = email.trim()
    if (!EMAIL_RE.test(trimmed)) { setAddErr('Enter a valid email address.'); return }
    setAdding(true)
    const { data: created, error } = await supabase
      .from('notification_recipients')
      .insert({ email: trimmed, created_by: me?.id })
      .select('id')
      .single()
    if (error) {
      setAdding(false)
      if (error.code === '23505') setAddErr('This email is already on the list.')
      else setAddErr(error.message)
      return
    }
    const { error: subErr } = await supabase
      .from('notification_subscriptions')
      .insert(NOTIFICATION_TYPES.map(t => ({ recipient_id: created.id, event_type: t.id })))
    setAdding(false)
    setEmail('')
    load()
    if (subErr) show('Recipient added, but subscriptions failed. Tick them manually.', 'error', { duration: 6000 })
    else show('Recipient added.', 'success')
  }

  async function toggle(row, typeId, checked) {
    setSavingId(row.id)
    const setChecked = value => setRecipients(prev => prev.map(r => {
      if (r.id !== row.id) return r
      const subs = new Set(r.subs)
      if (value) subs.add(typeId); else subs.delete(typeId)
      return { ...r, subs }
    }))
    setChecked(checked)
    const { error } = checked
      ? await supabase.from('notification_subscriptions')
          .upsert({ recipient_id: row.id, event_type: typeId }, { onConflict: 'recipient_id,event_type', ignoreDuplicates: true })
      : await supabase.from('notification_subscriptions')
          .delete().eq('recipient_id', row.id).eq('event_type', typeId)
    if (error) {
      setChecked(!checked)
      show('Failed: ' + error.message, 'error')
    }
    setSavingId(null)
  }

  async function remove(row) {
    if (!window.confirm(`Remove ${row.email} from notifications?`)) return
    setSavingId(row.id)
    const { error } = await supabase.from('notification_recipients').delete().eq('id', row.id)
    if (error) { show('Failed: ' + error.message, 'error') }
    else { setRecipients(prev => prev.filter(r => r.id !== row.id)); show('Recipient removed.', 'success') }
    setSavingId(null)
  }

  async function runTest(recipientId) {
    setTesting(recipientId ?? 'all')
    const sample = recipientId != null ? kind : ''
    const res = await sendTestEmail(recipientId, sample || undefined)
    setTesting(null)
    if (res.ok) show(`${sample ? 'Sample' : 'Test'} email sent to ${res.sent} recipient(s). Check the inbox and Spam.`, 'success', { duration: 6000 })
    else show(testErrorMessage(res.error), 'error', { duration: 8000 })
  }

  if (!isAdmin) return (
    <div className="page">
      <div className="empty"><p>You do not have permission to view this page.</p></div>
    </div>
  )

  return (
    <div className="page">
      {ToastEl}

      <div className="page-header">
        <div>
          <h1 className="page-title">Notification Settings</h1>
          <p className="page-sub">Manage who receives email alerts. Emails are sent from a fixed sender account.</p>
        </div>
        <button
          className="btn"
          disabled={recipients.length === 0 || testing !== null}
          onClick={() => runTest()}
        >
          <Send size={14} /> {testing === 'all' ? 'Sending…' : 'Send test email'}
        </button>
      </div>

      <div className="bg-surface rounded-xl border border-line shadow-card p-4 mb-5">
        <form onSubmit={addRecipient} className="flex flex-wrap items-start gap-3">
          <div className="flex-1 min-w-[220px]">
            <input
              type="email"
              required
              value={email}
              onChange={e => setEmail(e.target.value)}
              placeholder="name@example.com"
            />
            {addErr && <div className="mt-1.5 text-[12px] text-danger-text">{addErr}</div>}
          </div>
          <button type="submit" className="btn primary" disabled={adding}>
            <Mail size={14} /> {adding ? 'Adding…' : 'Add Recipient'}
          </button>
        </form>
      </div>

      <ul className="mb-5 space-y-1 text-[12px] text-ink-muted">
        {NOTIFICATION_TYPES.map(t => (
          <li key={t.id}><span className="font-medium text-ink">{t.label}</span> — {t.description}</li>
        ))}
      </ul>

      <div className="flex flex-wrap items-center gap-2 mb-3 text-[12px] text-ink-muted">
        <label htmlFor="email-kind">Email sent by each row's Send button:</label>
        <select id="email-kind" className="w-auto" value={kind} onChange={e => setKind(e.target.value)} disabled={testing !== null}>
          {EMAIL_KINDS.map(k => <option key={k.value} value={k.value}>{k.label}</option>)}
        </select>
        <span>Samples use fictitious data and are never sent to everyone.</span>
      </div>

      {loading ? (
        <div className="loading-screen"><div className="spinner" /></div>
      ) : recipients.length === 0 ? (
        <div className="empty"><p>No notification recipients yet.</p></div>
      ) : (
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Email</th>
                {NOTIFICATION_TYPES.map(t => (
                  <th key={t.id} title={t.description}>{t.label}</th>
                ))}
                <th></th>
              </tr>
            </thead>
            <tbody>
              {recipients.map(r => (
                <tr key={r.id}>
                  <td className="text-[13px] font-medium text-ink">{r.email}</td>
                  {NOTIFICATION_TYPES.map(t => (
                    <td key={t.id}>
                      <input
                        type="checkbox"
                        checked={r.subs.has(t.id)}
                        disabled={savingId === r.id}
                        onChange={e => toggle(r, t.id, e.target.checked)}
                      />
                    </td>
                  ))}
                  <td>
                    <div className="flex items-center gap-1.5">
                      <button
                        className="btn-xs flex items-center gap-1"
                        disabled={testing !== null || savingId === r.id}
                        onClick={() => runTest(r.id)}
                        title={kind ? 'Send the selected sample email to this address' : 'Send a test email to this address'}
                      >
                        <Send size={10} /> {testing === r.id ? 'Sending…' : 'Send'}
                      </button>
                      <button
                        className="btn-xs red flex items-center gap-1"
                        disabled={savingId === r.id}
                        onClick={() => remove(r)}
                        title="Remove"
                      >
                        <Trash2 size={10} />
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}
