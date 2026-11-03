import { combineBillsForPrint } from '../lib/finalBill'

const peso = n => '₱' + Number(n || 0).toLocaleString('en-PH', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
const signed = n => (Number(n) < 0 ? '-' : '') + peso(Math.abs(Number(n) || 0))

// The summed statement of a tenant's several beds, as it will print. Per-bed editing stays in the sections below it.
export default function CombinedBillSummary({ items }) {
  if (!items || items.length < 2) return null
  const c = combineBillsForPrint(items)
  return (
    <div className="bg-surface-2 border border-line-subtle rounded-xl p-3 space-y-2 text-[12px]">
      <div className="font-semibold text-[13px] text-ink">Summed final bill (one statement on the print)</div>
      <table className="w-full">
        <tbody>
          {c.lines.map((l, i) => (
            <tr key={i} className="border-t border-line-subtle">
              <td className="py-1 pr-2">{l.label}</td>
              <td className="pr-2 text-ink-muted">
                {l.mid}{l.rate != null && ` × ${peso(l.rate)}`}
                {l.kind === 'forfeit' && l.original != null && ` (${peso(l.original)} forfeited)`}
              </td>
              <td className="text-right tabular-nums">{signed(l.amount)}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <div className={`text-right text-[14px] font-bold ${c.net_amount < 0 ? 'text-success-text' : 'text-ink'}`}>
        {c.net_amount < 0 ? `Amount to be returned ${peso(-c.net_amount)}` : `Total amount due ${peso(c.net_amount)}`}
      </div>
      <div className="text-ink-muted">{c.bedNote}</div>
    </div>
  )
}
