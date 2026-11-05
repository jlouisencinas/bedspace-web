import { ticketPlace } from '../../lib/maintenanceTickets'

function fmtDate(d) {
  if (!d) return '—'
  return new Date(d).toLocaleDateString('en-PH', { month: 'short', day: 'numeric', year: 'numeric' })
}

export default function MaintenanceTab({ tickets, error }) {
  if (error) return (
    <div className="text-[12px] text-danger-text bg-danger-bg border border-danger-border rounded-lg px-3 py-2.5">
      Could not load maintenance tickets: {error}
    </div>
  )
  if (tickets.length === 0) return (
    <div className="text-center py-6">
      <p className="text-[13px] text-ink-faint">No maintenance tickets linked to this tenant.</p>
    </div>
  )
  return (
    <table className="payments-table">
      <thead><tr><th>Location</th><th>Concern</th><th>Status</th><th>Raised</th><th>Resolved</th></tr></thead>
      <tbody>
        {tickets.map(tk => (
          <tr key={tk.id}>
            <td>{ticketPlace(tk)}</td>
            <td>
              {tk.concern}
              {tk.remarks && <div className="text-[11px] text-ink-muted mt-0.5">{tk.remarks}</div>}
              {tk.resolution_notes && <div className="text-[11px] text-success-text mt-0.5">Resolution: {tk.resolution_notes}</div>}
            </td>
            <td>
              <span className={`inline-flex items-center px-2 py-0.5 rounded-full text-[10px] font-bold ${
                tk.status === 'PENDING' ? 'bg-warning-bg text-warning-text' : 'bg-success-bg text-success-text'
              }`}>
                {tk.status}
              </span>
            </td>
            <td className="text-[11px] text-ink-faint whitespace-nowrap">{fmtDate(tk.raised_at)}</td>
            <td className="text-[11px] text-ink-faint whitespace-nowrap">{fmtDate(tk.resolved_at)}</td>
          </tr>
        ))}
      </tbody>
    </table>
  )
}
