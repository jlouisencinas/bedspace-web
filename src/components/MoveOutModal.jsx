import { useState, useEffect, useMemo, useRef } from 'react'
import { Link } from 'react-router-dom'
import { useAuth } from '../lib/auth'
import { requestApproval, fetchPendingMoveOutRequests } from '../lib/approvals'
import { verifyAdvanceFresh } from '../lib/supabase'
import { loadMoveOutBundle } from '../lib/moveOutData'
import {
  buildFinalBillDrafts, rebuildCreditLines, normalizeLines, computeTotals, round2, isSystemLine, isComputedLine,
  siblingGroup, siblingMismatch, toCents, pendingMoveOutFor,
} from '../lib/finalBill'
import { classifyStay, computeCoverage, appStart, localToday } from '../lib/stay'
import AdvanceCheckBox from './AdvanceCheckBox'
import CombinedBillSummary from './CombinedBillSummary'
import FinalBillPreview from './FinalBillPreview'
import { LogOut, Clock, AlertTriangle, X, CheckCircle, Pencil, Plus, Printer } from 'lucide-react'

const today = localToday

const peso = n => '₱' + Number(n || 0).toLocaleString('en-PH', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
const rd = n => (n == null ? '—' : Number(n).toLocaleString('en-PH', { maximumFractionDigits: 2, useGrouping: false }))
const strip = ({ _amt, ...l }) => l
const signed = n => (Number(n) < 0 ? '-' : '') + peso(Math.abs(Number(n) || 0))
const iso10 = v => (v ? String(v).slice(0, 10) : '')
const bedOf = t => t.bed_letter || t.beds?.bed_letter || ''
const isTail = l => l.kind === 'credit' || l.kind === 'forfeit' || l.source === 'ADVANCE_CLAWBACK'
const compose = (fresh, added) => [
  ...fresh.filter(l => !isTail(l) && l.kind !== 'payment'), ...added, ...fresh.filter(isTail), ...fresh.filter(l => l.kind === 'payment'),
]
const totalsOf = lines => computeTotals(normalizeLines(lines.map(strip)))
const SOURCE_NAME = { PREV_TENANT_MOVE_OUT: "previous tenant's move-out reading", MOVE_IN_READING: 'move-in reading', CUTOFF_CLOSING: 'closing reading of a cutoff', CUTOFF_PREV: 'opening reading of the cutoff', MANUAL: 'entered by staff' }

export default function MoveOutModal({ bed, tenants: tenantsProp, onClose, onSubmit }) {
  const { isAdmin } = useAuth()
  const group = useMemo(() => siblingGroup(bed, tenantsProp || [bed]), [])
  const mismatch = useMemo(() => siblingMismatch(bed, tenantsProp || [bed]), [])
  const groupIds = useMemo(() => group.map(g => g.id), [group])
  const multi = group.length > 1
  const defaultMoveOut = group[0].move_out_date ? iso10(group[0].move_out_date) : today()

  const [step, setStep] = useState(1)
  const [form, setForm] = useState({
    move_out_date:        defaultMoveOut,
    actual_move_out_date: defaultMoveOut,
    amount_paid:          '',
    water_reading:        '',
    electric_reading:     '',
  })
  const [reason, setReason]   = useState('')
  const [busy, setBusy]       = useState(false)
  const [submitted, setSubmitted] = useState(false)
  const [outcomes, setOutcomes] = useState(null)
  const [error, setError]     = useState('')
  const [actualTouched, setActualTouched] = useState(false)
  const [locked, setLocked] = useState(false)
  const [vacated, setVacated] = useState(false)
  const [previewOpen, setPreviewOpen] = useState(false)
  const [pendingReqs, setPendingReqs] = useState([])

  const [pre, setPre] = useState(null)
  const [preErr, setPreErr] = useState('')
  const [beds, setBeds] = useState({})
  const [sig, setSig] = useState('')
  const [rebuilt, setRebuilt] = useState(false)
  const [staleNotes, setStaleNotes] = useState({})
  const [startInfo, setStartInfo] = useState({ WATER: null, ELECTRIC: null })
  const [overrides, setOverrides] = useState({ WATER: '', ELECTRIC: '' })
  const [applied, setApplied] = useState({ WATER: '', ELECTRIC: '' })
  const seq = useRef(0)
  const todo = group.filter(g => outcomes?.[g.id]?.status !== 'ok')

  // One pending move-out request per tenant (like the profile edit): one cheap query when the modal opens.
  useEffect(() => {
    fetchPendingMoveOutRequests()
      .then(rows => setPendingReqs(pendingMoveOutFor(rows, groupIds)))
      .catch(e => console.warn('pending move-out check skipped:', e.message))
  }, [])

  useEffect(() => {
    const n = ++seq.current
    setPreErr('')
    loadMoveOutBundle({ groupIds, moveOutDate: form.actual_move_out_date })
      .then(b => { if (n === seq.current) setPre({ ...b, date: form.actual_move_out_date }) })
      .catch(e => { if (n === seq.current) { setPre(null); setPreErr(e.message) } })
  }, [form.actual_move_out_date])

  const coverage = useMemo(() => {
    if (!pre || pre.date !== form.actual_move_out_date) return null
    const t = pre.group[0]
    const cls = classifyStay({ moveIn: iso10(t.move_in_date), planned: iso10(t.move_out_date), actual: form.actual_move_out_date, appStartISO: appStart(pre.cutoffs) })
    return computeCoverage({ cutoffs: pre.cutoffs, moveInISO: iso10(t.move_in_date), moveOutISO: form.actual_move_out_date, kind: cls.kind })
  }, [pre, form.actual_move_out_date])
  const minOf = (util) => {
    const fin = coverage?.[util === 'WATER' ? 'water' : 'electric']?.final
    const row = fin ? pre.bundle.rowsByCutoff.get(util)?.get(fin.id) : null
    return row && row.prev != null ? Number(row.prev) : null
  }
  const minWater = minOf('WATER'), minElec = minOf('ELECTRIC')

  const set = (k, v) => {
    setError('')
    setForm(f => {
      const next = { ...f, [k]: v }
      if (k === 'move_out_date' && !actualTouched) next.actual_move_out_date = v
      return next
    })
  }

  const pendingText = pendingReqs.length
    ? `A move-out request for ${[...new Set(group.map(g => g.name))].join(' & ')} is already waiting for admin approval (submitted ${new Date(pendingReqs[0].created_at).toLocaleDateString('en-PH', { month: 'short', day: 'numeric', year: 'numeric' })}${pendingReqs[0].requester_email ? ` by ${pendingReqs[0].requester_email}` : ''}).${isAdmin ? ' Review it in Approvals instead of processing this move-out again.' : ' Wait for the admin to decide it.'}`
    : ''

  function validateStep1() {
    if (pendingText) return pendingText
    const actual = form.actual_move_out_date
    for (const g of group) {
      if (g.move_in_date && actual < iso10(g.move_in_date)) return `The move-out date cannot be before the move-in date${multi ? ` of Bed ${bedOf(g)}` : ''}.`
    }
    if (!form.water_reading) return 'Water meter reading is required.'
    if (minWater !== null && Number(form.water_reading) < minWater)
      return `Water reading (${form.water_reading}) cannot be less than the period's starting reading (${minWater}).`
    if (!form.electric_reading) return 'Electric meter reading is required.'
    if (minElec !== null && Number(form.electric_reading) < minElec)
      return `Electric reading (${form.electric_reading}) cannot be less than the period's starting reading (${minElec}).`
    if (preErr) return `Could not load billing data: ${preErr}`
    if (!pre || pre.date !== actual) return 'Billing data is still loading. Try again in a moment.'
    return null
  }

  // Re-reads everything the bill depends on and rebuilds the computed lines. Lines staff typed are kept; with `onlyUtil`
  // only that utility's computed lines are replaced (a start-reading edit). Returns { blocked } or { ok }.
  async function buildAll({ useOverrides = overrides, onlyUtil = null } = {}) {
    const b = await loadMoveOutBundle({ groupIds, moveOutDate: form.actual_move_out_date })
    setPre({ ...b, date: form.actual_move_out_date })
    const res = buildFinalBillDrafts({
      group: b.group.filter(g => todo.some(t => t.id === g.id)), cutoffs: b.cutoffs, tenants: b.tenants, moveOutDate: form.actual_move_out_date,
      readings: { water: form.water_reading, electric: form.electric_reading }, bundle: b.bundle,
      deposits: b.deposits, storedCredits: b.storedCredits, payments: b.payments, plannedMoveOut: b.plannedMoveOut,
      waived: new Map(todo.map(g => [g.id, !!beds[g.id]?.waived])), siblingIds: b.siblingIds,
      startOverrides: { WATER: useOverrides.WATER === '' ? undefined : useOverrides.WATER, ELECTRIC: useOverrides.ELECTRIC === '' ? undefined : useOverrides.ELECTRIC },
      isAdmin,
    })
    const blocked = [...new Set(todo.flatMap(g => res.drafts.get(g.id).blocking))]
    if (blocked.length) { setBeds({}); setSig(''); return { blocked } }
    setBeds(prev => {
      const next = {}
      for (const g of todo) {
        const d = res.drafts.get(g.id), old = prev[g.id]
        let lines
        if (onlyUtil && old) {
          const without = old.lines.filter(l => l.source !== onlyUtil)
          const fresh = d.lines.filter(l => l.source === onlyUtil)
          const first = old.lines.findIndex(l => l.source === onlyUtil)
          const tail = without.findIndex(l => isTail(l) || l.kind === 'payment')
          const at = first >= 0 ? first : (tail < 0 ? without.length : tail)
          lines = [...without.slice(0, at), ...fresh, ...without.slice(at)]
        } else {
          lines = compose(d.lines, old ? old.lines.filter(l => l.kind === 'unsettled') : [])
        }
        next[g.id] = { draft: d, lines, waived: old?.waived || false, waiveReason: old?.waiveReason || '', preparedBy: old?.preparedBy || '', verified: null, editIdx: null }
      }
      return next
    })
    setStartInfo(res.startReadings)
    setApplied(useOverrides)
    return { ok: true }
  }

  const sigOf = () => `${form.actual_move_out_date}|${form.water_reading}|${form.electric_reading}`

  async function goToBill() {
    const err = validateStep1()
    if (err) { setError(err); return }
    setError('')
    const s = sigOf()
    if (Object.keys(beds).length && s === sig) { setStep(2); return }
    setBusy(true)
    try {
      const hadDraft = Object.keys(beds).length > 0
      const r = await buildAll()
      if (r.blocked) { setError(r.blocked.join('\n')); setBusy(false); return }
      setSig(s); setRebuilt(hadDraft); setStaleNotes({})
      setStep(2)
    } catch (e) { setError(e.message) }
    setBusy(false)
  }

  async function changeStart(util, value) {
    const next = { ...overrides, [util]: value }
    setOverrides(next)
    setBusy(true); setError('')
    try {
      const r = await buildAll({ useOverrides: next, onlyUtil: util })
      if (r.blocked) setError(r.blocked.join('\n'))
    } catch (e) { setError(e.message) }
    setBusy(false)
  }

  // Something the bill depends on changed under the open modal: nothing was written, rebuild and send staff back to review.
  async function rebuildAfterStale(notes) {
    const r = await buildAll()
    if (r.blocked) { setStep(1); setError(r.blocked.join('\n')); return }
    setStaleNotes(notes); setRebuilt(false); setError(''); setStep(2)
  }

  const patchBed = (id, patch) => setBeds(prev => ({ ...prev, [id]: { ...prev[id], ...patch } }))
  const patchLine = (id, i, patch) => setBeds(prev => ({ ...prev, [id]: { ...prev[id], lines: prev[id].lines.map((l, j) => (j === i ? { ...l, ...patch } : l)) } }))
  function toggleWaive(id, next) {
    const s = beds[id]
    const r = rebuildCreditLines(s.lines, pre.deposits.get(id), { earlyTermination: s.draft.earlyTermination, waived: next, prior: s.draft.prior })
    patchBed(id, { waived: next, lines: r.lines, draft: { ...s.draft, check: r.check, notes: r.notes }, verified: null })
  }
  function setAmount(id, i, raw) {
    const l = beds[id].lines[i]
    const n = Number(raw)
    patchLine(id, i, { _amt: raw, amount: raw === '' || !Number.isFinite(n) ? 0 : (l.kind === 'credit' ? -Math.abs(n) : n) })
  }
  function addLine(id) {
    const s = beds[id]
    const at = s.lines.findIndex(l => isTail(l) || l.kind === 'payment')
    const line = { label: 'Add: Unsettled ', mid: '', amount: 0, kind: 'unsettled', _amt: '' }
    const lines = at < 0 ? [...s.lines, line] : [...s.lines.slice(0, at), line, ...s.lines.slice(at)]
    patchBed(id, { lines, editIdx: at < 0 ? s.lines.length : at })
  }
  function removeLine(id, i) { patchBed(id, { lines: beds[id].lines.filter((_, j) => j !== i), editIdx: null }) }

  const billFor = (g) => {
    const s = beds[g.id]
    const w = isAdmin && s.draft.earlyTermination && s.waived
    return {
      cutoff_id: s.draft.cutoff_id, covered_cutoffs: s.draft.covered_cutoffs, lines: normalizeLines(s.lines.map(strip)), details: s.draft.details,
      early_termination: s.draft.earlyTermination, forfeit_waived: w, waived_reason: w ? s.waiveReason.trim() : null,
      prepared_by: s.preparedBy.trim() || null,
    }
  }

  function validateStep2() {
    for (const g of todo) {
      const s = beds[g.id]
      const tag = multi ? `Bed ${bedOf(g)}: ` : ''
      if (s.draft.errors.length) return `${tag}${s.draft.errors[0]}`
      for (const l of s.lines) {
        if (!String(l.label ?? '').trim()) return `${tag}every line needs a label.`
        if (l._amt !== undefined && l._amt !== '' && !Number.isFinite(Number(l._amt))) return `${tag}"${l.label}" has an invalid amount.`
      }
      if (s.draft.earlyTermination && s.waived && !s.waiveReason.trim()) return `${tag}enter the reason management approved waiving the forfeiture.`
    }
    return null
  }

  async function goToConfirm() {
    const err = validateStep2()
    if (err) { setError(err); return }
    setError(''); setBusy(true)
    for (const g of todo) patchBed(g.id, { editIdx: null })
    try {
      const notes = {}
      const verdicts = {}
      for (const g of todo) {
        const v = await verifyAdvanceFresh(g, form.actual_move_out_date, billFor(g))
        verdicts[g.id] = v
        if (!v.ok) notes[g.id] = [...v.errors, ...v.stale]
      }
      if (Object.keys(notes).length) {
        await rebuildAfterStale(notes)
        setBusy(false)
        return
      }
      for (const g of todo) patchBed(g.id, { verified: { check: verdicts[g.id].check, at: new Date() } })
      setStaleNotes({})
      setStep(3)
    } catch (e) { setError(e.message) }
    setBusy(false)
  }

  const heldAfter = useMemo(() => {
    if (!pre || step !== 3) return []
    return todo.flatMap(g => {
      const s = beds[g.id]
      if (!s) return []
      const settled = new Set(normalizeLines(s.lines.map(strip)).flatMap(l => (l.kind === 'credit' || l.kind === 'forfeit') ? (l.deposit_ids || []) : []))
      return (pre.deposits.get(g.id) || []).filter(d => d.status === 'HELD' && !settled.has(d.id)).map(d => ({ ...d, bed: bedOf(g) }))
    })
  }, [pre, beds, step])
  const settleCounts = useMemo(() => {
    let applied = 0, forfeited = 0
    for (const g of todo) {
      const s = beds[g.id]; if (!s) continue
      for (const l of s.lines) {
        if (l.kind === 'credit') applied += l.deposit_ids?.length || 0
        if (l.kind === 'forfeit') forfeited += l.deposit_ids?.length || 0
      }
    }
    return { applied, forfeited }
  }, [beds])
  const combinedNetCents = todo.reduce((s, g) => s + (beds[g.id] ? toCents(totalsOf(beds[g.id].lines).net_amount) : 0), 0)

  const moveOutPayload = () => ({
    move_out_date: form.move_out_date, actual_move_out_date: form.actual_move_out_date,
    amount_paid: form.amount_paid, water_reading: round2(form.water_reading), electric_reading: round2(form.electric_reading),
  })

  async function confirm() {
    const moveOut = moveOutPayload()
    setBusy(true); setError('')
    try {
      if (!isAdmin) {
        if (!reason.trim()) { setError('Please provide a reason for the move-out.'); setBusy(false); return }
        const mkBill = (g) => {
          const s = beds[g.id]
          return { ...billFor(g), ...totalsOf(s.lines), planned_move_out: iso10(g.move_out_date) || null, prior_cutoff: s.draft.prior?.name ? { name: s.draft.prior.name } : null, advance_check: s.verified?.check ?? s.draft.check }
        }
        const first = todo[0]
        const ref = (g) => ({
          _tenant_id: String(g.id), _bed_id: String(g.bed_id), _room_no: g.room_no, _bed_letter: bedOf(g),
          _tenant_name: g.name, _rate: g.rate, _move_in_date: g.move_in_date,
        })
        await requestApproval({
          entityType: 'TENANT_STAY',
          entityId:   String(first.id),
          fieldName:  'move_out',
          oldValue:   { is_active: true, move_out_date: first.move_out_date || null },
          newValue: {
            _action: 'process_move_out', ...ref(first), ...moveOut, _bill: mkBill(first),
            ...(todo.length > 1 ? { _siblings: todo.slice(1).map(g => ({ ...ref(g), _bill: mkBill(g) })) } : {}),
          },
          reason: reason.trim(),
        })
        setSubmitted(true)
      } else {
        const items = todo.map(g => ({ tenant: g, bill: billFor(g), withPayment: g.id === group[0].id }))
        const res = await onSubmit({ moveOut, items, groupTenantIds: groupIds, vacated: { confirmed: vacated, at: new Date().toISOString() } })
        finishRun(res)
      }
    } catch (e) {
      setError(e.message)
    }
    setBusy(false)
  }

  function finishRun(res) {
    setOutcomes(prev => {
      const next = { ...(prev || {}) }
      for (const r of res) next[r.tenantId] = r
      return next
    })
    setStep('done')
    if (res.some(r => r.status === 'failed' && (r.partial || r.orphanBill))) setLocked(true)
  }

  const retriable = (r) => r.status === 'failed' && !r.partial && !r.orphanBill && !r.stale
  async function retryFailed() {
    const failed = group.filter(g => outcomes[g.id] && retriable(outcomes[g.id]))
    setBusy(true); setError('')
    try {
      const items = []
      for (const g of failed) {
        const v = await verifyAdvanceFresh(g, form.actual_move_out_date, billFor(g))
        if (!v.ok) { await goBackForStale({ [g.id]: [...v.errors, ...v.stale] }); setBusy(false); return }
        items.push({ tenant: g, bill: billFor(g), withPayment: g.id === group[0].id })
      }
      const res = await onSubmit({ moveOut: moveOutPayload(), items, groupTenantIds: groupIds, vacated: { confirmed: vacated, at: new Date().toISOString() } })
      finishRun(res)
    } catch (e) { setError(e.message) }
    setBusy(false)
  }
  async function goBackForStale(notes) {
    try { await rebuildAfterStale(notes) } catch (e2) { setError(`Reloading the bill failed (${e2.message}); close and reopen Move Out.`) }
  }
  async function fixStale() {
    setBusy(true); setError('')
    const notes = {}
    for (const g of group) if (outcomes[g.id]?.stale) notes[g.id] = outcomes[g.id].diffs || [outcomes[g.id].error]
    await goBackForStale(notes)
    setBusy(false)
  }

  const head = (title) => (
    <div className="modal-head">
      <h3><span className="inline-flex items-center gap-1.5"><LogOut size={16} /> {title}</span></h3>
      <button className="btn-close" onClick={onClose}><X size={16} /></button>
    </div>
  )
  const headBar = (
    <div className="bg-danger-bg border border-danger-border rounded-xl px-4 py-3 text-[13px] space-y-1.5">
      {group.map(g => (
        <div key={g.id}>
          <div className="font-semibold text-ink">{g.name}</div>
          <div className="text-ink-muted mt-0.5">
            Room {g.room_no} · Bed {bedOf(g)}{g.rate ? ` · ₱${Number(g.rate).toLocaleString('en-PH')}/mo` : ''}
            {g.move_in_date && ` · stays ${iso10(g.move_in_date)} to ${iso10(g.move_out_date) || 'no end date'}`}
          </div>
        </div>
      ))}
      {multi && <div className="text-[12px] text-ink-muted pt-1 border-t border-danger-border">These {group.length} beds are rented by the same name and leave on the same planned date, so they move out together: one date, one set of room readings, one bill per bed.</div>}
      {mismatch.length > 0 && (
        <div className="text-[12px] text-warning-text pt-1 border-t border-danger-border">
          Not part of this move-out: {mismatch.map(m => `Bed ${bedOf(m)} (planned ${iso10(m.move_out_date) || 'no end date'})`).join(', ')} — same name but a different planned date. Move it out separately.
        </div>
      )}
    </div>
  )

  if (submitted) {
    return (
      <div className="overlay" onClick={e => e.stopPropagation()}>
        <div className="modal modal-sm">
          {head('Process Move Out')}
          <div className="modal-body text-center py-8">
            <Clock size={36} className="mx-auto mb-3 text-amber-400" />
            <h4 className="text-[15px] font-semibold text-ink mb-2">Sent for Approval</h4>
            <p className="text-[13px] text-ink-muted leading-relaxed">
              The move-out request and {multi ? 'its final bills have' : 'its final bill has'} been submitted to an admin for review.
              {multi ? ' The tenants and beds' : ' The tenant and bed'} will remain active until approved.
            </p>
          </div>
          <div className="modal-foot"><button className="btn primary" onClick={onClose}>Close</button></div>
        </div>
      </div>
    )
  }

  if (step === 'done') {
    const okIds = group.filter(g => outcomes[g.id]?.status === 'ok').map(g => outcomes[g.id].billId)
    const failed = group.filter(g => outcomes[g.id]?.status === 'failed')
    const stale = failed.filter(g => outcomes[g.id].stale)
    const canRetry = failed.some(g => retriable(outcomes[g.id]))
    const combined = group.reduce((s, g) => s + (outcomes[g.id]?.status === 'ok' ? toCents(outcomes[g.id].net_amount) : 0), 0)
    return (
      <div className="overlay" onClick={e => e.stopPropagation()}>
        <div className="modal modal-sm">
          {head(failed.length ? 'Move Out Needs Attention' : 'Move Out Complete')}
          <div className="modal-body py-6 space-y-3 text-[13px]">
            {group.map(g => {
              const r = outcomes[g.id]
              if (!r) return null
              if (r.status === 'ok') {
                const refund = r.net_amount < 0
                return (
                  <div key={g.id} className="rounded-xl bg-success-bg border border-success-border px-3 py-2.5">
                    <div className="font-semibold text-ink flex items-center gap-1.5"><CheckCircle size={14} className="text-emerald-500" /> {g.name} · Bed {bedOf(g)} has moved out</div>
                    <div className={`text-[14px] font-semibold ${refund ? 'text-success-text' : 'text-ink'}`}>
                      {refund ? `Amount to be returned ${peso(-r.net_amount)}` : `Total amount due ${peso(r.net_amount)}`}
                    </div>
                    <div className="text-[12px] text-ink-muted">Final bill #{r.billId}</div>
                  </div>
                )
              }
              return (
                <div key={g.id} className="rounded-xl bg-danger-bg border border-danger-border px-3 py-2.5">
                  <div className="font-semibold text-danger-text flex items-center gap-1.5"><AlertTriangle size={14} /> {g.name} · Bed {bedOf(g)} did NOT complete</div>
                  <div className="text-[12px] text-ink whitespace-pre-wrap">{r.error}</div>
                  {r.partial && <div className="text-[12px] text-danger-text mt-1">This bed is partly processed and cannot be retried here. Follow the steps in the message above.</div>}
                </div>
              )
            })}
            {multi && okIds.length > 0 && (
              <div className={`text-[14px] font-bold ${combined < 0 ? 'text-success-text' : 'text-ink'}`}>
                {okIds.length === group.length ? 'Combined: ' : `Combined (${okIds.length} of ${group.length} beds): `}
                {combined < 0 ? `amount to be returned ${peso(-combined / 100)}` : `total amount due ${peso(combined / 100)}`}
              </div>
            )}
            {error && <div className="p-3 bg-danger-bg text-danger-text rounded-xl border border-danger-border whitespace-pre-wrap">{error}</div>}
          </div>
          <div className="modal-foot">
            <button className="btn secondary" onClick={onClose} disabled={busy}>Close</button>
            {stale.length > 0 && <button className="btn secondary" onClick={fixStale} disabled={busy}>Review the rebuilt bill</button>}
            {canRetry && <button className="btn danger" onClick={retryFailed} disabled={busy}>{busy ? 'Retrying…' : 'Retry failed bed(s)'}</button>}
            {okIds.length > 0 && <Link className="btn primary" to={`/print/final-bill?ids=${okIds.join(',')}`}><Printer size={14} /> {okIds.length > 1 ? 'Print final bills' : 'Print final bill'}</Link>}
          </div>
        </div>
      </div>
    )
  }

  const summedItems = todo.filter(g => beds[g.id]).map(g => ({ bed: bedOf(g), bill: { lines: beds[g.id].lines.map(strip), details: beds[g.id].draft.details } }))
  const previewList = () => todo.filter(g => beds[g.id]).map(g => {
    const s = beds[g.id], lines = normalizeLines(s.lines.map(strip))
    return {
      bill: {
        id: g.id, status: 'DRAFT', move_out_date: form.actual_move_out_date, lines, net_amount: computeTotals(lines).net_amount,
        details: { ...s.draft.details, advance_check: s.verified?.check ?? s.draft.check }, prepared_by: s.preparedBy.trim(),
      },
      tenant: { name: g.name, beds: { bed_letter: bedOf(g), rooms: { room_no: g.room_no } } },
    }
  })
  const stepTitle = { 1: 'Move-out details', 2: 'Final bill', 3: 'Confirm' }[step]
  const waterName = coverage?.water.final?.name, elecName = coverage?.electric.final?.name
  const stayClass = group.some(g => beds[g.id]?.draft.stay.kind === 'STAY_BILLED')

  return (
    <div className="overlay" onClick={e => e.stopPropagation()}>
      <div className="modal" style={{ maxWidth: step === 1 ? 520 : 800 }}>
        {head(`Process Move Out — ${stepTitle} (${step}/3)`)}
        <div className="modal-body space-y-4">
          {headBar}

          {step === 1 && pendingText && (
            <div className="bg-warning-bg border border-warning-border rounded-xl px-3 py-2.5 text-[12px] text-warning-text">
              <AlertTriangle size={13} className="shrink-0 mt-px inline mr-1" /> {pendingText}
            </div>
          )}

          {step === 1 && (
            <div className="form-grid">
              <div className="fg">
                <label>Move Out Date</label>
                <input type="date" value={form.move_out_date} onChange={e => set('move_out_date', e.target.value)} />
              </div>
              <div className="fg">
                <label>Actual Move Out Date</label>
                <input type="date" value={form.actual_move_out_date}
                  onChange={e => { setActualTouched(true); set('actual_move_out_date', e.target.value) }} />
              </div>

              <div className="form-section">Final Meter Readings{multi ? ' (the room, shared by all beds)' : ''}</div>

              <div className="fg">
                <label>Water Reading <span className="text-danger-text">*</span></label>
                <input type="number" value={form.water_reading} min={minWater ?? 0} step="0.0001"
                  placeholder="e.g. 1234.50" onChange={e => set('water_reading', e.target.value)} required />
                <span className="block text-[11px] text-ink-faint mt-1">
                  {coverage ? (waterName ? `Saved against the ${waterName} cutoff` : 'No cutoff holds this date for water') : 'Checking cutoffs…'}
                  {minWater !== null && ` · Min: ${minWater}`}
                </span>
              </div>
              <div className="fg">
                <label>Electric Reading <span className="text-danger-text">*</span></label>
                <input type="number" value={form.electric_reading} min={minElec ?? 0} step="0.0001"
                  placeholder="e.g. 5678.90" onChange={e => set('electric_reading', e.target.value)} required />
                <span className="block text-[11px] text-ink-faint mt-1">
                  {coverage ? (elecName ? `Saved against the ${elecName} cutoff` : 'No cutoff holds this date for electricity') : 'Checking cutoffs…'}
                  {minElec !== null && ` · Min: ${minElec}`}
                </span>
              </div>
              {coverage && (!waterName || !elecName) && (
                <div className="fg full">
                  <div className="bg-warning-bg border border-warning-border rounded-xl px-3 py-2.5 text-[12px] text-warning-text">
                    <AlertTriangle size={13} className="shrink-0 mt-px inline mr-1" />
                    {[!waterName && coverage.water.missing, !elecName && coverage.electric.missing].filter(Boolean).map(m => `Open the ${m.name} cutoff first.`).join(' ')}
                    {isAdmin ? ' As an admin you can continue: those lines are 0 and that reading is not saved.' : ' Ask an admin to open it, or to process this move-out.'}
                  </div>
                </div>
              )}

              <div className="fg full">
                <label>Final Amount Paid (PHP, optional){multi ? ` — recorded once, on Bed ${bedOf(group[0])}` : ''}</label>
                <input type="number" value={form.amount_paid} onChange={e => set('amount_paid', e.target.value)} placeholder="0.00" min="0" step="0.01" />
              </div>

              {!isAdmin && (
                <div className="fg full">
                  <div className="bg-warning-bg border border-warning-border rounded-xl px-3 py-2.5 text-[12px] text-warning-text">
                    <AlertTriangle size={13} className="shrink-0 mt-px inline mr-1" /> Move-out requires admin approval. The bed{multi ? 's' : ''} and tenant{multi ? 's' : ''} will remain active until an admin reviews and approves this request.
                  </div>
                </div>
              )}
            </div>
          )}

          {step === 2 && (
            <div className="space-y-5 text-[12px]">
              {rebuilt && (
                <div className="bg-info-bg border border-info-border rounded-xl px-3 py-2 text-info-text">
                  The date or readings changed, so the computed lines were rebuilt (edits to them were reset). Lines you added were kept.
                </div>
              )}
              {stayClass && (
                <div className="bg-surface-2 border border-line-subtle rounded-xl px-3 py-2.5 space-y-2">
                  <div className="font-semibold text-ink">Where the stay's meter readings start</div>
                  {['WATER', 'ELECTRIC'].map(u => {
                    const si = startInfo[u]
                    return (
                      <div key={u} className="flex items-center gap-2 flex-wrap">
                        <span className="w-20 text-ink-muted">{u === 'WATER' ? 'Water' : 'Electricity'}</span>
                        <span className="text-ink">
                          {si ? `${rd(si.value)} — ${SOURCE_NAME[si.source] || si.source}${si.date && si.source !== 'MANUAL' ? ` (${si.date})` : ''}` : 'not found: enter it'}
                        </span>
                        <input type="number" step="0.01" className="w-28 text-right ml-auto" placeholder="override" value={overrides[u]}
                          onChange={e => setOverrides(o => ({ ...o, [u]: e.target.value }))}
                          onBlur={() => { if (overrides[u] !== applied[u]) changeStart(u, overrides[u]) }} />
                      </div>
                    )
                  })}
                  <div className="text-ink-faint">The room's consumption between the start reading and the move-out reading is split by days present between the beds. Change a start reading only if the meter was read differently.</div>
                </div>
              )}
              <CombinedBillSummary items={summedItems} />
              {todo.map(g => beds[g.id] && (
                <BedBill key={g.id} g={g} s={beds[g.id]} multi={multi} isAdmin={isAdmin} staleNote={staleNotes[g.id]}
                  actual={form.actual_move_out_date}
                  patchBed={patchBed} patchLine={patchLine} toggleWaive={toggleWaive} setAmount={setAmount}
                  addLine={addLine} removeLine={removeLine} />
              ))}
              {multi && (
                <div className="rounded-xl bg-surface-2 px-4 py-3 space-y-1">
                  {todo.map(g => beds[g.id] && (
                    <div key={g.id} className="flex justify-between">
                      <span className="text-ink-muted">Bed {bedOf(g)} — {g.name}</span>
                      <span className="tabular-nums">{signed(totalsOf(beds[g.id].lines).net_amount)}</span>
                    </div>
                  ))}
                  <div className={`flex justify-between text-[15px] font-bold border-t border-line-subtle pt-1 ${combinedNetCents < 0 ? 'text-success-text' : 'text-ink'}`}>
                    <span>{combinedNetCents < 0 ? 'Combined amount to be returned' : 'Combined total amount due'}</span>
                    <span className="tabular-nums">{peso(Math.abs(combinedNetCents) / 100)}</span>
                  </div>
                </div>
              )}
            </div>
          )}

          {step === 3 && (
            <div className="space-y-3 text-[13px]">
              <CombinedBillSummary items={summedItems} />
              <div className="rounded-xl bg-surface-2 px-4 py-3 space-y-1">
                <div>Actual move-out: <strong>{form.actual_move_out_date}</strong> (lease end {iso10(group[0].move_out_date) || 'not set'})</div>
                <div>Readings: water <strong>{form.water_reading}</strong> · electric <strong>{form.electric_reading}</strong></div>
                {todo.map(g => beds[g.id] && (
                  <div key={g.id} className={`font-bold ${totalsOf(beds[g.id].lines).net_amount < 0 ? 'text-success-text' : 'text-ink'}`}>
                    {multi && `Bed ${bedOf(g)} — ${g.name}: `}
                    {totalsOf(beds[g.id].lines).net_amount < 0 ? `Amount to be returned ${peso(-totalsOf(beds[g.id].lines).net_amount)}` : `Total amount due ${peso(totalsOf(beds[g.id].lines).net_amount)}`}
                    {beds[g.id].draft.earlyTermination && (
                      <span className={`ml-2 font-normal ${beds[g.id].waived ? 'text-success-text' : 'text-danger-text'}`}>
                        {beds[g.id].waived ? `early termination — forfeiture waived: ${beds[g.id].waiveReason}` : 'early termination — advance and deposit forfeited'}
                      </span>
                    )}
                  </div>
                ))}
                {multi && (
                  <div className={`text-[15px] font-bold ${combinedNetCents < 0 ? 'text-success-text' : 'text-ink'}`}>
                    {combinedNetCents < 0 ? `Combined amount to be returned ${peso(-combinedNetCents / 100)}` : `Combined total amount due ${peso(combinedNetCents / 100)}`}
                  </div>
                )}
              </div>
              {todo.map(g => beds[g.id] && (
                <div key={g.id} className="space-y-1">
                  {multi && <div className="text-[11px] font-bold uppercase tracking-wider text-ink-faint">Bed {bedOf(g)}</div>}
                  <AdvanceCheckBox check={beds[g.id].verified?.check ?? beds[g.id].draft.check} checkedAt={beds[g.id].verified?.at} />
                </div>
              ))}
              {isAdmin && (
                <label className="flex items-start gap-2 text-ink cursor-pointer rounded-xl border border-line-subtle px-3 py-2.5">
                  <input type="checkbox" className="mt-0.5" checked={vacated} onChange={e => setVacated(e.target.checked)} />
                  <span><strong>Tenant{multi ? 's have' : ' has'} vacated the room and access has been returned</strong> (required{multi ? '; one tick covers every bed' : ''}).</span>
                </label>
              )}
              {isAdmin ? (
                <div className="text-ink-muted">
                  Confirming saves {multi ? `${group.length} final bills` : 'the final bill'}, moves {multi ? 'the tenants' : 'the tenant'} out, frees {multi ? 'the beds' : 'the bed'}, saves the move-out readings and sets
                  {' '}{settleCounts.applied} receipt(s) to APPLIED and {settleCounts.forfeited} to FORFEITED.
                </div>
              ) : (
                <>
                  <div className="bg-warning-bg border border-warning-border rounded-xl px-3 py-2.5 text-[12px] text-warning-text">
                    <AlertTriangle size={13} className="shrink-0 mt-px inline mr-1" /> This is sent to an admin as ONE request with the full bill{multi ? 's' : ''}. Nothing changes until it is approved.
                  </div>
                  <div className="fg">
                    <label>Reason for move-out <span className="text-danger-text">*</span></label>
                    <textarea rows={2} value={reason} onChange={e => { setError(''); setReason(e.target.value) }}
                      placeholder="State the reason for the move-out…" />
                  </div>
                </>
              )}
              {heldAfter.length > 0 && (
                <div className="bg-warning-bg border border-warning-border rounded-xl px-3 py-2 text-[12px] text-warning-text">
                  {heldAfter.length} receipt(s) ({heldAfter.map(d => `${multi ? `Bed ${d.bed} ` : ''}${d.kind.toLowerCase()} ${peso(d.amount)}`).join(', ')}) have no credit or forfeit line and will stay HELD.
                </div>
              )}
            </div>
          )}

          {error && (
            <div className="p-3 bg-danger-bg text-danger-text text-[13px] rounded-xl border border-danger-border whitespace-pre-wrap">{error}</div>
          )}
        </div>
        <div className="modal-foot">
          {locked && <button type="button" className="btn primary" onClick={onClose}>Close</button>}
          {!locked && step === 1 && <button type="button" className="btn secondary" onClick={onClose}>Cancel</button>}
          {!locked && step > 1 && <button type="button" className="btn secondary" disabled={busy} onClick={() => setPreviewOpen(true)}><Printer size={14} /> Preview bill</button>}
          {!locked && step > 1 && <button type="button" className="btn secondary" disabled={busy} onClick={() => { setError(''); for (const g of todo) patchBed(g.id, { editIdx: null }); setStep(step - 1) }}>Back</button>}
          {!locked && step === 1 && <button type="button" className="btn primary" disabled={busy || !!pendingText} onClick={goToBill}>{busy ? 'Building bill…' : 'Next: Final bill'}</button>}
          {!locked && step === 2 && <button type="button" className="btn primary" disabled={busy} onClick={goToConfirm}>{busy ? 'Checking the database…' : 'Next: Confirm'}</button>}
          {!locked && step === 3 && (
            <button type="button" className="btn danger" disabled={busy || (isAdmin && !vacated)} onClick={confirm}>
              {busy ? 'Processing…' : isAdmin ? 'Confirm Move Out' : 'Submit for Approval'}
            </button>
          )}
        </div>
      </div>
      {previewOpen && <FinalBillPreview list={previewList()} onClose={() => setPreviewOpen(false)} />}
    </div>
  )
}

// One bed's section of the final bill editor.
function BedBill({ g, s, multi, isAdmin, staleNote, actual, patchBed, patchLine, toggleWaive, setAmount, addLine, removeLine }) {
  const { draft, lines, waived, waiveReason, preparedBy, editIdx } = s
  const totals = totalsOf(lines)
  const net = totals.net_amount
  const planned = iso10(g.move_out_date)
  const cov = draft.details.stay.coverage
  const kindText = draft.stay.kind === 'STAY_BILLED'
    ? (draft.stay.rentRule === 'FLAT_ONE_MONTH' ? 'One-month stay: flat monthly rent, billed only on this final bill' : 'One-month stay ended early or late: rent prorated by days')
    : draft.stay.kind === 'WHOLE_MONTHS' ? `Rent for the stay (${draft.details.stay.rent_summary || 'months plus extra days'}) less rent already billed on closed statements`
    : 'Rent prorated by days'
  return (
    <div className="space-y-3 border border-line-subtle rounded-xl p-3">
      {multi && <div className="font-semibold text-[13px] text-ink">Bed {bedOf(g)} — {g.name}</div>}
      {staleNote && (
        <div className="bg-warning-bg border border-warning-border rounded-xl px-3 py-2 text-warning-text space-y-1">
          <div className="font-semibold">The bill depended on data that changed while you were working. It was rebuilt, review it and confirm again.</div>
          {staleNote.map((x, i) => <div key={i}>{x}</div>)}
        </div>
      )}
      <AdvanceCheckBox check={draft.check} />
      {draft.errors.length > 0 && (
        <div className="bg-danger-bg border border-danger-border rounded-xl px-3 py-2 text-danger-text space-y-1">
          {draft.errors.map((w, i) => <div key={i}><AlertTriangle size={12} className="inline mr-1" />{w}</div>)}
        </div>
      )}
      {draft.warnings.length > 0 && (
        <div className="bg-warning-bg border border-warning-border rounded-xl px-3 py-2 text-warning-text space-y-1">
          {draft.warnings.map((w, i) => <div key={i}><AlertTriangle size={12} className="inline mr-1" />{w}</div>)}
        </div>
      )}

      {draft.earlyTermination && (
        <div className="bg-danger-bg border border-danger-border rounded-xl px-3 py-2.5 space-y-2">
          <div className="text-danger-text font-semibold">
            Early termination: the move-out ({actual}) is before the lease end ({planned}).
            {!waived && ' Advance and deposit are forfeited.'}
          </div>
          {isAdmin ? (
            <>
              <label className="flex items-center gap-2 text-ink cursor-pointer">
                <input type="checkbox" checked={waived} onChange={e => toggleWaive(g.id, e.target.checked)} />
                Management approved — do not forfeit
              </label>
              {waived && (
                <input type="text" value={waiveReason} onChange={e => patchBed(g.id, { waiveReason: e.target.value })}
                  placeholder="Reason management approved the waiver (required)" className="w-full" />
              )}
            </>
          ) : (
            <div className="text-ink-muted">Only an admin can waive the forfeiture. The approving admin can change it when reviewing this request.</div>
          )}
        </div>
      )}

      <div className="text-ink-muted space-y-0.5">
        <div>{kindText}.</div>
        <div>
          Covers: water {cov.water.covered.length ? cov.water.covered.join(', ') : 'no period'} · electricity {cov.electric.covered.length ? cov.electric.covered.join(', ') : 'no period'}.
          {' '}Everything below is filled in from existing data; click a row to adjust it, or add a line.
        </div>
      </div>

      <table className="w-full">
        <thead>
          <tr className="text-left text-[10px] uppercase tracking-wider text-ink-faint">
            <th className="py-1">Item</th><th>Details</th><th className="text-right">Amount</th><th></th>
          </tr>
        </thead>
        <tbody>
          {lines.map((l, i) => {
            const editing = editIdx === i
            const credit = l.kind === 'credit' || l.kind === 'payment', forfeit = l.kind === 'forfeit'
            const system = isSystemLine(l)
            const noDelete = system || isComputedLine(l)
            return (
              <tr key={i} className="border-t border-line-subtle align-top">
                {editing ? (
                  <>
                    <td className="py-1 pr-2"><input type="text" className="w-full" value={l.label} onChange={e => patchLine(g.id, i, { label: e.target.value })} /></td>
                    <td className="pr-2"><input type="text" className="w-full" value={l.mid ?? ''} onChange={e => patchLine(g.id, i, { mid: e.target.value })} /></td>
                    <td className="text-right">
                      {forfeit ? <span className="text-ink-muted">{peso(0)}</span> : system ? (
                        <span className="text-ink-muted" title="Set from the receipts, the stored advance credits and the recorded payments; it cannot be changed here">{credit ? `-${peso(Math.abs(l.amount))}` : signed(l.amount)}</span>
                      ) : (
                        <input type="number" step="0.01" className="w-28 text-right"
                          value={l._amt !== undefined ? l._amt : (l.kind === 'credit' ? Math.abs(l.amount) : l.amount)}
                          onChange={e => setAmount(g.id, i, e.target.value)} />
                      )}
                    </td>
                    <td className="whitespace-nowrap pl-2">
                      <button type="button" className="btn-xs blue" onClick={() => { patchLine(g.id, i, { _amt: undefined }); patchBed(g.id, { editIdx: null }) }}>Done</button>
                      {!noDelete && <button type="button" className="btn-xs red ml-1" onClick={() => removeLine(g.id, i)} title="Remove line"><X size={10} /></button>}
                    </td>
                  </>
                ) : (
                  <>
                    <td className={`py-1.5 pr-2 cursor-pointer ${l.kind === 'unsettled' ? 'italic' : ''}`} onClick={() => patchBed(g.id, { editIdx: i })}>{l.label}</td>
                    <td className="pr-2 text-ink-muted cursor-pointer" onClick={() => patchBed(g.id, { editIdx: i })}>
                      {l.mid}{l.rate != null && ` × ${peso(l.rate)}`}
                      {forfeit && l.original != null && ` (${peso(l.original)} forfeited)`}
                      {l.rate_note && <div className="text-[11px] text-warning-text">{l.rate_note}</div>}
                      {l.gap_note && <div className="text-[11px] text-ink-faint">{l.gap_note}</div>}
                    </td>
                    <td className={`text-right tabular-nums cursor-pointer ${credit ? 'text-success-text' : ''}`} onClick={() => patchBed(g.id, { editIdx: i })}>
                      {credit ? `-${peso(Math.abs(l.amount))}` : signed(l.amount)}
                    </td>
                    <td className="pl-2"><button type="button" className="text-ink-faint hover:text-ink" onClick={() => patchBed(g.id, { editIdx: i })} title="Edit"><Pencil size={11} /></button></td>
                  </>
                )}
              </tr>
            )
          })}
        </tbody>
      </table>
      <button type="button" className="btn-xs blue inline-flex items-center gap-1" onClick={() => addLine(g.id)}>
        <Plus size={11} /> Add line (e.g. unsettled earlier amounts)
      </button>
      {lines.some(isSystemLine) && (
        <div className="text-ink-faint">Advance, deposit, forfeit, charge-back and payment lines come from the receipts and payments and cannot be changed in amount or removed (their label and details can). Rent, water and electricity lines can be edited but not removed. Add an "Unsettled" line for any other deduction.</div>
      )}

      {draft.notes.map((n, i) => <div key={i} className="text-ink-muted">{n}</div>)}

      <div className="rounded-xl bg-surface-2 px-4 py-3 flex items-center justify-between">
        <div className="text-ink-muted">Charges {peso(totals.total_charges)} · Credits {peso(totals.total_credits)}</div>
        <div className={`text-[15px] font-bold ${net < 0 ? 'text-success-text' : 'text-ink'}`}>
          {net < 0 ? `Amount to be returned ${peso(-net)}` : `Total amount due ${peso(net)}`}
        </div>
      </div>

      {(draft.details.water || draft.details.electric) && (
        <div>
          <div className="text-[10px] font-bold uppercase tracking-wider text-ink-faint mb-1">Billing details (as of {draft.details.asOf})</div>
          <table className="w-full text-ink-muted">
            <thead><tr className="text-left text-[10px] uppercase tracking-wider text-ink-faint">
              <th></th><th>Start</th><th>Move-out</th><th>Room consumption</th><th>Personal</th></tr></thead>
            <tbody>
              {[['Water', draft.details.water], ['Electricity', draft.details.electric]].filter(([, x]) => x).map(([k, x]) => (
                <tr key={k} className="border-t border-line-subtle">
                  <td className="font-semibold text-ink">{k}</td><td>{rd(x.prev)}</td><td>{rd(x.curr)}</td>
                  <td>{x.roomCons != null ? rd(x.roomCons) : '—'}</td><td>{rd(x.personalCons)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <div className="fg">
        <label>Prepared by</label>
        <input type="text" value={preparedBy} onChange={e => patchBed(g.id, { preparedBy: e.target.value })} placeholder="Name" />
      </div>
    </div>
  )
}
