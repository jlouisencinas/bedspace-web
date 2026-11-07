import { useState, useEffect, useMemo } from 'react'
import { Link } from 'react-router-dom'
import { loadReissueBundle } from '../lib/moveOutData'
import { verifyReissueFresh, reissueFinalBill } from '../lib/supabase'
import {
  buildFinalBillDrafts, rebuildCreditLines, normalizeLines, computeTotals, applyReceiptRefs, reissueLines, reissueDiff, mergeCoveredEntries, toCents,
} from '../lib/finalBill'
import { hasExtension, extensionNights, nightsWarning } from '../lib/stayExtension'
import { BedBill } from './MoveOutModal'
import FinalBillPreview from './FinalBillPreview'
import { RotateCcw, X, CheckCircle, Printer } from 'lucide-react'

const peso = n => '₱' + Number(n || 0).toLocaleString('en-PH', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
const signed = n => (Number(n) < 0 ? '-' : '') + peso(Math.abs(Number(n) || 0))
const strip = ({ _amt, ...l }) => l
const iso10 = v => (v ? String(v).slice(0, 10) : '')
const isTail = l => l.kind === 'credit' || l.kind === 'forfeit' || l.source === 'ADVANCE_CLAWBACK'
const totalsOf = lines => computeTotals(normalizeLines(lines.map(strip)))
const READING_SOURCE = { INTERIM: 'saved move-out reading', BILL: 'from the bill being replaced' }

/**
 * Admin: void a FINAL bill of a moved-out tenant and issue a corrected one in its place, in one database transaction (requirements §5
 * "Void & re-issue"). Step 1 shows the move-out date and readings (read-only) and asks the 12:00 PM choice of a late move-out; step 2 is
 * the bill editor plus the comparison with the old bill; step 3 asks the reason.
 */
export default function ReissueFinalBillModal({ bill, tenant, onClose, onDone }) {
  const [step, setStep] = useState(1)
  const [pre, setPre] = useState(null)
  const [loadErr, setLoadErr] = useState('')
  const [afterNoon, setAfterNoon] = useState(null)
  const [s, setS] = useState(null)
  const [fresh, setFresh] = useState(null)
  const [verdict, setVerdict] = useState(null)
  const [reason, setReason] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [newId, setNewId] = useState(null)
  const [previewOpen, setPreviewOpen] = useState(false)

  useEffect(() => {
    loadReissueBundle({ bill }).then(setPre).catch(e => setLoadErr(e.message))
  }, [])

  // Escape closes, except while the re-issue is running or the preview overlay is open.
  useEffect(() => {
    const onKey = (e) => { if (e.key === 'Escape' && !busy && !previewOpen) onClose() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [busy, previewOpen, onClose])

  const moveOut = iso10(bill.move_out_date)
  const late = !!pre && hasExtension({ contractISO: pre.planned, actualISO: moveOut })
  const g = pre ? { ...pre.tenant, move_out_date: pre.planned } : null
  const deposits = pre?.deposits.get(bill.tenant_id) || []

  function build() {
    const res = buildFinalBillDrafts({
      group: [pre.tenant], cutoffs: pre.cutoffs, tenants: pre.tenants, moveOutDate: moveOut, readings: pre.readings, bundle: pre.bundle,
      deposits: pre.deposits, storedCredits: pre.storedCredits, storedCarry: pre.storedCarry, payments: pre.payments, plannedMoveOut: pre.plannedMoveOut,
      waived: new Map([[bill.tenant_id, !!bill.forfeit_waived]]), siblingIds: pre.siblingIds, startOverrides: pre.startOverrides,
      isAdmin: true, vacatedAfterNoon: late ? afterNoon : null,
    })
    const d = res.drafts.get(bill.tenant_id)
    if (d.blocking.length) return { blocked: d.blocking }
    const r = reissueLines({ oldLines: bill.lines, freshLines: d.lines })
    const od = bill.details || {}
    const { advance_check: _c, ref_corrections: _r, recomputed_at_approval: _a, reissue: _i, ...keep } = od
    const details = {
      ...keep, ...d.details,
      water: r.kept.WATER ? (od.water ?? d.details.water) : d.details.water,
      electric: r.kept.ELECTRIC ? (od.electric ?? d.details.electric) : d.details.electric,
      ...(od.approval_request_id != null || pre.request?.id ? { approval_request_id: od.approval_request_id ?? pre.request.id } : {}),
    }
    if (!d.details.extension) delete details.extension
    return {
      ok: true, fresh: d.lines,
      s: {
        draft: { ...d, details }, lines: applyReceiptRefs(r.lines, deposits), waived: !!bill.forfeit_waived, waiveReason: bill.waived_reason || '',
        preparedBy: bill.prepared_by || '', verified: null, editIdx: null,
      },
    }
  }

  function goToBill() {
    setError('')
    if (late && afterNoon == null) { setError('Choose whether the tenant vacated by 12:00 PM or after 12:00 PM.'); return }
    try {
      const r = build()
      if (r.blocked) { setError(r.blocked.join('\n')); return }
      setS(r.s); setFresh(r.fresh); setVerdict(null); setStep(2)
    } catch (e) { setError(e.message) }
  }

  const patchBed = (_id, patch) => setS(prev => ({ ...prev, ...patch }))
  const patchLine = (_id, i, patch) => setS(prev => ({ ...prev, lines: prev.lines.map((l, j) => (j === i ? { ...l, ...patch } : l)) }))
  function setAmount(_id, i, raw) {
    const l = s.lines[i]
    const n = Number(raw)
    patchLine(null, i, { _amt: raw, amount: raw === '' || !Number.isFinite(n) ? 0 : (l.kind === 'credit' ? -Math.abs(n) : n) })
  }
  function addLine() {
    const at = s.lines.findIndex(l => isTail(l) || l.kind === 'payment')
    const line = { label: 'Add: Unsettled ', mid: '', amount: 0, kind: 'unsettled', _amt: '' }
    setS(prev => ({ ...prev, lines: at < 0 ? [...prev.lines, line] : [...prev.lines.slice(0, at), line, ...prev.lines.slice(at)], editIdx: at < 0 ? prev.lines.length : at }))
  }
  const removeLine = (_id, i) => setS(prev => ({ ...prev, lines: prev.lines.filter((_, j) => j !== i), editIdx: null }))
  function toggleWaive(_id, next) {
    const r = rebuildCreditLines(s.lines, deposits, { earlyTermination: s.draft.earlyTermination, waived: next, prior: s.draft.prior })
    setS(prev => ({ ...prev, waived: next, lines: applyReceiptRefs(r.lines, deposits), draft: { ...prev.draft, check: r.check, notes: r.notes } }))
  }

  const billNow = () => {
    const lines = normalizeLines(s.lines.map(strip))
    const w = s.draft.earlyTermination && s.waived
    return {
      tenant_id: bill.tenant_id, move_out_date: moveOut, cutoff_id: s.draft.cutoff_id, early_termination: s.draft.earlyTermination,
      forfeit_waived: w, waived_reason: w ? s.waiveReason.trim() : null, lines, details: s.draft.details, prepared_by: s.preparedBy.trim() || null,
      ...computeTotals(lines),
    }
  }
  const diff = useMemo(() => (s ? reissueDiff(bill, { lines: s.lines.map(strip) }, { recomputed: fresh }) : null), [s, fresh])

  function validateStep2() {
    if (s.draft.errors.length) return s.draft.errors[0]
    for (const l of s.lines) {
      if (!String(l.label ?? '').trim()) return 'Every line needs a label.'
      if (l._amt !== undefined && l._amt !== '' && !Number.isFinite(Number(l._amt))) return `"${l.label}" has an invalid amount.`
    }
    if (s.draft.earlyTermination && s.waived && !s.waiveReason.trim()) return 'Enter the reason management approved waiving the forfeiture.'
    return null
  }

  async function goToConfirm() {
    const err = validateStep2()
    if (err) { setError(err); return }
    setBusy(true); setError('')
    try {
      const { covered_cutoffs: _cc, ...b } = billNow()
      const v = await verifyReissueFresh(bill, pre.planned, b)
      if (!v.ok) {
        setError(`The bill no longer matches the database: ${[...v.errors, ...v.stale].join(' ')} Go back to step 1 and build it again.`)
      } else {
        setVerdict(v)
        setS(prev => ({ ...prev, editIdx: null, verified: { check: v.check, at: new Date() } }))
        setStep(3)
      }
    } catch (e) { setError(e.message) }
    setBusy(false)
  }

  async function confirm() {
    if (!reason.trim()) { setError('Enter the reason for the re-issue.'); return }
    setBusy(true); setError('')
    try {
      const b = billNow()
      const id = await reissueFinalBill(bill.id, reason.trim(), {
        ...b, cutoff_id: verdict.cutoff_id, covered_cutoffs: mergeCoveredEntries(verdict.covered_cutoffs, bill.covered_cutoffs),
        details: { ...b.details, advance_check: verdict.check, reissue: { of: bill.id, reason: reason.trim() } },
      })
      setNewId(id); setStep('done')
      onDone?.(id)
    } catch (e) { setError(e.message) }
    setBusy(false)
  }

  const head = (
    <div className="modal-head">
      <h3><span className="inline-flex items-center gap-1.5"><RotateCcw size={16} /> Void &amp; re-issue final bill #{bill.id}{step !== 'done' ? ` (${step}/3)` : ''}</span></h3>
      <button className="btn-close" onClick={onClose}><X size={16} /></button>
    </div>
  )

  if (step === 'done') {
    return (
      <div className="overlay" onClick={e => e.stopPropagation()}>
        <div className="modal modal-sm">
          {head}
          <div className="modal-body py-6 space-y-3 text-[13px]">
            <div className="rounded-xl bg-success-bg border border-success-border px-3 py-2.5">
              <div className="font-semibold text-ink flex items-center gap-1.5"><CheckCircle size={14} className="text-emerald-500" /> Final bill #{newId} issued</div>
              <div className="text-[12px] text-ink-muted">Final bill #{bill.id} is now VOID and marked "replaced by #{newId}". The receipts are settled on #{newId}.</div>
            </div>
          </div>
          <div className="modal-foot">
            <button className="btn secondary" onClick={onClose}>Close</button>
            <Link className="btn primary" to={`/print/final-bill?id=${newId}`}><Printer size={14} /> Print final bill</Link>
          </div>
        </div>
      </div>
    )
  }

  const net = s ? totalsOf(s.lines).net_amount : null
  const oldNet = Number(bill.net_amount)
  const previewList = () => (s ? [{
    bill: { id: bill.id, status: 'DRAFT', move_out_date: moveOut, lines: normalizeLines(s.lines.map(strip)), net_amount: net, details: { ...s.draft.details, advance_check: s.verified?.check ?? s.draft.check, reissue: { of: bill.id } }, prepared_by: s.preparedBy.trim() },
    tenant: { name: tenant?.name ?? pre?.tenant?.name, beds: { bed_letter: pre?.tenant?.bed_letter ?? '', rooms: { room_no: pre?.tenant?.room_no ?? '' } } },
  }] : [])

  return (
    <div className="overlay" onClick={e => e.stopPropagation()}>
      <div className="modal" style={{ maxWidth: step === 1 ? 560 : 820 }}>
        {head}
        <div className="modal-body space-y-4 text-[12px]">
          <div className="bg-warning-bg border border-warning-border rounded-xl px-4 py-3 text-warning-text space-y-0.5">
            <div className="font-semibold">{pre?.tenant?.name ?? tenant?.name} · Room {pre?.tenant?.room_no ?? '—'} · Bed {pre?.tenant?.bed_letter ?? '—'}</div>
            <div>Bill #{bill.id} ({oldNet < 0 ? `to return ${peso(-oldNet)}` : `due ${peso(oldNet)}`}) becomes VOID and is kept for the record; a new FINAL bill with a new number replaces it. The tenant, the bed and the readings are not changed.</div>
          </div>
          {loadErr && <div className="p-3 bg-danger-bg text-danger-text rounded-xl border border-danger-border">Could not load the billing data: {loadErr}</div>}
          {!pre && !loadErr && <div className="text-ink-muted">Loading the billing data…</div>}

          {step === 1 && pre && (
            <div className="space-y-3">
              <div className="rounded-xl bg-surface-2 px-4 py-3 space-y-1 text-[13px]">
                <div>Move-out date: <strong>{moveOut}</strong> · contract (planned) move-out: <strong>{pre.planned || 'not set'}</strong></div>
                <div>Water reading: <strong>{pre.readings.water === '' ? '—' : pre.readings.water}</strong>{pre.readingSources.water ? ` (${READING_SOURCE[pre.readingSources.water]})` : ''}
                  {' '}· Electric reading: <strong>{pre.readings.electric === '' ? '—' : pre.readings.electric}</strong>{pre.readingSources.electric ? ` (${READING_SOURCE[pre.readingSources.electric]})` : ''}</div>
                <div className="text-ink-muted">The date and readings cannot be changed here.</div>
              </div>
              {late && (
                <div className="bg-info-bg border border-info-border rounded-xl px-3 py-2.5 text-info-text space-y-1.5">
                  <div className="font-semibold">
                    Stay extension: rent stops on {pre.planned}; the nights after it are ₱500.00 each
                    ({extensionNights({ contractISO: pre.planned, actualISO: moveOut, afterNoon: false })} night(s) if vacated by 12:00 PM, {extensionNights({ contractISO: pre.planned, actualISO: moveOut, afterNoon: true })} if after).
                  </div>
                  {typeof bill.details?.extension?.after_noon === 'boolean' && (
                    <div className="text-ink-muted">The bill being replaced recorded: vacated {bill.details.extension.after_noon ? 'after' : 'by'} 12:00 PM.</div>
                  )}
                  <div className="flex gap-4 flex-wrap text-ink">
                    <label className="flex items-center gap-1.5 cursor-pointer">
                      <input type="radio" name="reissue-noon" checked={afterNoon === false} onChange={() => { setError(''); setAfterNoon(false) }} /> Vacated by 12:00 PM
                    </label>
                    <label className="flex items-center gap-1.5 cursor-pointer">
                      <input type="radio" name="reissue-noon" checked={afterNoon === true} onChange={() => { setError(''); setAfterNoon(true) }} /> Vacated after 12:00 PM
                    </label>
                    <span className="text-ink-muted">(required)</span>
                  </div>
                  {nightsWarning(extensionNights({ contractISO: pre.planned, actualISO: moveOut, afterNoon: afterNoon === true })) && (
                    <div className="text-warning-text">{nightsWarning(extensionNights({ contractISO: pre.planned, actualISO: moveOut, afterNoon: afterNoon === true }))}</div>
                  )}
                </div>
              )}
            </div>
          )}

          {step === 2 && s && (
            <div className="space-y-4">
              <ReissueDiffTable diff={diff} billId={bill.id} />
              <BedBill g={g} s={s} multi={false} isAdmin staleNote={null} actual={moveOut} check={s.draft.check}
                refNeeded={[]} refs={{}} setRef={() => {}} refFlow={new Map()} refIndex={[]}
                patchBed={patchBed} patchLine={patchLine} toggleWaive={toggleWaive} setAmount={setAmount}
                addLine={addLine} removeLine={removeLine} />
            </div>
          )}

          {step === 3 && s && (
            <div className="space-y-3 text-[13px]">
              <div className="rounded-xl bg-surface-2 px-4 py-3 space-y-1">
                <div>Bill #{bill.id}: {signed(oldNet)} → new bill: <strong>{signed(net)}</strong> ({net < 0 ? `amount to be returned ${peso(-net)}` : `total amount due ${peso(net)}`})</div>
                <div className="text-ink-muted">Change: {signed((toCents(net) - toCents(oldNet)) / 100)}{net < 0 ? ' · the refund of the new bill is PENDING' : ''}</div>
              </div>
              <div className="fg">
                <label>Reason for the re-issue <span className="text-danger-text">*</span></label>
                <textarea rows={2} value={reason} onChange={e => { setError(''); setReason(e.target.value) }} placeholder="e.g. Re-issued under the stay-extension rule (₱500/night)" />
              </div>
              <div className="text-ink-muted">Confirming voids #{bill.id}, puts its receipts back and settles them on the new bill, all in one step: if anything fails nothing is changed.</div>
            </div>
          )}

          {error && <div className="p-3 bg-danger-bg text-danger-text text-[13px] rounded-xl border border-danger-border whitespace-pre-wrap">{error}</div>}
        </div>
        <div className="modal-foot">
          <button type="button" className="btn secondary" disabled={busy} onClick={onClose}>Cancel</button>
          {step !== 1 && <button type="button" className="btn secondary" disabled={busy} onClick={() => setPreviewOpen(true)}><Printer size={14} /> Preview bill</button>}
          {step !== 1 && <button type="button" className="btn secondary" disabled={busy} onClick={() => { setError(''); setStep(step - 1) }}>Back</button>}
          {step === 1 && <button type="button" className="btn primary" disabled={!pre || (late && afterNoon == null)} onClick={goToBill}>Next: Bill</button>}
          {step === 2 && <button type="button" className="btn primary" disabled={busy} onClick={goToConfirm}>{busy ? 'Checking the database…' : 'Next: Confirm'}</button>}
          {step === 3 && <button type="button" className="btn danger" disabled={busy || !reason.trim()} onClick={confirm}>{busy ? 'Re-issuing…' : 'Void & re-issue'}</button>}
        </div>
      </div>
      {previewOpen && <FinalBillPreview list={previewList()} onClose={() => setPreviewOpen(false)} />}
    </div>
  )
}

function ReissueDiffTable({ diff, billId }) {
  if (!diff) return null
  const hasRecomputed = diff.rows.some(r => r.recomputed !== undefined)
  return (
    <div className="border border-line-subtle rounded-xl p-3 space-y-2">
      <div className="text-[10px] font-bold uppercase tracking-wider text-ink-faint">Comparison with bill #{billId}</div>
      <table className="w-full">
        <thead>
          <tr className="text-left text-[10px] uppercase tracking-wider text-ink-faint">
            <th className="py-1">Item</th><th className="text-right">Bill #{billId}</th><th className="text-right">New bill</th><th className="text-right">Change</th>
            {hasRecomputed && <th className="text-right" title="Recomputed from the database now: the new bill uses this amount unless you edit the line">Recomputed now</th>}
          </tr>
        </thead>
        <tbody>
          {diff.rows.map(r => (
            <tr key={r.key} className="border-t border-line-subtle">
              <td className="py-1">{r.label}</td>
              <td className="text-right tabular-nums">{signed(r.old)}</td>
              <td className="text-right tabular-nums">{signed(r.new)}</td>
              <td className={`text-right tabular-nums ${r.change ? 'font-semibold' : 'text-ink-faint'}`}>{signed(r.change)}</td>
              {hasRecomputed && <td className="text-right tabular-nums text-ink-muted">{r.recomputed !== undefined ? signed(r.recomputed) : ''}</td>}
            </tr>
          ))}
          <tr className="border-t border-line font-bold">
            <td className="py-1">Net (negative = to be returned)</td>
            <td className="text-right tabular-nums">{signed(diff.net.old)}</td>
            <td className="text-right tabular-nums">{signed(diff.net.new)}</td>
            <td className="text-right tabular-nums">{signed(diff.net.change)}</td>
            {hasRecomputed && <td />}
          </tr>
        </tbody>
      </table>
      {diff.replaced.length > 0 && (
        <div className="text-ink-muted">Replaced by the computed stay extension: {diff.replaced.map(l => `"${l.label.trim()}" ${peso(l.amount)}`).join(', ')}.</div>
      )}
      {hasRecomputed && <div className="text-ink-faint">Water and electricity are recomputed from the database ("Recomputed now"), so the bill equals the share the room's statements use; the column "Bill #{billId}" shows the approved amounts. Edit a line to use another amount.</div>}
    </div>
  )
}
