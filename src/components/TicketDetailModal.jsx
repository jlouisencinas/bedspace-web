import { useState, useEffect } from 'react'
import { X, CheckCircle } from 'lucide-react'
import { fetchProfileEmail } from '../lib/supabase'

function fmtDateTime(d) {
  if (!d) return '—'
  return new Date(d).toLocaleString('en-PH', {
    month: 'short', day: 'numeric', year: 'numeric',
    hour: 'numeric', minute: '2-digit',
  })
}

export default function TicketDetailModal({ ticket, canWrite, onClose, onResolve }) {
  const [resolvedByEmail, setResolvedByEmail] = useState(null)

  useEffect(() => {
    let cancelled = false
    setResolvedByEmail(null)
    if (ticket.status === 'RESOLVED' && ticket.resolved_by) {
      fetchProfileEmail(ticket.resolved_by)
        .then(email => { if (!cancelled) setResolvedByEmail(email) })
        .catch(() => { if (!cancelled) setResolvedByEmail(null) })
    }
    return () => { cancelled = true }
  }, [ticket.status, ticket.resolved_by])

  return (
    <div className="overlay" onClick={e => e.stopPropagation()}>
      <div className="modal modal-sm">
        <div className="modal-head">
          <div className="flex items-center gap-2.5">
            <h3>Room {ticket.rooms?.room_no ?? '—'}</h3>
            {ticket.status === 'PENDING' ? (
              <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-[11px] font-semibold bg-warning-bg text-warning-text">
                <span className="w-1.5 h-1.5 rounded-full bg-amber-500" />PENDING
              </span>
            ) : (
              <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-[11px] font-semibold bg-success-bg text-success-text">
                <span className="w-1.5 h-1.5 rounded-full bg-emerald-500" />RESOLVED
              </span>
            )}
          </div>
          <button className="btn-close" onClick={onClose}><X size={16} /></button>
        </div>
        <div className="modal-body">
          <div className="detail-row">
            <div className="detail-label">Concern</div>
            <div className="detail-value whitespace-pre-wrap break-words">{ticket.concern}</div>
          </div>
          <div className="detail-row">
            <div className="detail-label">Remarks</div>
            <div className="detail-value whitespace-pre-wrap break-words">{ticket.remarks || '—'}</div>
          </div>
          <div className="detail-row">
            <div className="detail-label">Raised By</div>
            <div className="detail-value">
              {ticket.tenants?.name || <span className="italic">Staff-raised</span>}
            </div>
          </div>
          <div className="detail-row">
            <div className="detail-label">Raised</div>
            <div className="detail-value">{fmtDateTime(ticket.raised_at)}</div>
          </div>

          {ticket.status === 'RESOLVED' && (
            <div className="mt-3 pt-3" style={{ borderTop: '1px solid var(--border)' }}>
              <div className="detail-row">
                <div className="detail-label">Resolution Notes</div>
                <div className="detail-value whitespace-pre-wrap break-words">{ticket.resolution_notes || '—'}</div>
              </div>
              <div className="detail-row">
                <div className="detail-label">Resolved By</div>
                <div className="detail-value">{resolvedByEmail || 'Staff'}</div>
              </div>
              <div className="detail-row">
                <div className="detail-label">Resolved At</div>
                <div className="detail-value">{fmtDateTime(ticket.resolved_at)}</div>
              </div>
            </div>
          )}
        </div>
        <div className="modal-foot">
          <button className="btn secondary" onClick={onClose}>Close</button>
          {ticket.status === 'PENDING' && canWrite && (
            <button className="btn success" onClick={() => onResolve(ticket)}>
              <CheckCircle size={13} /> Resolve
            </button>
          )}
        </div>
      </div>
    </div>
  )
}
