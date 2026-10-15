import { useState, useEffect, useMemo } from 'react'
import { Link } from 'react-router-dom'
import { useAuth } from '../lib/auth'
import { requestApproval } from '../lib/approvals'
import {
  fetchCutoffs, fetchUtilityBill, fetchInterimReadings, fetchSplits, fetchTenants, fetchTenantDeposits,
  fetchStoredAdvanceCredits,
} from '../lib/supabase'
import {
  buildFinalBillDraft, rebuildCreditLines, cutoffForDate, normalizeLines, computeTotals, round2,
} from '../lib/finalBill'
import { LogOut, Clock, AlertTriangle, X, CheckCircle, Pencil, Plus, Printer } from 'lucide-react'

function today() { return new Date().toISOString().slice(0,10) }

const peso = n => '₱' + Number(n || 0).toLocaleString('en-PH', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
const rd = n => (n == null ? '—' : Number(n).toLocaleString('en-PH', { maximumFractionDigits: 2, useGrouping: false }))
const strip = ({ _amt, ...l }) => l
const signed = n => (Number(n) < 0 ? '-' : '') + peso(Math.abs(Number(n) || 0))

export default function MoveOutModal({ bed, onClose, onSubmit }) {
  const { isAdmin } = useAuth()
  const defaultMoveOut = bed?.move_out_date ? bed.move_out_date.slice(0,10) : today()
  const plannedMoveOut = bed?.move_out_date ? bed.move_out_date.slice(0,10) : null
  const tenantId = bed.tenant_id || bed.id

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
  const [result, setResult]   = useState(null)
  const [error, setError]     = useState('')
  const [actualTouched, setActualTouched] = useState(false)

  const [cutoffs, setCutoffs]   = useState(null)
  const [deposits, setDeposits] = useState(null)
  const [storedCredits, setStoredCredits] = useState(null)
  const [loadError, setLoadError] = useState('')
  const [locked, setLocked] = useState(false)
  const [ctx, setCtx] = useState(null)

  const [draft, setDraft] = useState(null)
  const [lines, setLines] = useState([])
  const [draftSig, setDraftSig] = useState('')
  const [rebuilt, setRebuilt] = useState(false)
  const [waived, setWaived] = useState(false)
  const [waiveReason, setWaiveReason] = useState('')
  const [preparedBy, setPreparedBy] = useState('')
  const [editIdx, setEditIdx] = useState(null)

  useEffect(() => {
    Promise.all([fetchCutoffs(), fetchTenantDeposits(tenantId), fetchStoredAdvanceCredits()])
      .then(([c, d, s]) => { setCutoffs(c); setDeposits(d); setStoredCredits(s) })
      .catch(e => setLoadError(e.message))
  }, [tenantId])

  const cutoff = useMemo(
    () => (cutoffs ? cutoffForDate(cutoffs, form.actual_move_out_date) : null),
    [cutoffs, form.actual_move_out_date],
  )

  async function loadCtx(cutoffId) {
    const [billRows, interims, splits, tenants] = await Promise.all([
      fetchUtilityBill(cutoffId), fetchInterimReadings(cutoffId), fetchSplits(cutoffId), fetchTenants(),
    ])
    const c = { cutoffId, billRows, interims, splits, tenants }
    setCtx(c)
    return c
  }

  useEffect(() => {
    if (cutoff?.id) loadCtx(cutoff.id).catch(() => setCtx(null))
    else setCtx(null)
  }, [cutoff?.id])

  const minOf = (key) => {
    const row = ctx?.billRows?.find(b => b.room_id === bed?.room_id)
    return row && row[key] != null ? Number(row[key]) : null
  }
  const minWater = minOf('water_prev'), minElec = minOf('elec_prev')

  const set = (k, v) => {
    setError('')
    setForm(f => {
      const next = { ...f, [k]: v }
      if (k === 'move_out_date' && !actualTouched) next.actual_move_out_date = v
      return next
    })
  }

  function validateStep1() {
    if (!form.actual_move_out_date) return 'Actual move-out date is required.'
    if (bed.move_in_date && form.actual_move_out_date < bed.move_in_date.slice(0,10))
      return 'The move-out date cannot be before the move-in date.'
    if (!form.water_reading) return 'Water meter reading is required.'
    if (minWater !== null && Number(form.water_reading) < minWater)
      return `Water reading (${form.water_reading}) cannot be less than the period's starting reading (${minWater}).`
    if (!form.electric_reading) return 'Electric meter reading is required.'
    if (minElec !== null && Number(form.electric_reading) < minElec)
      return `Electric reading (${form.electric_reading}) cannot be less than the period's starting reading (${minElec}).`
    if (loadError) return `Could not load billing data: ${loadError}`
    if (!cutoffs || !deposits || !storedCredits) return 'Billing data is still loading. Try again in a moment.'
    if (!cutoff && !isAdmin) return 'No billing period (cutoff) covers this move-out date. Pick a date inside an existing cutoff, or ask an admin to process this move-out.'
    return null
  }

  async function goToBill() {
    const err = validateStep1()
    if (err) { setError(err); return }
    setError('')
    const sig = `${form.actual_move_out_date}|${form.water_reading}|${form.electric_reading}`
    if (draft && sig === draftSig) { setStep(2); return }
    setBusy(true)
    try {
      const c = cutoff ? (ctx?.cutoffId === cutoff.id ? ctx : await loadCtx(cutoff.id)) : { billRows: [], interims: [], splits: [], tenants: [] }
      const roomId = bed.room_id
      const fresh = buildFinalBillDraft({
        tenant: { ...bed, id: tenantId, beds: bed.beds || (roomId ? { room_id: roomId } : null) },
        cutoff, cutoffs, billRows: c.billRows, interims: c.interims, tenants: c.tenants, splits: c.splits,
        deposits, storedCredits, moveOutDate: form.actual_move_out_date,
        readings: { water: form.water_reading, electric: form.electric_reading },
        plannedMoveOut, waived,
      })
      // Rebuilding resets the computed lines but keeps the lines staff added (unsettled / free lines).
      const added = draft ? lines.filter(l => l.kind === 'unsettled') : []
      setRebuilt(!!draft)
      setDraft(fresh); setLines([...fresh.lines.filter(l => l.kind !== 'credit' && l.kind !== 'forfeit' && l.source !== 'ADVANCE_CLAWBACK'), ...added, ...fresh.lines.filter(l => l.kind === 'credit' || l.kind === 'forfeit' || l.source === 'ADVANCE_CLAWBACK')])
      setDraftSig(sig); setEditIdx(null)
      setStep(2)
    } catch (e) { setError(e.message) }
    setBusy(false)
  }

  function toggleWaive(next) {
    setWaived(next)
    setLines(ls => rebuildCreditLines(ls, deposits, { earlyTermination: draft.earlyTermination, waived: next, prior: draft.prior }).lines)
  }

  const patchLine = (i, patch) => setLines(ls => ls.map((l, j) => (j === i ? { ...l, ...patch } : l)))
  function setAmount(i, raw) {
    const n = Number(raw)
    const l = lines[i]
    patchLine(i, { _amt: raw, amount: raw === '' || !Number.isFinite(n) ? 0 : (l.kind === 'credit' ? -Math.abs(n) : n) })
  }
  function addLine() {
    setLines(ls => [...ls, { label: 'Add: Unsettled ', mid: '', amount: 0, kind: 'unsettled', _amt: '' }])
    setEditIdx(lines.length)
  }
  const removeLine = (i) => { setLines(ls => ls.filter((_, j) => j !== i)); setEditIdx(null) }

  const stored = useMemo(() => normalizeLines(lines.map(strip)), [lines])
  const totals = useMemo(() => computeTotals(stored), [stored])
  const net = totals.net_amount

  function validateStep2() {
    for (const l of lines) {
      if (!String(l.label ?? '').trim()) return 'Every line needs a label.'
      if (l._amt !== undefined && l._amt !== '' && !Number.isFinite(Number(l._amt))) return `"${l.label}" has an invalid amount.`
    }
    if (draft.earlyTermination && waived && !waiveReason.trim()) return 'Enter the reason management approved waiving the forfeiture.'
    return null
  }
  function goToConfirm() {
    const err = validateStep2()
    if (err) { setError(err); return }
    setError(''); setEditIdx(null); setStep(3)
  }

  const heldAfter = useMemo(() => {
    if (!deposits) return []
    const settled = new Set(stored.flatMap(l => (l.kind === 'credit' || l.kind === 'forfeit') ? (l.deposit_ids || []) : []))
    return deposits.filter(d => d.status === 'HELD' && !settled.has(d.id))
  }, [deposits, stored])
  const settleCounts = useMemo(() => ({
    applied: stored.filter(l => l.kind === 'credit').reduce((s, l) => s + (l.deposit_ids?.length || 0), 0),
    forfeited: stored.filter(l => l.kind === 'forfeit').reduce((s, l) => s + (l.deposit_ids?.length || 0), 0),
  }), [stored])

  async function confirm() {
    const moveOut = {
      move_out_date: form.move_out_date, actual_move_out_date: form.actual_move_out_date,
      amount_paid: form.amount_paid, water_reading: round2(form.water_reading), electric_reading: round2(form.electric_reading),
    }
    const billBase = {
      cutoff_id: cutoff?.id ?? null, lines: stored, details: draft.details,
      early_termination: draft.earlyTermination, forfeit_waived: isAdmin && draft.earlyTermination && waived,
      waived_reason: isAdmin && draft.earlyTermination && waived ? waiveReason.trim() : null,
      prepared_by: preparedBy.trim() || null,
    }
    setBusy(true); setError('')
    try {
      if (!isAdmin) {
        if (!reason.trim()) { setError('Please provide a reason for the move-out.'); setBusy(false); return }
        await requestApproval({
          entityType: 'TENANT_STAY',
          entityId:   String(tenantId),
          fieldName:  'move_out',
          oldValue:   { is_active: true, move_out_date: bed.move_out_date || null },
          newValue: {
            _action:       'process_move_out',
            _tenant_id:    String(tenantId),
            _bed_id:       String(bed.bed_id),
            _room_no:      bed.room_no    || bed._room_no,
            _bed_letter:   bed.bed_letter || bed._bed_letter,
            _tenant_name:  bed.tenant_name || bed.name,
            _rate:         bed.rate,
            _move_in_date: bed.move_in_date,
            ...moveOut,
            _bill: { ...billBase, ...totals, planned_move_out: plannedMoveOut, prior_cutoff: draft.prior ? { name: draft.prior.name } : null },
          },
          reason: reason.trim(),
        })
        setSubmitted(true)
      } else {
        setResult(await onSubmit({ moveOut, bill: billBase }))
        setStep('done')
      }
    } catch (e) {
      setError(e.message)
      if (e.partial || e.orphanBill) setLocked(true)
    }
    setBusy(false)
  }

  const name     = bed?.tenant_name || bed?.name || '—'
  const roomInfo = `Room ${bed?.room_no} · Bed ${bed?.bed_letter || bed?.bed}`
  const rateText = bed?.rate ? '₱' + Number(bed.rate).toLocaleString('en-PH') + '/mo' : ''
  const headBar = (
    <div className="bg-danger-bg border border-danger-border rounded-xl px-4 py-3 text-[13px]">
      <div className="font-semibold text-ink">{name}</div>
      <div className="text-ink-muted mt-0.5">{roomInfo}{rateText && ` · ${rateText}`}</div>
    </div>
  )
  const head = (title) => (
    <div className="modal-head">
      <h3><span className="inline-flex items-center gap-1.5"><LogOut size={16} /> {title}</span></h3>
      <button className="btn-close" onClick={onClose}><X size={16} /></button>
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
              The move-out request and its final bill have been submitted to an admin for review.
              The tenant and bed will remain active until approved.
            </p>
          </div>
          <div className="modal-foot"><button className="btn primary" onClick={onClose}>Close</button></div>
        </div>
      </div>
    )
  }

  if (step === 'done') {
    const refund = result.net_amount < 0
    return (
      <div className="overlay" onClick={e => e.stopPropagation()}>
        <div className="modal modal-sm">
          {head('Move Out Complete')}
          <div className="modal-body text-center py-8">
            <CheckCircle size={36} className="mx-auto mb-3 text-emerald-500" />
            <h4 className="text-[15px] font-semibold text-ink mb-2">{name} has moved out</h4>
            <p className={`text-[14px] font-semibold ${refund ? 'text-success-text' : 'text-ink'}`}>
              {refund ? `Amount to be returned ${peso(-result.net_amount)}` : `Total amount due ${peso(result.net_amount)}`}
            </p>
            <p className="text-[12px] text-ink-muted mt-1">Final bill #{result.billId}</p>
          </div>
          <div className="modal-foot">
            <button className="btn secondary" onClick={onClose}>Close</button>
            <Link className="btn primary" to={`/print/final-bill?id=${result.billId}`}><Printer size={14} /> Print final bill</Link>
          </div>
        </div>
      </div>
    )
  }

  const stepTitle = { 1: 'Move-out details', 2: 'Final bill', 3: 'Confirm' }[step]

  return (
    <div className="overlay" onClick={e => e.stopPropagation()}>
      <div className="modal" style={{ maxWidth: step === 1 ? 520 : 760 }}>
        {head(`Process Move Out — ${stepTitle} (${step}/3)`)}
        <div className="modal-body space-y-4">
          {headBar}

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

              <div className="form-section">Final Meter Readings</div>

              <div className="fg">
                <label>Water Reading <span className="text-danger-text">*</span></label>
                <input type="number" value={form.water_reading} min={minWater ?? 0} step="0.0001"
                  placeholder="e.g. 1234.50" onChange={e => set('water_reading', e.target.value)} required />
                {minWater !== null && <span className="block text-[11px] text-ink-faint mt-1">Min: {minWater} (period start)</span>}
              </div>
              <div className="fg">
                <label>Electric Reading <span className="text-danger-text">*</span></label>
                <input type="number" value={form.electric_reading} min={minElec ?? 0} step="0.0001"
                  placeholder="e.g. 5678.90" onChange={e => set('electric_reading', e.target.value)} required />
                {minElec !== null && <span className="block text-[11px] text-ink-faint mt-1">Min: {minElec} (period start)</span>}
              </div>

              <div className="fg full">
                <label>Final Amount Paid (PHP, optional)</label>
                <input type="number" value={form.amount_paid} onChange={e => set('amount_paid', e.target.value)} placeholder="0.00" min="0" step="0.01" />
              </div>

              {!isAdmin && (
                <div className="fg full">
                  <div className="bg-warning-bg border border-warning-border rounded-xl px-3 py-2.5 text-[12px] text-warning-text">
                    <AlertTriangle size={13} className="shrink-0 mt-px inline mr-1" /> Move-out requires admin approval. The bed and tenant will remain active until an admin reviews and approves this request.
                  </div>
                </div>
              )}
            </div>
          )}

          {step === 2 && draft && (
            <div className="space-y-3 text-[12px]">
              {rebuilt && (
                <div className="bg-info-bg border border-info-border rounded-xl px-3 py-2 text-info-text">
                  The date or readings changed, so the computed lines were rebuilt (edits to them were reset). Lines you added were kept.
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
                    Early termination: the move-out ({form.actual_move_out_date}) is before the lease end ({plannedMoveOut}).
                    {!waived && ' Advance and deposit are forfeited.'}
                  </div>
                  {isAdmin ? (
                    <>
                      <label className="flex items-center gap-2 text-ink cursor-pointer">
                        <input type="checkbox" checked={waived} onChange={e => toggleWaive(e.target.checked)} />
                        Management approved — do not forfeit
                      </label>
                      {waived && (
                        <input type="text" value={waiveReason} onChange={e => setWaiveReason(e.target.value)}
                          placeholder="Reason management approved the waiver (required)" className="w-full" />
                      )}
                    </>
                  ) : (
                    <div className="text-ink-muted">Only an admin can waive the forfeiture. The approving admin can change it when reviewing this request.</div>
                  )}
                </div>
              )}

              <div className="text-ink-muted">
                {draft.period ? <>Billing period <strong className="text-ink">{draft.period.start} to {draft.period.end}</strong> (end exclusive)</> : <strong className="text-ink">No billing period covers this date</strong>} ·
                everything below is filled in from existing data; click a row to adjust it, or add a line.
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
                    const credit = l.kind === 'credit', forfeit = l.kind === 'forfeit'
                    return (
                      <tr key={i} className="border-t border-line-subtle align-top">
                        {editing ? (
                          <>
                            <td className="py-1 pr-2"><input type="text" className="w-full" value={l.label} onChange={e => patchLine(i, { label: e.target.value })} /></td>
                            <td className="pr-2"><input type="text" className="w-full" value={l.mid ?? ''} onChange={e => patchLine(i, { mid: e.target.value })} /></td>
                            <td className="text-right">
                              {forfeit ? <span className="text-ink-muted">{peso(0)}</span> : (
                                <input type="number" step="0.01" className="w-28 text-right"
                                  value={l._amt !== undefined ? l._amt : (credit ? Math.abs(l.amount) : l.amount)}
                                  onChange={e => setAmount(i, e.target.value)} />
                              )}
                            </td>
                            <td className="whitespace-nowrap pl-2">
                              <button type="button" className="btn-xs blue" onClick={() => { patchLine(i, { _amt: undefined }); setEditIdx(null) }}>Done</button>
                              <button type="button" className="btn-xs red ml-1" onClick={() => removeLine(i)} title="Remove line"><X size={10} /></button>
                            </td>
                          </>
                        ) : (
                          <>
                            <td className={`py-1.5 pr-2 cursor-pointer ${l.kind === 'unsettled' ? 'italic' : ''}`} onClick={() => setEditIdx(i)}>{l.label}</td>
                            <td className="pr-2 text-ink-muted cursor-pointer" onClick={() => setEditIdx(i)}>
                              {l.mid}{l.rate != null && ` × ${peso(l.rate)}`}
                              {forfeit && l.original != null && ` (${peso(l.original)} forfeited)`}
                            </td>
                            <td className={`text-right tabular-nums cursor-pointer ${credit ? 'text-success-text' : ''}`} onClick={() => setEditIdx(i)}>
                              {credit ? `-${peso(Math.abs(l.amount))}` : signed(l.amount)}
                            </td>
                            <td className="pl-2"><button type="button" className="text-ink-faint hover:text-ink" onClick={() => setEditIdx(i)} title="Edit"><Pencil size={11} /></button></td>
                          </>
                        )}
                      </tr>
                    )
                  })}
                </tbody>
              </table>
              <button type="button" className="btn-xs blue inline-flex items-center gap-1" onClick={addLine}>
                <Plus size={11} /> Add line (e.g. unsettled earlier amounts)
              </button>

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
                      <th></th><th>Previous</th><th>Current</th><th>Room consumption</th><th>Personal</th></tr></thead>
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
                <input type="text" value={preparedBy} onChange={e => setPreparedBy(e.target.value)} placeholder="Name" />
              </div>
            </div>
          )}

          {step === 3 && draft && (
            <div className="space-y-3 text-[13px]">
              <div className="rounded-xl bg-surface-2 px-4 py-3 space-y-1">
                <div>Actual move-out: <strong>{form.actual_move_out_date}</strong> (lease end {plannedMoveOut || 'not set'})</div>
                <div>Readings: water <strong>{form.water_reading}</strong> · electric <strong>{form.electric_reading}</strong></div>
                <div className={`text-[15px] font-bold ${net < 0 ? 'text-success-text' : 'text-ink'}`}>
                  {net < 0 ? `Amount to be returned ${peso(-net)}` : `Total amount due ${peso(net)}`}
                </div>
                {draft.earlyTermination && (
                  <div className={waived ? 'text-success-text' : 'text-danger-text'}>
                    {waived ? `Early termination — forfeiture waived by management: ${waiveReason}` : 'Early termination — advance and deposit forfeited'}
                  </div>
                )}
              </div>
              {isAdmin ? (
                <div className="text-ink-muted">
                  Confirming saves the final bill, moves the tenant out, frees the bed, saves the move-out readings and sets
                  {' '}{settleCounts.applied} receipt(s) to APPLIED and {settleCounts.forfeited} to FORFEITED.
                </div>
              ) : (
                <>
                  <div className="bg-warning-bg border border-warning-border rounded-xl px-3 py-2.5 text-[12px] text-warning-text">
                    <AlertTriangle size={13} className="shrink-0 mt-px inline mr-1" /> This is sent to an admin with the full bill. Nothing changes until it is approved.
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
                  {heldAfter.length} receipt(s) ({heldAfter.map(d => `${d.kind.toLowerCase()} ${peso(d.amount)}`).join(', ')}) have no credit or forfeit line and will stay HELD.
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
          {!locked && step > 1 && <button type="button" className="btn secondary" disabled={busy} onClick={() => { setError(''); setEditIdx(null); setStep(step - 1) }}>Back</button>}
          {!locked && step === 1 && <button type="button" className="btn primary" disabled={busy} onClick={goToBill}>{busy ? 'Building bill…' : 'Next: Final bill'}</button>}
          {!locked && step === 2 && <button type="button" className="btn primary" onClick={goToConfirm}>Next: Confirm</button>}
          {!locked && step === 3 && (
            <button type="button" className="btn danger" disabled={busy} onClick={confirm}>
              {busy ? 'Processing…' : isAdmin ? 'Confirm Move Out' : 'Submit for Approval'}
            </button>
          )}
        </div>
      </div>
    </div>
  )
}
