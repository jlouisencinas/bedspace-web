import { useState, useEffect } from 'react'
import { useAuth } from '../lib/auth'
import { requestApproval } from '../lib/approvals'
import { fetchCutoffs, fetchUtilityBill } from '../lib/supabase'
import { LogOut, Clock, AlertTriangle, X } from 'lucide-react'

function today() { return new Date().toISOString().slice(0,10) }

export default function MoveOutModal({ bed, onClose, onSubmit, saving }) {
  const { isAdmin } = useAuth()
  const defaultMoveOut = bed?.move_out_date ? bed.move_out_date.slice(0,10) : today()
  const [form, setForm] = useState({
    move_out_date:        defaultMoveOut,
    actual_move_out_date: defaultMoveOut,
    amount_paid:          '',
    water_reading:        '',
    electric_reading:     '',
  })
  const [reason, setReason]   = useState('')
  const [pending, setPending] = useState(false)
  const [submitted, setSubmitted] = useState(false)
  const [error, setError]     = useState('')
  const [actualTouched, setActualTouched] = useState(false)
  const [minWater, setMinWater] = useState(null)
  const [minElec,  setMinElec]  = useState(null)

  useEffect(() => {
    async function loadMinReadings() {
      try {
        const cutoffs = await fetchCutoffs()
        const active = cutoffs.find(c => c.is_active)
        if (!active) return
        const bill = await fetchUtilityBill(active.id)
        const row = bill.find(b => b.room_id === bed?.room_id)
        if (row) {
          if (row.water_prev != null) setMinWater(Number(row.water_prev))
          if (row.elec_prev  != null) setMinElec(Number(row.elec_prev))
        }
      } catch { /* non-critical */ }
    }
    if (bed?.room_id) loadMinReadings()
  }, [bed?.room_id])

  const set = (k, v) => {
    setError('')
    setForm(f => {
      const next = { ...f, [k]: v }
      if (k === 'move_out_date' && !actualTouched) next.actual_move_out_date = v
      return next
    })
  }

  function validate() {
    if (!form.water_reading) return 'Water meter reading is required.'
    if (minWater !== null && Number(form.water_reading) < minWater)
      return `Water reading (${form.water_reading}) cannot be less than the period's starting reading (${minWater}).`
    if (!form.electric_reading) return 'Electric meter reading is required.'
    if (minElec !== null && Number(form.electric_reading) < minElec)
      return `Electric reading (${form.electric_reading}) cannot be less than the period's starting reading (${minElec}).`
    return null
  }

  async function handleSubmit(e) {
    e.preventDefault()
    const validErr = validate()
    if (validErr) { setError(validErr); return }

    if (!isAdmin) {
      if (!reason.trim()) {
        setError('Please provide a reason for the move-out.')
        return
      }
      setError('')
      setPending(true)
      try {
        const tenantId = String(bed.tenant_id || bed.id)
        await requestApproval({
          entityType: 'TENANT_STAY',
          entityId:   tenantId,
          fieldName:  'move_out',
          oldValue:   { is_active: true, move_out_date: bed.move_out_date || null },
          newValue: {
            _action:              'process_move_out',
            _tenant_id:           tenantId,
            _bed_id:              String(bed.bed_id),
            _room_no:             bed.room_no    || bed._room_no,
            _bed_letter:          bed.bed_letter || bed._bed_letter,
            _tenant_name:         bed.tenant_name || bed.name,
            _rate:                bed.rate,
            _move_in_date:        bed.move_in_date,
            move_out_date:        form.move_out_date,
            actual_move_out_date: form.actual_move_out_date,
            amount_paid:          form.amount_paid,
            water_reading:        form.water_reading,
            electric_reading:     form.electric_reading,
          },
          reason: reason.trim(),
        })
        setSubmitted(true)
      } catch (err) {
        setError(err.message)
      } finally {
        setPending(false)
      }
      return
    }

    onSubmit(form)
  }

  const name          = bed?.tenant_name || bed?.name || '—'
  const roomInfo      = `Room ${bed?.room_no} · Bed ${bed?.bed_letter || bed?.bed}`
  const rate          = bed?.rate ? '₱' + Number(bed.rate).toLocaleString('en-PH') + '/mo' : ''
  const needsApproval = !isAdmin

  if (submitted) {
    return (
      <div className="overlay" onClick={e => e.stopPropagation()}>
        <div className="modal modal-sm">
          <div className="modal-head">
            <h3><span className="inline-flex items-center gap-1.5"><LogOut size={16} /> Process Move Out</span></h3>
            <button className="btn-close" onClick={onClose}><X size={16} /></button>
          </div>
          <div className="modal-body text-center py-8">
            <Clock size={36} className="mx-auto mb-3 text-amber-400" />
            <h4 className="text-[15px] font-semibold text-ink mb-2">Sent for Approval</h4>
            <p className="text-[13px] text-ink-muted leading-relaxed">
              The move-out request has been submitted to an admin for review.
              The tenant and bed will remain active until approved.
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
          <h3><span className="inline-flex items-center gap-1.5"><LogOut size={16} /> Process Move Out</span></h3>
          <button className="btn-close" onClick={onClose}><X size={16} /></button>
        </div>
        <form onSubmit={handleSubmit}>
          <div className="modal-body space-y-4">
            <div className="bg-danger-bg border border-danger-border rounded-xl px-4 py-3 text-[13px]">
              <div className="font-semibold text-ink">{name}</div>
              <div className="text-ink-muted mt-0.5">{roomInfo}{rate && ` · ${rate}`}</div>
            </div>
            <div className="form-grid">
              <div className="fg">
                <label>Move Out Date</label>
                <input type="date" value={form.move_out_date} onChange={e => set('move_out_date', e.target.value)} />
              </div>
              <div className="fg">
                <label>Actual Move Out Date</label>
                <input
                  type="date"
                  value={form.actual_move_out_date}
                  onChange={e => { setActualTouched(true); set('actual_move_out_date', e.target.value) }}
                />
              </div>

              <div className="form-section">Final Meter Readings</div>

              <div className="fg">
                <label>Water Reading <span className="text-danger-text">*</span></label>
                <input
                  type="number"
                  value={form.water_reading}
                  min={minWater ?? 0}
                  step="0.0001"
                  placeholder="e.g. 1234.50"
                  onChange={e => set('water_reading', e.target.value)}
                  required
                />
                {minWater !== null && (
                  <span className="block text-[11px] text-ink-faint mt-1">
                    Min: {minWater} (period start)
                  </span>
                )}
              </div>

              <div className="fg">
                <label>Electric Reading <span className="text-danger-text">*</span></label>
                <input
                  type="number"
                  value={form.electric_reading}
                  min={minElec ?? 0}
                  step="0.0001"
                  placeholder="e.g. 5678.90"
                  onChange={e => set('electric_reading', e.target.value)}
                  required
                />
                {minElec !== null && (
                  <span className="block text-[11px] text-ink-faint mt-1">
                    Min: {minElec} (period start)
                  </span>
                )}
              </div>

              <div className="fg full">
                <label>Final Amount Paid (PHP)</label>
                <input type="number" value={form.amount_paid} onChange={e => set('amount_paid', e.target.value)} placeholder="0.00" min="0" step="0.01" />
              </div>

              {needsApproval && (
                <div className="fg full space-y-3">
                  <div className="bg-warning-bg border border-warning-border rounded-xl px-3 py-2.5 text-[12px] text-warning-text">
                    <AlertTriangle size={13} className="shrink-0 mt-px inline mr-1" /> Move-out requires admin approval. The bed and tenant will remain active until an admin reviews and approves this request.
                  </div>
                  <div className="fg">
                    <label>Reason for move-out <span className="text-danger-text">*</span></label>
                    <textarea
                      rows={2}
                      value={reason}
                      onChange={e => { setError(''); setReason(e.target.value) }}
                      placeholder="State the reason for the move-out…"
                      required={needsApproval}
                    />
                  </div>
                </div>
              )}
            </div>
            {error && (
              <div className="p-3 bg-danger-bg text-danger-text text-[13px] rounded-xl border border-danger-border">{error}</div>
            )}
          </div>
          <div className="modal-foot">
            <button type="button" className="btn secondary" onClick={onClose}>Cancel</button>
            <button type="submit" className="btn danger" disabled={saving || pending}>
              {pending          ? 'Submitting…'
               : saving        ? 'Processing…'
               : needsApproval ? 'Submit for Approval'
               : 'Confirm Move Out'}
            </button>
          </div>
        </form>
      </div>
    </div>
  )
}
