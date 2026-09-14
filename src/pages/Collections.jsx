import { useState, useEffect, useMemo } from 'react'
import {
  fetchCutoffs, fetchTenants, recordPaymentsBatch, voidPayments,
  fetchPaymentsForCutoff, fetchUtilityBill, fetchInterimReadings,
  fetchSplits, fetchAddons, fetchAreaReadings,
} from '../lib/supabase'
import { computeBilling } from '../lib/billing'
import { getCachedBilling, cacheBilling } from '../lib/billingCache'
import { useToast } from '../components/Toast'
import { Droplets, Zap, Wallet } from 'lucide-react'

const r2 = n => Math.round((Number(n) || 0) * 100) / 100

function fmt(n) { return n ? '₱' + Number(n).toLocaleString('en-PH', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) : '—' }
function fmtDate(d) {
  if (!d) return '—'
  return new Date(d).toLocaleDateString('en-PH', { month: 'short', day: 'numeric', year: 'numeric' })
}
function todayStr() { return new Date().toISOString().slice(0, 10) }

const fmtPeso = n => '₱' + Number(n || 0).toLocaleString('en-PH', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
const parseAmt = v => parseFloat(String(v).replace(/[₱,\s]/g, '')) || 0

function lastPaymentDate(pays) {
  return pays.reduce((max, p) => (!max || (p.payment_date && p.payment_date > max)) ? p.payment_date : max, null)
}

// ── Select-then-batch pay cell ─────────────────────────────────────────────────

function PayCell({ row, category, pays, billed, selected, onToggle, onAmountChange }) {
  const netPaid = r2(pays.reduce((s, p) => s + Number(p.amount || 0), 0))
  const key     = `${row.id}:${category}`
  const staged  = selected.get(key)

  if (netPaid > 0) {
    return (
      <div className="space-y-1.5">
        <div className="flex items-center gap-2 flex-wrap">
          <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-bold bg-emerald-50 text-emerald-700 border border-emerald-100">
            ✓ Paid
          </span>
          <span className="text-[13px] font-semibold text-emerald-700">{fmtPeso(netPaid)}</span>
          <span className="text-[11px] text-slate-400">{fmtDate(lastPaymentDate(pays))}</span>
          <button
            onClick={() => onToggle(row, category, 0)}
            className="text-[11px] text-slate-400 hover:text-navy-600 underline transition-colors"
          >
            {staged ? 'cancel' : '+ add'}
          </button>
        </div>
        {staged && (
          <input
            type="text"
            value={staged.amount}
            onChange={e => onAmountChange(row, category, e.target.value)}
            placeholder="₱ 0.00"
            className="w-32 px-2.5 py-1.5 text-[13px] rounded-lg bg-white focus:outline-none focus:ring-2 focus:ring-navy-500/25 transition-colors"
            style={{ border: '1px solid #E8E2D9' }}
          />
        )}
      </div>
    )
  }

  const remaining = Math.max(r2(billed - netPaid), 0)
  return (
    <label className="flex items-center gap-2 cursor-pointer select-none">
      <input
        type="checkbox"
        checked={!!staged}
        onChange={() => onToggle(row, category, remaining)}
        className="w-4 h-4 accent-navy-600 shrink-0"
      />
      <input
        type="text"
        value={staged ? staged.amount : ''}
        onChange={e => onAmountChange(row, category, e.target.value)}
        disabled={!staged}
        placeholder="₱ 0.00"
        className="w-28 px-2.5 py-1.5 text-[13px] rounded-lg bg-white disabled:opacity-50 focus:outline-none focus:ring-2 focus:ring-navy-500/25 transition-colors"
        style={{ border: '1px solid #E8E2D9' }}
      />
    </label>
  )
}

// ── Collections Page ───────────────────────────────────────────────────────────

export default function Collections() {
  const [tenants,         setTenants]         = useState([])
  const [loading,         setLoading]         = useState(true)
  const [activeCutoff,    setActiveCutoff]    = useState(null)
  const [cutoffPayments,  setCutoffPayments]  = useState([])
  const [billingPerTenant,setBillingPerTenant]= useState([])

  const [selected,   setSelected]   = useState(new Map())
  const [batchDate,  setBatchDate]  = useState(todayStr())
  const [batchNotes, setBatchNotes] = useState('')
  const [saving,     setSaving]     = useState(false)

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
    return new Map(billingPerTenant.map(t => [t.id, {
      rw:   r2((t.rent || 0) + (t.water || 0) + (t.addonRentWater || 0)),
      elec: r2((t.elec  || 0) + (t.addonElectric || 0)),
    }]))
  }, [billingPerTenant])

  function toggleCell(row, category, defaultAmount) {
    setSelected(prev => {
      const next = new Map(prev)
      const key = `${row.id}:${category}`
      if (next.has(key)) {
        next.delete(key)
      } else {
        next.set(key, { amount: defaultAmount > 0 ? String(defaultAmount) : '', tenant: row, category })
      }
      return next
    })
  }

  function updateAmount(row, category, rawValue) {
    setSelected(prev => {
      const key = `${row.id}:${category}`
      if (!prev.has(key)) return prev
      const next = new Map(prev)
      next.set(key, { ...prev.get(key), amount: rawValue })
      return next
    })
  }

  function clearSelection() { setSelected(new Map()) }

  async function handleUndo(insertedRows) {
    try {
      await voidPayments(insertedRows)
      await load()
      show('Reversed.', 'success')
    } catch(e) {
      if (e.code === '23505') show('Already reversed.', 'error')
      else show(e.message, 'error')
    }
  }

  async function handleSaveBatch() {
    if (selected.size === 0 || saving) return

    const staged = Array.from(selected.values())
    if (staged.some(s => parseAmt(s.amount) <= 0)) {
      show('Every selected amount must be greater than ₱0.', 'error')
      return
    }

    const entries = staged.map(s => ({
      tenantId:     s.tenant.id,
      category:     s.category,
      amount:       parseAmt(s.amount),
      paymentDate:  batchDate,
      notes:        batchNotes.trim() || null,
      cutoffId:     activeCutoff?.id   || null,
      _tenantName:  s.tenant.name,
      _roomNo:      s.tenant.room_no,
      _bedLetter:   s.tenant.bed_letter,
      _cutoffName:  activeCutoff?.name || null,
    }))

    setSaving(true)
    try {
      const inserted = await recordPaymentsBatch(entries)
      const total = r2(entries.reduce((s, e) => s + e.amount, 0))
      setSelected(new Map())
      await load()
      show(`${inserted.length} payments recorded · ${fmtPeso(total)}`, 'success', {
        duration: 10000,
        action: { label: 'Undo', onClick: () => handleUndo(inserted) },
      })
    } catch(e) {
      show(e.message, 'error')
    }
    setSaving(false)
  }

  if (loading) return (
    <div className="loading-screen"><div className="spinner" /></div>
  )

  const rwPaidTotal   = r2(collectionRows.reduce((s, r) => s + r.rwPays.reduce((ss, p) => ss + Number(p.amount || 0), 0), 0))
  const elecPaidTotal = r2(collectionRows.reduce((s, r) => s + r.elecPays.reduce((ss, p) => ss + Number(p.amount || 0), 0), 0))
  // Net-sum, not `.length > 0` — a fully-voided cell (paid then undone) must
  // revert to "unpaid" here, and `.length` would still count the void row.
  const rwCount   = collectionRows.filter(r => r2(r.rwPays.reduce((s, p) => s + Number(p.amount || 0), 0)) > 0).length
  const elecCount = collectionRows.filter(r => r2(r.elecPays.reduce((s, p) => s + Number(p.amount || 0), 0)) > 0).length
  const n         = collectionRows.length

  const selectedList  = Array.from(selected.values())
  const selectedTotal = r2(selectedList.reduce((s, x) => s + parseAmt(x.amount), 0))

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
              {rwPaidTotal > 0 && <strong className="text-navy-600 ml-1">· {fmt(rwPaidTotal)}</strong>}
            </span>
            <span className="text-slate-200">|</span>
            <span className="text-slate-500 text-[12px]">
              Electricity: <strong className="text-emerald-600">{elecCount}/{n}</strong> paid
              {elecPaidTotal > 0 && <strong className="text-navy-600 ml-1">· {fmt(elecPaidTotal)}</strong>}
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
                      <PayCell
                        row={r} category="RENT_WATER" pays={r.rwPays}
                        billed={billingMap.get(r.id)?.rw || 0}
                        selected={selected} onToggle={toggleCell} onAmountChange={updateAmount}
                      />
                    </td>
                    <td>
                      <PayCell
                        row={r} category="ELECTRICITY" pays={r.elecPays}
                        billed={billingMap.get(r.id)?.elec || 0}
                        selected={selected} onToggle={toggleCell} onAmountChange={updateAmount}
                      />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}

      {/* ── Sticky batch-save bar ── */}
      {selected.size > 0 && (
        <div className="sticky bottom-4 z-20 mt-4 bg-white rounded-xl border border-navy-200 shadow-modal px-4 py-3 flex flex-wrap items-center gap-3">
          <span className="text-[13px] font-semibold text-slate-700 shrink-0">
            {selectedList.length} selected · <span className="text-navy-600">{fmtPeso(selectedTotal)}</span>
          </span>
          <input
            type="date"
            value={batchDate}
            onChange={e => setBatchDate(e.target.value)}
            className="px-2.5 py-1.5 text-[13px] rounded-lg bg-white focus:outline-none focus:ring-2 focus:ring-navy-500/25 transition-colors"
            style={{ border: '1px solid #E8E2D9' }}
          />
          <input
            type="text"
            value={batchNotes}
            onChange={e => setBatchNotes(e.target.value)}
            placeholder="Notes (optional)"
            className="flex-1 min-w-[160px] px-2.5 py-1.5 text-[13px] rounded-lg bg-white focus:outline-none focus:ring-2 focus:ring-navy-500/25 transition-colors"
            style={{ border: '1px solid #E8E2D9' }}
          />
          <button
            onClick={handleSaveBatch}
            disabled={saving}
            className="btn primary shrink-0 disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {saving ? 'Saving…' : 'Save'}
          </button>
          <button
            onClick={clearSelection}
            disabled={saving}
            className="btn secondary shrink-0 disabled:opacity-50 disabled:cursor-not-allowed"
          >
            Clear
          </button>
        </div>
      )}

      {ToastEl}
    </div>
  )
}
