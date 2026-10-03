import { useState } from 'react'
import { DollarSign, X, AlertTriangle, Clock, Info } from 'lucide-react'
import { updateTenantRate, supabase } from '../lib/supabase'
import { requestApproval, fetchPendingForEntity } from '../lib/approvals'
import { useAuth } from '../lib/auth'

function fmt(n) { return n ? '₱' + Number(n).toLocaleString('en-PH') : '—' }

export default function CorrectRateModal({ tenant, onClose, onDone }) {
  const { isAdmin } = useAuth()

  const [newRate,   setNewRate]   = useState(String(tenant.rate || ''))
  const [reason,    setReason]    = useState('')
  const [saving,    setSaving]    = useState(false)
  const [submitted, setSubmitted] = useState(false)
  const [error,     setError]     = useState('')

  function validate() {
    if (!newRate || Number(newRate) <= 0) return 'Please enter a valid rate.'
    if (Number(newRate) === Number(tenant.rate)) return 'New rate must be different from the current rate.'
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
      if (!isAdmin) {
        const pending = await fetchPendingForEntity('TENANT', String(tenant.id))
        if (pending.some(p => p.field_name === 'tenant_rate')) {
          setError('A rate correction request for this tenant is already pending approval.')
          setSaving(false)
          return
        }
        await requestApproval({
          entityType: 'TENANT',
          entityId:   String(tenant.id),
          fieldName:  'tenant_rate',
          oldValue:   { rate: tenant.rate },
          newValue: {
            rate:         Number(newRate),
            _tenant_name: tenant.name,
            _room_no:     tenant.room_no,
            _bed_letter:  tenant.bed_letter,
          },
          reason: reason.trim(),
        })
        setSubmitted(true)
      } else {
        const { data: { user } } = await supabase.auth.getUser()
        await updateTenantRate(
          tenant.id,
          Number(newRate),
          reason.trim(),
          { tenant_name: tenant.name, room_no: tenant.room_no, bed_letter: tenant.bed_letter },
          user?.id
        )
        onDone()
      }
    } catch (err) {
      setError(err.message)
    }
    setSaving(false)
  }

  if (submitted) {
    return (
      <div className="overlay" onClick={e => e.stopPropagation()}>
        <div className="modal modal-sm">
          <div className="modal-head">
            <h3>Rate Correction</h3>
            <button className="btn-close" onClick={onClose}><X size={16} /></button>
          </div>
          <div className="modal-body text-center py-8">
            <Clock size={36} className="mx-auto mb-3 text-amber-400" />
            <h4 className="text-[15px] font-semibold text-ink mb-2">Sent for Approval</h4>
            <p className="text-[13px] text-ink-muted leading-relaxed max-w-[260px] mx-auto">
              Rate correction for <strong>{tenant.name}</strong> has been submitted.
              An admin will review and process it.
            </p>
          </div>
          <div className="modal-foot">
            <button className="btn primary" onClick={onClose}>Close</button>
          </div>
        </div>
      </div>
    )
  }

  return (
    <div className="overlay" onClick={e => e.stopPropagation()}>
      <div className="modal modal-sm">
        <div className="modal-head">
          <h3 className="flex items-center gap-2">
            <DollarSign size={15} className="text-ink-faint" /> Correct Rate
          </h3>
          <button className="btn-close" onClick={onClose}><X size={16} /></button>
        </div>

        <form onSubmit={handleSubmit}>
          <div className="modal-body">
            <div className="bg-surface-2 border border-line-subtle rounded-xl px-4 py-3 text-[13px] mb-5">
              <div className="font-semibold text-ink">{tenant.name}</div>
              <div className="text-ink-muted mt-0.5">
                Room {tenant.room_no} · Bed {tenant.bed_letter} · Current rate: {fmt(tenant.rate)}/mo
              </div>
            </div>

            <div className="form-grid">
              <div className="fg full">
                <label>New Rate (₱) *</label>
                <input
                  type="number"
                  value={newRate}
                  min="0"
                  step="0.01"
                  onChange={e => { setNewRate(e.target.value); setError('') }}
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
                  placeholder="Why is this rate being corrected?"
                  required
                />
              </div>

              <div className="fg full">
                <div className="flex items-start gap-2 bg-warning-bg border border-warning-border rounded-xl px-3 py-2.5 text-[12px] text-warning-text">
                  <Info size={13} className="shrink-0 mt-px text-amber-500" />
                  This also changes how past periods look if a statement for this tenant is reopened
                  or reprinted later — billing recomputes live from the current rate, there's no
                  historical rate lock.
                </div>
              </div>

              {!isAdmin && (
                <div className="fg full">
                  <div className="flex items-start gap-2 bg-warning-bg border border-warning-border rounded-xl px-3 py-2.5 text-[12px] text-warning-text">
                    <AlertTriangle size={13} className="shrink-0 mt-px text-amber-500" />
                    Rate corrections require admin approval before taking effect.
                  </div>
                </div>
              )}
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
              {saving
                ? 'Saving…'
                : isAdmin ? 'Save Correction' : 'Submit for Approval'}
            </button>
          </div>
        </form>
      </div>
    </div>
  )
}
