import { useState, useEffect, useRef } from 'react'
import { useSearchParams, Link } from 'react-router-dom'
import { fetchFinalBill, fetchFinalBillGroup, fetchTenantDeposits, correctReceiptRef, DEPOSIT_REF_LABEL, DEPOSIT_KIND_LABEL, supabase } from '../lib/supabase'
import { receiptRefsNeeded } from '../lib/finalBill'
import { buildPrintUnits, statementProps, peso } from '../lib/finalBillStatement'
import { useAuth } from '../lib/auth'
import FinalBillPages from '../components/FinalBillPages'

export default function PrintFinalBill() {
  const [params] = useSearchParams()
  const { isAdmin } = useAuth()
  const ids = (params.get('ids') ? params.get('ids').split(',') : [params.get('id')]).map(Number).filter(n => Number.isFinite(n) && n > 0)
  const idsKey = ids.join(',')

  const [units, setUnits]     = useState([])
  const [loading, setLoading] = useState(true)
  const [error, setError]     = useState('')
  const [prepared, setPrepared] = useState({})
  const [series, setSeries] = useState({})
  const [billingDate, setBillingDate] = useState('')
  const [reload, setReload] = useState(0)
  const [refRows, setRefRows] = useState([])
  const [refErr, setRefErr] = useState('')
  const [fixId, setFixId] = useState(null)
  const [fixVal, setFixVal] = useState('')
  const [fixBusy, setFixBusy] = useState(false)
  const [fixMsg, setFixMsg] = useState(null)
  const fixDone = useRef(null)

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
        if (!reload) {
          setPrepared(Object.fromEntries(built.map(u => [u.key, u.view.prepared_by || ''])))
          setSeries(Object.fromEntries(built.map(u => [u.key, u.key])))
          setBillingDate(String(built[0].view.move_out_date).slice(0, 10))
        }
        if (isAdmin) {
          try {
            const rows = []
            for (const u of built) {
              for (const it of u.items) {
                if (it.bill.status !== 'FINAL') continue
                const deps = await fetchTenantDeposits(it.bill.tenant_id)
                for (const e of receiptRefsNeeded(it.bill.lines, deps)) {
                  rows.push({ billId: it.bill.id, bed: it.bed, entry: e, status: deps.find(d => d.id === e.deposit_id)?.status })
                }
              }
            }
            setRefRows(rows); setRefErr('')
          } catch (e) { setRefErr(e.message); throw e }
        }
        if (fixDone.current) { setFixMsg({ ok: true, text: fixDone.current }); fixDone.current = null }
      } catch (e) {
        if (fixDone.current) {
          setFixMsg({ ok: false, text: `The number was saved, but reloading the bill failed (${e.message}). Reload the page before printing.` })
          fixDone.current = null
        } else setError(e.message)
      }
      setLoading(false)
    })()
  }, [idsKey, reload, isAdmin])

  async function saveFix(depositId) {
    setFixBusy(true); setFixMsg(null)
    try {
      const r = await correctReceiptRef(depositId, fixVal)
      setFixId(null); setFixVal('')
      fixDone.current = r?.changed === false ? 'The number was already on file; nothing changed.' : 'Receipt number corrected; the bill was updated.'
      setReload(n => n + 1)
    } catch (e) { setFixMsg({ ok: false, text: e.message }) }
    setFixBusy(false)
  }

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

      {isAdmin && (refRows.length > 0 || refErr) && (
        <div className="no-print bg-surface border border-line rounded-xl text-[12px] text-ink space-y-2" style={{ maxWidth: 760, margin: '0 auto 16px', padding: 14 }}>
          <div className="text-[10px] font-semibold text-ink-faint uppercase tracking-wider">Receipt numbers (admin)</div>
          {refErr && <div className="text-danger-text">Could not load the receipts: {refErr}</div>}
          {refRows.map(({ billId, bed, entry: e, status }) => {
            const label = DEPOSIT_REF_LABEL[e.kind]
            const fixable = !e.locked && (status === 'APPLIED' || status === 'FORFEITED')
            return (
              <div key={`${billId}-${e.deposit_id}`} className="flex flex-wrap items-center gap-x-2 gap-y-1 border-t border-line-subtle pt-2">
                <span className="font-semibold">Bed {bed}</span>
                <span className="text-ink-muted">{DEPOSIT_KIND_LABEL[e.kind]} {peso(e.amount)} · receipt #{e.deposit_id} · {status}</span>
                <span>{label} {String(e.current ?? '').trim() || '—'}{e.locked ? ' (from the reservation payment)' : ''}</span>
                {fixable && fixId !== e.deposit_id && (
                  <button type="button" className="btn-xs blue ml-auto" disabled={fixBusy} onClick={() => { setFixId(e.deposit_id); setFixVal(e.current || ''); setFixMsg(null) }}>Fix</button>
                )}
                {fixId === e.deposit_id && (
                  <div className="flex items-center gap-2 w-full sm:w-auto sm:ml-auto">
                    <input type="text" className="flex-1 sm:flex-none sm:w-40 min-w-0" value={fixVal} autoComplete="off" maxLength={60}
                      placeholder={`${label} number`} onChange={ev => setFixVal(ev.target.value)} />
                    <button type="button" className="btn-xs blue" disabled={fixBusy} onClick={() => saveFix(e.deposit_id)}>{fixBusy ? 'Saving…' : 'Save'}</button>
                    <button type="button" className="btn-xs gray" disabled={fixBusy} onClick={() => setFixId(null)}>Cancel</button>
                  </div>
                )}
              </div>
            )
          })}
          {fixMsg && <div className={`whitespace-pre-wrap ${fixMsg.ok ? 'text-success-text' : 'text-danger-text'}`}>{fixMsg.text}</div>}
        </div>
      )}

      {units.map(u => (
        <FinalBillPages key={u.key} propsFor={copyLabel => statementProps(u, { copyLabel, series: series[u.key], preparedBy: prepared[u.key], billingDate })}
          voidText={u.view.status === 'VOID' ? `VOID${u.view.void_reason ? ` — ${u.view.void_reason}` : ''}` : ''} />
      ))}
    </div>
  )
}
