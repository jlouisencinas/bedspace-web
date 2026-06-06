import { useState, useEffect, useMemo } from 'react'
import { useSearchParams, Link } from 'react-router-dom'
import { fetchCutoffs, fetchUtilityBill, fetchInterimReadings, fetchTenants, fetchSplits, fetchAddons, fetchAreaReadings } from '../lib/supabase'
import { computeBilling } from '../lib/billing'
import Statement from '../components/Statement'

const COMPANY = {
  address:    'JP Rizal ext., Cor Lapu-Lapu street, Brgy. West Rembo, Taguig City',
  bankName:   'NJL Corp.',
  bankAcct:   '00 138 802 7530',
  bankBranch: 'BDO Valero-Salcedo Branch',
}

const peso = n => '₱' + Number(n || 0).toLocaleString('en-PH', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
const kwh  = n => Number(n || 0).toLocaleString('en-PH', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
const reading = n => String(Math.round(Number(n) || 0))   // meter readings: integer, no comma

const MO = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec']
const fmt = (iso) => { if (!iso) return ''; const [y,m,d] = iso.slice(0,10).split('-'); return `${+d}-${MO[+m-1]}-${y}` }
const addDays = (iso, n) => new Date(Date.parse(iso.slice(0,10)+'T00:00:00Z') + n*86400000).toISOString().slice(0,10)
// Electricity period is 10th → 10th (end date is the reading date, inclusive)
const periodLabelIncl = (start, end) => {
  const [, sm, sd] = start.slice(0,10).split('-'); const [, em, ed] = end.slice(0,10).split('-')
  return `${+sd} ${MO[+sm-1]} - ${+ed} ${MO[+em-1]}`
}

export default function PrintElectricity() {
  const [params] = useSearchParams()
  const cutoffId = Number(params.get('cutoff'))

  const [cutoff, setCutoff] = useState(null)
  const [bill, setBill]     = useState([])
  const [interims, setInterims] = useState([])
  const [tenants, setTenants] = useState([])
  const [splits, setSplits] = useState([])
  const [addons, setAddons] = useState([])
  const [areas, setAreas] = useState([])
  const [loading, setLoading] = useState(true)

  const [billingDate, setBillingDate] = useState('')
  const [billStart, setBillStart]     = useState(1)
  const [preparedBy, setPreparedBy]   = useState('')

  useEffect(() => {
    (async () => {
      try {
        const cs = await fetchCutoffs()
        const c = cs.find(x => x.id === cutoffId)
        setCutoff(c)
        const [b, ir, t, sp, ad, ar] = await Promise.all([
          fetchUtilityBill(cutoffId), fetchInterimReadings(cutoffId), fetchTenants(),
          fetchSplits(cutoffId), fetchAddons(cutoffId), fetchAreaReadings(cutoffId),
        ])
        setBill(b); setInterims(ir); setTenants(t); setSplits(sp); setAddons(ad); setAreas(ar)
        if (c) setBillingDate(c.electric_end)   // reading is taken ON the 10th
      } catch (e) { console.error(e) }
      setLoading(false)
    })()
  }, [cutoffId])

  const { perTenant } = useMemo(() => {
    if (!cutoff || !bill.length) return { perTenant: [] }
    return computeBilling(cutoff, bill, interims, tenants, splits, addons, areas)
  }, [cutoff, bill, interims, tenants, splits, addons, areas])

  const roomMap = useMemo(() => {
    const m = {}; bill.forEach(b => { m[b.room_id] = b }); return m
  }, [bill])

  const statements = useMemo(
    () => perTenant.filter(t => (t.elec + (t.addonElectric || 0)) > 0.01),
    [perTenant]
  )

  if (loading) return <div className="loading-screen"><div className="spinner" /></div>
  if (!cutoff) return <div className="page"><p>Cutoff not found. <Link to="/billing">Back</Link></p></div>

  const asOf   = cutoff.electric_end                 // the 10th (reading date)
  const due    = billingDate ? addDays(billingDate, 7) : ''
  const period = periodLabelIncl(cutoff.electric_start, cutoff.electric_end)

  const buildProps = (t, billNo, copyLabel) => {
    const room = roomMap[t.room_id] || {}
    const sp = splits.find(s => s.room_id === t.room_id && s.tenant_id === t.id && s.utility === 'ELECTRIC')
    const charges = []
    if (!t.special || t.elec > 0) charges.push({ label: 'Electricity (kWh)', mid: kwh(t.elecCons), amount: t.elec })
    ;(t.addons || []).filter(a => a.bill_on === 'ELECTRIC').forEach(a =>
      charges.push({ label: `Add: ${a.label}${a.recurring ? '' : ' · one-time'}`, mid: '', amount: Number(a.amount) }))
    return {
      company: COMPANY, copyLabel, peso,
      name: t.name, room: t.room_no, asOf: fmt(asOf), due: fmt(due), billNo, preparedBy,
      charges,
      total: t.elec + (t.addonElectric || 0),
      details: t.special ? null : {
        header: ['', 'Previous Reading', 'Current Reading', 'Actual Room Consumption (kWh)', 'Personal Consumption'],
        rows: [['Electric', reading(room.elec_prev), reading(room.elec_curr),
                kwh((Number(room.elec_curr) || 0) - (Number(room.elec_prev) || 0)), kwh(t.elecCons)]],
      },
      asOfNote: t.special ? '' : `** current reading as of ${fmt(asOf)}`,
      splitNote: sp ? `** custom split: ${Number(sp.weight_pct)}% of room electricity` : '',
    }
  }

  return (
    <div style={{ background: '#F0F4F8', minHeight: '100vh', padding: '16px 0' }}>
      <div className="no-print" style={{ maxWidth: 760, margin: '0 auto 16px', display: 'flex', gap: 12, flexWrap: 'wrap', alignItems: 'flex-end', background: '#fff', padding: 14, borderRadius: 10, border: '1px solid #e2e8f0' }}>
        <Link to="/billing" className="btn secondary">← Back</Link>
        <div className="fg" style={{ maxWidth: 150 }}><label>Billing Date</label>
          <input type="date" value={billingDate} onChange={e => setBillingDate(e.target.value)} /></div>
        <div className="fg" style={{ maxWidth: 110 }}><label>Start Bill No.</label>
          <input type="number" value={billStart} onChange={e => setBillStart(Number(e.target.value) || 1)} /></div>
        <div className="fg" style={{ maxWidth: 180 }}><label>Prepared by</label>
          <input type="text" value={preparedBy} onChange={e => setPreparedBy(e.target.value)} placeholder="Name" /></div>
        <div style={{ marginLeft: 'auto', display: 'flex', gap: 8, alignItems: 'center' }}>
          <span style={{ fontSize: 12, color: '#64748B' }}>{statements.length} bill(s) · Electricity</span>
          <button className="btn primary" onClick={() => window.print()}>🖨 Print / Save PDF</button>
        </div>
      </div>

      {statements.map((t, i) => {
        const billNo = String(billStart + i).padStart(4, '0')
        return (
          <div className="a4page" key={t.id}>
            <Statement {...buildProps(t, billNo, "Tenant's Copy")} />
            <div className="cutline" />
            <Statement {...buildProps(t, billNo, "Owner's Copy")} />
          </div>
        )
      })}
    </div>
  )
}
