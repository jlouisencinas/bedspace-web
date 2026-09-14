import { useState, useMemo } from 'react'
import { X } from 'lucide-react'
import { addTicket } from '../lib/supabase'

export default function NewTicketModal({ rooms, tenants, onClose, onSaved }) {
  const [form, setForm] = useState({ room_id: '', tenant_id: '', concern: '', remarks: '' })
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  const set = (k, v) => setForm(f => ({ ...f, [k]: v }))

  // Tenants that live in the selected room
  const roomTenants = useMemo(() => {
    if (!form.room_id) return tenants
    return tenants.filter(t => String(t.beds?.room_id) === String(form.room_id))
  }, [tenants, form.room_id])

  async function handleSubmit(e) {
    e.preventDefault()
    if (!form.room_id) { setError('Please select a room.'); return }
    if (!form.concern.trim()) { setError('Concern is required.'); return }
    setBusy(true); setError('')
    try {
      await addTicket({
        roomId:    Number(form.room_id),
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
                <label>Room <span className="text-red-600">*</span></label>
                <select
                  value={form.room_id}
                  onChange={e => { set('room_id', e.target.value); set('tenant_id', '') }}
                  required
                >
                  <option value="">— Select room —</option>
                  {rooms.map(r => (
                    <option key={r.id} value={r.id}>Room {r.room_no} · {r.room_type}</option>
                  ))}
                </select>
              </div>
              <div className="fg full">
                <label>Raised by Tenant (optional)</label>
                <select
                  value={form.tenant_id}
                  onChange={e => set('tenant_id', e.target.value)}
                >
                  <option value="">— Staff-raised / anonymous —</option>
                  {roomTenants.map(t => (
                    <option key={t.id} value={t.id}>{t.name}</option>
                  ))}
                </select>
              </div>
              <div className="fg full">
                <label>Concern <span className="text-red-600">*</span></label>
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
              <div className="mt-3 p-3 bg-red-50 text-red-700 text-[13px] rounded-xl border border-red-100">{error}</div>
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
