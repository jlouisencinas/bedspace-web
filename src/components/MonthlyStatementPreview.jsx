import { useEffect, useMemo, useState } from 'react'
import { createPortal } from 'react-dom'
import { X } from 'lucide-react'
import Statement from './Statement'
import {
  rentWaterRows, electricityRows, rentWaterProps, electricityProps,
  rentWaterDefaultBillingDate, electricityDefaultBillingDate, REPRINT_BANNER,
} from '../lib/monthlyStatement'

const todayIso = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Manila', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date())

// One tenant's monthly statement (Tenant's + Owner's copy) exactly as the print page renders it. Writes nothing.
// component 'RW' | 'ELEC'; row = the perTenant row (the primary bed's row for a whole-room rental);
// result / inputs = computeCutoffBilling result and its loadCutoffBillingInputs inputs for the cutoff.
export default function MonthlyStatementPreview({ component, cutoff, row, result, inputs, onClose }) {
  const isRW = component === 'RW'
  const defaultNo = useMemo(() => {
    const list = isRW ? rentWaterRows(result.perTenant) : electricityRows(result.perTenant)
    const i = list.findIndex(t => t.id === row.id)
    return i >= 0 ? i + 1 : 1
  }, [isRW, result, row])
  const [billingDate, setBillingDate] = useState(() => isRW ? rentWaterDefaultBillingDate(cutoff) : electricityDefaultBillingDate(cutoff))
  const [billNo, setBillNo] = useState(defaultNo)
  const [preparedBy, setPreparedBy] = useState('')
  const [showReprint, setShowReprint] = useState(true)

  // While it is open, printing shows only this statement (see .fb-preview-open in index.css).
  useEffect(() => {
    document.body.classList.add('fb-preview-open')
    return () => document.body.classList.remove('fb-preview-open')
  }, [])

  const roomRow = inputs.bill.find(b => b.room_id === row.room_id)
  const banner = showReprint ? REPRINT_BANNER(todayIso()) : undefined
  const no = String(billNo).padStart(4, '0')
  const propsFor = (copyLabel) => isRW
    ? rentWaterProps({ t: row, cutoff, roomRow, splits: inputs.splits, credit: result.credits.get(row.id), billNo: no, copyLabel, billingDate, preparedBy, banner })
    : electricityProps({ t: row, cutoff, roomRow, splits: inputs.splits, billNo: no, copyLabel, billingDate, preparedBy, banner })

  return createPortal(
    <div className="fbp-root print-light" onClick={e => e.stopPropagation()}>
      <div className="no-print" style={{ maxWidth: 760, margin: '0 auto 16px', display: 'flex', gap: 12, flexWrap: 'wrap', alignItems: 'flex-end', background: '#fff', padding: 14, borderRadius: 10, border: '1px solid #e2e8f0' }}>
        <button type="button" className="btn secondary" onClick={onClose}><X size={14} /> Close preview</button>
        <div className="fg" style={{ maxWidth: 150 }}><label>Billing Date</label>
          <input type="date" value={billingDate} onChange={e => setBillingDate(e.target.value)} /></div>
        <div className="fg" style={{ maxWidth: 110 }}><label>Bill No.</label>
          <input type="number" value={billNo} onChange={e => setBillNo(Number(e.target.value) || 1)} /></div>
        <div className="fg" style={{ maxWidth: 180 }}><label>Prepared by</label>
          <input type="text" value={preparedBy} onChange={e => setPreparedBy(e.target.value)} placeholder="Name" /></div>
        <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12, color: '#334155' }}>
          <input type="checkbox" checked={showReprint} onChange={e => setShowReprint(e.target.checked)} /> Show reprint notice
        </label>
        <div style={{ marginLeft: 'auto', display: 'flex', gap: 8, alignItems: 'center' }}>
          <span style={{ fontSize: 12, color: '#64748B' }}>{cutoff.name} · {isRW ? 'Rent + Water' : 'Electricity'} · recalculated</span>
          <button type="button" className="btn primary" onClick={() => window.print()}>🖨 Print / Save PDF</button>
        </div>
      </div>
      <div className="a4page">
        <Statement {...propsFor("Tenant's Copy")} />
        <div className="cutline" />
        <Statement {...propsFor("Owner's Copy")} />
      </div>
    </div>,
    document.body,
  )
}
