import { AlertTriangle, CheckCircle } from 'lucide-react'

const peso = n => '₱' + Number(n || 0).toLocaleString('en-PH', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
const hhmm = d => d.toLocaleTimeString('en-PH', { hour: '2-digit', minute: '2-digit' })

const CHECK_TONE = {
  NO_ADVANCE: 'bg-surface-2 border-line-subtle text-ink-muted',
  NOT_CREDITED_BEFORE: 'bg-success-bg border-success-border text-success-text',
  PARTLY_CREDITED_BEFORE: 'bg-info-bg border-info-border text-info-text',
  FULLY_CREDITED_BEFORE: 'bg-info-bg border-info-border text-info-text',
  FORFEITED: 'bg-danger-bg border-danger-border text-danger-text',
  ORPHAN_IGNORED: 'bg-warning-bg border-warning-border text-warning-text',
  BLOCKED: 'bg-danger-bg border-danger-border text-danger-text',
}

export default function AdvanceCheckBox({ check, checkedAt }) {
  if (!check) return null
  const warn = check.status === 'FORFEITED' || check.status === 'ORPHAN_IGNORED' || check.status === 'BLOCKED'
  const before = check.prior.map(p => p.name).join(' & ')
  return (
    <div className={`border rounded-xl px-3 py-2.5 space-y-2 ${CHECK_TONE[check.status] || CHECK_TONE.NO_ADVANCE}`}>
      <div className="font-semibold flex items-start gap-1.5">
        {warn ? <AlertTriangle size={13} className="shrink-0 mt-px" /> : <CheckCircle size={13} className="shrink-0 mt-px" />}
        <span>Advance check</span>
        {checkedAt && <span className="ml-auto font-normal text-[11px]">Checked against the database at {hhmm(checkedAt)}</span>}
      </div>
      <div className="text-ink">{check.text}</div>
      {check.receipts.length > 0 && (
        <table className="w-full text-ink-muted">
          <thead><tr className="text-left text-[10px] uppercase tracking-wider text-ink-faint">
            <th className="py-0.5">Receipt</th><th className="text-right">Amount</th>
            <th className="text-right">Credited before{before ? ` (${before})` : ''}</th>
            <th className="text-right">Credited on this bill</th><th className="text-right">Forfeited</th>
          </tr></thead>
          <tbody>
            {check.receipts.map(r => (
              <tr key={r.deposit_id} className="border-t border-line-subtle tabular-nums">
                <td className="py-0.5">{r.ref}</td><td className="text-right">{peso(r.amount)}</td>
                <td className="text-right">{peso(r.credited_before)}</td><td className="text-right">{peso(r.credited_here)}</td>
                <td className="text-right">{check.forfeited > 0 ? peso(r.amount) : peso(0)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  )
}

