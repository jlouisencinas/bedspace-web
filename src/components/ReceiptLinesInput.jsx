import { Plus, X } from 'lucide-react'
import { PAYMENT_MODES, PAYMENT_MODE_LABEL } from '../lib/supabase'
import { blankLine, centsToInput, fmtCents, parseMoney, sumCents } from '../lib/receiptLines'

const CELL = 'w-full px-2 py-1.5 text-[13px] rounded-lg border border-line bg-surface text-ink focus:outline-none focus:ring-2 focus:ring-navy-700/25 focus:border-navy-600 transition-colors'

// Controlled editor for one kind of receipt (advance or deposit) with several lines, e.g. bank + cash.
// lines: [{ amount: string, mode: '' | 'BANK' | 'CASH', refNo, bankRef, date }]. Never rounds or auto-resizes
// other lines; "Fill remainder" is an explicit action.
// dueCents = null is free mode (reservation payments): any amounts, no due comparison, no "Fill remainder".
export default function ReceiptLinesInput({
  title, refLabel, refRequired = false, dueCents, lines, onChange, defaultDate = '', minLines = 1, addLabel = 'Add line',
}) {
  const free = dueCents == null
  const total = sumCents(lines)
  const diff = free ? 0 : dueCents - total
  const anyUnparsed = lines.some(l => parseMoney(l.amount) == null)

  const patch = (i, p) => onChange(lines.map((l, idx) => (idx === i ? { ...l, ...p } : l)))
  const remove = i => onChange(lines.filter((_, idx) => idx !== i))
  const add = () => onChange([...lines, blankLine({ date: defaultDate })])
  const fillRemainder = () => {
    const last = lines.length - 1
    const others = sumCents(lines.slice(0, last))
    const rest = (dueCents ?? 0) - others
    if (rest > 0) patch(last, { amount: centsToInput(rest) })
  }

  return (
    <div className="flex flex-col gap-3">
      {title &&<div className="text-[12px] font-semibold text-ink-secondary">{title}</div>}

      {lines.map((l, i) => (
        <div key={i} className="rounded-lg border border-line bg-surface-2 p-3">
          <div className="grid grid-cols-2 gap-x-3 gap-y-3">
            <div>
              <label className="block text-[11px] text-ink-muted mb-1 leading-tight">Amount (PHP) *</label>
              <input
                type="text" inputMode="decimal" className={CELL} placeholder="0.00"
                value={l.amount} onChange={e => patch(i, { amount: e.target.value })}
              />
            </div>
            <div>
              <label className="block text-[11px] text-ink-muted mb-1 leading-tight">Mode *</label>
              <select className={CELL} value={l.mode} onChange={e => patch(i, { mode: e.target.value })}>
                <option value="" disabled>Select…</option>
                {PAYMENT_MODES.map(m => <option key={m} value={m}>{PAYMENT_MODE_LABEL[m]}</option>)}
              </select>
            </div>
            <div>
              <label className="block text-[11px] text-ink-muted mb-1 leading-tight">{refLabel}{refRequired ? ' *' : ''}</label>
              <input
                type="text" className={CELL} placeholder={refRequired ? "Required" : "Optional"}
                value={l.refNo} onChange={e => patch(i, { refNo: e.target.value })}
              />
            </div>
            <div>
              <label className="block text-[11px] text-ink-muted mb-1 leading-tight">Date *</label>
              <input type="date" className={CELL} value={l.date} onChange={e => patch(i, { date: e.target.value })} />
            </div>
            {l.mode === 'BANK' && (
              <div className="col-span-2">
                <label className="block text-[11px] text-ink-muted mb-1 leading-tight">Bank reference</label>
                <input
                  type="text" className={CELL} placeholder="Optional, e.g. transfer ref no."
                  value={l.bankRef} onChange={e => patch(i, { bankRef: e.target.value })}
                />
              </div>
            )}
          </div>
          <div className="flex items-center justify-end gap-2 mt-3">
            {!free && i === lines.length - 1 && dueCents > 0 && (
              <button type="button" className="btn-xs blue" onClick={fillRemainder}>Fill remainder</button>
            )}
            {lines.length > minLines && (
              <button type="button" className="btn-xs red" onClick={() => remove(i)}>
                <X size={10} /> Remove line
              </button>
            )}
          </div>
        </div>
      ))}

      <div className="flex items-center justify-between gap-2 pt-0.5">
        <button type="button" className="btn-xs gray" onClick={add}><Plus size={10} /> {addLabel}</button>
        {free ? (
          lines.length > 0 && (
            <span className="text-[12px] font-semibold text-ink-secondary">
              Lines total {fmtCents(total)}{anyUnparsed ? ' · check the amounts' : ''}
            </span>
          )
        ) : (
        <span className={`text-[12px] font-semibold ${diff === 0 && !anyUnparsed ? 'text-success-text' : 'text-danger-text'}`}>
          Lines total {fmtCents(total)} of {fmtCents(dueCents)} due
          {anyUnparsed ? ' · check the amounts'
            : diff > 0 ? ` · Short ${fmtCents(diff)}`
            : diff < 0 ? ` · Over ${fmtCents(-diff)}` : ''}
        </span>
        )}
      </div>
    </div>
  )
}
