import { useState, useEffect, useMemo } from 'react'
import {
  fetchCutoffs, fetchTenants, recordPayment,
  fetchPaymentsForCutoff, fetchUtilityBill, fetchInterimReadings,
  fetchSplits, fetchAddons, fetchAreaReadings,
} from '../lib/supabase'
import { computeBilling } from '../lib/billing'
import { getCachedBilling, cacheBilling } from '../lib/billingCache'
import { useToast } from '../components/Toast'
import { Droplets, Zap, Wallet } from 'lucide-react'

function fmt(n) { return n ? '₱' + Number(n).toLocaleString('en-PH', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) : '—' }
function fmtDate(d) {
  if (!d) return '—'
  return new Date(d).toLocaleDateString('en-PH', { month: 'short', day: 'numeric', year: 'numeric' })
}
function todayStr() { return new Date().toISOString().slice(0, 10) }

// ── Inline payment entry ───────────────────────────────────────────────────────

const fmtPeso = n => '₱' + Number(n).toLocaleString('en-PH', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
const parseAmt = v => parseFloat(String(v).replace(/[₱,\s]/g, '')) || 0

function InlinePayCell({ onRecord, defaultAmount }) {
  const [display, setDisplay] = useState(defaultAmount != null ? fmtPeso(defaultAmount) : '')
  const [busy,    setBusy]    = useState(false)

  function handleFocus(e) {
    const n = parseAmt(display)
    setDisplay(n > 0 ? String(n) : '')
    e.target.select()
  }

  function handleBlur() {
    const n = parseAmt(display)
    if (n > 0) setDisplay(fmtPeso(n))
  }

  async function submit() {
    const n = parseAmt(display)
    if (n <= 0 || busy) return
    setBusy(true)
    try { await onRecord(n) }
    finally { setBusy(false); setDisplay('') }
  }

  return (
    <div className="flex items-center gap-1.5">
      <input
        type="text"
        value={display}
        onChange={e => setDisplay(e.target.value)}
        onFocus={handleFocus}
        onBlur={handleBlur}
        onKeyDown={e => e.key === 'Enter' && submit()}
        placeholder="₱ 0.00"
        disabled={busy}
        className="w-32 px-2.5 py-1.5 text-[13px] rounded-lg bg-white focus:outline-none focus:ring-2 focus:ring-navy-500/25 transition-colors"
        style={{ border: '1px solid #E8E2D9' }}
      />
      <button
        onClick={submit}
        disabled={parseAmt(display) <= 0 || busy}
        className="w-7 h-7 flex items-center justify-center rounded-full bg-emerald-500 text-white text-[13px] font-bold hover:bg-emerald-600 disabled:opacity-30 disabled:cursor-not-allowed transition-colors shrink-0"
      >
        {busy
          ? <span className="w-3 h-3 border-2 border-white border-t-transparent rounded-full animate-spin inline-block" />
          : '✓'}
      </button>
    </div>
  )
}

function PaidCell({ pays, onAdd }) {
  const [adding, setAdding] = useState(false)
  const total    = pays.reduce((s, p) => s + Number(p.amount), 0)
  const lastDate = pays[0]?.payment_date

  return (
    <div className="space-y-1.5">
      <div className="flex items-center gap-2 flex-wrap">
        <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-bold bg-emerald-50 text-emerald-700 border border-emerald-100">
          ✓ Paid
        </span>
        <span className="text-[13px] font-semibold text-emerald-700">
          ₱{Number(total).toLocaleString('en-PH', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
        </span>
        <span className="text-[11px] text-slate-400">{fmtDate(lastDate)}</span>
        <button
          onClick={() => setAdding(a => !a)}
          className="text-[11px] text-slate-400 hover:text-navy-600 underline transition-colors"
        >
          {adding ? 'cancel' : '+ add'}
        </button>
      </div>
      {adding && (
        <InlinePayCell onRecord={async n => { await onAdd(n); setAdding(false) }} />
      )}
    </div>
  )
}

// ── Collections Page ───────────────────────────────────────────────────────────

export default function Collections() {
  const [tenants,         setTenants]         = useState([])
  const [loading,         setLoading]         = useState(true)
  const [activeCutoff,    setActiveCutoff]    = useState(null)
  const [cutoffPayments,  setCutoffPayments]  = useState([])
  const [billingPerTenant,setBillingPerTenant]= useState([])
  const { show, ToastEl } = useToast()

  useEffect(() => { load() }, [])

  async function load() {
    setLoading(true)
    try {
      const allTenants = await fetchTenants()
      setTenants(allTenants)

      const cuts   = await fetchCutoffs()
      const active = cuts.find(c => c.is_active) || cuts[0] || null
      setActiveCutoff(active)

      if (active) {
        const cached = getCachedBilling(active.id)
        if (cached) {
          const cutoffPays = await fetchPaymentsForCutoff(active.id)
          setCutoffPayments(cutoffPays)
          setBillingPerTenant(cached)
        } else {
          const [cutoffPays, bill, ir, sp, ad, ar] = await Promise.all([
            fetchPaymentsForCutoff(active.id),
            fetchUtilityBill(active.id),
            fetchInterimReadings(active.id),
            fetchSplits(active.id),
            fetchAddons(active.id),
            fetchAreaReadings(active.id),
          ])
          setCutoffPayments(cutoffPays)
          if (bill.length) {
            const { perTenant } = computeBilling(active, bill, ir, allTenants, sp, ad, ar)
            cacheBilling(active.id, perTenant)
            setBillingPerTenant(perTenant)
          }
        }
      }
    } catch(e) { show(e.message, 'error') }
    setLoading(false)
  }

  const enriched = useMemo(() =>
    tenants.filter(t => t.is_active).map(t => ({
      ...t,
      room_no:      t.beds?.rooms?.room_no   || '',
      bed_letter:   t.beds?.bed_letter       || '',
      bed_location: t.beds?.bed_location     || '',
    }))
  , [tenants])

  const collectionRows = useMemo(() =>
    enriched.map(t => {
      const tPays    = cutoffPayments.filter(p => p.tenant_id === t.id)
      const rwPays   = tPays.filter(p => p.category === 'RENT_WATER')
      const elecPays = tPays.filter(p => p.category === 'ELECTRICITY')
      return { ...t, rwPays, elecPays }
    })
  , [enriched, cutoffPayments])

  const billingMap = useMemo(() => {
    const r2 = n => Math.round(n * 100) / 100
    return new Map(billingPerTenant.map(t => [t.id, {
      rw:   r2((t.rent || 0) + (t.water || 0) + (t.addonRentWater || 0)),
      elec: r2((t.elec  || 0) + (t.addonElectric || 0)),
    }]))
  }, [billingPerTenant])

  async function handleInlineRecord(tenant, category, amount) {
    await recordPayment(tenant.id, {
      payment_date:  todayStr(),
      amount:        Number(amount),
      category,
      cutoff_id:     activeCutoff?.id   || null,
      _tenant_name:  tenant.name,
      _room_no:      tenant.room_no,
      _bed_letter:   tenant.bed_letter,
      _cutoff_name:  activeCutoff?.name || null,
    })
    setCutoffPayments(prev => [...prev, {
      id:           Date.now(),
      tenant_id:    tenant.id,
      payment_date: todayStr(),
      amount:       Number(amount),
      category,
      cutoff_id:    activeCutoff?.id,
    }])
    show('Payment recorded.', 'success')
  }

  if (loading) return (
    <div className="loading-screen"><div className="spinner" /></div>
  )

  const rwPaid    = collectionRows.reduce((s, r) => s + r.rwPays.reduce((ss, p) => ss + Number(p.amount), 0), 0)
  const elecPaid  = collectionRows.reduce((s, r) => s + r.elecPays.reduce((ss, p) => ss + Number(p.amount), 0), 0)
  const rwCount   = collectionRows.filter(r => r.rwPays.length > 0).length
  const elecCount = collectionRows.filter(r => r.elecPays.length > 0).length
  const n         = collectionRows.length

  return (
    <div className="page">
      {/* ── Header ── */}
      <div className="page-header">
        <div>
          <h1 className="page-title">Collections <small>{activeCutoff?.name ?? ''}</small></h1>
          {activeCutoff && (
            <p className="page-sub text-[11px] flex items-center gap-1.5 flex-wrap">
              <Droplets size={11} className="text-blue-500 shrink-0" />
              Water {fmtDate(activeCutoff.water_start)}–{fmtDate(activeCutoff.water_end)}
              {' · '}
              <Zap size={11} className="text-amber-500 shrink-0" />
              Electric {fmtDate(activeCutoff.electric_start)}–{fmtDate(activeCutoff.electric_end)}
            </p>
          )}
        </div>
      </div>

      {!activeCutoff ? (
        <div className="card mt-4">
          <div className="empty">
            <Wallet size={32} className="mx-auto mb-3 text-slate-300" />
            <p>No active cutoff. Open one in Utilities first.</p>
          </div>
        </div>
      ) : (
        <>
          {/* Summary bar */}
          <div className="toolbar mt-4 flex-wrap gap-y-2 items-center">
            <span className="text-slate-500 text-[12px]">
              Rent+Water: <strong className="text-emerald-600">{rwCount}/{n}</strong> paid
              {rwPaid > 0 && <strong className="text-navy-600 ml-1">· {fmt(rwPaid)}</strong>}
            </span>
            <span className="text-slate-200">|</span>
            <span className="text-slate-500 text-[12px]">
              Electricity: <strong className="text-emerald-600">{elecCount}/{n}</strong> paid
              {elecPaid > 0 && <strong className="text-navy-600 ml-1">· {fmt(elecPaid)}</strong>}
            </span>
          </div>

          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Tenant</th>
                  <th>Room / Bed</th>
                  <th>Rent + Water <span className="font-normal text-slate-400 text-[10px]">(due EOM)</span></th>
                  <th>Electricity <span className="font-normal text-slate-400 text-[10px]">(due 10th)</span></th>
                </tr>
              </thead>
              <tbody>
                {collectionRows.length === 0 ? (
                  <tr><td colSpan={4}><div className="empty"><p>No active tenants.</p></div></td></tr>
                ) : collectionRows.map(r => (
                  <tr key={r.id}>
                    <td className="td-name">{r.name}</td>
                    <td className="text-[12px] text-slate-500">
                      Rm {r.room_no} · {r.bed_letter}
                      {r.bed_location && <span className="text-slate-400 ml-1">{r.bed_location}</span>}
                    </td>
                    <td>
                      {r.rwPays.length > 0
                        ? <PaidCell pays={r.rwPays} onAdd={n => handleInlineRecord(r, 'RENT_WATER', n)} />
                        : <InlinePayCell onRecord={n => handleInlineRecord(r, 'RENT_WATER', n)} defaultAmount={billingMap.get(r.id)?.rw || undefined} />
                      }
                    </td>
                    <td>
                      {r.elecPays.length > 0
                        ? <PaidCell pays={r.elecPays} onAdd={n => handleInlineRecord(r, 'ELECTRICITY', n)} />
                        : <InlinePayCell onRecord={n => handleInlineRecord(r, 'ELECTRICITY', n)} defaultAmount={billingMap.get(r.id)?.elec || undefined} />
                      }
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}

      {ToastEl}
    </div>
  )
}
