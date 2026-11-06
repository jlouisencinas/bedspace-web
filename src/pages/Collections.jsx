import { useState, useEffect, useMemo } from 'react'
import {
  fetchCutoffs, fetchTenants, recordPaymentsBatch, voidPayments,
  fetchPaymentsForCutoff, fetchAdvanceCreditData,
} from '../lib/supabase'
import { loadCutoffBillingInputs, computeCutoffBilling } from '../lib/cutoffBilling'
import { buildCollectionRows, cutoffOutstanding, pickPastDueCandidates } from '../lib/collectionsRows'
import { useToast } from '../components/Toast'
import { Droplets, Zap, Wallet, AlertTriangle } from 'lucide-react'
import { windowLastDay } from '../lib/cutoffDates'

const r2 = n => Math.round((Number(n) || 0) * 100) / 100
const amountsOf = credits => new Map([...(credits || new Map())].map(([id, c]) => [id, c.amount]))

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
  const remaining = Math.max(r2(billed - netPaid), 0)

  if (netPaid > 0) {
    return (
      <div className="space-y-1.5">
        <div className="flex items-center gap-2 flex-wrap">
          <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-bold bg-success-bg text-success-text border border-success-border">
            ✓ Paid
          </span>
          <span className="text-[13px] font-semibold text-success-text">{fmtPeso(netPaid)}</span>
          <span className="text-[11px] text-ink-faint">{fmtDate(lastPaymentDate(pays))}</span>
          <button
            onClick={() => onToggle(row, category, remaining)}
            className="text-[11px] text-ink-faint hover:text-navy-600 underline transition-colors"
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
            className="w-32 px-2.5 py-1.5 text-[13px] rounded-lg bg-surface focus:outline-none focus:ring-2 focus:ring-navy-500/25 transition-colors"
            style={{ border: '1px solid var(--border)' }}
          />
        )}
      </div>
    )
  }

  return (
    <div className="space-y-1">
      <div className="text-[11px] text-ink-faint">Billed: {fmtPeso(billed)}</div>
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
          className="w-28 px-2.5 py-1.5 text-[13px] rounded-lg bg-surface disabled:opacity-50 focus:outline-none focus:ring-2 focus:ring-navy-500/25 transition-colors"
          style={{ border: '1px solid var(--border)' }}
        />
      </label>
    </div>
  )
}

// ── Collections Page ───────────────────────────────────────────────────────────

