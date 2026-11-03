import { useState } from 'react'
import { AlertTriangle, RefreshCw, LogOut, Moon } from 'lucide-react'
import { BottomSheet } from './GuardShell'
import { notifyAsync } from '../lib/notify'
import {
  STATE_META, TONE_CHIP, checkOutVisitor, fmtDuration, fmtNight, fmtTime, fmtTimeSec, fmtWhen, idTypeLabel,
  logDayKey, requestOvernight, sameLogDay, visitTargetText,
} from '../lib/visitors'

const RANK = { RED: 0, PENDING: 1, DUE_SOON: 1 }

function overnightLine(r) {
  if (r.overnight_status === 'PENDING') return { text: `Pending approval (night of ${fmtNight(r.overnight_night)})`, tone: 'text-warning-text' }
  if (r.state === 'APPROVED') return { text: 'Approved for tonight', tone: 'text-success-text' }
  if (r.overnight_status === 'APPROVED') return { text: `Approved (night of ${fmtNight(r.overnight_night)})`, tone: 'text-success-text' }
  if (r.overnight_status === 'REJECTED') return { text: `Rejected${r.overnight_decision_note ? ` — ${r.overnight_decision_note}` : ''}`, tone: 'text-danger-text' }
  return null
}

function redSubStatus(r) {
  if (r.overnight_status === 'PENDING') return 'Request pending'
  if (r.overnight_status === 'REJECTED') return `Request rejected${r.overnight_decision_note ? ` — ${r.overnight_decision_note}` : ''}`
  return 'No request'
}

function cardTone(state) {
  if (state === 'RED') return 'border-2 border-danger-border bg-danger-bg'
  if (state === 'PENDING') return 'border border-warning-border bg-warning-bg'
  return 'border border-line bg-surface'
}

