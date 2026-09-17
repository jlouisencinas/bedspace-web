import { useState } from 'react'
import { X } from 'lucide-react'
import { resolveTicket } from '../lib/supabase'

function fmtDateTime(d) {
  if (!d) return '—'
  return new Date(d).toLocaleString('en-PH', {
    month: 'short', day: 'numeric', year: 'numeric',
    hour: 'numeric', minute: '2-digit',
  })
}

export default function ResolveTicketModal({ ticket, onClose, onSaved }) {
  const [notes, setNotes] = useState('')
  const [busy,  setBusy]  = useState(false)
  const [error, setError] = useState('')

  async function handleSubmit(e) {
    e.preventDefault()
    setBusy(true); setError('')
    try {
      await resolveTicket(ticket.id, notes.trim() || null)
      onSaved()
    } catch(err) {
      setError(err.message)
      setBusy(false)
    }
  }

  const room   = ticket.rooms?.room_no  ? `Room ${ticket.rooms.room_no}` : '—'
  const tenant = ticket.tenants?.name   || 'Staff-raised'

  return (
    <div className="overlay" onClick={e => e.stopPropagation()}>
      <div className="modal modal-sm">
        <div className="modal-head">
          <h3>Resolve Ticket</h3>
          <button className="btn-close" onClick={onClose}><X size={16} /></button>
        </div>
        <form onSubmit={handleSubmit}>
          <div className="modal-body space-y-4">
            <div className="bg-surface-2 border border-line-subtle rounded-xl px-4 py-3 text-[13px]">
              <div className="font-semibold text-ink mb-1">{ticket.concern}</div>
              <div className="text-ink-muted">{room} · {tenant} · Raised {fmtDateTime(ticket.raised_at)}</div>
              {ticket.remarks && <div className="mt-1.5 text-ink-secondary italic">{ticket.remarks}</div>}
            </div>
            <div className="fg">
              <label>Resolution notes (optional)</label>
              <textarea
                rows={3}
                value={notes}
                onChange={e => setNotes(e.target.value)}
                placeholder="Describe what was done to resolve this issue…"
              />
            </div>
            {error && (
              <div className="p-3 bg-danger-bg text-danger-text text-[13px] rounded-xl border border-danger-border">{error}</div>
            )}
          </div>
          <div className="modal-foot">
            <button type="button" className="btn secondary" onClick={onClose}>Cancel</button>
            <button type="submit" className="btn success" disabled={busy}>
              {busy ? 'Saving…' : 'Mark Resolved'}
            </button>
          </div>
        </form>
      </div>
    </div>
  )
}
