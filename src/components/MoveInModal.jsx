import { useState, useEffect, useRef } from 'react'
import { LogIn, X, FileUp, CheckCircle, Wifi } from 'lucide-react'
import MultiEntryInput from './MultiEntryInput'
import ReceiptLinesInput from './ReceiptLinesInput'
import { PAYMENT_MODE_LABEL } from '../lib/supabase'
import {
  parseMoney, dbToCents, centsToInput, fmtCents, planDeposit, validateLines, nameMatches, blankLine, sumCents, refsOf,
} from '../lib/receiptLines'
import { isDriveConfigured, isDriveConnected, preloadDrive, connectDrive } from '../lib/googleDrive'

export const GENDER_OPTIONS = [
  { value: 'F', label: 'Female' },
  { value: 'M', label: 'Male' },
]

export const SOURCE_OPTIONS = [
  { value: 'REFERRAL',  label: 'Referral' },
  { value: 'FACEBOOK',  label: 'Facebook' },
  { value: 'TIKTOK',    label: 'TikTok' },
  { value: 'INSTAGRAM', label: 'Instagram' },
  { value: 'WALK_IN',   label: 'Walk-in' },
]

const DOC_SLOTS = [
  { docType: 'GOVT_ID',         label: 'Govt ID 1'      },
  { docType: 'GOVT_ID',         label: 'Govt ID 2'      },
  { docType: 'SIGNED_CONTRACT', label: 'Signed Contract' },
]

