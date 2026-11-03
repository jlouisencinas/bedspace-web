import { useEffect, useState } from 'react'
import { X, Pencil, Ban } from 'lucide-react'
import VisitorIdPhoto from './VisitorIdPhoto'
import {
  STATE_META, TONE_CHIP, fetchOvernightRequests, fetchVisitEdits, fmtDateTime, fmtDuration, fmtNight, idTypeLabel,
  visitTargetText,
} from '../lib/visitors'

const FIELD_NAMES = {
  visitor_name: 'Name', contact_no: 'Contact', email: 'Email', no_email: 'No email', id_type: 'ID type',
  id_type_other: 'ID type (other)', id_number: 'ID number', visit_kind: 'Visit kind', tenant_id: 'Tenant id',
  tenant_name: 'Tenant', room_id: 'Room id', room_no: 'Room', bed_letters: 'Bed', purpose: 'Purpose',
  check_out_at: 'Check-out', voided: 'Voided',
}
const show = (k, v) => {
  if (v === null || v === undefined || v === '') return '—'
  if (typeof v === 'boolean') return v ? 'Yes' : 'No'
  if (k === 'check_out_at') return fmtDateTime(v)
  return String(v)
}

function Row({ label, children }) {
  return (
    <div className="detail-row">
      <div className="detail-label !w-32">{label}</div>
      <div className="detail-value">{children}</div>
    </div>
  )
}

