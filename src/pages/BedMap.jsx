import { useState, useEffect, useMemo } from 'react'
import {
  fetchBeds, updateBedStatus, logBedStatusChange,
  fetchReservationPayments, fetchAllReservationPayments, addReservationPayment, updateReservationPayment,
  voidReservationPayment, PAYMENT_MODES, PAYMENT_MODE_LABEL,
} from '../lib/supabase'
import { useToast } from '../components/Toast'
import { useAuth } from '../lib/auth'
import SearchInput from '../components/SearchInput'
import ReservationLedgerModal from '../components/ReservationLedgerModal'
import { parseMoney, moneyProblem, dbToCents, fmtCents, centsToInput } from '../lib/receiptLines'
import { SearchX, X } from 'lucide-react'

function todayISO() { return new Date().toISOString().slice(0, 10) }

function fmtDay(d) {
  if (!d) return '—'
  return new Date(d + 'T00:00:00').toLocaleDateString('en-PH', { month: 'short', day: 'numeric', year: 'numeric' })
}

// "P3,000 held" on the card; exact cents only when the amount is not whole pesos.
function chipAmount(cents) {
  return cents % 100 === 0 ? fmtCents(cents).replace(/\.00$/, '') : fmtCents(cents)
}

const FIELD = 'w-full px-2 py-1.5 text-[13px] rounded-lg border border-line bg-surface text-ink focus:outline-none focus:ring-2 focus:ring-navy-700/25 focus:border-navy-600 transition-colors'

function blankPay() { return { amount: '', refNo: '', bankRef: '', mode: '', date: todayISO(), notes: '' } }

function payFormError(v) {
  const cents = parseMoney(v.amount)
  if (cents == null) return `Reservation payment: ${moneyProblem(v.amount)}.`
  if (cents <= 0) return 'Reservation payment: amount must be greater than 0.'
  if (!PAYMENT_MODES.includes(v.mode)) return 'Choose how the reservation was paid (BANK or CASH).'
  if (!v.refNo.trim()) return 'Reservation payment: T.R# is required.'
  if (!v.date) return 'Reservation payment: date is required.'
  return ''
}

function PaymentFields({ v, onChange }) {
  const set = (k, val) => onChange({ ...v, [k]: val })
  return (
    <div className="grid grid-cols-2 gap-2">
      <div>
        <label className="block text-[11px] text-ink-muted mb-0.5">Amount (PHP) *</label>
        <input type="text" inputMode="decimal" className={FIELD} placeholder="0.00" value={v.amount} onChange={e => set('amount', e.target.value)} />
      </div>
      <div>
        <label className="block text-[11px] text-ink-muted mb-0.5">Mode *</label>
        <select className={FIELD} value={v.mode} onChange={e => set('mode', e.target.value)}>
          <option value="" disabled>Select…</option>
          {PAYMENT_MODES.map(m => <option key={m} value={m}>{PAYMENT_MODE_LABEL[m]}</option>)}
        </select>
      </div>
      <div>
        <label className="block text-[11px] text-ink-muted mb-0.5">T.R# *</label>
        <input type="text" className={FIELD} placeholder="Required" value={v.refNo} onChange={e => set('refNo', e.target.value)} />
      </div>
      <div>
        <label className="block text-[11px] text-ink-muted mb-0.5">Date received *</label>
        <input type="date" className={FIELD} value={v.date} onChange={e => set('date', e.target.value)} />
      </div>
      {v.mode === 'BANK' && (
        <div className="col-span-2">
          <label className="block text-[11px] text-ink-muted mb-0.5">Bank reference</label>
          <input type="text" className={FIELD} placeholder="Optional" value={v.bankRef} onChange={e => set('bankRef', e.target.value)} />
        </div>
      )}
      <div className="col-span-2">
        <label className="block text-[11px] text-ink-muted mb-0.5">Notes</label>
        <input type="text" className={FIELD} placeholder="Optional" value={v.notes} onChange={e => set('notes', e.target.value)} />
      </div>
    </div>
  )
}

const PAY_STATUS_CLS = {
  HELD:      'bg-warning-bg text-warning-text',
  APPLIED:   'bg-success-bg text-success-text',
  FORFEITED: 'bg-danger-bg text-danger-text',
  VOID:      'bg-surface-3 text-ink-muted',
}