export default function Collections() {
  const [tenants,         setTenants]         = useState([])
  const [loading,         setLoading]         = useState(true)
  const [cutoffs,         setCutoffs]         = useState([])
  const [selectedId,      setSelectedId]      = useState(null)
  const [cutoffPayments,  setCutoffPayments]  = useState([])
  const [billingPerTenant,setBillingPerTenant]= useState([])
  const [credits,         setCredits]         = useState(new Map())
  const [hasBill,         setHasBill]         = useState(false)
  const [advData,         setAdvData]         = useState({ deposits: [], finalBills: [], stored: [], error: null })
  const [pastDue,         setPastDue]         = useState({ loading: false, items: [], error: null })

  const [selected,   setSelected]   = useState(new Map())
  const [batchDate,  setBatchDate]  = useState(todayStr())
  const [batchNotes, setBatchNotes] = useState('')
  const [saving,     setSaving]     = useState(false)

  const { show, ToastEl } = useToast()

  useEffect(() => { load(null) }, [])

  // refreshPastDue is false when only the picker changed: the banner is cached for the page session, saves/undos refresh it.
  async function load(id = selectedId, { refreshPastDue = true } = {}) {
    setLoading(true)
    let shared = null
    try {
      const [cuts, allTenants, adv] = await Promise.all([fetchCutoffs(), fetchTenants(), fetchAdvanceCreditData()])
      setCutoffs(cuts); setTenants(allTenants); setAdvData(adv)
      shared = { cuts, tenants: allTenants, advData: adv }

      const target = cuts.find(c => c.id === id) || cuts.find(c => c.is_active) || cuts[0] || null
      setSelectedId(target?.id ?? null)
      if (target) {
        const [inputs, pays] = await Promise.all([
          loadCutoffBillingInputs(target, { tenants: allTenants, advData: adv }),
          fetchPaymentsForCutoff(target.id),
        ])
        const result = computeCutoffBilling(target, inputs)
        setBillingPerTenant(result.perTenant)
        setCredits(result.credits)
        setHasBill(inputs.bill.length > 0)
        setCutoffPayments(pays)
      } else {
        setBillingPerTenant([]); setCredits(new Map()); setHasBill(false); setCutoffPayments([])
      }
    } catch(e) { show(e.message, 'error') }
    setLoading(false)
    if (shared && refreshPastDue) loadPastDue(shared)
  }

  async function loadPastDue({ cuts, tenants: allTenants, advData: adv }) {
    setPastDue(prev => ({ ...prev, loading: true, error: null }))
    try {
      const items = await Promise.all(pickPastDueCandidates(cuts).map(async c => {
        const [inputs, pays] = await Promise.all([
          loadCutoffBillingInputs(c, { tenants: allTenants, advData: adv }),
          fetchPaymentsForCutoff(c.id),
        ])
        const { perTenant, credits: cr } = computeCutoffBilling(c, inputs)
        const rows = buildCollectionRows({ perTenant, tenants: allTenants, payments: pays, adjustments: amountsOf(cr), includeInactive: true })
        return { cutoff: c, ...cutoffOutstanding(rows) }
      }))
      setPastDue({ loading: false, items: items.filter(i => i.total > 0), error: null })
    } catch(e) {
      setPastDue({ loading: false, items: [], error: e.message || String(e) })
    }
  }

  function changeCutoff(id) {
    if (saving || id === selectedId) return
    setSelected(new Map())
    load(id, { refreshPastDue: false })
  }

  const selectedCutoff = cutoffs.find(c => c.id === selectedId) || null
  const isPast = !!selectedCutoff && !selectedCutoff.is_active

  // Second-to-last-bill advance credit (credits) is an adjustment against rent, so the amount to collect is net of it.
  const collectionRows = useMemo(() =>
    buildCollectionRows({
      perTenant: billingPerTenant, tenants, payments: cutoffPayments,
      adjustments: amountsOf(credits), includeInactive: isPast,
    })
  , [billingPerTenant, tenants, cutoffPayments, credits, isPast])

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
      cutoffId:     selectedCutoff?.id   || null,
      _tenantName:  s.tenant.name,
      _roomNo:      s.tenant.room_no,
      _bedLetter:   s.tenant.bed_letter,
      _cutoffName:  selectedCutoff?.name || null,
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
          <h1 className="page-title flex items-center gap-2 flex-wrap">
            Collections <small>{selectedCutoff?.name ?? ''}</small>
            {isPast && (
              <span className="inline-flex items-center px-2 py-0.5 rounded-full text-[10px] font-bold bg-warning-bg text-warning-text border border-warning-border">
                Past cutoff
              </span>
            )}
          </h1>
          {selectedCutoff && (
            <p className="page-sub text-[11px] flex items-center gap-1.5 flex-wrap">
              <Droplets size={11} className="text-blue-500 shrink-0" />
              Water {fmtDate(selectedCutoff.water_start)}–{fmtDate(windowLastDay(selectedCutoff.water_end))}
              {' · '}
              <Zap size={11} className="text-amber-500 shrink-0" />
              Electric {fmtDate(selectedCutoff.electric_start)}–{fmtDate(selectedCutoff.electric_end)}
            </p>
          )}
        </div>
        {cutoffs.length > 0 && (
          <select
            value={selectedId ?? ''}
            onChange={e => changeCutoff(Number(e.target.value))}
            disabled={saving}
            aria-label="Cutoff"
            className="px-3 py-2 border border-line rounded-lg text-[13px] bg-surface disabled:opacity-50 focus:outline-none focus:ring-2 focus:ring-navy-700/25 focus:border-navy-600 transition-colors"
          >
            {cutoffs.map(c => (
              <option key={c.id} value={c.id}>{c.name}{c.is_active ? ' (active)' : ''}</option>
            ))}
          </select>
        )}
      </div>

      {advData.error && (
        <div className="mb-3 px-4 py-3 bg-warning-bg border border-warning-border rounded-xl text-[13px] text-warning-text">
          Advance credits could not be loaded ({advData.error}); Rent + Water amounts do not include any second-to-last-bill advance credit.
        </div>
      )}

      {pastDue.error && (
        <div className="mb-3 px-4 py-3 bg-danger-bg border border-danger-border rounded-xl text-[13px] text-danger-text">
          Past-due check unavailable: {pastDue.error}
        </div>
      )}
      {pastDue.items.some(i => i.cutoff.id !== selectedId) && (
        <div className="mb-3 px-4 py-3 bg-warning-bg border border-warning-border rounded-xl text-[13px] text-warning-text">
          <div className="flex items-center gap-1.5 font-semibold mb-1">
            <AlertTriangle size={14} className="shrink-0 text-amber-500" /> Past due
          </div>
          <ul className="space-y-0.5">
            {pastDue.items.filter(i => i.cutoff.id !== selectedId).map(i => (
              <li key={i.cutoff.id}>
                {i.cutoff.name}: {fmtPeso(i.total)} outstanding ({i.unpaidCount} {i.unpaidCount === 1 ? 'tenant' : 'tenants'})
                {' · '}
                <button
                  onClick={() => changeCutoff(i.cutoff.id)}
                  disabled={saving}
                  className="underline font-semibold hover:text-navy-600 disabled:opacity-50"
                >
                  View
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}

      {!selectedCutoff ? (
        <div className="card mt-4">
          <div className="empty">
            <Wallet size={32} className="mx-auto mb-3 text-ink-faint" />
            <p>No active cutoff. Open one in Utilities first.</p>
          </div>
        </div>
      ) : (
        <>
          {/* Summary bar */}
          <div className="toolbar mt-4 flex-wrap gap-y-2 items-center">
            <span className="text-ink-muted text-[12px]">
              Rent+Water: <strong className="text-success-text">{rwCount}/{n}</strong> paid
              {rwPaidTotal > 0 && <strong className="text-navy-600 ml-1">· {fmt(rwPaidTotal)}</strong>}
            </span>
            <span className="text-ink-faint">|</span>
            <span className="text-ink-muted text-[12px]">
              Electricity: <strong className="text-success-text">{elecCount}/{n}</strong> paid
              {elecPaidTotal > 0 && <strong className="text-navy-600 ml-1">· {fmt(elecPaidTotal)}</strong>}
            </span>
          </div>

          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Tenant</th>
                  <th>Room / Bed</th>
                  <th>Rent + Water <span className="font-normal text-ink-faint text-[10px]">(due EOM)</span></th>
                  <th>Electricity <span className="font-normal text-ink-faint text-[10px]">(due 10th)</span></th>
                </tr>
              </thead>
              <tbody>
                {collectionRows.length === 0 ? (
                  <tr><td colSpan={4}><div className="empty"><p>
                    {!isPast ? 'No active tenants.' : hasBill ? 'No billed tenants for this cutoff.' : 'No billing data for this cutoff.'}
                  </p></div></td></tr>
                ) : collectionRows.map(r => (
                  <tr key={r.id}>
                    <td className="td-name">{r.name}</td>
                    <td className="text-[12px] text-ink-muted">
                      Rm {r.room_no} · {r.bed_letter}
                      {r.bed_location && <span className="text-ink-faint ml-1">{r.bed_location}</span>}
                    </td>
                    <td>
                      <PayCell
                        row={r} category="RENT_WATER" pays={r.rwPays}
                        billed={r.billed.rw}
                        selected={selected} onToggle={toggleCell} onAmountChange={updateAmount}
                      />
                    </td>
                    <td>
                      <PayCell
                        row={r} category="ELECTRICITY" pays={r.elecPays}
                        billed={r.billed.elec}
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
        <div className="sticky bottom-4 z-20 mt-4 bg-surface rounded-xl border border-navy-200 shadow-modal px-4 py-3 flex flex-wrap items-center gap-3">
          <span className="text-[13px] font-semibold text-ink-secondary shrink-0">
            {selectedList.length} selected · <span className="text-navy-600">{fmtPeso(selectedTotal)}</span>
          </span>
          <span className={`text-[12px] shrink-0 ${isPast ? 'font-semibold text-warning-text' : 'text-ink-muted'}`}>
            Recording against {selectedCutoff?.name ?? '—'}
          </span>
          <input
            type="date"
            value={batchDate}
            onChange={e => setBatchDate(e.target.value)}
            className="px-2.5 py-1.5 text-[13px] rounded-lg bg-surface focus:outline-none focus:ring-2 focus:ring-navy-500/25 transition-colors"
            style={{ border: '1px solid var(--border)' }}
          />
          <input
            type="text"
            value={batchNotes}
            onChange={e => setBatchNotes(e.target.value)}
            placeholder="Notes (optional)"
            className="flex-1 min-w-[160px] px-2.5 py-1.5 text-[13px] rounded-lg bg-surface focus:outline-none focus:ring-2 focus:ring-navy-500/25 transition-colors"
            style={{ border: '1px solid var(--border)' }}
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
