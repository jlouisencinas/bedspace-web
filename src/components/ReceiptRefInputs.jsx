import { normalizeReceiptRef, refKey } from '../lib/finalBill'
import { DEPOSIT_KIND_LABEL, DEPOSIT_REF_LABEL, PAYMENT_MODE_LABEL } from '../lib/supabase'

const peso = n => '₱' + Number(n || 0).toLocaleString('en-PH', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
const keyOf = (kind, v) => { const n = normalizeReceiptRef(kind, v); return n.error ? null : refKey(n.value) }

/**
 * Same number on another receipt of the same kind. Receipts of this tenant are never flagged (a split BANK+CASH advance may share
 * one S.I#); receipts of the other beds in this flow (`flow`: Map(deposit_id -> { tenantId, bed })) get a soft note; any other
 * tenant's receipt in `index` (fetchReceiptRefIndex rows) gets a warning.
 */
function duplicates({ entry, value, tenantId, flow, refs, index }) {
  const key = keyOf(entry.kind, value)
  if (!key) return { warn: [], note: [] }
  const flowTenants = new Set([tenantId, ...[...flow.values()].map(f => f.tenantId)])
  const beds = new Set()
  for (const [id, f] of flow) {
    if (f.tenantId === tenantId || f.kind !== entry.kind) continue
    if (keyOf(f.kind, refs[id] ?? f.current) === key) beds.add(f.bed)
  }
  const label = DEPOSIT_REF_LABEL[entry.kind]
  const shown = normalizeReceiptRef(entry.kind, value).value
  const warn = (index || [])
    .filter(r => r.kind === entry.kind && !flowTenants.has(r.tenant_id) && keyOf(r.kind, r.ref_no) === key)
    .map(r => `${label} ${shown} is already on ${r.tenants?.name || `tenant #${r.tenant_id}`}'s ${DEPOSIT_KIND_LABEL[r.kind].toLowerCase()} receipt (#${r.id}, ${r.status}).`)
  const note = beds.size ? [`${label} ${shown} is also used for Bed ${[...beds].join(' & ')}; fine if one invoice covers both beds.`] : []
  return { warn, note }
}

/**
 * One S.I#/T.R# input per receipt. entries = receiptRefsNeeded() rows; refs = { [deposit_id]: string } (typed values);
 * hints = { [deposit_id]: string } extra line under an input.
 */
export default function ReceiptRefInputs({ entries, refs, onChange, tenantId, flow = new Map(), index = [], hints = {}, disabled = false }) {
  return (
    <div className="space-y-2">
      {entries.map(e => {
        const label = DEPOSIT_REF_LABEL[e.kind]
        const meta = [
          `${DEPOSIT_KIND_LABEL[e.kind]} ${peso(e.amount)}`,
          e.payment_mode && PAYMENT_MODE_LABEL[e.payment_mode],
          e.received_date && `received ${String(e.received_date).slice(0, 10)}`,
        ].filter(Boolean).join(' · ')
        const tag = e.fromReservation && (
          <span className="text-[10px] font-bold px-1.5 py-0.5 rounded bg-warning-bg text-warning-text">From reservation</span>
        )
        if (e.locked) {
          return (
            <div key={e.deposit_id} className="flex flex-wrap items-center gap-x-2 gap-y-1">
              <span className="text-ink">{label} {e.current} (from the reservation payment)</span>
              <span className="text-ink-faint">{meta}</span>
              {tag}
            </div>
          )
        }
        const raw = refs[e.deposit_id] ?? ''
        const n = normalizeReceiptRef(e.kind, raw)
        const err = n.error && (e.required || String(raw).trim() !== '') ? n.error : null
        const { warn, note } = duplicates({ entry: e, value: raw, tenantId, flow, refs, index })
        return (
          <div key={e.deposit_id} className="space-y-1">
            <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
              <label className="flex items-center gap-2 w-full sm:w-auto">
                <span className="w-10 shrink-0 font-semibold text-ink">{label}</span>
                <input type="text" inputMode="text" autoComplete="off" maxLength={60} disabled={disabled}
                  className={`flex-1 sm:flex-none sm:w-44 min-w-0 ${err ? 'border-danger-border' : ''}`}
                  value={raw} placeholder={e.required ? 'number (required)' : 'number (optional)'}
                  onChange={ev => onChange(e.deposit_id, ev.target.value)} />
              </label>
              <span className="text-ink-faint">{meta}{!e.required && ' · no number needed for a 0.00 receipt'}</span>
              {tag}
            </div>
            {err && <div className="text-danger-text">{err}</div>}
            {hints[e.deposit_id] && <div className="text-ink-muted">{hints[e.deposit_id]}</div>}
            {warn.map((w, i) => <div key={`w${i}`} className="text-warning-text">{w}</div>)}
            {note.map((w, i) => <div key={`n${i}`} className="text-ink-faint">{w}</div>)}
          </div>
        )
      })}
    </div>
  )
}
