import { useState, useEffect, useMemo, useRef } from 'react'
import { useSearchParams } from 'react-router-dom'
import {
  fetchCutoffs, fetchTenants, recordPaymentsBatch, voidPayments,
  fetchPaymentsForCutoff, fetchAdvanceCreditData, setPaymentReceiptRefs, correctPaymentAmount,
} from '../lib/supabase'
import { loadCutoffBillingInputs, computeCutoffBilling } from '../lib/cutoffBilling'
import { buildCollectionRows, cutoffOutstanding, countFullyPaid, pickPastDueCandidates, resolveCutoffId, adjacentCutoffId, createPastDueRefresh, cellStatus } from '../lib/collectionsRows'
import { normalizePaymentRef, formatPaymentRefs, effectivePaymentLines, canEditPaymentRef, validateStagedRefs, canCorrectPaymentAmount, validateAmountCorrection } from '../lib/paymentRefs'
import { useAuth } from '../lib/auth'
import { useToast } from '../components/Toast'
import { Droplets, Zap, Wallet, AlertTriangle, ChevronLeft, ChevronRight } from 'lucide-react'
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

const refInputCls = 'w-32 px-2.5 py-1.5 text-[12px] rounded-lg bg-surface disabled:opacity-50 focus:outline-none focus:ring-2 focus:ring-navy-500/25 transition-colors'

function StagedRefInputs({ row, category, staged, onRefChange }) {
  return (
    <div className="flex items-center gap-1.5 flex-wrap">
      <input
        type="text" aria-label="S.I#" value={staged.siNo} maxLength={60}
        onChange={e => onRefChange(row, category, 'siNo', e.target.value)}
        placeholder="S.I# (optional)" className={refInputCls} style={{ border: '1px solid var(--border)' }}
      />
      <input
        type="text" aria-label="T.R#" value={staged.trNo} maxLength={60}
        onChange={e => onRefChange(row, category, 'trNo', e.target.value)}
        placeholder="T.R# (optional)" className={refInputCls} style={{ border: '1px solid var(--border)' }}
      />
    </div>
  )
}

function AmountPreview({ line, editing, billed, netPaid }) {
  const v = validateAmountCorrection({ payment: line, newAmount: editing.amount, reason: editing.reason })
  if (v.newCents == null) return <div className="text-[11px] text-ink-faint">Enter the correct amount (₱0 voids the whole line).</div>
  const after = cellStatus({ billed, paid: (Math.round(Number(netPaid) * 100) + v.deltaCents) / 100 })
  const tail = after.state === 'over' ? `Overpaid ${fmtPeso(after.over)}`
    : after.state === 'paid' ? 'Fully paid'
    : `Remaining ${fmtPeso(after.remaining)}`
  return (
    <div className="text-[11px] text-ink-muted">
      {v.voidsLine && <span className="font-semibold text-warning-text">₱0 voids this whole payment line · </span>}
      Billed {fmtPeso(after.billed)} · Paid after correction {fmtPeso(after.paid)} · {tail}
    </div>
  )
}

