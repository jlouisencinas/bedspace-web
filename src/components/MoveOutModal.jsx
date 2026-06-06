import { useState } from 'react'

function today() { return new Date().toISOString().slice(0,10) }

export default function MoveOutModal({ bed, onClose, onSubmit, saving }) {
  const [form, setForm] = useState({
    move_out_date:       bed?.move_out_date ? bed.move_out_date.slice(0,10) : today(),
    actual_move_out_date: today(),
    amount_paid: '',
  })

  const set = (k, v) => setForm(f => ({ ...f, [k]: v }))

  function handleSubmit(e) {
    e.preventDefault()
    onSubmit(form)
  }

  const name = bed?.tenant_name || bed?.name || '—'
  const roomInfo = `Room ${bed?.room_no} · Bed ${bed?.bed_letter || bed?.bed}`
  const rate = bed?.rate ? '₱' + Number(bed.rate).toLocaleString('en-PH') + '/mo' : ''

  return (
    <div className="overlay" onClick={e => e.target === e.currentTarget && onClose()}>
      <div className="modal modal-sm">
        <div className="modal-head">
          <h3>📤 Process Move Out</h3>
          <button className="btn-close" onClick={onClose}>✕</button>
        </div>
        <form onSubmit={handleSubmit}>
          <div className="modal-body">
            <div style={{ padding:'10px 12px', background:'#FEF2F2', borderRadius:8, marginBottom:16, fontSize:13 }}>
              <strong>{name}</strong><br />
              {roomInfo} {rate && `· ${rate}`}
            </div>
            <div className="form-grid">
              <div className="fg">
                <label>Move Out Date</label>
                <input type="date" value={form.move_out_date} onChange={e => set('move_out_date', e.target.value)} />
              </div>
              <div className="fg">
                <label>Actual Move Out Date</label>
                <input type="date" value={form.actual_move_out_date} onChange={e => set('actual_move_out_date', e.target.value)} />
              </div>
              <div className="fg full">
                <label>Final Amount Paid (PHP)</label>
                <input type="number" value={form.amount_paid} onChange={e => set('amount_paid', e.target.value)} placeholder="0.00" min="0" step="0.01" />
              </div>
            </div>
          </div>
          <div className="modal-foot">
            <button type="button" className="btn secondary" onClick={onClose}>Cancel</button>
            <button type="submit" className="btn danger" disabled={saving}>
              {saving ? 'Processing…' : '✓ Confirm Move Out'}
            </button>
          </div>
        </form>
      </div>
    </div>
  )
}
