import { useEffect, useMemo, useState } from 'react'
import { X } from 'lucide-react'
import { fetchAllReservationPayments, PAYMENT_MODE_LABEL } from '../lib/supabase'
import { dbToCents, fmtCents } from '../lib/receiptLines'

const STATUSES = ['HELD', 'APPLIED', 'FORFEITED', 'VOID']
const STATUS_CLS = {
  HELD:      'bg-warning-bg text-warning-text',
  APPLIED:   'bg-success-bg text-success-text',
  FORFEITED: 'bg-danger-bg text-danger-text',
  VOID:      'bg-surface-3 text-ink-muted',
}

function fmtDay(d) {
  if (!d) return '—'
  return new Date(d + 'T00:00:00').toLocaleDateString('en-PH', { month: 'short', day: 'numeric', year: 'numeric' })
}

// Read-only. The one place where forfeited reservation income is reported.
export default function ReservationLedgerModal({ onClose }) {
  const [rows,    setRows]    = useState([])
  const [loading, setLoading] = useState(true)
  const [error,   setError]   = useState('')
  const [filter,  setFilter]  = useState('')

  useEffect(() => {
    let cancelled = false
    fetchAllReservationPayments()
      .then(r => { if (!cancelled) setRows(r) })
      .catch(e => { if (!cancelled) setError(e.message) })
      .finally(() => { if (!cancelled) setLoading(false) })
    return () => { cancelled = true }
  }, [])

  const totals = useMemo(() => {
    const t = Object.fromEntries(STATUSES.map(s => [s, 0]))
    for (const r of rows) t[r.status] = (t[r.status] || 0) + dbToCents(r.amount)
    return t
  }, [rows])

  const shown = filter ? rows.filter(r => r.status === filter) : rows

  return (
    <div className="overlay" onClick={e => e.stopPropagation()}>
      <div className="modal modal-lg">
        <div className="modal-head">
          <h3>Reservation payments</h3>
          <button className="btn-close" onClick={onClose}><X size={16} /></button>
        </div>
        <div className="modal-body">
          <div className="flex flex-wrap items-center gap-2 mb-3">
            <select
              value={filter} onChange={e => setFilter(e.target.value)}
              className="px-3 py-2 border border-line rounded-lg text-[13px] bg-surface text-ink"
            >
              <option value="">All statuses</option>
              {STATUSES.map(s => <option key={s} value={s}>{s}</option>)}
            </select>
            {STATUSES.map(s => (
              <span key={s} className={`text-[11px] font-semibold px-2 py-1 rounded-full ${STATUS_CLS[s]}`}>
                {s} {fmtCents(totals[s])}
              </span>
            ))}
          </div>

          {loading && <p className="text-[13px] text-ink-muted">Loading…</p>}
          {error && <p className="text-[13px] text-danger-text">Could not load reservation payments: {error}</p>}
          {!loading && !error && shown.length === 0 && <div className="empty"><p>No reservation payments</p></div>}

          {shown.length > 0 && (
            <div className="table-wrap max-h-[55vh] overflow-y-auto">
              <table>
                <thead className="sticky top-0 z-10">
                  <tr>
                    <th>Room / Bed</th><th>Reserved for</th><th>T.R#</th><th>Date</th><th>Mode</th>
                    <th>Bank ref</th><th className="text-right">Amount</th><th>Status</th><th>Note</th><th>Tenant</th>
                  </tr>
                </thead>
                <tbody>
                  {shown.map(r => (
                    <tr key={r.id}>
                      <td className="whitespace-nowrap">{r.beds?.rooms?.room_no ?? '?'} · {r.beds?.bed_letter ?? '?'}</td>
                      <td>{r.reserved_name || '—'}</td>
                      <td>{r.ref_no || '—'}</td>
                      <td className="whitespace-nowrap">{fmtDay(r.received_date)}</td>
                      <td>{PAYMENT_MODE_LABEL[r.payment_mode] || r.payment_mode}</td>
                      <td>{r.bank_ref || '—'}</td>
                      <td className="text-right whitespace-nowrap">{fmtCents(dbToCents(r.amount))}</td>
                      <td>
                        <span className={`text-[9px] font-bold uppercase tracking-wider px-1.5 py-0.5 rounded-full ${STATUS_CLS[r.status] || ''}`}>{r.status}</span>
                      </td>
                      <td className="text-[12px] text-ink-muted">{r.settled_note || r.notes || ''}</td>
                      <td>{r.tenants?.name || '—'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
        <div className="modal-foot">
          <button className="btn secondary" onClick={onClose}>Close</button>
        </div>
      </div>
    </div>
  )
}