function statusClass(s) {
  if (!s) return 'vacant'
  switch (s.toUpperCase()) {
    case 'LEASED':       return 'leased'
    case 'RESERVED':     return 'reserved'
    case 'OUT OF ORDER': return 'oor'
    case 'REMOVED':      return 'removed'
    default:             return 'vacant'
  }
}

function BedStatusBadge({ status }) {
  const MAP = {
    'LEASED':        { label: 'Leased',   cls: 'bg-info-bg text-info-text border border-info-border' },
    'VACANT':        { label: 'Vacant',   cls: 'bg-success-bg text-success-text border border-success-border' },
    'RESERVED':      { label: 'Reserved', cls: 'bg-navy-100 text-navy-700 border border-navy-200' },
    'OUT OF ORDER':  { label: 'OOO',      cls: 'bg-surface-3 text-ink-muted border border-line' },
  }
  const s = status?.toUpperCase()
  const c = MAP[s] || MAP['VACANT']
  return (
    <span className={`text-[9px] font-bold uppercase tracking-wider px-1.5 py-0.5 rounded-full whitespace-nowrap shrink-0 ${c.cls}`}>
      {c.label}
    </span>
  )
}

// ── Status Change Modal ────────────────────────────────────────────────────────

const STATUS_ACTIONS = {
  VACANT:        [{ to: 'RESERVED', label: 'Reserve' }, { to: 'OUT OF ORDER', label: 'Out of Order' }],
  RESERVED:      [{ to: 'VACANT',   label: 'Remove Reservation' }, { to: 'OUT OF ORDER', label: 'Out of Order' }],
  'OUT OF ORDER': [{ to: 'VACANT',  label: 'Mark Vacant' }, { to: 'RESERVED', label: 'Reserve' }],
}

