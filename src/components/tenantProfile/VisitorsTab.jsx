import { Link } from 'react-router-dom'
import { DoorOpen } from 'lucide-react'
import { STATE_META, TONE_CHIP, fmtDateTime } from '../../lib/visitors'
import { VISITS_LIMIT } from '../../lib/tenantHistory'

const OVERNIGHT_LABEL = { PENDING: 'Overnight pending', APPROVED: 'Overnight approved', REJECTED: 'Overnight rejected' }

export default function VisitorsTab({ visits, loading, error, noBed }) {
  return (
    <div>
      {loading ? (
        <p className="text-[12px] text-ink-muted">Loading visitor log…</p>
      ) : error ? (
        <div className="text-[12px] text-danger-text bg-danger-bg border border-danger-border rounded-lg px-3 py-2.5">
          Could not load visitor log entries: {error}
        </div>
      ) : visits.length === 0 ? (
        <div className="text-center py-6">
          <DoorOpen size={28} className="mx-auto mb-2 text-ink-faint" />
          <p className="text-[13px] text-ink-faint">No visitor log entries.</p>
          {noBed && <p className="text-[11px] text-ink-faint mt-1">Visits are logged against bed tenants only.</p>}
        </div>
      ) : (
        <>
          {visits.length >= VISITS_LIMIT && (
            <p className="text-[11px] text-ink-faint mb-2">Showing the latest {VISITS_LIMIT} visits.</p>
          )}
          <table className="payments-table">
            <thead><tr><th>Check-in</th><th>Check-out</th><th>Visitor</th><th>Contact</th><th>Status</th></tr></thead>
            <tbody>
              {visits.map(v => {
                const meta = STATE_META[v.state] || { label: v.state || '—', tone: 'neutral' }
                return (
                  <tr key={v.id}>
                    <td className="whitespace-nowrap">{fmtDateTime(v.check_in_at)}</td>
                    <td className="whitespace-nowrap">{v.check_out_at ? fmtDateTime(v.check_out_at) : '—'}</td>
                    <td>{v.visitor_name}</td>
                    <td className="text-ink-muted">{v.contact_no}</td>
                    <td>
                      <div className="flex flex-wrap gap-1">
                        <span className={`text-[10px] font-bold px-1.5 py-0.5 rounded ${TONE_CHIP[meta.tone]}`}>{meta.label}</span>
                        {OVERNIGHT_LABEL[v.overnight_status] && (
                          <span className="text-[10px] font-bold px-1.5 py-0.5 rounded bg-surface-3 text-ink-muted">{OVERNIGHT_LABEL[v.overnight_status]}</span>
                        )}
                      </div>
                      {v.voided_at && v.void_reason && <div className="text-[11px] text-danger-text mt-0.5">Void: {v.void_reason}</div>}
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </>
      )}
      <div className="mt-3">
        <Link className="btn-xs blue" to="/visitors">Open Visitor Log</Link>
      </div>
    </div>
  )
}
