import { useState, useEffect } from 'react'
import { useSearchParams, Link } from 'react-router-dom'
import { fetchFinalBill, fetchFinalBillGroup, supabase } from '../lib/supabase'
import { buildPrintUnits, statementProps, peso } from '../lib/finalBillStatement'
import FinalBillPages from '../components/FinalBillPages'

export default function PrintFinalBill() {
  const [params] = useSearchParams()
  const ids = (params.get('ids') ? params.get('ids').split(',') : [params.get('id')]).map(Number).filter(n => Number.isFinite(n) && n > 0)
  const idsKey = ids.join(',')

  const [units, setUnits]     = useState([])
  const [loading, setLoading] = useState(true)
  const [error, setError]     = useState('')
  const [prepared, setPrepared] = useState({})
  const [series, setSeries] = useState({})
  const [billingDate, setBillingDate] = useState('')

  useEffect(() => {
    (async () => {
      try {
        const list = []
        for (const id of idsKey.split(',').filter(Boolean)) {
          let b
          try { b = await fetchFinalBill(Number(id)) } catch (e) {
            if (e?.code === 'PGRST116' || /coerce|0 rows|no rows/i.test(e?.message || '')) {
              throw new Error(idsKey.includes(',') ? `Final bill #${id} not found.` : 'Final bill not found.')
            }
            throw e
          }
          if (!b) throw new Error(idsKey.includes(',') ? `Final bill #${id} not found.` : 'Final bill not found.')
          const { data: t, error: tErr } = await supabase
            .from('tenants')
            .select('name, beds!bed_id(bed_letter, rooms(room_no))')
            .eq('id', b.tenant_id)
            .single()
          if (tErr) throw tErr
          list.push({ bill: b, tenant: t })
        }
        if (!list.length) throw new Error('Final bill not found.')
        // Printing one bed of a tenant's several beds opens the whole group.
        const byId = new Map(list.map(x => [x.bill.id, x]))
        for (const x of list) {
          if (x.bill.status === 'VOID') continue
          for (const g of await fetchFinalBillGroup(x.bill, x.tenant)) if (!byId.has(g.bill.id)) byId.set(g.bill.id, g)
        }
        const built = buildPrintUnits([...byId.values()])
        setUnits(built)
        setPrepared(Object.fromEntries(built.map(u => [u.key, u.view.prepared_by || ''])))
        setSeries(Object.fromEntries(built.map(u => [u.key, u.key])))
        setBillingDate(String(built[0].view.move_out_date).slice(0, 10))
      } catch (e) { setError(e.message) }
      setLoading(false)
    })()
  }, [idsKey])

  if (loading) return <div className="loading-screen"><div className="spinner" /></div>
  if (!units.length) return <div className="page"><p>{error || 'Final bill not found.'} <Link to="/tenants">Back</Link></p></div>

  const allNet = units.filter(u => u.view.status !== 'VOID').reduce((s, u) => s + Math.round(Number(u.view.net_amount) * 100), 0) / 100
  return (
    <div className="print-light" style={{ background: '#F0F4F8', minHeight: '100vh', padding: '16px 0' }}>
      <div className="no-print" style={{ maxWidth: 760, margin: '0 auto 16px', display: 'flex', gap: 12, flexWrap: 'wrap', alignItems: 'flex-end', background: '#fff', padding: 14, borderRadius: 10, border: '1px solid #e2e8f0' }}>
        <Link to="/tenants" className="btn secondary">← Back</Link>
        <div className="fg" style={{ maxWidth: 150 }}><label>Billing Date</label>
          <input type="date" value={billingDate} onChange={e => setBillingDate(e.target.value)} /></div>
        {units.map(u => (
          <div key={u.key} style={{ display: 'flex', gap: 12, alignItems: 'flex-end' }}>
            <div className="fg" style={{ maxWidth: 100 }}>
              <label>Series{units.length > 1 ? ` (${u.label})` : ''}</label>
              <input type="number" min="0" value={series[u.key] ?? ''} onChange={e => setSeries(p => ({ ...p, [u.key]: Number(e.target.value) || 0 }))} />
            </div>
            <div className="fg" style={{ maxWidth: 180 }}>
              <label>Prepared by{units.length > 1 ? ` (${u.label})` : ''}</label>
              <input type="text" value={prepared[u.key] ?? ''} onChange={e => setPrepared(p => ({ ...p, [u.key]: e.target.value }))} placeholder="Name" />
            </div>
          </div>
        ))}
        <div style={{ marginLeft: 'auto', display: 'flex', gap: 8, alignItems: 'center' }}>
          <span style={{ fontSize: 12, color: '#64748B' }}>
            Final bill{units.flatMap(u => u.items).length > 1 ? 's' : ''} {units.flatMap(u => u.items).map(x => `#${x.bill.id}${x.bill.status === 'VOID' ? ' (VOID)' : ''}`).join(', ')}
          </span>
          <button className="btn primary" onClick={() => window.print()}>🖨 Print / Save PDF</button>
        </div>
        {units.length > 1 && (
          <div style={{ flexBasis: '100%', fontSize: 13, color: '#0f172a' }}>
            {units.map(u => (
              <div key={u.key}>{u.label} — {u.tenant?.name}: {Number(u.view.net_amount) < 0 ? `amount to be returned ${peso(-u.view.net_amount)}` : `total amount due ${peso(u.view.net_amount)}`}</div>
            ))}
            <div style={{ fontWeight: 700, marginTop: 4, color: allNet < 0 ? '#15803d' : undefined }}>
              Combined: {allNet < 0 ? `amount to be returned ${peso(-allNet)}` : `total amount due ${peso(allNet)}`}
            </div>
          </div>
        )}
      </div>

      {units.map(u => (
        <FinalBillPages key={u.key} propsFor={copyLabel => statementProps(u, { copyLabel, series: series[u.key], preparedBy: prepared[u.key], billingDate })}
          voidText={u.view.status === 'VOID' ? `VOID${u.view.void_reason ? ` — ${u.view.void_reason}` : ''}` : ''} />
      ))}
    </div>
  )
}