function BedStatusModal({ bed, onClose, onSaved, onPaymentsChanged }) {
  const { isAdmin, user } = useAuth()
  const [pending,  setPending]  = useState(null)
  const [name,     setName]     = useState(bed.reserved_name || '')
  const [saving,   setSaving]   = useState(false)
  const [error,    setError]    = useState('')

  const current  = (bed.status || 'VACANT').toUpperCase()
  const actions  = STATUS_ACTIONS[current] || STATUS_ACTIONS.VACANT
  const needName = pending === 'RESERVED'

  const [payments,    setPayments]    = useState([])
  const [payLoading,  setPayLoading]  = useState(current === 'RESERVED')
  const [payLoadErr,  setPayLoadErr]  = useState('')
  const [addOpen,     setAddOpen]     = useState(false)
  const [addForm,     setAddForm]     = useState(blankPay)
  const [editing,     setEditing]     = useState(null)
  const [voiding,     setVoiding]     = useState(null)
  const [payBusy,     setPayBusy]     = useState(false)
  const [payError,    setPayError]    = useState('')
  const [recordNow,   setRecordNow]   = useState(false)
  const [reserveForm, setReserveForm] = useState(blankPay)
  const [confirmForfeit, setConfirmForfeit] = useState(false)

  async function loadPayments() {
    setPayLoading(true); setPayLoadErr('')
    try { setPayments(await fetchReservationPayments({ bedId: bed.bed_id })) }
    catch (e) { setPayLoadErr(e.message) }
    setPayLoading(false)
  }
  useEffect(() => { if (current === 'RESERVED') loadPayments() }, [])

  const heldCents = payments.filter(p => p.status === 'HELD').reduce((sum, p) => sum + dbToCents(p.amount), 0)
  const leaving   = current === 'RESERVED' && (pending === 'VACANT' || pending === 'OUT OF ORDER')
  useEffect(() => { setConfirmForfeit(false) }, [payments, heldCents])

  const forfeitBlocked = leaving && (payLoading || !!payLoadErr || (heldCents > 0 && !confirmForfeit))

  async function handleConfirm() {
    if (!pending) return
    if (needName && !name.trim()) { setError('Please enter the name of the person reserving this bed.'); return }
    if (needName && recordNow) {
      const msg = payFormError(reserveForm)
      if (msg) { setError(msg); return }
    }
    setSaving(true)
    setError('')
    try {
      const resolvedName = needName ? name.trim() : null
      await updateBedStatus(bed.bed_id, pending, resolvedName)
      logBedStatusChange(bed, pending, resolvedName).catch(() => {})

      if (needName && recordNow) {
        try {
          await addReservationPayment({
            bedId: bed.bed_id, amount: reserveForm.amount, refNo: reserveForm.refNo, bankRef: reserveForm.bankRef,
            paymentMode: reserveForm.mode, receivedDate: reserveForm.date, notes: reserveForm.notes,
          }, user?.id)
        } catch (pe) {
          onSaved(bed.bed_id, pending, resolvedName, { error: `Bed reserved, but the payment was NOT recorded: ${pe.message}. Record it from the bed.` })
          onClose()
          setSaving(false)
          return
        }
      }

      onSaved(bed.bed_id, pending, resolvedName, leaving && heldCents > 0 ? { forfeitedCents: heldCents } : undefined)
      onClose()
    } catch(e) { setError(e.message) }
    setSaving(false)
  }

  async function savePayment() {
    const msg = payFormError(addForm)
    if (msg) { setPayError(msg); return }
    setPayBusy(true); setPayError('')
    try {
      await addReservationPayment({
        bedId: bed.bed_id, amount: addForm.amount, refNo: addForm.refNo, bankRef: addForm.bankRef,
        paymentMode: addForm.mode, receivedDate: addForm.date, notes: addForm.notes,
      }, user?.id)
      setAddOpen(false); setAddForm(blankPay())
      await loadPayments()
      onPaymentsChanged()
    } catch (e) { setPayError(e.message) }
    setPayBusy(false)
  }

  async function saveEdit() {
    const msg = payFormError(editing.form)
    if (msg) { setPayError(msg); return }
    setPayBusy(true); setPayError('')
    try {
      const f = editing.form
      await updateReservationPayment(editing.id, {
        amount: f.amount, ref_no: f.refNo, bank_ref: f.mode === 'BANK' ? f.bankRef : '',
        payment_mode: f.mode, received_date: f.date, notes: f.notes,
      }, user?.id)
      setEditing(null)
      await loadPayments()
      onPaymentsChanged()
    } catch (e) { setPayError(e.message) }
    setPayBusy(false)
  }

  async function saveVoid() {
    if (!voiding.reason.trim()) { setPayError('A reason is required to void a reservation payment.'); return }
    setPayBusy(true); setPayError('')
    try {
      await voidReservationPayment(voiding.id, voiding.reason, user?.id)
      setVoiding(null)
      await loadPayments()
      onPaymentsChanged()
    } catch (e) { setPayError(e.message) }
    setPayBusy(false)
  }

  function startEdit(p) {
    setPayError(''); setVoiding(null)
    setEditing({
      id: p.id,
      form: {
        amount: centsToInput(dbToCents(p.amount)), refNo: p.ref_no || '', bankRef: p.bank_ref || '',
        mode: p.payment_mode, date: p.received_date, notes: p.notes || '',
      },
    })
  }

  return (
    <div className="overlay" onClick={e => e.stopPropagation()}>
      <div className="modal" style={{ maxWidth: current === 'RESERVED' ? 520 : 400 }}>
        <div className="modal-head">
          <h3>Bed {bed.bed_letter} · Room {bed.room_no}</h3>
          <button className="btn-close" onClick={onClose}><X size={16} /></button>
        </div>

        <div className="modal-body">
          <div className="flex items-center gap-2 mb-5">
            <span className="text-[13px] text-ink-muted">Current status:</span>
            <BedStatusBadge status={bed.status || 'VACANT'} />
            {current === 'RESERVED' && bed.reserved_name && (
              <span className="text-[13px] text-ink-secondary font-medium">— {bed.reserved_name}</span>
            )}
          </div>

          {current === 'RESERVED' && (
            <div className="mb-4 rounded-xl border border-line p-3">
              <div className="flex items-center justify-between mb-2">
                <span className="text-[12px] font-semibold text-ink-secondary">Reservation payments</span>
                {!addOpen && (
                  <button type="button" className="btn-xs blue" onClick={() => { setAddOpen(true); setPayError(''); setEditing(null); setVoiding(null) }}>
                    + Record payment
                  </button>
                )}
              </div>

              {payLoading && <p className="text-[12px] text-ink-muted">Loading…</p>}
              {payLoadErr && <p className="text-[12px] text-danger-text">Could not load reservation payments: {payLoadErr}</p>}
              {!payLoading && !payLoadErr && !payments.some(p => p.status === 'HELD') && (
                <p className="text-[12px] text-ink-muted">No reservation payment held. It is optional. Earlier payments for this bed are in the Reservation payments ledger.</p>
              )}

              <div className="flex flex-col gap-2">
                {payments.filter(p => p.status === 'HELD').map(p => (
                  <div key={p.id} className="rounded-lg bg-surface-2 px-2.5 py-2 text-[12px]">
                    {editing?.id === p.id ? (
                      <div className="flex flex-col gap-2">
                        <PaymentFields v={editing.form} onChange={form => setEditing(e => ({ ...e, form }))} />
                        <div className="flex justify-end gap-2">
                          <button type="button" className="btn-xs gray" onClick={() => { setEditing(null); setPayError('') }}>Cancel</button>
                          <button type="button" className="btn-xs green" disabled={payBusy} onClick={saveEdit}>{payBusy ? 'Saving…' : 'Save'}</button>
                        </div>
                      </div>
                    ) : (
                      <>
                        <div className="flex items-start justify-between gap-2">
                          <div className="text-ink-secondary">
                            <span className="font-semibold text-ink">{fmtCents(dbToCents(p.amount))}</span>
                            {' · '}{p.ref_no ? `TR# ${p.ref_no}` : 'No TR#'} · {fmtDay(p.received_date)} · {PAYMENT_MODE_LABEL[p.payment_mode] || p.payment_mode}
                            {p.bank_ref ? ` (${p.bank_ref})` : ''}
                          </div>
                          <span className={`text-[9px] font-bold uppercase tracking-wider px-1.5 py-0.5 rounded-full shrink-0 ${PAY_STATUS_CLS[p.status] || ''}`}>{p.status}</span>
                        </div>
                        {p.notes && <div className="text-ink-muted mt-0.5">{p.notes}</div>}
                        {p.settled_note && <div className="text-ink-muted mt-0.5">{p.settled_note}</div>}
                        {isAdmin && p.status === 'HELD' && voiding?.id !== p.id && (
                          <div className="flex justify-end gap-2 mt-1.5">
                            <button type="button" className="btn-xs gray" onClick={() => startEdit(p)}>Edit</button>
                            <button type="button" className="btn-xs red" onClick={() => { setPayError(''); setEditing(null); setVoiding({ id: p.id, reason: '' }) }}>Void</button>
                          </div>
                        )}
                        {voiding?.id === p.id && (
                          <div className="flex flex-col gap-1.5 mt-1.5">
                            <input
                              type="text" className={FIELD} autoFocus placeholder="Reason for voiding (required)"
                              value={voiding.reason} onChange={e => setVoiding(v => ({ ...v, reason: e.target.value }))}
                            />
                            <div className="flex justify-end gap-2">
                              <button type="button" className="btn-xs gray" onClick={() => { setVoiding(null); setPayError('') }}>Cancel</button>
                              <button type="button" className="btn-xs red" disabled={payBusy} onClick={saveVoid}>{payBusy ? 'Voiding…' : 'Confirm void'}</button>
                            </div>
                          </div>
                        )}
                      </>
                    )}
                  </div>
                ))}
              </div>

              {addOpen && (
                <div className="mt-2 flex flex-col gap-2">
                  <PaymentFields v={addForm} onChange={setAddForm} />
                  <div className="flex justify-end gap-2">
                    <button type="button" className="btn-xs gray" onClick={() => { setAddOpen(false); setPayError('') }}>Cancel</button>
                    <button type="button" className="btn-xs green" disabled={payBusy} onClick={savePayment}>{payBusy ? 'Saving…' : 'Save payment'}</button>
                  </div>
                </div>
              )}

              {payError && <p className="mt-2 text-[12px] text-danger-text">{payError}</p>}
              {heldCents > 0 && (
                <p className="mt-2 text-[12px] text-ink-muted">Held: <strong className="text-ink">{fmtCents(heldCents)}</strong>. It becomes the tenant's deposit at Move In.</p>
              )}
            </div>
          )}

          <div className="flex flex-col gap-2 mb-4">
            {actions.map(a => (
              <button
                key={a.to}
                type="button"
                onClick={() => { setPending(a.to); setError(''); setConfirmForfeit(false) }}
                className={`w-full text-left px-4 py-3 rounded-xl border text-[13px] font-medium transition-colors ${
                  pending === a.to
                    ? 'border-navy-600 bg-navy-50 text-navy-800'
                    : 'border-line bg-surface text-ink-secondary hover:bg-surface-2'
                }`}
              >
                {a.to === 'RESERVED'      && '🔖 '}
                {a.to === 'VACANT'        && '✅ '}
                {a.to === 'OUT OF ORDER'  && '🔧 '}
                {a.label}
              </button>
            ))}
          </div>

          {needName && (
            <div className="mb-1">
              <label className="block text-[12px] font-semibold text-ink-secondary mb-1.5">
                Reserved for *
              </label>
              <input
                type="text"
                value={name}
                onChange={e => { setName(e.target.value); setError('') }}
                placeholder="Full name of person reserving"
                autoFocus
                onKeyDown={e => e.key === 'Enter' && handleConfirm()}
                className="w-full px-3 py-2 text-[13px] rounded-lg border border-line focus:outline-none focus:ring-2 focus:ring-navy-700/25 focus:border-navy-600 transition-colors"
              />

              <label className="flex items-center gap-2 mt-3 text-[12px] text-ink-secondary cursor-pointer">
                <input type="checkbox" checked={recordNow} onChange={e => { setRecordNow(e.target.checked); setError('') }} />
                Record reservation payment now (optional)
              </label>
              {recordNow && (
                <div className="mt-2">
                  <PaymentFields v={reserveForm} onChange={v => { setReserveForm(v); setError('') }} />
                </div>
              )}
            </div>
          )}

          {leaving && heldCents > 0 && (
            <div className="mb-1 rounded-lg border border-danger-border bg-danger-bg text-danger-text px-3 py-2 text-[12px]">
              <p className="font-semibold">{fmtCents(heldCents)} reservation payment will be FORFEITED</p>
              <p className="mt-0.5">It is not refunded. The payment rows are kept as FORFEITED and the Activity log records it.</p>
              <label className="flex items-center gap-2 mt-2 cursor-pointer">
                <input type="checkbox" checked={confirmForfeit} onChange={e => setConfirmForfeit(e.target.checked)} />
                I understand {fmtCents(heldCents)} will be forfeited
              </label>
            </div>
          )}
          {leaving && payLoadErr && (
            <p className="text-[12px] text-danger-text">Cannot confirm until the reservation payments could be checked. Close and reopen this bed.</p>
          )}

          {error && (
            <p className="mt-2 text-[12px] text-danger-text">{error}</p>
          )}
        </div>

        <div className="modal-foot">
          <button className="btn secondary" onClick={onClose}>Cancel</button>
          <button
            className="btn primary"
            disabled={!pending || saving || forfeitBlocked}
            onClick={handleConfirm}
          >
            {saving ? 'Saving…' : 'Confirm'}
          </button>
        </div>
      </div>
    </div>
  )
}

