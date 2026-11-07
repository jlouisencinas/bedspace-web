import { useState, useRef, useEffect, useMemo, useCallback } from 'react'
import { Link } from 'react-router-dom'
import { ChevronDown, ChevronRight, RefreshCw, Eye, Printer, AlertTriangle } from 'lucide-react'
import { fetchTenants, fetchAdvanceCreditData } from '../../lib/supabase'
import { loadCutoffBillingInputs, computeCutoffBilling } from '../../lib/cutoffBilling'
import { tenantCutoffs, paidByComponent, toCents2, statementForTenant, roomAsOf, hasTransferInWindow, HISTORY_CAP } from '../../lib/tenantStatements'
import { centsToPeso } from '../../lib/tenantHistory'
import { windowLastDay } from '../../lib/cutoffDates'
import MonthlyStatementPreview from '../MonthlyStatementPreview'

// Same formatters as the Billing page, so every figure reads exactly as it does there.
const peso = n => '₱' + (Math.abs(Number(n) || 0) < 0.005 ? 0 : Number(n)).toLocaleString('en-PH', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
const m3   = n => (Math.abs(Number(n) || 0) < 0.005 ? 0 : Number(n)).toLocaleString('en-PH', { maximumFractionDigits: 2 })

const MAX_PARALLEL = 2

function Line({ label, value, sub, strong, muted }) {
  return (
    <div className={`flex justify-between gap-3 text-[12px] ${muted ? 'text-ink-muted' : 'text-ink-secondary'}`}>
      <span>{label}</span>
      <span className={`text-right tabular-nums ${strong ? 'font-semibold text-ink' : ''}`}>
        {value}
        {sub && <span className="block text-[10px] text-ink-faint leading-[1.3]">{sub}</span>}
      </span>
    </div>
  )
}

function Balance({ billedCents, paidCents }) {
  const diff = billedCents - paidCents
  return (
    <div className={`flex justify-between text-[12px] font-semibold pt-1 mt-1 border-t border-line-subtle ${diff > 0 ? 'text-danger-text' : 'text-success-text'}`}>
      <span>{diff > 0 ? 'Balance' : diff < 0 ? 'Credit' : 'Settled'}</span>
      <span className="tabular-nums">{diff === 0 ? centsToPeso(0) : centsToPeso(Math.abs(diff))}</span>
    </div>
  )
}

function Block({ title, children }) {
  return (
    <div className="rounded-lg border border-line p-2.5 space-y-0.5">
      <div className="text-[10px] font-bold text-ink-faint uppercase tracking-widest mb-1">{title}</div>
      {children}
    </div>
  )
}

const Note = ({ children }) => <p className="text-[11px] text-ink-muted">{children}</p>

export default function StatementHistory({
  tenant, siblingIds, cutoffs, cutoffsError, payments, paysError, finalBills, billsLoading, billsError,
  transfers, transfersError, isAdmin, canAct,
}) {
  const [showAll, setShowAll] = useState(false)
  const [open, setOpen] = useState(() => new Set())
  const [results, setResults] = useState(() => new Map())
  const [preview, setPreview] = useState(null)

  const mounted = useRef(true)
  const shared = useRef(null)
  const queue = useRef([])
  const running = useRef(0)
  useEffect(() => { mounted.current = true; return () => { mounted.current = false } }, [])

  const active = tenant.is_active !== false
  const rows = useMemo(() => tenantCutoffs({ tenant, cutoffs, finalBills, payments }), [tenant, cutoffs, finalBills, payments])
  const visible = showAll ? rows : rows.slice(0, HISTORY_CAP)

  const setResult = (id, v) => { if (mounted.current) setResults(m => new Map(m).set(id, v)) }

  // fetchTenants + advance-credit data once per mount; a failure is retried on the next expand / Refresh.
  const getShared = () => {
    if (!shared.current) {
      shared.current = Promise.all([fetchTenants(), fetchAdvanceCreditData()])
      shared.current.catch(() => { shared.current = null })
    }
    return shared.current
  }

  const computeRow = useCallback(async (cutoff) => {
    setResult(cutoff.id, { status: 'loading' })
    try {
      const [tenants, advData] = await getShared()
      const inputs = await loadCutoffBillingInputs(cutoff, { tenants, advData })
      const result = computeCutoffBilling(cutoff, inputs)
      setResult(cutoff.id, { status: 'ready', inputs, result, at: new Date() })
    } catch (e) {
      setResult(cutoff.id, { status: 'error', error: e?.message || String(e) })
    }
  }, [])

  const pump = useCallback(() => {
    while (running.current < MAX_PARALLEL && queue.current.length) {
      const c = queue.current.shift()
      running.current++
      computeRow(c).finally(() => { running.current--; pump() })
    }
  }, [computeRow])

  const enqueue = (cutoff) => {
    if (queue.current.some(c => c.id === cutoff.id)) return
    setResult(cutoff.id, { status: 'queued' })
    queue.current.push(cutoff)
    pump()
  }

  const toggle = (cutoff) => {
    const next = new Set(open)
    if (next.has(cutoff.id)) next.delete(cutoff.id)
    else {
      next.add(cutoff.id)
      if (active && !results.has(cutoff.id)) enqueue(cutoff)
    }
    setOpen(next)
  }

  if (cutoffsError) return <p className="text-[12px] text-danger-text">Could not load cutoffs ({cutoffsError}); the statement history needs them.</p>
  if (billsLoading) return <p className="text-[12px] text-ink-muted">Loading…</p>
  if (!rows.length) return <p className="text-[13px] text-ink-faint italic">No cutoff overlaps this tenant's stay.</p>

  return (
    <div className="space-y-2">
      {!active && (
        <div className="text-[12px] text-ink-secondary bg-surface-2 rounded-lg px-3 py-2">
          Moved out: monthly statements are not recalculated for moved-out tenants (the Billing page no longer includes them for
          earlier periods). Each cutoff shows the payments recorded on it, and the cutoffs their final bill covers.
        </div>
      )}
      {(paysError || billsError) && (
        <div className="text-[12px] text-danger-text bg-danger-bg border border-danger-border rounded-lg px-3 py-2">
          {paysError ? `Payments could not be loaded (${paysError}): paid amounts and balances below are incomplete. ` : ''}
          {billsError ? `Final bills could not be loaded (${billsError}): final-bill coverage is not shown.` : ''}
        </div>
      )}
      {visible.map(r => {
        const c = r.cutoff
        const paid = paidByComponent(payments, c.id)
        const isOpen = open.has(c.id)
        return (
          <div key={c.id} className="rounded-xl border border-line overflow-hidden">
            <button type="button" onClick={() => toggle(c)}
              className="w-full flex items-center gap-2 flex-wrap px-3 py-2 bg-surface-2 text-left text-[12px] hover:bg-surface-3">
              {isOpen ? <ChevronDown size={14} className="text-ink-faint" /> : <ChevronRight size={14} className="text-ink-faint" />}
              <span className="font-semibold text-ink">{c.name}</span>
              <span className="text-ink-faint">Water {c.water_start} → {windowLastDay(c.water_end) || 'open'} · Electric {c.electric_start} → {c.electric_end || 'open'}</span>
              {c.is_active && <span className="text-[10px] font-bold px-1.5 py-0.5 rounded bg-info-bg text-info-text">Open period</span>}
              {(r.coveredWater.length > 0 || r.coveredElec.length > 0) && (
                <span className="text-[10px] font-bold px-1.5 py-0.5 rounded bg-surface-3 text-ink-muted">
                  Final bill #{[...new Set([...r.coveredWater, ...r.coveredElec])].join(', #')}
                </span>
              )}
              <span className="ml-auto text-ink-muted">
                Paid R+W <span className="font-semibold text-ink">{centsToPeso(paid.rwCents)}</span>
                {' · '}Elec <span className="font-semibold text-ink">{centsToPeso(paid.elecCents)}</span>
              </span>
            </button>
            {isOpen && (
              <div className="px-3 py-2.5 space-y-2">
                {active
                  ? <ActiveStatement cutoff={c} entry={results.get(c.id)} paid={paid} tenant={tenant} siblingIds={siblingIds}
                      transfers={transfers} transfersError={transfersError} isAdmin={isAdmin} canAct={canAct}
                      onRefresh={() => enqueue(c)} onPreview={setPreview} />
                  : <MovedOutCutoff row={r} paid={paid} />}
                {paid.otherCents !== 0 && <Note>Other payments on this cutoff: {centsToPeso(paid.otherCents)} (not part of either statement).</Note>}
              </div>
            )}
          </div>
        )
      })}
      {!showAll && rows.length > HISTORY_CAP && (
        <button type="button" className="btn-xs" onClick={() => setShowAll(true)}>Load older ({rows.length - HISTORY_CAP})</button>
      )}
      {preview && <MonthlyStatementPreview {...preview} onClose={() => setPreview(null)} />}
    </div>
  )
}

function MovedOutCutoff({ row, paid }) {
  const part = (label, ids, paidCents) => (
    <Block title={label}>
      {ids.length
        ? <Note>Billed on final bill #{ids.join(', #')} (this component). Payments on this cutoff are netted on that final bill.</Note>
        : <Note>Not on the current Billing page (moved out): payments only.</Note>}
      <Line label="Paid" value={centsToPeso(paidCents)} strong />
    </Block>
  )
  return (
    <div className="grid gap-2 sm:grid-cols-2">
      {part('Rent + Water', row.coveredWater, paid.rwCents)}
      {part('Electricity', row.coveredElec, paid.elecCents)}
    </div>
  )
}

function ActiveStatement({ cutoff, entry, paid, tenant, siblingIds, transfers, transfersError, isAdmin, canAct, onRefresh, onPreview }) {
  if (!entry || entry.status === 'queued' || entry.status === 'loading') {
    return <p className="text-[12px] text-ink-muted">Recalculating this statement…</p>
  }
  if (entry.status === 'error') {
    return (
      <div className="flex items-center gap-2 text-[12px] text-danger-text bg-danger-bg border border-danger-border rounded-lg px-3 py-2">
        <span>Could not compute this statement: {entry.error}</span>
        <button type="button" className="btn-xs ml-auto" onClick={onRefresh}><RefreshCw size={10} /> Retry</button>
      </div>
    )
  }

  const { result, inputs, at } = entry
  const s = statementForTenant(result, tenant, { siblingIds })
  const advError = inputs.advData?.error
  const row = s.row
  const primaryBed = row && s.kind === 'WHOLE_ROOM' ? row.bed : null

  const label = (
    <div className="text-[11px] text-warning-text bg-warning-bg border border-warning-border rounded-lg px-3 py-2">
      Recalculated from current data on {at.toLocaleString('en-PH', { dateStyle: 'medium', timeStyle: 'short' })}. This is not the
      original printout: rate edits, re-readings, add-on, split or move-in corrections made since then change it, and tenants
      who have since moved out without a final bill for this period are left out, so room shares (water, electricity) can differ
      from what was originally billed.
      {cutoff.is_active && <> Open period: figures change until the cutoff closes.</>}
    </div>
  )
  const toolbar = (
    <div className="flex justify-end">
      <button type="button" className="btn-xs" onClick={onRefresh}><RefreshCw size={10} /> Refresh</button>
    </div>
  )

  if (s.kind === 'STAY_BILLED') {
    return <>{label}<Note>One-month stay: rent and utilities are billed on the final bill at move-out, not on monthly statements.</Note>{toolbar}</>
  }
  if (!row) {
    return <>{label}<Note>No charge computed for this tenant on this cutoff (no readings yet, or no days in this window).</Note>{toolbar}</>
  }

  const held = !transfersError && cutoff.water_end && !hasTransferInWindow(transfers, cutoff)
    ? roomAsOf(transfers, windowLastDay(cutoff.water_end), row.room_no) : row.room_no
  const roomWarn = held != null && String(held) !== String(row.room_no)
  const rwPrintable = (row.rent + row.water + (row.addonRentWater || 0)) > 0.01
  const ePrintable = (row.elec + (row.addonElectric || 0)) > 0.01
  const printId = row.id

  const actions = (comp, printable, disabledReason) => printable && canAct && (
    <div className="flex items-center gap-2 pt-1.5">
      <button type="button" className="btn-xs blue" disabled={!!disabledReason} title={disabledReason || ''}
        onClick={() => onPreview({ component: comp, cutoff, row, result, inputs })}><Eye size={10} /> Preview</button>
      {isAdmin && !disabledReason && (
        <Link className="btn-xs" to={`/print/${comp === 'RW' ? 'rent-water' : 'electricity'}?cutoff=${cutoff.id}&tenant=${printId}`}>
          <Printer size={10} /> Print
        </Link>
      )}
    </div>
  )

  return (
    <>
      {label}
      {advError && (
        <div className="text-[12px] text-warning-text bg-warning-bg border border-warning-border rounded-lg px-3 py-2">
          Advance data could not be loaded ({advError}); the amounts below include neither the second-to-last-bill advance window (rent carried to the final bill) nor any stored advance credit.
        </div>
      )}
      {s.kind === 'WHOLE_ROOM' && (
        <Note>Whole-room statement (all beds): shown on Bed {primaryBed}'s row on the Billing page. Payments recorded on the other beds' profiles are not counted here, so no balance is shown.</Note>
      )}
      {s.kind === 'BILLED' && row.wholeRoom && (
        <Note>Whole-room statement (all beds). Payments recorded on the other beds' profiles are not counted in the balance.</Note>
      )}
      {roomWarn && (
        <div className="flex gap-1.5 text-[11px] text-warning-text">
          <AlertTriangle size={12} className="shrink-0 mt-0.5" />
          <span>The Billing page places this tenant in Room {row.room_no} (current) for this period; they were in Room {held} then. Figures follow the Billing page.</span>
        </div>
      )}
      {transfersError && <Note>Room history could not be loaded ({transfersError}); the room shown follows the Billing page.</Note>}
      {s.roomCheck && (!s.roomCheck.waterOk || !s.roomCheck.elecOk) && (
        <div className="flex gap-1.5 text-[11px] text-danger-text">
          <AlertTriangle size={12} className="shrink-0 mt-0.5" />
          <span>Check readings for Room {s.roomCheck.roomNo} on this cutoff ({[!s.roomCheck.waterOk && 'water', !s.roomCheck.elecOk && 'electricity'].filter(Boolean).join(', ')}).</span>
        </div>
      )}
      <div className="text-[11px] text-ink-muted">
        Room {row.transferred && row.fromRoomNo ? `${row.fromRoomNo}→${row.room_no}` : row.room_no}{row.bed ? ` · Bed ${row.bed}` : ''}
        {row.transferred && <span className="badge leased ml-1.5">XFER</span>}
        {row.wholeRoom && <span className="badge ml-1.5 bg-info-bg text-info-text">ROOM</span>}
      </div>

      <div className="grid gap-2 sm:grid-cols-2">
        <Block title="Rent + Water">
          <Line label="Rent" value={s.rw.rent ? peso(s.rw.rent) : '—'} />
          <Line label={`Water (${m3(s.rw.waterCons)} m³)`} value={peso(s.rw.water)}
            sub={row.transferred && row.oldWater > 0 ? `R${row.fromRoomNo}: ${peso(row.oldWater)} · R${row.room_no}: ${peso(row.water - row.oldWater)}` : null} />
          {s.rw.addons.map(a => <Line key={a.id} label={`${a.label}${a.recurring ? '' : ' (one-time)'}`} value={peso(a.amount)} muted />)}
          <Line label="RW Total" value={peso(s.rw.total)} strong />
          {s.credit && (
            <>
              <Line label="Less: Advanced Payment" value={`-${peso(s.credit.amount)}`}
                sub={[s.credit.ref, `remaining ${peso(s.credit.remaining)} for the final bill`].filter(Boolean).join(' · ')} />
              <Line label="Net" value={peso(s.rw.net)} strong />
            </>
          )}
          <Line label="Paid" value={centsToPeso(paid.rwCents)} />
          {s.kind === 'BILLED' && <Balance billedCents={toCents2(s.rw.net)} paidCents={paid.rwCents} />}
          {actions('RW', rwPrintable, advError ? 'Advance data could not be loaded: do not issue this statement until that is fixed' : '')}
        </Block>
        <Block title="Electricity">
          <Line label={`Electricity (${m3(s.elec.elecCons)} kWh)`} value={peso(s.elec.elec)}
            sub={row.transferred && row.oldElec > 0 ? `R${row.fromRoomNo}: ${peso(row.oldElec)} · R${row.room_no}: ${peso(row.elec - row.oldElec)}` : null} />
          {s.elec.addons.map(a => <Line key={a.id} label={`${a.label}${a.recurring ? '' : ' (one-time)'}`} value={peso(a.amount)} muted />)}
          <Line label="Elec Total" value={peso(s.elec.total)} strong />
          <Line label="Paid" value={centsToPeso(paid.elecCents)} />
          {s.kind === 'BILLED' && <Balance billedCents={toCents2(s.elec.total)} paidCents={paid.elecCents} />}
          {actions('ELEC', ePrintable, '')}
        </Block>
      </div>
      {toolbar}
    </>
  )
}
