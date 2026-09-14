import { useState, useEffect } from 'react'
import { LogIn, X, FileUp, CheckCircle, Wifi } from 'lucide-react'
import MultiEntryInput from './MultiEntryInput'
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

function today() { return new Date().toISOString().slice(0, 10) }

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

export default function MoveInModal({ bed, allBeds, onBedChange, onClose, onSubmit, saving }) {
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
  const [contacts,   setContacts]   = useState([{ value: '', label: 'Mobile', isPrimary: true }])
  const [emails,     setEmails]     = useState([{ value: '', label: '', isPrimary: true }])
  const [docs,           setDocs]           = useState(DOC_SLOTS.map(s => ({ ...s, file: null })))
  const [formError,      setFormError]      = useState('')
  const [driveConnected, setDriveConnected] = useState(isDriveConnected)
  const [drivePreloaded, setDrivePreloaded] = useState(false)

  useEffect(() => {
    if (bed) setForm(f => ({ ...f, rate: bed.default_rate || '' }))
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

  function handleSubmit(e) {
    e.preventDefault()
    setFormError('')

    // All 3 document slots are required
    const missingDocs = docs.filter(d => !d.file).map(d => d.label)
    if (missingDocs.length) {
      setFormError(`Please attach: ${missingDocs.join(', ')}`)
      return
    }

    onSubmit({ ...form, duration: calcDuration(form.move_in_date, form.move_out_date), contacts, emails, docs })
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
                  <label>Select Vacant Bed *</label>
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
                        Room {b.room_no} · Bed {b.bed_letter} {b.bed_location ? `(${b.bed_location})` : ''} — {b.room_type}
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
                    className="bg-slate-50 text-slate-500 cursor-default"
                  />
                </div>
              )}

              <div className="fg full">
                <label>Rate (PHP) *</label>
                <input type="number" value={form.rate} onChange={e => set('rate', e.target.value)} required min="0" step="0.01" />
              </div>

              {/* ── Personal Info ── */}
              <div className="form-section">Personal Information</div>

              <div className="fg full">
                <label>Full Name *</label>
                <input type="text" value={form.name} onChange={e => set('name', e.target.value)} required placeholder="Last, First Middle" />
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
                <label>How did they find us? *</label>
                <select value={form.source} onChange={e => set('source', e.target.value)} required>
                  <option value="" disabled>Select source…</option>
                  {SOURCE_OPTIONS.map(o => (
                    <option key={o.value} value={o.value}>{o.label}</option>
                  ))}
                </select>
              </div>
              <div className="fg full">
                <label>Permanent Address *</label>
                <input type="text" value={form.permanent_address} onChange={e => set('permanent_address', e.target.value)} required placeholder="Street, Barangay, City, Province" />
              </div>

              {/* ── Contact Numbers ── */}
              <div className="form-section">Contact Numbers *</div>
              <div className="fg full">
                <MultiEntryInput
                  entries={contacts}
                  onChange={v => { setFormError(''); setContacts(v) }}
                  placeholder="09xx-xxx-xxxx"
                  type="tel"
                  required
                  showLabel={false}
                />
              </div>

              {/* ── Emails ── */}
              <div className="form-section">Email Addresses *</div>
              <div className="fg full">
                <MultiEntryInput
                  entries={emails}
                  onChange={v => { setFormError(''); setEmails(v) }}
                  placeholder="name@email.com"
                  type="email"
                  required
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
                  className="bg-slate-50 text-slate-500 cursor-default"
                />
              </div>

              {/* ── Work & Employer ── */}
              <div className="form-section">Work & Employment</div>

              <div className="fg">
                <label>Occupation *</label>
                <input type="text" value={form.occupation} onChange={e => set('occupation', e.target.value)} required placeholder="e.g. Software Engineer" />
              </div>
              <div className="fg">
                <label>Work Schedule *</label>
                <input type="text" placeholder="Day / Night" value={form.work_schedule} onChange={e => set('work_schedule', e.target.value)} required />
              </div>
              <div className="fg">
                <label>Employer / Company *</label>
                <input type="text" value={form.employer} onChange={e => set('employer', e.target.value)} required placeholder="e.g. Acme Corp" />
              </div>
              <div className="fg">
                <label>Employer Contact No *</label>
                <input type="text" value={form.employer_contact_no} onChange={e => set('employer_contact_no', e.target.value)} required />
              </div>
              <div className="fg full">
                <label>Location of Work *</label>
                <input type="text" value={form.location_of_work} onChange={e => set('location_of_work', e.target.value)} required placeholder="Office address or area" />
              </div>
              <div className="fg full">
                <label>Employer Address *</label>
                <input type="text" value={form.employer_address} onChange={e => set('employer_address', e.target.value)} required placeholder="Company address" />
              </div>

              {/* ── Government IDs & Contract ── */}
              <div className="form-section">Government IDs & Contract *</div>

              {isDriveConfigured() && (
                <div className="fg full">
                  {driveConnected ? (
                    <div className="flex items-center gap-2 text-[12px] text-emerald-700 bg-emerald-50 border border-emerald-100 rounded-lg px-3 py-2">
                      <CheckCircle size={13} className="shrink-0" />
                      Google Drive connected — files will be uploaded automatically on submit.
                    </div>
                  ) : (
                    <div className="flex items-center gap-3 bg-amber-50 border border-amber-100 rounded-lg px-3 py-2">
                      <Wifi size={13} className="shrink-0 text-amber-500" />
                      <span className="text-[12px] text-amber-800 flex-1">Connect Google Drive to upload files to the tenant folder.</span>
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
                  <label>{d.label} *</label>
                  <div className="flex items-center gap-1.5">
                    <label className={`flex-1 flex items-center gap-2 px-2.5 py-1.5 text-[13px] rounded-lg border cursor-pointer transition-colors min-w-0 ${
                      d.file
                        ? 'border-emerald-300 bg-emerald-50 hover:bg-emerald-100'
                        : 'border-slate-200 bg-white hover:bg-slate-50'
                    }`}>
                      <FileUp size={13} className={d.file ? 'text-emerald-500 shrink-0' : 'text-slate-400 shrink-0'} />
                      <span className={`truncate ${d.file ? 'text-emerald-800 font-medium' : 'text-slate-400'}`}>
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
                        className="shrink-0 text-slate-400 hover:text-red-500 transition-colors"
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
                <label>Name *</label>
                <input type="text" value={form.emergency_contact_name} onChange={e => set('emergency_contact_name', e.target.value)} required />
              </div>
              <div className="fg">
                <label>Contact No *</label>
                <input type="text" value={form.emergency_contact_no} onChange={e => set('emergency_contact_no', e.target.value)} required />
              </div>

              <div className="fg full">
                <label>Comments</label>
                <textarea value={form.comments} onChange={e => set('comments', e.target.value)} placeholder="Optional notes…" />
              </div>

            </div>

            {formError && (
              <div className="mt-3 px-3 py-2.5 bg-red-50 border border-red-100 rounded-xl text-[13px] text-red-700 flex items-start gap-2">
                <span className="shrink-0 mt-px">⚠</span>
                {formError}
              </div>
            )}
          </div>

          <div className="modal-foot">
            <button type="button" className="btn secondary" onClick={onClose}>Cancel</button>
            <button type="submit" className="btn success" disabled={saving}>
              {saving ? 'Saving…' : 'Confirm Move In'}
            </button>
          </div>
        </form>
      </div>
    </div>
  )
}
