import { useEffect, useRef, useState } from 'react'
import { ChevronRight, Info, AlertTriangle, Clock, Repeat } from 'lucide-react'
import VisitTargetPicker from './VisitTargetPicker'
import IdPhotoCapture, { EMPTY_PHOTO, releasePhoto } from './IdPhotoCapture'
import { TABBAR_H } from './GuardShell'
import { notifyAsync } from '../lib/notify'
import {
  ALLOW_NO_EMAIL, addRecentTarget, checkInVisitor, cleanName, contactKey, contactKeyReady, contactValid,
  emailValid, fmtDate, fmtTime, lookupContact, manilaHour, targetLabel,
} from '../lib/visitors'

let lastTarget = null

const sameTarget = (a, b) => !!a && !!b && a.kind === b.kind &&
  (a.kind === 'OFFICE' ? a.purpose === b.purpose : a.tenant_id === b.tenant_id && a.room_id === b.room_id)

function Card({ n, title, refEl, bad, children }) {
  return (
    <section ref={refEl} className={`bg-surface rounded-xl border p-4 scroll-mt-20 ${bad ? 'border-danger-border ring-1 ring-danger-border' : 'border-line'}`}>
      <h2 className="text-[15px] font-semibold text-ink mb-3 flex items-center gap-2">
        <span className="w-6 h-6 rounded-full bg-surface-3 text-ink-secondary text-[13px] font-bold flex items-center justify-center">{n}</span>
        {title}
      </h2>
      {children}
    </section>
  )
}

