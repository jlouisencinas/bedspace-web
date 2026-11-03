import { useState } from 'react'
import { X, Ban, AlertTriangle } from 'lucide-react'
import { voidVisit, fmtDateTime } from '../lib/visitors'

export default function VisitorVoidModal({ visit, onClose, onDone }) {
  const [reason, setReason] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const ok = reason.trim().length >= 3

  async function submit(e) {
    e.preventDefault()
    if (!ok) return
    setBusy(true); setError('')
    try {
      await voidVisit(visit.id, reason.trim())
      onDone()
    } catch (err) {
      setError(err.message)
      setBusy(false)
    }
  }

  return (
    <div className="overlay" onClick={e => e.stopPropagation()}>
      <form className="modal modal-sm" onSubmit={submit}>
        <div className="modal-head">
          <h3>Void visitor entry #{visit.id}</h3>
          <button type="button" className="btn-close" onClick={onClose} aria-label="Close"><X size={16} /></button>
        </div>
        <div className="modal-body space-y-4">
          <div className="text-[13px] text-ink-secondary">
            <div className="font-semibold text-ink">{visit.visitor_name}</div>
            <div>Checked in {fmtDateTime(visit.check_in_at)}</div>
          </div>
          <div className="p-3 rounded-xl bg-warning-bg text-warning-text border border-warning-border text-[13px] flex items-start gap-2">
            <AlertTriangle size={15} className="shrink-0 mt-0.5" />
            Voided entries stay in history. This cannot be undone.
          </div>
          <div className="fg">
            <label htmlFor="void-reason">Reason (required)</label>
            <textarea id="void-reason" rows={3} value={reason} maxLength={300} autoFocus onChange={e => setReason(e.target.value)}
              placeholder="e.g. Duplicate entry, wrong visitor" />
          </div>
          {error && <div className="p-3 rounded-xl bg-danger-bg text-danger-text border border-danger-border text-[13px]">{error}</div>}
        </div>
        <div className="modal-foot">
          <button type="button" className="btn secondary" onClick={onClose} disabled={busy}>Cancel</button>
          <button type="submit" className="btn danger" disabled={busy || !ok}><Ban size={14} />{busy ? 'Voiding…' : 'Void entry'}</button>
        </div>
      </form>
    </div>
  )
}