export default function VisitorDetailDrawer({ visit, isAdmin, onClose, onCorrect, onVoid }) {
  const [edits, setEdits] = useState(null)
  const [requests, setRequests] = useState(null)
  const [error, setError] = useState('')

  useEffect(() => {
    let cancelled = false
    setEdits(null); setRequests(null); setError('')
    Promise.all([fetchVisitEdits(visit.id), fetchOvernightRequests(visit.id)])
      .then(([e, r]) => { if (!cancelled) { setEdits(e); setRequests(r) } })
      .catch(e => { if (!cancelled) setError(e.message) })
    return () => { cancelled = true }
  }, [visit.id, visit.updated_at])

  const meta = STATE_META[visit.state] || STATE_META.OK
  const voided = !!visit.voided_at

  return (
    <div className="fixed inset-0 z-50 flex justify-end animate-fade-in" style={{ background: 'var(--overlay)' }} onClick={onClose}>
      <aside className="w-full sm:max-w-md h-full bg-surface shadow-modal flex flex-col" onClick={e => e.stopPropagation()}
        role="dialog" aria-modal="true" aria-label={`Visit #${visit.id}`}
        style={{ paddingTop: 'env(safe-area-inset-top)', paddingBottom: 'env(safe-area-inset-bottom)' }}>
        <div className="px-5 py-4 flex items-start gap-3 border-b border-line">
          <div className="flex-1 min-w-0">
            <div className={`text-[16px] font-semibold text-ink break-words ${voided ? 'line-through' : ''}`}>{visit.visitor_name}</div>
            <div className="text-[12px] text-ink-muted">Visit #{visit.id}</div>
          </div>
          <span className={`shrink-0 px-2.5 py-1 rounded-full text-[12px] font-semibold ${TONE_CHIP[meta.tone]}`}>{meta.label}</span>
          <button type="button" className="btn-close" onClick={onClose} aria-label="Close"><X size={18} /></button>
        </div>

        <div className="flex-1 overflow-y-auto px-5 py-4 space-y-5">
          {voided && (
            <div className="p-3 rounded-xl bg-danger-bg text-danger-text border border-danger-border text-[13px]">
              Voided {fmtDateTime(visit.voided_at)}. Reason: {visit.void_reason}
            </div>
          )}
          <div>
            <Row label="Visiting">{visitTargetText(visit)}</Row>
            <Row label="Check-in">{fmtDateTime(visit.check_in_at)} · by {visit.check_in_guard_name}</Row>
            <Row label="Check-out">{visit.check_out_at ? `${fmtDateTime(visit.check_out_at)} · by ${visit.check_out_guard_name}` : 'Still inside'}</Row>
            <Row label="Duration">{fmtDuration((visit.check_out_at ? Date.parse(visit.check_out_at) : Date.parse(visit.server_now)) - Date.parse(visit.check_in_at))}</Row>
            <Row label="Contact">{visit.contact_no}</Row>
            <Row label="Email">{visit.no_email ? 'No email' : visit.email}</Row>
            <Row label="ID type">{idTypeLabel(visit.id_type, visit.id_type_other)}</Row>
            <Row label="ID number">{visit.id_number || '—'}</Row>
            <Row label="Overnight">
              {visit.overnight_status === 'NONE' ? 'Not requested' : `${visit.overnight_status} (night of ${fmtNight(visit.overnight_night)})`}
              {visit.overstay_unapproved && <span className={`ml-2 px-2 py-0.5 rounded-full text-[11px] font-semibold ${TONE_CHIP.danger}`}>Past cut-off, no approval</span>}
            </Row>
          </div>

          <section>
            <h4 className="text-[11px] font-semibold text-ink-faint uppercase tracking-wider mb-2">ID photo</h4>
            <VisitorIdPhoto path={visit.id_photo_path} purgedAt={visit.id_photo_purged_at} isAdmin={isAdmin} />
          </section>

          {error && <div className="p-3 rounded-xl bg-danger-bg text-danger-text border border-danger-border text-[13px]">{error}</div>}

          <section>
            <h4 className="text-[11px] font-semibold text-ink-faint uppercase tracking-wider mb-2">Overnight requests</h4>
            {requests === null ? <div className="text-[13px] text-ink-muted">Loading…</div>
              : requests.length === 0 ? <div className="text-[13px] text-ink-muted">None</div>
              : requests.map(r => (
                <div key={r.id} className="py-2 border-b border-line-subtle last:border-b-0 text-[13px]">
                  <div className="text-ink font-medium">Night of {fmtNight(r.new_value?.night)} · {r.status}</div>
                  <div className="text-ink-secondary break-words">Reason: {r.reason}</div>
                  <div className="text-ink-muted">Requested {fmtDateTime(r.created_at)} (front desk: {r.new_value?.guard_name || '—'})</div>
                  {r.decided_at && <div className="text-ink-muted break-words">Decided {fmtDateTime(r.decided_at)}{r.decision_notes ? ` — ${r.decision_notes}` : ''}</div>}
                </div>
              ))}
          </section>

          <section>
            <h4 className="text-[11px] font-semibold text-ink-faint uppercase tracking-wider mb-2">Edit history</h4>
            {edits === null ? <div className="text-[13px] text-ink-muted">Loading…</div>
              : edits.length === 0 ? <div className="text-[13px] text-ink-muted">No corrections.</div>
              : edits.map(e => (
                <div key={e.id} className="py-2 border-b border-line-subtle last:border-b-0 text-[13px]">
                  <div className="text-ink font-medium">{e.action === 'VOID' ? 'Voided' : 'Corrected'} · {fmtDateTime(e.edited_at)} · {e.edited_by_email || 'unknown'}</div>
                  <div className="text-ink-secondary break-words">Reason: {e.reason}</div>
                  {Object.entries(e.changes || {}).map(([k, c]) => (
                    <div key={k} className="text-ink-muted break-words">{FIELD_NAMES[k] || k}: {show(k, c?.old)} → {show(k, c?.new)}</div>
                  ))}
                </div>
              ))}
          </section>
        </div>

        {!voided && (
          <div className="px-5 py-3 border-t border-line flex gap-3">
            <button type="button" className="btn secondary flex-1 !min-h-[44px]" onClick={onCorrect}><Pencil size={14} /> Correct</button>
            <button type="button" className="btn danger flex-1 !min-h-[44px]" onClick={onVoid}><Ban size={14} /> Void</button>
          </div>
        )}
      </aside>
    </div>
  )
}