export default function VisitorCheckIn({ layout = 'guard', guardName = null, recordedBy, nowMs, onCheckedIn, show }) {
  const [target, setTarget] = useState(null)
  const [pickerOpen, setPickerOpen] = useState(false)
  const [contact, setContact] = useState('')
  const [name, setName] = useState('')
  const [email, setEmail] = useState('')
  const [noEmail, setNoEmail] = useState(false)
  const [idType, setIdType] = useState('')
  const [idTypeOther, setIdTypeOther] = useState('')
  const [photo, setPhoto] = useState(EMPTY_PHOTO)
  const [overnight, setOvernight] = useState(false)
  const [reason, setReason] = useState('')
  const [busy, setBusy] = useState(false)
  const [showMissing, setShowMissing] = useState(false)
  const [error, setError] = useState('')
  const [lookup, setLookup] = useState(null)

  const topRef = useRef(null)
  const refs = { target: useRef(null), visitor: useRef(null), id: useRef(null), overnight: useRef(null) }
  const form = useRef({})
  form.current = { name, email, noEmail, idType }
  const lookupSeq = useRef(0)
  const lookedUpKey = useRef('')

  useEffect(() => () => releasePhoto(photo), [photo.previewUrl])

  // A submit error describes the form as it was; any edit makes it stale.
  useEffect(() => { setError('') }, [target, contact, name, email, noEmail, idType, idTypeOther, photo.token, overnight, reason])

  useEffect(() => {
    if (!contactKeyReady(contact)) { lookedUpKey.current = ''; return }
    const key = contactKey(contact)
    if (key === lookedUpKey.current) return
    const seq = ++lookupSeq.current
    const timer = setTimeout(async () => {
      try {
        const r = await lookupContact(contact.trim())
        if (seq !== lookupSeq.current) return
        lookedUpKey.current = key
        if (r) applyLookup(r)
        else setLookup(null)
      } catch {
        // Returning-visitor lookup is only a typing shortcut; check-in still validates every field on the server.
      }
    }, 400)
    return () => clearTimeout(timer)
  }, [contact])

  function applyLookup(r) {
    const f = form.current
    const filled = []
    if (!cleanName(f.name)) { setName(r.visitor_name || ''); filled.push('name') }
    if (!f.email.trim() && !f.noEmail) {
      if (r.no_email) setNoEmail(ALLOW_NO_EMAIL)
      else setEmail(r.email || '')
      filled.push('email')
    }
    if (!f.idType) { setIdType(r.id_type || ''); setIdTypeOther(r.id_type_other || ''); filled.push('idType') }
    const differs = (!filled.includes('name') && cleanName(f.name).toLowerCase() !== String(r.visitor_name || '').toLowerCase())
      || (!filled.includes('email') && (f.noEmail ? !r.no_email : f.email.trim().toLowerCase() !== String(r.email || '').toLowerCase()))
      || (!filled.includes('idType') && f.idType !== r.id_type)
    setLookup({ r, filled, offer: differs })
  }

  function applyLastDetails() {
    const r = lookup?.r
    if (!r) return
    setName(r.visitor_name || '')
    if (r.no_email && ALLOW_NO_EMAIL) { setNoEmail(true); setEmail('') } else { setNoEmail(false); setEmail(r.email || '') }
    setIdType(r.id_type || ''); setIdTypeOther(r.id_type_other || '')
    setLookup({ r, filled: ['name', 'email', 'idType'], offer: false })
  }

  function clearLookup() {
    const filled = lookup?.filled || []
    if (filled.includes('name')) setName('')
    if (filled.includes('email')) { setEmail(''); setNoEmail(false) }
    if (filled.includes('idType')) { setIdType(''); setIdTypeOther('') }
    setLookup(null)
  }

  const nameOk = cleanName(name).length >= 2 && cleanName(name).length <= 100
  const emailOk = noEmail ? ALLOW_NO_EMAIL : emailValid(email)
  const otherOk = idType !== 'OTHER' || (idTypeOther.trim().length >= 2 && idTypeOther.trim().length <= 40)
  const reasonOk = !overnight || (reason.trim().length >= 3 && reason.trim().length <= 300)
  const missing = [
    !target && { key: 'target', label: 'who they are visiting' },
    !contactValid(contact) && { key: 'visitor', label: 'contact number' },
    !nameOk && { key: 'visitor', label: 'full name' },
    !emailOk && { key: 'visitor', label: 'email or No email' },
    !idType && { key: 'id', label: 'ID type' },
    idType && !otherOk && { key: 'id', label: 'specify ID type' },
    photo.status !== 'ready' && { key: 'id', label: 'ID photo' },
    !reasonOk && { key: 'overnight', label: 'overnight reason' },
  ].filter(Boolean)
  const bad = k => showMissing && missing.some(m => m.key === k)
  const uploading = photo.status === 'processing' || photo.status === 'uploading'

  const hour = manilaHour(nowMs)
  const timeNote = hour >= 22 || hour < 6 ? 'danger' : hour === 21 ? 'warning' : null

  function reset() {
    releasePhoto(photo)
    setTarget(null); setContact(''); setName(''); setEmail(''); setNoEmail(false)
    setIdType(''); setIdTypeOther(''); setPhoto(EMPTY_PHOTO); setOvernight(false); setReason('')
    setShowMissing(false); setError(''); setLookup(null); lookedUpKey.current = ''
  }

  async function submit() {
    setError('')
    if (busy || uploading) return
    if (missing.length) {
      setShowMissing(true)
      refs[missing[0].key].current?.scrollIntoView({ behavior: 'smooth', block: 'start' })
      return
    }
    setBusy(true)
    try {
      const r = await checkInVisitor({
        visitKind: target.kind,
        tenantId: target.kind === 'TENANT' ? target.tenant_id : null,
        purpose: target.kind === 'OFFICE' ? target.purpose : null,
        visitorName: cleanName(name), contactNo: contact.trim(),
        email: noEmail ? null : email.trim(), noEmail,
        idType, idTypeOther: idType === 'OTHER' ? idTypeOther.trim() : null,
        photoPath: photo.path, guardName,
        overnight, overnightReason: overnight ? reason.trim() : null,
      })
      if (r.request_id) notifyAsync('approval_request', r.request_id)
      show(`${cleanName(name)} checked in at ${fmtTime(r.check_in_at)}${r.request_id ? '. Overnight request sent.' : ''}`, 'success')
      addRecentTarget(target)
      lastTarget = target
      reset()
      topRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' })
      onCheckedIn?.(r)
    } catch (e) {
      setError(e.message)
      show(e.message, 'error', { duration: 6000 })
    } finally {
      setBusy(false)
    }
  }

  const buttonLabel = busy ? 'Checking in…' : uploading ? 'Uploading ID photo…' : missing.length ? `Check in · ${missing.length} missing` : 'Check in'
  const guard = layout === 'guard'

  return (
    <div ref={topRef} className="guard-form space-y-3 scroll-mt-20">
      <Card n={1} title="Visiting" refEl={refs.target} bad={bad('target')}>
        {lastTarget && !sameTarget(lastTarget, target) && (
          <button type="button" onClick={() => setTarget(lastTarget)}
            className="mb-2 max-w-full min-h-[48px] px-3 rounded-full border border-line bg-surface-2 text-[14px] text-ink-secondary flex items-center gap-2 hover:bg-surface-hover focus:outline-none focus-visible:ring-2 focus-visible:ring-navy-500">
            <Repeat size={14} className="shrink-0" /><span className="truncate">Same as last: {targetLabel(lastTarget)}</span>
          </button>
        )}
        <button type="button" onClick={() => setPickerOpen(true)}
          className="w-full min-h-[56px] px-4 rounded-xl border border-line bg-surface-2 flex items-center gap-3 text-left hover:bg-surface-hover focus:outline-none focus-visible:ring-2 focus-visible:ring-navy-500">
          <span className={`flex-1 min-w-0 text-[15px] break-words ${target ? 'text-ink font-medium' : 'text-ink-muted'}`}>
            {target ? targetLabel(target) : 'Choose tenant or office'}
          </span>
          <span className="text-[14px] font-semibold text-navy-600 shrink-0 flex items-center">{target ? 'Change' : ''}<ChevronRight size={18} /></span>
        </button>
      </Card>

      <Card n={2} title="Visitor" refEl={refs.visitor} bad={bad('visitor')}>
        <div className="space-y-3">
          <div className="fg">
            <label htmlFor="v-contact">Contact number</label>
            <input id="v-contact" type="tel" inputMode="tel" autoComplete="off" value={contact} maxLength={30}
              onChange={e => setContact(e.target.value)} placeholder="09XX XXX XXXX" className="!text-[16px] !py-3" />
          </div>
          {lookup && (lookup.filled.length > 0 || lookup.offer) && (
            <div className="p-3 rounded-xl bg-info-bg text-info-text border border-info-border text-[14px] space-y-2">
              <div className="flex items-start gap-2">
                <Info size={16} className="shrink-0 mt-0.5" />
                <span className="flex-1">
                  {lookup.filled.length > 0
                    ? `Returning visitor — details from ${fmtDate(lookup.r.last_visit_at)} filled in. Check them against the ID.`
                    : `Returning visitor — last visit ${fmtDate(lookup.r.last_visit_at)}.`}
                </span>
              </div>
              <div className="flex flex-wrap gap-2">
                {lookup.offer && <button type="button" onClick={applyLastDetails} className="btn secondary !min-h-[48px]">Use details from last visit</button>}
                {lookup.filled.length > 0 && <button type="button" onClick={clearLookup} className="btn secondary !min-h-[48px]">Clear</button>}
              </div>
            </div>
          )}
          <div className="fg">
            <label htmlFor="v-name">Full name</label>
            <input id="v-name" type="text" autoCapitalize="words" autoComplete="off" value={name} maxLength={100}
              onChange={e => setName(e.target.value)} placeholder="As shown on the ID" className="!text-[16px] !py-3" />
          </div>
          <div className="fg">
            <label htmlFor="v-email">Email</label>
            <input id="v-email" type="email" inputMode="email" autoComplete="off" value={email} disabled={noEmail} maxLength={254}
              onChange={e => setEmail(e.target.value)} placeholder={noEmail ? 'No email' : 'name@example.com'} className="!text-[16px] !py-3 disabled:opacity-60" />
          </div>
          {ALLOW_NO_EMAIL && (
            <label className="flex items-center gap-3 min-h-[48px] cursor-pointer text-[15px] text-ink">
              <input type="checkbox" className="w-5 h-5" checked={noEmail} onChange={e => { setNoEmail(e.target.checked); if (e.target.checked) setEmail('') }} />
              No email
            </label>
          )}
        </div>
      </Card>

      <Card n={3} title="ID" refEl={refs.id} bad={bad('id')}>
        <IdPhotoCapture photo={photo} setPhoto={setPhoto} idType={idType} setIdType={setIdType}
          idTypeOther={idTypeOther} setIdTypeOther={setIdTypeOther}
          missing={showMissing ? { idType: !idType, idTypeOther: idType && !otherOk, photo: photo.status !== 'ready' } : {}} />
      </Card>

      <section ref={refs.overnight} className={`bg-surface rounded-xl border p-4 space-y-3 scroll-mt-20 ${bad('overnight') ? 'border-danger-border ring-1 ring-danger-border' : 'border-line'}`}>
        <label className="flex items-center gap-3 min-h-[48px] cursor-pointer text-[15px] font-medium text-ink">
          <input type="checkbox" className="w-5 h-5" checked={overnight} onChange={e => setOvernight(e.target.checked)} />
          Staying overnight (after 10:00 PM)
        </label>
        {overnight && (
          <div className="fg">
            <label htmlFor="v-reason">Reason / relationship</label>
            <textarea id="v-reason" rows={2} maxLength={300} value={reason} onChange={e => setReason(e.target.value)}
              placeholder="e.g. Sister visiting from the province" className="!text-[16px]" />
          </div>
        )}
        {timeNote === 'warning' && (
          <div className="p-3 rounded-xl bg-warning-bg text-warning-text border border-warning-border text-[14px] flex items-start gap-2">
            <Clock size={16} className="shrink-0 mt-0.5" /> Cut-off at 10:00 PM. Request overnight or ask the visitor to leave by then.
          </div>
        )}
        {timeNote === 'danger' && (
          <div className="p-3 rounded-xl bg-danger-bg text-danger-text border border-danger-border text-[14px] flex items-start gap-2">
            <AlertTriangle size={16} className="shrink-0 mt-0.5" /> Past the 10:00 PM cut-off. This visitor needs overnight approval now.
          </div>
        )}
        <p className="text-[13px] text-ink-muted">Check-in time is recorded automatically. Recorded by: {recordedBy}.</p>
      </section>

      {showMissing && missing.length > 0 && (
        <div className="p-3 rounded-xl bg-danger-bg text-danger-text border border-danger-border text-[14px]" role="alert">
          Missing: {missing.map(m => m.label).join(', ')}
        </div>
      )}
      {error && <div className="p-3 rounded-xl bg-danger-bg text-danger-text border border-danger-border text-[14px]" role="alert">{error}</div>}

      <div className={guard ? 'fixed inset-x-0 z-20 bg-canvas border-t border-line' : 'sticky bottom-0 z-10 bg-canvas pt-2 pb-3'}
        style={guard ? { bottom: TABBAR_H } : undefined}>
        <div className={guard ? 'max-w-xl mx-auto px-3 py-2' : ''}>
          <button type="button" onClick={submit} disabled={busy || uploading} aria-disabled={missing.length > 0}
            className={`btn w-full !min-h-[52px] !text-[16px] ${missing.length ? 'secondary' : 'primary'}`}>
            {buttonLabel}
          </button>
        </div>
      </div>

      {pickerOpen && (
        <VisitTargetPicker initialPurpose={target?.kind === 'OFFICE' ? target.purpose : ''} onClose={() => setPickerOpen(false)}
          onPick={t => { setTarget(t); setPickerOpen(false) }} />
      )}
    </div>
  )
}
