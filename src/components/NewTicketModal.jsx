import { useState, useMemo } from 'react'
import { X } from 'lucide-react'
import { addTicket } from '../lib/supabase'
import { parseTargetValue, targetValue, tenantsForTarget } from '../lib/maintenanceTickets'
import { MAINTENANCE_LOCATIONS } from '../../supabase/functions/_shared/maintenance-locations.ts'

export default function NewTicketModal({ rooms, tenants, onClose, onSaved }) {
  const [form, setForm] = useState({ target: '', tenant_id: '', concern: '', remarks: '' })
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  const set = (k, v) => setForm(f => ({ ...f, [k]: v }))

  const target = useMemo(() => parseTargetValue(form.target), [form.target])
  const targetTenants = useMemo(() => tenantsForTarget(tenants, target), [tenants, target])

  async function handleSubmit(e) {
    e.preventDefault()
    if (!target.roomId && !target.location) { setError('Please select a room or common area.'); return }
    if (!form.concern.trim()) { setError('Concern is required.'); return }
    setBusy(true); setError('')
    try {
      await addTicket({
        roomId:    target.roomId,
        location:  target.location,
        tenantId:  form.tenant_id ? Number(form.tenant_id) : null,
        concern:   form.concern.trim(),
        remarks:   form.remarks.trim() || null,
      })
      onSaved()
    } catch(err) {
      setError(err.message)
      setBusy(false)
    }
  }

  return (
    <div className="overlay" onClick={e => e.stopPropagation()}>
      <div className="modal modal-sm">
        <div className="modal-head">
          <h3>New Maintenance Ticket</h3>
          <button className="btn-close" onClick={onClose}><X size={16} /></button>
        </div>
        <form onSubmit={handleSubmit}>
          <div className="modal-body">
            <div className="form-grid">
              <div className="fg full">
                <label>Location <span className="text-danger-text">*</span></label>
                <select
                  value={form.target}
                  onChange={e => { setError(''); set('target', e.target.value); set('tenant_id', '') }}
                  required
                >
                  <option value="">— Select room or common area —</option>
                  <optgroup label="Common areas">
                    {MAINTENANCE_LOCATIONS.map(l => (
                      <option key={l.code} value={targetValue({ location: l.code })}>{l.label}</option>
                    ))}
                  </optgroup>
                  <optgroup label="Rooms">
                    {rooms.map(r => (
                      <option key={r.id} value={targetValue({ roomId: r.id })}>Room {r.room_no} · {r.room_type}</option>
                    ))}
                  </optgroup>
                </select>
              </div>
              <div className="fg full">
                <label>Raised by Tenant (optional)</label>
                <select
                  value={form.tenant_id}
                  onChange={e => set('tenant_id', e.target.value)}
                >
                  <option value="">— Staff-raised / anonymous —</option>
                  {targetTenants.map(t => (
                    <option key={t.id} value={t.id}>{t.name}</option>
                  ))}
                </select>
              </div>
              <div className="fg full">
                <label>Concern <span className="text-danger-text">*</span></label>
                <input
                  type="text"
                  value={form.concern}
                  onChange={e => { setError(''); set('concern', e.target.value) }}
                  placeholder="e.g. aircon leak, clogged drain"
                  required
                />
              </div>
              <div className="fg full">
                <label>Remarks (optional)</label>
                <textarea rows={2} value={form.remarks} onChange={e => set('remarks', e.target.value)} placeholder="Additional details…" />
              </div>
            </div>
            {error && (
              <div className="mt-3 p-3 bg-danger-bg text-danger-text text-[13px] rounded-xl border border-danger-border">{error}</div>
            )}
          </div>
          <div className="modal-foot">
            <button type="button" className="btn secondary" onClick={onClose}>Cancel</button>
            <button type="submit" className="btn primary" disabled={busy}>
              {busy ? 'Saving…' : '+ Raise Ticket'}
            </button>
          </div>
        </form>
      </div>
    </div>
  )
}
