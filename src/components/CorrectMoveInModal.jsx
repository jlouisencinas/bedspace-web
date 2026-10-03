import { useState } from 'react'
import { CalendarClock, X, Info } from 'lucide-react'
import { updateTenantMoveInDate, supabase } from '../lib/supabase'

function fmtDate(d) {
  if (!d) return '—'
  return new Date(d).toLocaleDateString('en-PH', { month: 'short', day: 'numeric', year: 'numeric' })
}

export default function CorrectMoveInModal({ tenant, onClose, onDone }) {
  const currentDate = tenant.move_in_date ? tenant.move_in_date.slice(0, 10) : ''
  const moveOutDate = tenant.move_out_date ? tenant.move_out_date.slice(0, 10) : ''

  const [newDate, setNewDate] = useState(currentDate)
  const [reason,  setReason]  = useState('')
  const [saving,  setSaving]  = useState(false)
  const [error,   setError]   = useState('')

  function validate() {
    if (!newDate) return 'Please enter a valid move-in date.'
    if (moveOutDate && newDate >= moveOutDate) return 'Move-in date must be before the move-out date.'
    if (newDate === currentDate) return 'New move-in date must be different from the current one.'
    if (!reason.trim()) return 'Please provide a reason for this correction.'
    return null
  }

  async function handleSubmit(e) {
    e.preventDefault()
    const err = validate()
    if (err) { setError(err); return }

    setSaving(true)
    setError('')
    try {
      const { data: { user } } = await supabase.auth.getUser()
      await updateTenantMoveInDate(
        tenant.id,
        newDate,
        reason.trim(),
        { tenant_name: tenant.name, room_no: tenant.room_no, bed_letter: tenant.bed_letter },
        user?.id
      )
      onDone()
    } catch (err) {
      setError(err.message)
    }
    setSaving(false)
  }

  return (
    <div className="overlay" onClick={e => e.stopPropagation()}>
      <div className="modal modal-sm">
        <div className="modal-head">
          <h3 className="flex items-center gap-2">
            <CalendarClock size={15} className="text-ink-faint" /> Correct Move-in Date
          </h3>
          <button className="btn-close" onClick={onClose}><X size={16} /></button>
        </div>

        <form onSubmit={handleSubmit}>
          <div className="modal-body">
            <div className="bg-surface-2 border border-line-subtle rounded-xl px-4 py-3 text-[13px] mb-5">
              <div className="font-semibold text-ink">{tenant.name}</div>
              <div className="text-ink-muted mt-0.5">
                Room {tenant.room_no} · Bed {tenant.bed_letter}
              </div>
            </div>

            <div className="form-grid">
              <div className="fg full">
                <label>Current Move-in Date</label>
                <input
                  type="text"
                  readOnly
                  value={fmtDate(currentDate)}
                  className="bg-surface-2 text-ink-muted cursor-default"
                />
              </div>

              <div className="fg full">
                <label>New Move-in Date *</label>
                <input
                  type="date"
                  value={newDate}
                  max={moveOutDate || undefined}
                  onChange={e => { setNewDate(e.target.value); setError('') }}
                  required
                  autoFocus
                />
              </div>

              <div className="fg full">
                <label>Reason *</label>
                <textarea
                  rows={2}
                  value={reason}
                  onChange={e => { setReason(e.target.value); setError('') }}
                  placeholder="Why is this move-in date being corrected?"
                  required
                />
              </div>

              <div className="fg full">
                <div className="flex items-start gap-2 bg-warning-bg border border-warning-border rounded-xl px-3 py-2.5 text-[12px] text-warning-text">
                  <Info size={13} className="shrink-0 mt-px text-amber-500" />
                  This changes how this tenant's first-period rent and occupancy are computed. Billing
                  recomputes live from the move-in date, so statements for past periods will change if
                  reopened or reprinted.
                </div>
              </div>
            </div>

            {error && (
              <div className="mt-3 px-3 py-2.5 bg-danger-bg border border-danger-border rounded-xl text-[13px] text-danger-text flex items-start gap-2">
                <span className="shrink-0 mt-px">⚠</span>
                {error}
              </div>
            )}
          </div>

          <div className="modal-foot">
            <button type="button" className="btn secondary" onClick={onClose}>Cancel</button>
            <button type="submit" className="btn primary" disabled={saving}>
              {saving ? 'Saving…' : 'Save Correction'}
            </button>
          </div>
        </form>
      </div>
    </div>
  )
}