function PaymentLines({ pays, refEdit, amountEdit, billed, netPaid }) {
  const lines = effectivePaymentLines(pays)
  if (lines.length === 0) return null
  const { role, editing, saving } = refEdit
  const amtEditing = amountEdit.editing
  return (
    <div className="space-y-1">
      {lines.map(l => {
        const refs = formatPaymentRefs(l)
        const perm = canEditPaymentRef({ role, payment: l })
        const isEditing = editing?.paymentId === l.id
        const isAmountEditing = amtEditing?.paymentId === l.id
        const fieldOk = f => { const p = canEditPaymentRef({ role, payment: l, field: f }); return p.canFill || p.canChange }
        return (
          <div key={l.id} className="space-y-1">
            <div className="text-[11px] text-ink-muted flex items-center gap-1.5 flex-wrap">
              <span>{fmtPeso(l.amount)} · {fmtDate(l.payment_date)}</span>
              {refs ? <span>· {refs}</span> : <span className="text-ink-faint italic">· no S.I#/T.R# yet</span>}
              {!isEditing && !isAmountEditing && (perm.canFill || perm.canChange) && (
                <button
                  onClick={() => refEdit.start(l)}
                  disabled={saving}
                  className="text-[11px] text-ink-faint hover:text-navy-600 underline transition-colors disabled:opacity-50"
                >
                  {refs ? 'Edit' : '+ add numbers'}
                </button>
              )}
              {!isEditing && !isAmountEditing && canCorrectPaymentAmount({ role, payment: l }) && (
                <button
                  onClick={() => amountEdit.start(l)}
                  disabled={saving}
                  className="text-[11px] text-ink-faint hover:text-navy-600 underline transition-colors disabled:opacity-50"
                >
                  Edit amount
                </button>
              )}
            </div>
            {isAmountEditing && (
              <div className="space-y-1">
                <div className="flex items-center gap-1.5 flex-wrap">
                  <input
                    type="text" aria-label="Corrected amount" value={amtEditing.amount} maxLength={20} disabled={saving}
                    onChange={e => amountEdit.change('amount', e.target.value)}
                    placeholder="₱ 0.00" className={refInputCls} style={{ border: '1px solid var(--border)' }}
                  />
                  <input
                    type="text" aria-label="Reason for the correction" value={amtEditing.reason} maxLength={200} disabled={saving}
                    onChange={e => amountEdit.change('reason', e.target.value)}
                    placeholder="Reason (required)" className="w-48 px-2.5 py-1.5 text-[12px] rounded-lg bg-surface disabled:opacity-50 focus:outline-none focus:ring-2 focus:ring-navy-500/25 transition-colors"
                    style={{ border: '1px solid var(--border)' }}
                  />
                  <button onClick={amountEdit.save} disabled={saving} className="btn primary text-[12px] disabled:opacity-50">
                    {amountEdit.amountSaving ? 'Saving…' : 'Save'}
                  </button>
                  <button onClick={amountEdit.cancel} disabled={saving} className="btn secondary text-[12px] disabled:opacity-50">Cancel</button>
                </div>
                <AmountPreview line={l} editing={amtEditing} billed={billed} netPaid={netPaid} />
              </div>
            )}
            {isEditing && (
              <div className="flex items-center gap-1.5 flex-wrap">
                <input
                  type="text" aria-label="S.I#" value={editing.si} maxLength={60} disabled={saving || !fieldOk('si')}
                  onChange={e => refEdit.change('si', e.target.value)}
                  placeholder="S.I# (optional)" className={refInputCls} style={{ border: '1px solid var(--border)' }}
                />
                <input
                  type="text" aria-label="T.R#" value={editing.tr} maxLength={60} disabled={saving || !fieldOk('tr')}
                  onChange={e => refEdit.change('tr', e.target.value)}
                  placeholder="T.R# (optional)" className={refInputCls} style={{ border: '1px solid var(--border)' }}
                />
                <button onClick={refEdit.save} disabled={saving} className="btn primary text-[12px] disabled:opacity-50">
                  {saving ? 'Saving…' : 'Save'}
                </button>
                <button onClick={refEdit.cancel} disabled={saving} className="btn secondary text-[12px] disabled:opacity-50">Cancel</button>
              </div>
            )}
          </div>
        )
      })}
    </div>
  )
}

function PayCell({ row, category, pays, status, selected, onToggle, onAmountChange, onRefChange, refEdit, amountEdit }) {
  const { state, billed, paid: netPaid, remaining, over } = status
  const key     = `${row.id}:${category}`
  const staged  = selected.get(key)

  if (state === 'partial' || state === 'paid' || state === 'over') {
    return (
      <div className="space-y-1.5">
        <div className="flex items-center gap-2 flex-wrap">
          {state === 'partial' ? (
            <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-bold bg-warning-bg text-warning-text border border-warning-border">
              Partial · Remaining {fmtPeso(remaining)}
            </span>
          ) : (
            <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-bold bg-success-bg text-success-text border border-success-border">
              ✓ Paid
            </span>
          )}
          {state === 'over' && (
            <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-bold bg-info-bg text-info-text border border-info-border">
              Overpaid {fmtPeso(over)}
            </span>
          )}
          <span className={`text-[13px] font-semibold ${state === 'partial' ? 'text-ink' : 'text-success-text'}`}>{fmtPeso(netPaid)}</span>
          <span className="text-[11px] text-ink-faint">{fmtDate(lastPaymentDate(pays))}</span>
          <button
            onClick={() => onToggle(row, category, remaining)}
            className="text-[11px] text-ink-faint hover:text-navy-600 underline transition-colors"
          >
            {staged ? 'cancel' : '+ add'}
          </button>
        </div>
        <div className="text-[11px] text-ink-faint">Billed {fmtPeso(billed)} · Paid {fmtPeso(netPaid)}</div>
        <PaymentLines pays={pays} refEdit={refEdit} amountEdit={amountEdit} billed={billed} netPaid={netPaid} />
        {staged && (
          <>
            <input
              type="text"
              value={staged.amount}
              onChange={e => onAmountChange(row, category, e.target.value)}
              placeholder="₱ 0.00"
              className="w-32 px-2.5 py-1.5 text-[13px] rounded-lg bg-surface focus:outline-none focus:ring-2 focus:ring-navy-500/25 transition-colors"
              style={{ border: '1px solid var(--border)' }}
            />
            <StagedRefInputs row={row} category={category} staged={staged} onRefChange={onRefChange} />
          </>
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
      {staged && <StagedRefInputs row={row} category={category} staged={staged} onRefChange={onRefChange} />}
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
  const [refEditing, setRefEditing] = useState(null)
  const [refSaving,  setRefSaving]  = useState(false)
  const [amountEditing, setAmountEditing] = useState(null)
  const [amountSaving,  setAmountSaving]  = useState(false)

  const { role } = useAuth()
  const { show, ToastEl } = useToast()
  const [searchParams, setSearchParams] = useSearchParams()
  const cutoffParam = searchParams.get('cutoff')
  const loadSeq = useRef(0)
  const pastDueRefresh = useRef(null)
  if (!pastDueRefresh.current) pastDueRefresh.current = createPastDueRefresh()

  // The URL is the source of the viewed cutoff: the picker writes ?cutoff=<id>, a bare /collections opens the active cutoff.
  useEffect(() => {
    setSelected(new Map())
    setRefEditing(null)
    setAmountEditing(null)
    load(cutoffParam, { refreshPastDue: false })
  }, [cutoffParam])

  // refreshPastDue is false when only the picker changed: the banner is cached for the page session, saves/undos refresh it.
  // The banner is cutoff-independent, so it still refreshes from a load that a newer cutoff load superseded.
  async function load(id = selectedId, { refreshPastDue = true } = {}) {
    if (refreshPastDue) pastDueRefresh.current.request()
    const seq = ++loadSeq.current
    const fresh = () => seq === loadSeq.current
    setLoading(true)
    let shared = null
    try {
      const [cuts, allTenants, adv] = await Promise.all([fetchCutoffs(), fetchTenants(), fetchAdvanceCreditData()])
      shared = { cuts, tenants: allTenants, advData: adv }
      if (fresh()) {
        setCutoffs(cuts); setTenants(allTenants); setAdvData(adv)
        const targetId = resolveCutoffId(cuts, id)
        const target = cuts.find(c => c.id === targetId) || null
        setSelectedId(target?.id ?? null)
        if (target) {
          const [inputs, pays] = await Promise.all([
            loadCutoffBillingInputs(target, { tenants: allTenants, advData: adv }),
            fetchPaymentsForCutoff(target.id),
          ])
          if (fresh()) {
            const result = computeCutoffBilling(target, inputs)
            setBillingPerTenant(result.perTenant)
            setCredits(result.credits)
            setHasBill(inputs.bill.length > 0)
            setCutoffPayments(pays)
          }
        } else {
          setBillingPerTenant([]); setCredits(new Map()); setHasBill(false); setCutoffPayments([])
        }
      }
    } catch(e) { if (fresh()) show(e.message, 'error') }
    if (fresh()) setLoading(false)
    if (shared && pastDueRefresh.current.shouldRun()) loadPastDue(shared)
  }

  async function loadPastDue({ cuts, tenants: allTenants, advData: adv }) {
    const token = pastDueRefresh.current.start()
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
      if (pastDueRefresh.current.finish(token, true)) setPastDue({ loading: false, items: items.filter(i => i.total > 0), error: null })
    } catch(e) {
      if (pastDueRefresh.current.finish(token, false)) setPastDue({ loading: false, items: [], error: e.message || String(e) })
    }
  }

  function changeCutoff(id) {
    if (saving || refSaving || amountSaving || id == null || id === selectedId) return
    setSearchParams(prev => { const next = new URLSearchParams(prev); next.set('cutoff', String(id)); return next }, { replace: true })
  }

  const selectedCutoff = cutoffs.find(c => c.id === selectedId) || null
  const isPast = !!selectedCutoff && !selectedCutoff.is_active
  const olderId = adjacentCutoffId(cutoffs, selectedId, 'older')
  const newerId = adjacentCutoffId(cutoffs, selectedId, 'newer')
  const pickerLocked = saving || refSaving || amountSaving

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
        next.set(key, { key, amount: defaultAmount > 0 ? String(defaultAmount) : '', siNo: '', trNo: '', tenant: row, category })
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

  function updateRef(row, category, field, rawValue) {
    setSelected(prev => {
      const key = `${row.id}:${category}`
      if (!prev.has(key)) return prev
      const next = new Map(prev)
      next.set(key, { ...prev.get(key), [field]: rawValue })
      return next
    })
  }

  function clearSelection() { setSelected(new Map()) }

  const refEdit = {
    role,
    editing: refEditing,
    saving: refSaving || saving || amountSaving,
    start: line => { setAmountEditing(null); setRefEditing({ paymentId: line.id, si: line.si_no ?? '', tr: line.tr_no ?? '', expectedSi: line.si_no ?? null, expectedTr: line.tr_no ?? null }) },
    change: (field, value) => setRefEditing(prev => (prev ? { ...prev, [field]: value } : prev)),
    cancel: () => setRefEditing(null),
    save: handleSaveRefs,
  }

  async function handleSaveRefs() {
    if (!refEditing || refSaving || amountSaving) return
    const si = normalizePaymentRef('SI', refEditing.si)
    const tr = normalizePaymentRef('TR', refEditing.tr)
    if (si.error || tr.error) {
      show(si.error ? `S.I#: ${si.error}` : `T.R#: ${tr.error}`, 'error')
      return
    }
    setRefSaving(true)
    try {
      const res = await setPaymentReceiptRefs({
        paymentId: refEditing.paymentId, expectedSi: refEditing.expectedSi, expectedTr: refEditing.expectedTr, si: si.value, tr: tr.value,
      })
      setRefEditing(null)
      await load()
      show(res?.changed === false ? 'No change.' : 'S.I#/T.R# saved.', 'success')
    } catch(e) {
      show(e.message, 'error')
    }
    setRefSaving(false)
  }

  const amountEdit = {
    editing: amountEditing,
    amountSaving,
    start: line => { setRefEditing(null); setAmountEditing({ paymentId: line.id, expected: line.amount, amount: (Math.round(line.amount * 100) / 100).toFixed(2), reason: '' }) },
    change: (field, value) => setAmountEditing(prev => (prev ? { ...prev, [field]: value } : prev)),
    cancel: () => setAmountEditing(null),
    save: handleSaveAmount,
  }

  async function handleSaveAmount() {
    if (!amountEditing || amountSaving || saving || refSaving) return
    const v = validateAmountCorrection({ payment: { amount: amountEditing.expected }, newAmount: amountEditing.amount, reason: amountEditing.reason })
    if (v.noChange) { show('No change: the amount is the same.', 'error'); return }
    if (!v.ok) { show(`${v.error} Nothing was saved.`, 'error'); return }
    setAmountSaving(true)
    try {
      const res = await correctPaymentAmount({
        paymentId: amountEditing.paymentId, expectedAmount: amountEditing.expected, newAmount: v.newAmount, reason: v.reason,
      })
      setAmountEditing(null)
      await load()
      show(res?.changed === false ? 'No change.'
        : v.voidsLine ? `Payment line voided (${fmtPeso(v.oldCents / 100)} -> ₱0.00).`
        : `Amount corrected (${fmtPeso(v.oldCents / 100)} -> ${fmtPeso(v.newAmount)}).`, 'success')
    } catch(e) {
      show(e.message, 'error')
    }
    setAmountSaving(false)
  }

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
    if (selected.size === 0 || saving || amountSaving) return

    const staged = Array.from(selected.values())
    if (staged.some(s => parseAmt(s.amount) <= 0)) {
      show('Every selected amount must be greater than ₱0.', 'error')
      return
    }
    const refErrors = validateStagedRefs(staged)
    if (refErrors.length > 0) {
      show(refErrors[0].message + (refErrors.length > 1 ? ` (+${refErrors.length - 1} more)` : '') + ' Nothing was saved.', 'error')
      return
    }

    const entries = staged.map(s => ({
      tenantId:     s.tenant.id,
      category:     s.category,
      amount:       parseAmt(s.amount),
      paymentDate:  batchDate,
      notes:        batchNotes.trim() || null,
      siNo:         normalizePaymentRef('SI', s.siNo).value,
      trNo:         normalizePaymentRef('TR', s.trNo).value,
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
  const rwCount   = countFullyPaid(collectionRows, 'rw')
  const elecCount = countFullyPaid(collectionRows, 'elec')
  const n         = collectionRows.length
  const outstanding = cutoffOutstanding(collectionRows)

  const selectedList  = Array.from(selected.values())
  const selectedTotal = r2(selectedList.reduce((s, x) => s + parseAmt(x.amount), 0))

  return (
    <div className="page">
      {/* ── Header ── */}
      <div className="page-header">
        <div>
          <h1 className="page-title flex items-center gap-2 flex-wrap">
            Collections
            {cutoffs.length > 0 ? (
              <span className="inline-flex items-center rounded-lg border border-line bg-surface overflow-hidden">
                <button
                  type="button" aria-label="Older cutoff" title="Older cutoff"
                  onClick={() => changeCutoff(olderId)} disabled={pickerLocked || olderId == null}
                  className="px-1.5 py-1.5 text-ink-muted hover:text-navy-600 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
                >
                  <ChevronLeft size={16} />
                </button>
                <select
                  value={selectedId ?? ''}
                  onChange={e => changeCutoff(Number(e.target.value))}
                  disabled={pickerLocked}
                  aria-label="Cutoff"
                  className="px-2 py-1 text-[14px] font-semibold bg-surface text-ink border-x border-line disabled:opacity-50 focus:outline-none focus:ring-2 focus:ring-navy-700/25 transition-colors"
                  style={{ backgroundColor: 'var(--surface)', color: 'var(--text-primary)', borderColor: 'var(--border)' }}
                >
                  {cutoffs.map(c => (
                    <option key={c.id} value={c.id}>{c.name}{c.is_active ? ' (active)' : ''}</option>
                  ))}
                </select>
                <button
                  type="button" aria-label="Newer cutoff" title="Newer cutoff"
                  onClick={() => changeCutoff(newerId)} disabled={pickerLocked || newerId == null}
                  className="px-1.5 py-1.5 text-ink-muted hover:text-navy-600 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
                >
                  <ChevronRight size={16} />
                </button>
              </span>
            ) : <small>{selectedCutoff?.name ?? ''}</small>}
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
                  disabled={pickerLocked}
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
            <span className="text-ink-faint">|</span>
            <span className="text-ink-muted text-[12px]">
              Remaining: <strong className={outstanding.total > 0 ? 'text-warning-text' : 'text-success-text'}>{fmtPeso(outstanding.total)}</strong>
              {outstanding.total > 0 && (
                <span className="text-ink-faint ml-1">(Rent+Water {fmtPeso(outstanding.rw)} · Electricity {fmtPeso(outstanding.elec)})</span>
              )}
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
                        status={r.status.rw}
                        selected={selected} onToggle={toggleCell} onAmountChange={updateAmount}
                        onRefChange={updateRef} refEdit={refEdit} amountEdit={amountEdit}
                      />
                    </td>
                    <td>
                      <PayCell
                        row={r} category="ELECTRICITY" pays={r.elecPays}
                        status={r.status.elec}
                        selected={selected} onToggle={toggleCell} onAmountChange={updateAmount}
                        onRefChange={updateRef} refEdit={refEdit} amountEdit={amountEdit}
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
            disabled={saving || amountSaving}
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