// ── BedMap Page ────────────────────────────────────────────────────────────────

export default function BedMap() {
  const [beds,        setBeds]        = useState([])
  const [loading,     setLoading]     = useState(true)
  const [search,      setSearch]      = useState('')
  const [typeFilter,  setTypeFilter]  = useState('')
  const [statFilter,  setStatFilter]  = useState('')
  const [statusModal, setStatusModal] = useState(null)
  const [ledgerOpen,  setLedgerOpen]  = useState(false)
  const [heldByBed,   setHeldByBed]   = useState({})
  const { show, ToastEl } = useToast()
  const { isViewer } = useAuth()

  // Best-effort: a missing table/policy must never break the Bed Map itself.
  async function loadHeld() {
    if (isViewer) { setHeldByBed({}); return }
    try {
      const rows = await fetchAllReservationPayments({ statuses: ['HELD'] })
      const map = {}
      for (const r of rows) map[r.bed_id] = (map[r.bed_id] || 0) + dbToCents(r.amount)
      setHeldByBed(map)
    } catch (e) { console.warn('reservation payments lookup skipped:', e.message) }
  }

  async function load() {
    setLoading(true)
    try { setBeds(await fetchBeds()) } catch (e) { show(e.message, 'error') }
    await loadHeld()
    setLoading(false)
  }
  useEffect(() => { load() }, [isViewer])

  function handleSaved(bedId, newStatus, newName, extra) {
    setBeds(prev => prev.map(b =>
      b.bed_id === bedId
        ? { ...b, status: newStatus, reserved_name: newStatus === 'RESERVED' ? newName : null }
        : b
    ))
    loadHeld()
    if (extra?.error) { show(extra.error, 'error', { duration: 15000 }); return }
    if (extra?.forfeitedCents) { show(`Reservation removed. ${fmtCents(extra.forfeitedCents)} forfeited.`, 'success'); return }
    const label = newStatus === 'OUT OF ORDER' ? 'Out of Order' : newStatus.charAt(0) + newStatus.slice(1).toLowerCase()
    show(`Bed updated to ${label}.`, 'success')
  }

  const roomTypes = useMemo(() =>
    [...new Set(beds.map(b => b.room_type).filter(Boolean))].sort(), [beds])

  const grouped = useMemo(() => {
    const q = search.toLowerCase()
    const map = {}
    beds.forEach(b => {
      if (b.status === 'REMOVED') return
      if (typeFilter && b.room_type !== typeFilter) return
      if (statFilter && b.status !== statFilter)    return
      if (q && !b.room_no.includes(q)
           && !(b.tenant_name   || '').toLowerCase().includes(q)
           && !(b.reserved_name || '').toLowerCase().includes(q)) return
      if (!map[b.room_no]) map[b.room_no] = { room_type: b.room_type, floor: b.floor, beds: [] }
      map[b.room_no].beds.push(b)
    })
    Object.values(map).forEach(r => r.beds.sort((a,b) => a.bed_letter.localeCompare(b.bed_letter)))
    return Object.entries(map).sort((a,b) => parseInt(a[0]) - parseInt(b[0]))
  }, [beds, search, typeFilter, statFilter])

  if (loading) return (
    <div className="loading-screen">
      <div className="spinner" />
      <span className="text-navy-500 font-semibold text-sm">Loading…</span>
    </div>
  )

  const totalBeds = beds.filter(b => b.status !== 'REMOVED').length
  const leased    = beds.filter(b => b.status === 'LEASED').length
  const vacant    = beds.filter(b => b.status === 'VACANT').length
  const reserved  = beds.filter(b => b.status === 'RESERVED').length

  return (
    <div className="page max-w-[1600px]">
      {ToastEl}

      {/* ── Header ── */}
      <div className="page-header">
        <div>
          <h1 className="page-title">Bed Map</h1>
          <p className="page-sub">
            {totalBeds} beds · {leased} occupied · {vacant} vacant · {reserved} reserved
          </p>
        </div>
        {!isViewer && (
          <button className="btn secondary" onClick={() => setLedgerOpen(true)}>Reservation payments</button>
        )}
        <div className="hidden md:flex items-center gap-4 text-[11px] font-semibold">
          {[
            { cls: 'bg-blue-500',    label: 'Leased'   },
            { cls: 'bg-emerald-500', label: 'Vacant'   },
            { cls: 'bg-navy-500',    label: 'Reserved' },
            { cls: 'bg-slate-300',   label: 'OOO'      },
          ].map(({ cls, label }) => (
            <div key={label} className="flex items-center gap-1.5 text-ink-muted">
              <span className={`w-2.5 h-2.5 rounded-full ${cls}`} />
              {label}
            </div>
          ))}
        </div>
      </div>

      {/* ── Toolbar ── */}
      <div className="toolbar">
        <SearchInput
          placeholder="Search room, tenant or reserved name…"
          value={search}
          onChange={e => setSearch(e.target.value)}
          className="w-64"
        />
        <select
          value={typeFilter}
          onChange={e => setTypeFilter(e.target.value)}
          className="px-3 py-2 rounded-lg text-[13px] bg-surface
                     focus:outline-none focus:ring-2 focus:ring-navy-700/25 focus:border-navy-600 transition-colors"
          style={{ border: '1px solid var(--border)' }}
        >
          <option value="">All Room Types</option>
          {roomTypes.map(t => <option key={t} value={t}>{t}</option>)}
        </select>
        <select
          value={statFilter}
          onChange={e => setStatFilter(e.target.value)}
          className="px-3 py-2 rounded-lg text-[13px] bg-surface
                     focus:outline-none focus:ring-2 focus:ring-navy-700/25 focus:border-navy-600 transition-colors"
          style={{ border: '1px solid var(--border)' }}
        >
          <option value="">All Statuses</option>
          <option value="LEASED">Leased</option>
          <option value="VACANT">Vacant</option>
          <option value="RESERVED">Reserved</option>
          <option value="OUT OF ORDER">Out of Order</option>
        </select>
      </div>

      {/* ── Grid ── */}
      {grouped.length === 0 ? (
        <div className="empty">
          <SearchX size={32} className="mx-auto mb-3 text-ink-faint" />
          <p>No rooms match your filter</p>
        </div>
      ) : (
        <div className="rooms-grid">
          {grouped.map(([roomNo, room]) => {
            const occ = room.beds.filter(b => b.status === 'LEASED').length
            return (
              <div key={roomNo} className="room-card">
                <div className="room-card-head">
                  <div>
                    <div className="room-no">Room {roomNo}</div>
                    <div className="room-type">{room.room_type}</div>
                  </div>
                  <div className="text-right">
                    <div className="room-occ">{occ}/{room.beds.length}</div>
                    <div className="text-[10px] text-right" style={{ color: 'rgba(28,23,20,0.50)' }}>occupied</div>
                  </div>
                </div>

                <div className="bed-list">
                  {room.beds.map(b => {
                    const cls       = statusClass(b.status)
                    const rate      = b.rate || b.default_rate
                    const isLeased  = b.status === 'LEASED'
                    const clickable = !isLeased && !isViewer
                    return (
                      <div
                        key={b.bed_id}
                        className={`bed-row transition-colors ${clickable ? 'cursor-pointer hover:bg-surface-2 rounded-lg -mx-1 px-1' : ''}`}
                        onClick={clickable ? () => setStatusModal(b) : undefined}
                        title={clickable ? 'Click to change status' : undefined}
                      >
                        <div className={`bed-dot ${cls}`}>{b.bed_letter}</div>
                        <div className="bed-info">
                          {b.bed_location && (
                            <div className="bed-location">{b.bed_location}</div>
                          )}
                          {isLeased && b.tenant_name ? (
                            <div className="bed-name">{b.tenant_name}</div>
                          ) : b.status === 'RESERVED' && b.reserved_name ? (
                            <div className="bed-name text-navy-600">{b.reserved_name}</div>
                          ) : null}
                          {!isViewer && b.status === 'RESERVED' && heldByBed[b.bed_id] > 0 && (
                            <div className="text-[10px] font-semibold text-warning-text bg-warning-bg border border-warning-border rounded-full px-1.5 py-px w-fit">
                              {chipAmount(heldByBed[b.bed_id])} held
                            </div>
                          )}
                          {rate ? (
                            <div className="bed-rate">
                              ₱{Number(rate).toLocaleString('en-PH')}
                            </div>
                          ) : null}
                        </div>
                        <BedStatusBadge status={b.status} />
                      </div>
                    )
                  })}
                </div>
              </div>
            )
          })}
        </div>
      )}

      {statusModal && (
        <BedStatusModal
          bed={statusModal}
          onClose={() => setStatusModal(null)}
          onSaved={handleSaved}
          onPaymentsChanged={loadHeld}
        />
      )}
      {ledgerOpen && <ReservationLedgerModal onClose={() => setLedgerOpen(false)} />}
    </div>
  )
}
