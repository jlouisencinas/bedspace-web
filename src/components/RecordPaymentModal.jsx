import { useState } from 'react'
import { CreditCard, X } from 'lucide-react'
import { recordPayment } from '../lib/supabase'

function fmt(n) { return n ? '₱' + Number(n).toLocaleString('en-PH') : '—' }
function today() { return new Date().toISOString().slice(0, 10) }

// Requires cutoffId — payments recorded without it are invisible to
// fetchPaymentsForCutoff() (Collections.jsx, Payment Monitoring).
export default function RecordPaymentModal({ tenant, cutoffId, cutoffName, onClose, onDone }) {
  const [payDate,     setPayDate]     = useState(today())
  const [payAmount,   setPayAmount]   = useState(String(tenant.rate || ''))
  const [payNotes,    setPayNotes]    = useState('')
  const [payCategory, setPayCategory] = useState('RENT_WATER')
  const [saving,      setSaving]      = useState(false)
  const [error,       setError]       = useState('')

  async function handlePayment() {
    setSaving(true)
    setError('')
    try {
      await recordPayment(tenant.id, {
        payment_date: payDate,
        amount:       Number(payAmount),
        notes:        payNotes.trim() || null,
        category:     payCategory,
        cutoff_id:    cutoffId || null,
        _tenant_name: tenant.name,
        _room_no:     tenant.room_no,
        _bed_letter:  tenant.bed_letter,
        _cutoff_name: cutoffName || null,
      })
      onDone()
    } catch(e) { setError(e.message) }
    setSaving(false)
  }

  return (
    <div className="overlay" onClick={e => e.stopPropagation()}>
      <div className="modal modal-sm">
        <div className="modal-head">
          <h3 className="flex items-center gap-2"><CreditCard size={15} className="text-slate-400" /> Record Payment</h3>
          <button className="btn-close" onClick={onClose}><X size={16} /></button>
        </div>
        <div className="modal-body space-y-4">
          <div className="bg-slate-50 border border-slate-100 rounded-xl px-4 py-3 text-[13px]">
            <div className="font-semibold text-slate-900">{tenant.name}</div>
            <div className="text-slate-500 mt-0.5">Room {tenant.room_no} · Bed {tenant.bed_letter} · {fmt(tenant.rate)}/mo</div>
          </div>
          <div className="form-grid">
            <div className="fg">
              <label>Payment For</label>
              <select value={payCategory} onChange={e => setPayCategory(e.target.value)}>
                <option value="RENT_WATER">Rent + Water (due EOM)</option>
                <option value="ELECTRICITY">Electricity (due 10th)</option>
                <option value="OTHER">Other</option>
              </select>
            </div>
            <div className="fg">
              <label>Date Paid *</label>
              <input type="date" value={payDate} onChange={e => setPayDate(e.target.value)} required />
            </div>
            <div className="fg full">
              <label>Amount (₱) *</label>
              <input
                type="number" min="1" step="0.01"
                value={payAmount} onChange={e => setPayAmount(e.target.value)}
                placeholder={tenant.rate ? String(tenant.rate) : '0'}
                required
              />
            </div>
            <div className="fg full">
              <label>Notes (optional)</label>
              <textarea
                rows={2} value={payNotes} onChange={e => setPayNotes(e.target.value)}
                placeholder="e.g. partial only, advance for next month…"
              />
            </div>
          </div>
          {!cutoffId && (
            <div className="p-3 bg-amber-50 text-amber-800 text-[13px] rounded-xl border border-amber-100">
              No active cutoff — this payment won't be visible in Collections or Payment Monitoring until a cutoff is opened.
            </div>
          )}
          {error && (
            <div className="p-3 bg-red-50 text-red-700 text-[13px] rounded-xl border border-red-100">{error}</div>
          )}
        </div>
        <div className="modal-foot">
          <button className="btn secondary" onClick={onClose}>Cancel</button>
          <button
            className="btn primary"
            disabled={saving || !cutoffId || !payDate || !payAmount || Number(payAmount) <= 0}
            onClick={handlePayment}
          >
            {saving ? 'Saving…' : 'Record'}
          </button>
        </div>
      </div>
    </div>
  )
}
