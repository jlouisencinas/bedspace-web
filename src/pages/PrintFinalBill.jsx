import { useState, useEffect } from 'react'
import { useSearchParams, Link } from 'react-router-dom'
import { fetchFinalBill, supabase } from '../lib/supabase'
import Statement from '../components/Statement'

const COMPANY = {
  address:    'JP Rizal ext., Cor Lapu-Lapu street, Brgy. West Rembo, Taguig City',
  bankName:   'NJL Corp.',
  bankAcct:   '00 138 802 7530',
  bankBranch: 'BDO Valero-Salcedo Branch',
}

const peso = n => '₱' + Number(n || 0).toLocaleString('en-PH', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
const signedPeso = n => (Number(n) < 0 ? '-' : '') + peso(Math.abs(Number(n) || 0))
const rate = n => '₱' + Number(n || 0).toLocaleString('en-PH', { minimumFractionDigits: 2, maximumFractionDigits: 4 })
const cu = n => Number(n || 0).toLocaleString('en-PH', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
const reading = n => (n == null ? '—' : Number(n).toLocaleString('en-PH', { maximumFractionDigits: 2, useGrouping: false }))

const MO = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec']
const fmt = (iso) => { if (!iso) return ''; const [y,m,d] = iso.slice(0,10).split('-'); return `${+d}-${MO[+m-1]}-${y}` }

function toCharge(l) {
  const credit = l.kind === 'credit'
  const forfeit = l.kind === 'forfeit'
  return {
    label: l.label,
    mid: forfeit && l.original != null ? [l.mid, `${peso(l.original)} forfeited`].filter(Boolean).join(' · ') : l.mid,
    rateText: l.rate != null ? rate(l.rate) : undefined,
    amount: l.amount,
    amountText: credit || Number(l.amount) < 0 ? signedPeso(l.amount) : undefined,
    italic: l.kind === 'unsettled',
  }
}

export default function PrintFinalBill() {
  const [params] = useSearchParams()
  const billId = Number(params.get('id'))

  const [bill, setBill]       = useState(null)
  const [tenant, setTenant]   = useState(null)
  const [loading, setLoading] = useState(true)
  const [error, setError]     = useState('')
  const [preparedBy, setPreparedBy] = useState('')

  useEffect(() => {
    (async () => {
      try {
        const b = await fetchFinalBill(billId)
        const { data: t, error: tErr } = await supabase
          .from('tenants')
          .select('name, beds!bed_id(bed_letter, rooms(room_no))')
          .eq('id', b.tenant_id)
          .single()
        if (tErr) throw tErr
        setBill(b); setTenant(t); setPreparedBy(b.prepared_by || '')
      } catch (e) { setError(e.message) }
      setLoading(false)
    })()
  }, [billId])

  if (loading) return <div className="loading-screen"><div className="spinner" /></div>
  if (!bill) return <div className="page"><p>{error || 'Final bill not found.'} <Link to="/tenants">Back</Link></p></div>

  const net = Number(bill.net_amount)
  const refund = net < 0
  const d = bill.details || {}
  const rows = []
  if (d.water)    rows.push(['Water', reading(d.water.prev), reading(d.water.curr), d.water.roomCons != null ? cu(d.water.roomCons) : '—', cu(d.water.personalCons)])
  if (d.electric) rows.push(['Electricity', reading(d.electric.prev), reading(d.electric.curr), d.electric.roomCons != null ? cu(d.electric.roomCons) : '—', cu(d.electric.personalCons)])

  const props = (copyLabel) => ({
    company: COMPANY, copyLabel, peso,
    name: tenant?.name, room: tenant?.beds?.rooms?.room_no ?? '',
    asOf: fmt(bill.move_out_date), due: fmt(bill.move_out_date), billNo: 'FINAL', preparedBy,
    charges: bill.lines.map(toCharge),
    total: Math.abs(net),
    totalLabel: refund ? 'Amount to be returned:' : 'Total amount due',
    totalColor: refund ? '#15803d' : undefined,
    details: rows.length ? {
      header: ['', 'Previous Reading', 'Current Reading', 'Actual Room Consumption', 'Personal Consumption'],
      rows,
    } : null,
    asOfNote: rows.length ? `** Current Reading as of ${fmt(bill.move_out_date)}` : '',
  })

  return (
    <div style={{ background: '#F0F4F8', minHeight: '100vh', padding: '16px 0' }}>
      <div className="no-print" style={{ maxWidth: 760, margin: '0 auto 16px', display: 'flex', gap: 12, flexWrap: 'wrap', alignItems: 'flex-end', background: '#fff', padding: 14, borderRadius: 10, border: '1px solid #e2e8f0' }}>
        <Link to="/tenants" className="btn secondary">← Back</Link>
        <div className="fg" style={{ maxWidth: 200 }}><label>Prepared by</label>
          <input type="text" value={preparedBy} onChange={e => setPreparedBy(e.target.value)} placeholder="Name" /></div>
        <div style={{ marginLeft: 'auto', display: 'flex', gap: 8, alignItems: 'center' }}>
          <span style={{ fontSize: 12, color: '#64748B' }}>Final bill #{bill.id}{bill.status === 'VOID' ? ' · VOID' : ''}</span>
          <button className="btn primary" onClick={() => window.print()}>🖨 Print / Save PDF</button>
        </div>
      </div>

      <div className="a4page">
        {bill.status === 'VOID' && (
          <div style={{ textAlign: 'center', color: '#dc2626', fontWeight: 800, fontSize: 14, marginBottom: 6 }}>
            VOID{bill.void_reason ? ` — ${bill.void_reason}` : ''}
          </div>
        )}
        <Statement {...props("Tenant's Copy")} />
        <div className="cutline" />
        <Statement {...props("Owner's Copy")} />
      </div>
    </div>
  )
}
