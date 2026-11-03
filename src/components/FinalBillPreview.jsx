import { useEffect, useMemo, useState } from 'react'
import { createPortal } from 'react-dom'
import { X } from 'lucide-react'
import FinalBillPages from './FinalBillPages'
import { buildPrintUnits, statementProps } from '../lib/finalBillStatement'

// The printed statement of an on-screen draft, before anything is saved. Writes nothing and stores nothing: it only renders the
// lines it is given. list = [{ bill, tenant }] as for the print page, with bill.status 'DRAFT'.
export default function FinalBillPreview({ list, onClose }) {
  const units = useMemo(() => buildPrintUnits(list), [list])
  const [billingDate, setBillingDate] = useState(() => String(list[0]?.bill.move_out_date || '').slice(0, 10))

  // While it is open, printing shows only this statement (see .fb-preview-open in index.css).
  useEffect(() => {
    document.body.classList.add('fb-preview-open')
    return () => document.body.classList.remove('fb-preview-open')
  }, [])

  return createPortal(
    <div className="fbp-root print-light" onClick={e => e.stopPropagation()}>
      <div className="no-print" style={{ maxWidth: 760, margin: '0 auto 16px', display: 'flex', gap: 12, flexWrap: 'wrap', alignItems: 'flex-end', background: '#fff', padding: 14, borderRadius: 10, border: '1px solid #e2e8f0' }}>
        <button type="button" className="btn secondary" onClick={onClose}><X size={14} /> Close preview</button>
        <div className="fg" style={{ maxWidth: 150 }}><label>Billing Date</label>
          <input type="date" value={billingDate} onChange={e => setBillingDate(e.target.value)} /></div>
        <div style={{ marginLeft: 'auto', display: 'flex', gap: 8, alignItems: 'center' }}>
          <span style={{ fontSize: 12, color: '#b91c1c', fontWeight: 700 }}>Draft: nothing has been saved</span>
          <button type="button" className="btn primary" onClick={() => window.print()}>🖨 Print / Save PDF</button>
        </div>
      </div>
      {units.map(u => (
        <FinalBillPages key={u.key} propsFor={copyLabel => statementProps(u, { copyLabel, preparedBy: u.view.prepared_by, billingDate, draft: true })} />
      ))}
    </div>,
    document.body,
  )
}