export default function VisitorInsideList({ rows, masked, guardName = null, nowMs, onChanged, show, updatedAt, onRefresh, loading, error }) {
  const [confirm, setConfirm] = useState(null)
  const [overnightFor, setOvernightFor] = useState(null)
  const [reason, setReason] = useState('')
  const [busy, setBusy] = useState(false)
  const [sheetError, setSheetError] = useState('')

  const sorted = [...rows].sort((a, b) =>
    (RANK[a.state] ?? 2) - (RANK[b.state] ?? 2) || Date.parse(a.check_in_at) - Date.parse(b.check_in_at))

  async function doCheckOut() {
    setBusy(true); setSheetError('')
    try {
      const at = await checkOutVisitor(confirm.id, guardName)
      show(`${confirm.visitor_name} checked out at ${fmtTime(at)}`, 'success')
      setConfirm(null)
      onChanged?.()
    } catch (e) {
      setSheetError(e.message)
      onChanged?.()
    } finally { setBusy(false) }
  }

  async function doRequest() {
    setBusy(true); setSheetError('')
    try {
      const id = await requestOvernight(overnightFor.id, reason.trim(), guardName)
      if (id) notifyAsync('approval_request', id)
      show('Request sent. After 10:00 PM the visitor stays red until an admin approves.', 'success', { duration: 6000 })
      setOvernightFor(null); setReason('')
      onChanged?.()
    } catch (e) {
      setSheetError(e.message)
    } finally { setBusy(false) }
  }

  const tonight = fmtNight(logDayKey(nowMs), true)
  const reasonOk = reason.trim().length >= 3 && reason.trim().length <= 300

  return (
    <div className="guard-form space-y-3">
      <h2 className="text-[16px] font-semibold text-ink px-1">Inside now ({rows.length})</h2>
      {error && <div className="p-3 rounded-xl bg-danger-bg text-danger-text border border-danger-border text-[14px]">{error}</div>}
      {!loading && !error && rows.length === 0 && (
        <div className="p-6 rounded-xl bg-surface border border-line text-center text-[14px] text-ink-muted">No visitors inside.</div>
      )}

      {sorted.map(r => {
        const meta = STATE_META[r.state] || STATE_META.OK
        const ov = overnightLine(r)
        const contact = masked ? r.contact_masked : r.contact_no
        return (
          <article key={r.id} className={`rounded-xl p-4 space-y-2 ${cardTone(r.state)}`}>
            {r.state === 'RED' && (
              <div className="text-danger-text">
                <div className="flex items-center gap-2 text-[15px] font-bold"><AlertTriangle size={18} className="shrink-0" /> Overnight not approved – must leave</div>
                <div className="text-[13px] pl-[26px] break-words">{redSubStatus(r)}</div>
              </div>
            )}
            <div className="flex items-start gap-2">
              <h3 className="flex-1 min-w-0 text-[16px] font-semibold text-ink break-words">{r.visitor_name}</h3>
              {r.state !== 'RED' && (
                <span className={`shrink-0 px-2.5 py-1 rounded-full text-[12px] font-semibold ${TONE_CHIP[meta.tone]}`}>{meta.label}</span>
              )}
            </div>
            <div className="text-[14px] text-ink-secondary break-words">Visiting {visitTargetText(r)}</div>
            <div className="text-[14px] text-ink-secondary">
              In {fmtWhen(r.check_in_at, nowMs)}{sameLogDay(r.check_in_at, nowMs) ? ' today' : ''} · by {r.check_in_guard_name} · {fmtDuration(nowMs - Date.parse(r.check_in_at))}
            </div>
            <div className="text-[14px] text-ink-secondary break-words">
              ID: {idTypeLabel(r.id_type, r.id_type_other)} · ☎ {contact || '—'}
              {!masked && (r.no_email ? ' · No email' : r.email ? ` · ${r.email}` : '')}
            </div>
            {ov && r.state !== 'RED' && <div className={`text-[14px] font-medium break-words ${ov.tone}`}>{ov.text}</div>}
            <div className="pt-1 space-y-2">
              <button type="button" onClick={() => { setSheetError(''); setConfirm(r) }} className="btn primary w-full !min-h-[48px] !text-[15px]">
                <LogOut size={16} /> Check out
              </button>
              {r.can_request_overnight && (
                <button type="button" onClick={() => { setSheetError(''); setReason(''); setOvernightFor(r) }} className="btn secondary w-full !min-h-[48px] !text-[15px]">
                  <Moon size={16} /> Request overnight
                </button>
              )}
            </div>
          </article>
        )
      })}

      <div className="flex items-center justify-between gap-3 px-1 text-[13px] text-ink-muted">
        <span>Updated {updatedAt ? fmtTimeSec(updatedAt) : '—'}</span>
        <button type="button" onClick={onRefresh} disabled={loading} className="btn secondary !min-h-[48px]">
          <RefreshCw size={14} className={loading ? 'animate-spin' : ''} /> Refresh
        </button>
      </div>

      {confirm && (
        <BottomSheet title={`Check out ${confirm.visitor_name}?`} onClose={() => !busy && setConfirm(null)}
          footer={<>
            <button type="button" className="btn secondary flex-1 !min-h-[48px] !text-[15px]" onClick={() => setConfirm(null)} disabled={busy}>Cancel</button>
            <button type="button" className="btn primary flex-1 !min-h-[48px] !text-[15px]" onClick={doCheckOut} disabled={busy}>{busy ? 'Checking out…' : 'Check out'}</button>
          </>}>
          <p className="text-[15px] text-ink-secondary">Time recorded now ({fmtTime(nowMs)}).</p>
          {sheetError && <div className="mt-3 p-3 rounded-xl bg-danger-bg text-danger-text border border-danger-border text-[14px]">{sheetError}</div>}
        </BottomSheet>
      )}

      {overnightFor && (
        <BottomSheet title={`Request overnight stay — tonight, ${tonight} (after 10:00 PM)`} onClose={() => !busy && setOvernightFor(null)}
          footer={<>
            <button type="button" className="btn secondary flex-1 !min-h-[48px] !text-[15px]" onClick={() => setOvernightFor(null)} disabled={busy}>Cancel</button>
            <button type="button" className="btn primary flex-1 !min-h-[48px] !text-[15px]" onClick={doRequest} disabled={busy || !reasonOk}>{busy ? 'Sending…' : 'Send'}</button>
          </>}>
          <div className="space-y-3">
            <p className="text-[14px] text-ink-secondary">{overnightFor.visitor_name} → {visitTargetText(overnightFor)}</p>
            <div className="fg">
              <label htmlFor="ov-reason">Reason / relationship</label>
              <textarea id="ov-reason" rows={3} maxLength={300} value={reason} onChange={e => setReason(e.target.value)} autoFocus
                placeholder="e.g. Sister visiting from the province" className="!text-[16px]" />
            </div>
            {sheetError && <div className="p-3 rounded-xl bg-danger-bg text-danger-text border border-danger-border text-[14px]">{sheetError}</div>}
          </div>
        </BottomSheet>
      )}
    </div>
  )
}
