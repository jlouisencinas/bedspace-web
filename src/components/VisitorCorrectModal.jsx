import { useState } from 'react'
import { X, Save } from 'lucide-react'
import VisitTargetPicker from './VisitTargetPicker'
import VisitorIdPhoto from './VisitorIdPhoto'
import {
  ALLOW_NO_EMAIL, ID_TYPES, cleanName, contactValid, correctVisit, emailValid, fmtDateTime, fromManilaLocalInput,
  idTypeLabel, targetLabel, toManilaLocalInput,
} from '../lib/visitors'

const initialTarget = v => (v.visit_kind === 'OFFICE'
  ? { kind: 'OFFICE', purpose: v.purpose || '' }
  : { kind: 'TENANT', tenant_id: v.tenant_id, tenant_name: v.tenant_name, room_id: v.room_id, room_no: v.room_no, bed_letters: v.bed_letters })

export default function VisitorCorrectModal({ visit, isAdmin, nowMs, onClose, onDone }) {
  const [name, setName] = useState(visit.visitor_name)
  const [contact, setContact] = useState(visit.contact_no)
  const [email, setEmail] = useState(visit.email || '')
  const [noEmail, setNoEmail] = useState(!!visit.no_email)
  const [idType, setIdType] = useState(visit.id_type)
  const [idTypeOther, setIdTypeOther] = useState(visit.id_type_other || '')
  const [idNumber, setIdNumber] = useState(visit.id_number || '')
  const [target, setTarget] = useState(initialTarget(visit))
  const [pickerOpen, setPickerOpen] = useState(false)
  const initialOut = toManilaLocalInput(visit.check_out_at)
  const [checkOut, setCheckOut] = useState(initialOut)
  const [reason, setReason] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  const changes = {}
  const summary = []
  const add = (key, label, from, to, value) => { changes[key] = value; summary.push(`${label}: ${from || '—'} → ${to || '—'}`) }

  if (cleanName(name) !== visit.visitor_name) add('visitor_name', 'Name', visit.visitor_name, cleanName(name), cleanName(name))
  if (contact.trim() !== visit.contact_no) add('contact_no', 'Contact', visit.contact_no, contact.trim(), contact.trim())
  if (noEmail !== !!visit.no_email) add('no_email', 'No email', visit.no_email ? 'Yes' : 'No', noEmail ? 'Yes' : 'No', noEmail)
  if (!noEmail && email.trim().toLowerCase() !== (visit.email || '')) add('email', 'Email', visit.email, email.trim().toLowerCase(), email.trim())
  if (idType !== visit.id_type || (idType === 'OTHER' && idTypeOther.trim() !== (visit.id_type_other || ''))) {
    changes.id_type = idType
    if (idType === 'OTHER') changes.id_type_other = idTypeOther.trim()
    summary.push(`ID type: ${idTypeLabel(visit.id_type, visit.id_type_other)} → ${idTypeLabel(idType, idTypeOther.trim())}`)
  }
  if ((idNumber.trim() || null) !== (visit.id_number || null)) add('id_number', 'ID number', visit.id_number, idNumber.trim(), idNumber.trim() || null)
  const init = initialTarget(visit)
  const targetChanged = target.kind !== init.kind
    || (target.kind === 'OFFICE' ? target.purpose !== init.purpose : target.tenant_id !== init.tenant_id || target.room_id !== init.room_id)
  if (targetChanged) {
    if (target.kind !== visit.visit_kind) changes.visit_kind = target.kind
    if (target.kind === 'TENANT') changes.tenant_id = target.tenant_id
    else changes.purpose = target.purpose
    summary.push(`Visiting: ${targetLabel(init)} → ${targetLabel(target)}`)
  }
  if (checkOut && checkOut !== initialOut) {
    add('check_out_at', 'Check-out', visit.check_out_at ? fmtDateTime(visit.check_out_at) : 'Inside', fmtDateTime(fromManilaLocalInput(checkOut)), fromManilaLocalInput(checkOut))
  }

  const problems = [
    (cleanName(name).length < 2 || cleanName(name).length > 100) && 'Name must be 2 to 100 characters.',
    !contactValid(contact) && 'Enter a valid contact number (7 to 15 digits).',
    !noEmail && !emailValid(email) && 'Enter a valid email, or tick No email.',
    idType === 'OTHER' && (idTypeOther.trim().length < 2 || idTypeOther.trim().length > 40) && 'Specify the ID type (2 to 40 characters).',
    idNumber.trim() && (idNumber.trim().length < 3 || idNumber.trim().length > 40) && 'The ID number must be 3 to 40 characters.',
    checkOut && !fromManilaLocalInput(checkOut) && 'Enter a valid check-out time.',
    // datetime-local has minute precision: the check-in minute itself is allowed (the server stores the check-in instant).
    checkOut && fromManilaLocalInput(checkOut) && Date.parse(fromManilaLocalInput(checkOut)) < Math.floor(Date.parse(visit.check_in_at) / 60000) * 60000
      && 'The check-out time cannot be before the check-in time.',
    checkOut && fromManilaLocalInput(checkOut) && Date.parse(fromManilaLocalInput(checkOut)) > nowMs
      && 'The check-out time cannot be in the future.',
  ].filter(Boolean)
  const canSave = summary.length > 0 && problems.length === 0 && reason.trim().length >= 3

  async function submit(e) {
    e.preventDefault()
    if (!canSave) return
    setBusy(true); setError('')
    try {
      await correctVisit(visit.id, changes, reason.trim())
      onDone()
    } catch (err) {
      setError(err.message)
      setBusy(false)
    }
  }

  return (
    <div className="overlay" onClick={e => e.stopPropagation()}>
      <form className="modal" onSubmit={submit}>
        <div className="modal-head">
          <h3>Correct visitor entry #{visit.id}</h3>
          <button type="button" className="btn-close" onClick={onClose} aria-label="Close"><X size={16} /></button>
        </div>
        <div className="modal-body space-y-4">
          <div className="p-3 rounded-xl bg-surface-2 border border-line-subtle text-[13px] text-ink-secondary space-y-2">
            <div><span className="font-semibold text-ink">Check-in:</span> {fmtDateTime(visit.check_in_at)} by {visit.check_in_guard_name} (cannot be changed)</div>
            <div className="font-semibold text-ink">ID photo (cannot be changed)</div>
            <VisitorIdPhoto path={visit.id_photo_path} purgedAt={visit.id_photo_purged_at} isAdmin={isAdmin} className="h-24" />
          </div>

          <div className="form-grid">
            <div className="fg full">
              <label>Visiting</label>
              <button type="button" onClick={() => setPickerOpen(true)} className="btn secondary justify-between w-full !min-h-[44px] text-left">
                <span className="truncate">{targetLabel(target)}</span><span className="text-navy-600">Change</span>
              </button>
            </div>
            <div className="fg">
              <label htmlFor="c-name">Visitor name</label>
              <input id="c-name" value={name} maxLength={100} onChange={e => setName(e.target.value)} />
            </div>
            <div className="fg">
              <label htmlFor="c-contact">Contact number</label>
              <input id="c-contact" type="tel" value={contact} maxLength={30} onChange={e => setContact(e.target.value)} />
            </div>
            <div className="fg">
              <label htmlFor="c-email">Email</label>
              <input id="c-email" type="email" value={email} disabled={noEmail} maxLength={254} onChange={e => setEmail(e.target.value)} />
            </div>
            <div className="flex items-end">
              {ALLOW_NO_EMAIL && (
                <label className="text-[13px] font-medium text-ink flex items-center gap-2 min-h-[38px] cursor-pointer">
                  <input type="checkbox" className="w-4 h-4" checked={noEmail} onChange={e => { setNoEmail(e.target.checked); if (e.target.checked) setEmail('') }} /> No email
                </label>
              )}
            </div>
            <div className="fg">
              <label htmlFor="c-idtype">ID type</label>
              <select id="c-idtype" value={idType} onChange={e => setIdType(e.target.value)}>
                {ID_TYPES.map(t => <option key={t.value} value={t.value}>{t.label}</option>)}
              </select>
            </div>
            {idType === 'OTHER' ? (
              <div className="fg">
                <label htmlFor="c-idother">Specify ID type</label>
                <input id="c-idother" value={idTypeOther} maxLength={40} onChange={e => setIdTypeOther(e.target.value)} />
              </div>
            ) : <div />}
            <div className="fg">
              <label htmlFor="c-idnumber">ID number (add here)</label>
              <input id="c-idnumber" value={idNumber} maxLength={40} onChange={e => setIdNumber(e.target.value)} placeholder="Optional" />
            </div>
            <div className="fg">
              <label htmlFor="c-out">Check-out time (Manila)</label>
              <input id="c-out" type="datetime-local" value={checkOut} onChange={e => setCheckOut(e.target.value)}
                min={toManilaLocalInput(visit.check_in_at)} max={toManilaLocalInput(nowMs)} />
            </div>
            <div className="fg full">
              <label htmlFor="c-reason">Reason for the correction (required)</label>
              <textarea id="c-reason" rows={2} maxLength={300} value={reason} onChange={e => setReason(e.target.value)} />
            </div>
          </div>

          {problems.length > 0 && (
            <div className="p-3 rounded-xl bg-danger-bg text-danger-text border border-danger-border text-[13px] space-y-1">
              {problems.map(p => <div key={p}>{p}</div>)}
            </div>
          )}
          <div className="p-3 rounded-xl bg-surface-2 border border-line-subtle text-[13px]">
            <div className="font-semibold text-ink mb-1">Changes</div>
            {summary.length ? summary.map(s => <div key={s} className="text-ink-secondary break-words">{s}</div>) : <div className="text-ink-muted">No changes yet.</div>}
          </div>
          {error && <div className="p-3 rounded-xl bg-danger-bg text-danger-text border border-danger-border text-[13px]">{error}</div>}
        </div>
        <div className="modal-foot">
          <button type="button" className="btn secondary" onClick={onClose} disabled={busy}>Cancel</button>
          <button type="submit" className="btn primary" disabled={busy || !canSave}><Save size={14} />{busy ? 'Saving…' : 'Save correction'}</button>
        </div>
      </form>
      {pickerOpen && (
        <VisitTargetPicker initialPurpose={target.kind === 'OFFICE' ? target.purpose : ''} onClose={() => setPickerOpen(false)}
          onPick={t => { setTarget(t); setPickerOpen(false) }} />
      )}
    </div>
  )
}