// Local calendar date (toISOString() is UTC, a day behind in the Philippines before 08:00).
function today() {
  const d = new Date()
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

function fmtDay(d) {
  if (!d) return '—'
  return new Date(d + 'T00:00:00').toLocaleDateString('en-PH', { month: 'short', day: 'numeric', year: 'numeric' })
}

function calcDuration(start, end) {
  if (!start || !end) return ''
  const s = new Date(start)
  const e = new Date(end)
  if (e <= s) return ''
  let years  = e.getFullYear() - s.getFullYear()
  let months = e.getMonth()    - s.getMonth()
  if (months < 0) { years--; months += 12 }
  const parts = []
  if (years  > 0) parts.push(`${years} year${years   !== 1 ? 's' : ''}`)
  if (months > 0) parts.push(`${months} month${months !== 1 ? 's' : ''}`)
  return parts.length ? parts.join(' ') : 'Less than 1 month'
}

export default function MoveInModal({
  bed, allBeds, onBedChange, onClose, onSubmit, saving,
  reservationPayments = [], reservationLoading = false, reservationError = '', otherReservedWithMoney = [],
}) {
  const [form, setForm] = useState({
    name: '', gender: '', rate: bed?.default_rate || '',
    move_in_date: today(), move_out_date: '',
    location_of_work: '', work_schedule: '',
    occupation: '', employer: '', employer_address: '', employer_contact_no: '',
    permanent_address: '',
    source: '',
    emergency_contact_name: '', emergency_contact_no: '',
    comments: '',
  })
  // null = follow the Rate field; a string = the user typed their own amount.
  const [dueText, setDueText] = useState({ advance: null, deposit: null })
  // Until the user edits a line amount, the first line follows the due amount; after that nothing auto-resizes.
  const [advLines, setAdvLines] = useState(() => [blankLine({ date: today() })])
  const [depLines, setDepLines] = useState(() => [blankLine({ date: today() })])
  const [touched,  setTouched]  = useState({ advance: false, deposit: false })
  const [nameAck,  setNameAck]  = useState(false)
  const [overAck,   setOverAck]   = useState(false)
  // Reservation payments typed at Move In (bed never reserved/recorded). Optional; not bed-bound client-side.
  const [resLines, setResLines] = useState([])
  const [contacts,   setContacts]   = useState([{ value: '', label: 'Mobile', isPrimary: true }])
  const [emails,     setEmails]     = useState([{ value: '', label: '', isPrimary: true }])
  const [docs,           setDocs]           = useState(DOC_SLOTS.map(s => ({ ...s, file: null })))
  const [formError,      setFormError]      = useState('')
  const [driveConnected, setDriveConnected] = useState(isDriveConnected)
  const [drivePreloaded, setDrivePreloaded] = useState(false)

  // Last name we auto-filled from a reservation; only replaced/cleared while the field still holds it.
  const prefilledName = useRef('')
  useEffect(() => {
    if (!bed) return
    const reserved = bed.status === 'RESERVED' ? (bed.reserved_name || '') : ''
    const previous = prefilledName.current
    prefilledName.current = reserved
    setForm(f => ({
      ...f,
      rate: bed.default_rate || '',
      name: f.name === '' || f.name === previous ? reserved : f.name,
    }))
  }, [bed])

  useEffect(() => {
    if (isDriveConfigured()) {
      preloadDrive().then(() => {
        setDrivePreloaded(true)
        setDriveConnected(isDriveConnected())
      }).catch(() => {})
    }
  }, [])

  const set = (k, v) => { setFormError(''); setForm(f => ({ ...f, [k]: v })) }

  function setDocFile(i, file) {
    setFormError('')
    setDocs(prev => prev.map((d, idx) => idx === i ? { ...d, file } : d))
  }

  const setDue = (k, v) => { setFormError(''); setDueText(u => ({ ...u, [k]: v })) }
  const advanceDueText = dueText.advance ?? String(form.rate ?? '')
  const depositDueText = dueText.deposit ?? String(form.rate ?? '')
  const advDueCents = parseMoney(advanceDueText)
  const depDueCents = parseMoney(depositDueText)

  const heldCents        = reservationPayments.reduce((sum, p) => sum + dbToCents(p.amount), 0)
  const newResCents      = sumCents(resLines)
  const reservationCents = heldCents + newResCents
  const existingRefs     = reservationPayments.map(p => p.ref_no).filter(Boolean)
  const allReservationRefs = [...existingRefs, ...refsOf(resLines)]
  const plan = planDeposit({ dueCents: depDueCents ?? 0, reservationCents })
  const overNeeded = plan.state === 'OVER' && newResCents > 0
  const possibleDuplicate = resLines.some(l => {
    const c = parseMoney(l.amount)
    return c != null && reservationPayments.some(p => dbToCents(p.amount) === c && p.received_date === l.date)
  })
  const reservedFor = reservationPayments[0]?.reserved_name || ''
  const nameMismatch = reservationPayments.length > 0 && reservedFor !== '' && form.name.trim() !== '' && !nameMatches(reservedFor, form.name)
  const otherBedWarning = reservationPayments.length === 0 && form.name.trim() !== ''
    ? otherReservedWithMoney.find(o => o.bed_id !== bed?.bed_id && nameMatches(o.reserved_name, form.name))
    : null

  // The tick only ever applies to the bed and payer name it was given for.
  useEffect(() => { setNameAck(false) }, [bed?.bed_id, reservedFor, form.name])
  useEffect(() => { setOverAck(false) }, [bed?.bed_id, form.name, reservationCents])

  const follow = (lines, isTouched, cents) => (isTouched ? lines : lines.map((l, i) =>
    i === 0 ? { ...l, amount: cents != null && cents > 0 ? centsToInput(cents) : '' } : l))
  const advShown = follow(advLines, touched.advance, advDueCents)
  const depShown = follow(depLines, touched.deposit, plan.shortfallCents)

  function changeLines(kind, next, shown, setLines) {
    setFormError('')
    if (next.length !== shown.length || next.some((l, i) => l.amount !== shown[i].amount)) {
      setTouched(t => ({ ...t, [kind]: true }))
    }
    setLines(next)
  }

  function handleSubmit(e) {
    e.preventDefault()
    setFormError('')

    if (reservationError) { setFormError(`Could not check this bed for reservation payments: ${reservationError}. Reselect the bed or reopen Move In.`); return }
    if (reservationLoading) { setFormError('Still checking this bed for reservation payments. Try again in a moment.'); return }
    if (advDueCents == null) { setFormError('Advance due must be an exact amount with at most 2 decimals (never rounded).'); return }
    if (depDueCents == null) { setFormError('Deposit due must be an exact amount with at most 2 decimals (never rounded).'); return }
    if (nameMismatch && !nameAck) {
      setFormError('Confirm that the reservation payment is being applied to a tenant with a different name.')
      return
    }

    if (overNeeded && !overAck) {
      setFormError(`Confirm that the reservation payment exceeds the deposit due by ${fmtCents(plan.overageCents)} and the surplus is returned on the final bill.`)
      return
    }

    const advLinesUsed = advDueCents > 0 ? advShown : []
    const depLinesUsed = plan.shortfallCents > 0 ? depShown : []
    const resErr = validateLines({ kind: 'RESERVATION', dueCents: null, lines: resLines, reservationRefs: existingRefs, maxDate: today() })
    const advErr = validateLines({ kind: 'ADVANCE', dueCents: advDueCents, lines: advLinesUsed, reservationRefs: allReservationRefs })
    const depErr = validateLines({ kind: 'DEPOSIT', dueCents: plan.shortfallCents, lines: depLinesUsed, reservationRefs: allReservationRefs })
    const errors = [...resErr.errors, ...advErr.errors, ...depErr.errors]
    if (errors.length) { setFormError(errors.join('\n')); return }

    const toLine = kind => l => ({
      kind,
      amountCents:  parseMoney(l.amount),
      paymentMode:  l.mode,
      refNo:        l.refNo.trim(),
      bankRef:      l.mode === 'BANK' ? l.bankRef.trim() : '',
      receivedDate: l.date,
    })
    onSubmit({
      ...form,
      duration: calcDuration(form.move_in_date, form.move_out_date),
      contacts, emails, docs,
      receipts: {
        advanceDueCents:          advDueCents,
        depositDueCents:          depDueCents,
        expectedReservationCents: heldCents,
        lines: [
          ...resLines.map(toLine('RESERVATION')),
          ...advLinesUsed.map(toLine('ADVANCE')),
          ...depLinesUsed.map(toLine('DEPOSIT')),
        ],
      },
    })
  }

  return (
    <div className="overlay" onClick={e => e.stopPropagation()}>
      <div className="modal">
        <div className="modal-head">
          <h3><span className="inline-flex items-center gap-1.5"><LogIn size={16} /> Move In New Tenant</span></h3>
          <button className="btn-close" onClick={onClose}><X size={16} /></button>
        </div>
        <form onSubmit={handleSubmit}>
          <div className="modal-body">
            <div className="form-grid">

              {/* ── Room & Bed ── */}
              <div className="form-section">Room & Bed</div>

              {allBeds && (
                <div className="fg full">
                  <label>Select Bed (Vacant or Reserved) *</label>
                  <select
                    value={bed?.bed_id || ''}
                    onChange={e => {
                      const b = allBeds.find(b => b.bed_id == e.target.value)
                      if (b && onBedChange) onBedChange(b)
                    }}
                    required
                  >
                    <option value="" disabled>Select…</option>
                    {allBeds.map(b => (
                      <option key={b.bed_id} value={b.bed_id}>
                        Room {b.room_no} · Bed {b.bed_letter} {b.bed_location ? `(${b.bed_location})` : ''} — {b.room_type}{b.status === 'RESERVED' ? ` — Reserved${b.reserved_name ? ` for ${b.reserved_name}` : ''}` : ''}
                      </option>
                    ))}
                  </select>
                </div>
              )}

              {!allBeds && bed && (
                <div className="fg full">
                  <label>Selected Bed</label>
                  <input type="text" readOnly
                    value={`Room ${bed.room_no} · Bed ${bed.bed_letter}${bed.bed_location ? ' (' + bed.bed_location + ')' : ''} — ${bed.room_type || ''}`}
                    className="bg-surface-2 text-ink-muted cursor-default"
                  />
                </div>
              )}

              <div className="fg full">
                <label>Rate (PHP) *</label>
                <input type="number" value={form.rate} onChange={e => set('rate', e.target.value)} required min="0" step="0.01" />
              </div>

              {/* ── Upfront payments ── */}
              <div className="form-section">Upfront Payments</div>

              <div className="fg full rounded-xl border border-line p-4 gap-3">
                <label>Reservation payment (optional)</label>
                <span className="text-[11px] text-ink-muted">
                  Money paid earlier to hold the bed, with its own T.R#. It is applied as part of the deposit. Required for each line: amount, mode, T.R# and the date it was received.
                </span>

                {reservationLoading && (
                  <span className="text-[12px] text-ink-muted">Checking this bed for reservation payments…</span>
                )}

                {reservationError && (
                  <span className="text-[12px] text-danger-text">Could not load reservation payments for this bed: {reservationError}</span>
                )}

                {reservationPayments.length > 0 && (
                  <div className="rounded-lg border border-info-border bg-info-bg text-info-text px-3 py-2 text-[12px] flex flex-col gap-1">
                    <div className="font-semibold">Reservation payment(s) already recorded on this bed (applied as deposit)</div>
                    {reservationPayments.map(p => (
                      <div key={p.id} className="flex flex-wrap justify-between gap-x-3">
                        <span>
                          {p.ref_no ? `TR# ${p.ref_no}` : 'No TR#'} · {fmtDay(p.received_date)} · {PAYMENT_MODE_LABEL[p.payment_mode] || p.payment_mode}
                          {p.bank_ref ? ` (${p.bank_ref})` : ''}{p.reserved_name ? ` · paid by ${p.reserved_name}` : ''}
                        </span>
                        <span className="font-semibold">{fmtCents(dbToCents(p.amount))}</span>
                      </div>
                    ))}
                  </div>
                )}

                {nameMismatch && (
                  <label className="flex items-start gap-2 rounded-lg border border-warning-border bg-warning-bg text-warning-text px-3 py-2 text-[12px] cursor-pointer">
                    <input type="checkbox" className="mt-0.5" checked={nameAck} onChange={e => { setFormError(''); setNameAck(e.target.checked) }} />
                    <span>Reservation was paid by <strong>{reservedFor}</strong>; apply to <strong>{form.name.trim()}</strong>. I confirm this is correct.</span>
                  </label>
                )}

                {otherBedWarning && (
                  <div className="rounded-lg border border-warning-border bg-warning-bg text-warning-text px-3 py-2 text-[12px]">
                    {otherBedWarning.reserved_name} has {fmtCents(otherBedWarning.totalCents)} of reservation payment on Room {otherBedWarning.room_no} Bed {otherBedWarning.bed_letter}.
                    Reservation money stays with that bed; select that bed to use it, or continue to collect the full deposit here.
                  </div>
                )}

                {resLines.length > 0 && (
                  <ReceiptLinesInput
                    refLabel="T.R# (Temporary Receipt)"
                    refRequired
                    dueCents={null}
                    minLines={0}
                    addLabel="Add another reservation payment"
                    lines={resLines}
                    defaultDate={today()}
                    onChange={next => { setFormError(''); setResLines(next) }}
                  />
                )}
                {resLines.length === 0 && (
                  <div>
                    <button type="button" className="btn-xs blue" onClick={() => { setFormError(''); setResLines([blankLine({ date: today() })]) }}>
                      + Add reservation payment
                    </button>
                  </div>
                )}

                {possibleDuplicate && (
                  <div className="rounded-lg border border-warning-border bg-warning-bg text-warning-text px-3 py-2 text-[12px]">
                    A reservation payment with the same amount and date is already recorded on this bed. Make sure you are not entering it twice.
                  </div>
                )}
              </div>

              <div className="fg full rounded-xl border border-line p-4 gap-3">
                <label>Advance due (PHP) *</label>
                <input type="text" inputMode="decimal" value={advanceDueText} onChange={e => setDue('advance', e.target.value)} required />
                {advDueCents > 0 && (
                  <ReceiptLinesInput
                    refLabel="S.I# (Sales Invoice)"
                    dueCents={advDueCents}
                    lines={advShown}
                    defaultDate={today()}
                    onChange={next => changeLines('advance', next, advShown, setAdvLines)}
                  />
                )}
              </div>

              <div className="fg full rounded-xl border border-line p-4 gap-3">
                <label>Deposit due (PHP) *</label>
                <input type="text" inputMode="decimal" value={depositDueText} onChange={e => setDue('deposit', e.target.value)} required />

                {depDueCents != null && reservationCents > 0 && (
                  <div className="rounded-lg border border-info-border bg-info-bg text-info-text px-3 py-2 text-[12px] flex flex-col gap-1">
                    <div className="font-semibold">
                      Deposit due {fmtCents(depDueCents)} - reservation {fmtCents(reservationCents)} = to collect now {fmtCents(plan.shortfallCents)}
                    </div>
                    {plan.state === 'FULL' && <div>Fully covered by reservation. The cashier collects no deposit.</div>}
                    {plan.state === 'OVER' && (
                      <div>
                        The reservation payment is {fmtCents(plan.overageCents)} more than the deposit due. The full {fmtCents(reservationCents)} stays
                        as the deposit and the surplus is returned through the final bill (Amount to be returned).
                      </div>
                    )}
                  </div>
                )}

                {overNeeded && (
                  <label className="flex items-start gap-2 rounded-lg border border-warning-border bg-warning-bg text-warning-text px-3 py-2 text-[12px] cursor-pointer">
                    <input type="checkbox" className="mt-0.5" checked={overAck} onChange={e => { setFormError(''); setOverAck(e.target.checked) }} />
                    <span>Reservation exceeds deposit due by {fmtCents(plan.overageCents)}; the surplus is returned on the final bill.</span>
                  </label>
                )}

                {depDueCents != null && plan.shortfallCents > 0 && (
                  <ReceiptLinesInput
                    refLabel="T.R# (Temporary Receipt)"
                    dueCents={plan.shortfallCents}
                    lines={depShown}
                    defaultDate={today()}
                    onChange={next => changeLines('deposit', next, depShown, setDepLines)}
                  />
                )}
              </div>

              {advDueCents != null && depDueCents != null && (
                <div className="fg full">
                  <div className="rounded-lg bg-surface-2 border border-line px-3.5 py-3 text-[12px] leading-relaxed text-ink-secondary">
                    Reservation held {fmtCents(heldCents)} (+ entered now {fmtCents(newResCents)}) · Advance {fmtCents(advDueCents)} ·
                    Deposit due {fmtCents(depDueCents)} = reservation {fmtCents(reservationCents)} + collected {fmtCents(plan.shortfallCents)}.
                    On file after Move In: advance {fmtCents(advDueCents)} + deposit {fmtCents(Math.max(depDueCents, reservationCents))}.
                  </div>
                </div>
              )}

              {/* ── Personal Info ── */}
              <div className="form-section">Personal Information</div>

              <div className="fg full">
                <label>Full Name *</label>
                <input type="text" value={form.name} onChange={e => set('name', e.target.value)} required placeholder="Last, First Middle" />
                {bed?.status === 'RESERVED' && bed.reserved_name && (
                  <span className="text-[11px] text-ink-muted mt-1">Reserved for {bed.reserved_name}</span>
                )}
              </div>
              <div className="fg">
                <label>Gender *</label>
                <select value={form.gender} onChange={e => set('gender', e.target.value)} required>
                  <option value="" disabled>Select…</option>
                  {GENDER_OPTIONS.map(o => (
                    <option key={o.value} value={o.value}>{o.label}</option>
                  ))}
                </select>
              </div>
              <div className="fg">
                <label>How did they find us?</label>
                <select value={form.source} onChange={e => set('source', e.target.value)}>
                  <option value="">Select source…</option>
                  {SOURCE_OPTIONS.map(o => (
                    <option key={o.value} value={o.value}>{o.label}</option>
                  ))}
                </select>
              </div>
              <div className="fg full">
                <label>Permanent Address</label>
                <input type="text" value={form.permanent_address} onChange={e => set('permanent_address', e.target.value)} placeholder="Street, Barangay, City, Province" />
              </div>

              {/* ── Contact Numbers ── */}
              <div className="form-section">Contact Numbers</div>
              <div className="fg full">
                <MultiEntryInput
                  entries={contacts}
                  onChange={v => { setFormError(''); setContacts(v) }}
                  placeholder="09xx-xxx-xxxx"
                  type="tel"
                  showLabel={false}
                />
              </div>

              {/* ── Emails ── */}
              <div className="form-section">Email Addresses</div>
              <div className="fg full">
                <MultiEntryInput
                  entries={emails}
                  onChange={v => { setFormError(''); setEmails(v) }}
                  placeholder="name@email.com"
                  type="email"
                  showLabel={false}
                />
              </div>

              {/* ── Lease Dates ── */}
              <div className="form-section">Lease Dates</div>
              <div className="fg">
                <label>Move In Date *</label>
                <input type="date" value={form.move_in_date} onChange={e => set('move_in_date', e.target.value)} required />
              </div>
              <div className="fg">
                <label>Move Out Date *</label>
                <input type="date" value={form.move_out_date} onChange={e => set('move_out_date', e.target.value)} required />
              </div>
              <div className="fg full">
                <label>Duration</label>
                <input
                  type="text"
                  readOnly
                  value={calcDuration(form.move_in_date, form.move_out_date) || '—'}
                  className="bg-surface-2 text-ink-muted cursor-default"
                />
              </div>

              {/* ── Work & Employer ── */}
              <div className="form-section">Work & Employment</div>

              <div className="fg">
                <label>Occupation</label>
                <input type="text" value={form.occupation} onChange={e => set('occupation', e.target.value)} placeholder="e.g. Software Engineer" />
              </div>
              <div className="fg">
                <label>Work Schedule</label>
                <input type="text" placeholder="Day / Night" value={form.work_schedule} onChange={e => set('work_schedule', e.target.value)} />
              </div>
              <div className="fg">
                <label>Employer / Company</label>
                <input type="text" value={form.employer} onChange={e => set('employer', e.target.value)} placeholder="e.g. Acme Corp" />
              </div>
              <div className="fg">
                <label>Employer Contact No</label>
                <input type="text" value={form.employer_contact_no} onChange={e => set('employer_contact_no', e.target.value)} />
              </div>
              <div className="fg full">
                <label>Location of Work</label>
                <input type="text" value={form.location_of_work} onChange={e => set('location_of_work', e.target.value)} placeholder="Office address or area" />
              </div>
              <div className="fg full">
                <label>Employer Address</label>
                <input type="text" value={form.employer_address} onChange={e => set('employer_address', e.target.value)} placeholder="Company address" />
              </div>

              {/* ── Government IDs & Contract ── */}
              <div className="form-section">Government IDs & Contract</div>

              {isDriveConfigured() && (
                <div className="fg full">
                  {driveConnected ? (
                    <div className="flex items-center gap-2 text-[12px] text-success-text bg-success-bg border border-success-border rounded-lg px-3 py-2">
                      <CheckCircle size={13} className="shrink-0" />
                      Google Drive connected — files will be uploaded automatically on submit.
                    </div>
                  ) : (
                    <div className="flex items-center gap-3 bg-warning-bg border border-warning-border rounded-lg px-3 py-2">
                      <Wifi size={13} className="shrink-0 text-amber-500" />
                      <span className="text-[12px] text-warning-text flex-1">Connect Google Drive to upload files to the tenant folder.</span>
                      <button
                        type="button"
                        disabled={!drivePreloaded}
                        className="shrink-0 text-[12px] font-semibold text-white bg-blue-600 hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed rounded-md px-2.5 py-1 transition-colors"
                        onClick={() => {
                          connectDrive()
                            .then(() => setDriveConnected(true))
                            .catch(e => setFormError(`Drive: ${e.message}`))
                        }}
                      >
                        {drivePreloaded ? 'Connect' : 'Loading…'}
                      </button>
                    </div>
                  )}
                </div>
              )}

              {docs.map((d, i) => (
                <div key={i} className="fg">
                  <label>{d.label}</label>
                  <div className="flex items-center gap-1.5">
                    <label className={`flex-1 flex items-center gap-2 px-2.5 py-1.5 text-[13px] rounded-lg border cursor-pointer transition-colors min-w-0 ${
                      d.file
                        ? 'border-emerald-300 bg-success-bg hover:bg-emerald-100'
                        : 'border-line bg-surface hover:bg-surface-2'
                    }`}>
                      <FileUp size={13} className={d.file ? 'text-emerald-500 shrink-0' : 'text-ink-faint shrink-0'} />
                      <span className={`truncate ${d.file ? 'text-emerald-800 font-medium' : 'text-ink-faint'}`}>
                        {d.file ? d.file.name : 'Choose file…'}
                      </span>
                      <input
                        type="file"
                        className="hidden"
                        accept="image/*,.pdf,.doc,.docx"
                        onChange={e => setDocFile(i, e.target.files?.[0] || null)}
                      />
                    </label>
                    {d.file && (
                      <button
                        type="button"
                        onClick={() => setDocFile(i, null)}
                        className="shrink-0 text-ink-faint hover:text-red-500 transition-colors"
                      >
                        <X size={14} />
                      </button>
                    )}
                  </div>
                </div>
              ))}

              {/* ── Emergency Contact ── */}
              <div className="form-section">Emergency Contact</div>

              <div className="fg">
                <label>Name</label>
                <input type="text" value={form.emergency_contact_name} onChange={e => set('emergency_contact_name', e.target.value)} />
              </div>
              <div className="fg">
                <label>Contact No</label>
                <input type="text" value={form.emergency_contact_no} onChange={e => set('emergency_contact_no', e.target.value)} />
              </div>

              <div className="fg full">
                <label>Comments</label>
                <textarea value={form.comments} onChange={e => set('comments', e.target.value)} placeholder="Optional notes…" />
              </div>

            </div>

            {formError && (
              <div className="mt-3 px-3 py-2.5 bg-danger-bg border border-danger-border rounded-xl text-[13px] text-danger-text flex items-start gap-2">
                <span className="shrink-0 mt-px">⚠</span>
                <span className="whitespace-pre-line">{formError}</span>
              </div>
            )}
          </div>

          <div className="modal-foot">
            <button type="button" className="btn secondary" onClick={onClose}>Cancel</button>
            <button type="submit" className="btn success" disabled={saving || reservationLoading}>
              {saving ? 'Saving…' : 'Confirm Move In'}
            </button>
          </div>
        </form>
      </div>
    </div>
  )
}
