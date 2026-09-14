import { useState, useEffect, useMemo, useRef } from 'react'
import { AlertTriangle, Clock, Search, SearchX, UserPen } from 'lucide-react'
import { fetchTenants, fetchTenantContacts, fetchTenantEmails } from '../lib/supabase'
import { requestApproval, fetchPendingForEntity } from '../lib/approvals'
import {
  PROFILE_FIELDS, norm, entriesFromDb, diffEntries, applyTenantProfileChange,
} from '../lib/tenantProfile'
import { useAuth } from '../lib/auth'
import { useToast } from '../components/Toast'
import MultiEntryInput from '../components/MultiEntryInput'
import { GENDER_OPTIONS, SOURCE_OPTIONS } from '../components/MoveInModal'

// Only profile-related requests block a new submission; a pending room
// transfer is unrelated to these fields.
const PROFILE_REQUEST_FIELDS = ['tenant_profile', 'move_out_date']
const PENDING_LABELS = {
  tenant_profile: 'Profile change',
  move_out_date:  'Move-out date change',
}

function fmtDate(d) {
  if (!d) return '—'
  return new Date(d).toLocaleDateString('en-PH', { month: 'short', day: 'numeric', year: 'numeric' })
}

function fmtDateTime(d) {
  if (!d) return '—'
  return new Date(d).toLocaleString('en-PH', {
    month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit',
  })
}

function toRows(dbRows, legacyValue, defaultLabel) {
  if (dbRows.length) return entriesFromDb(dbRows)
  const legacy = norm(legacyValue)
  if (legacy) return [{ value: legacy, label: defaultLabel, isPrimary: true, _legacyValue: legacy }]
  return [{ value: '', label: defaultLabel, isPrimary: true }]
}

// A row pre-filled from the old single-value tenants.contact_no/email column
// isn't a user edit on its own; it only gets migrated when something else is saved.
function onlyUntouchedLegacy(d) {
  return d.removed.length === 0 && d.updated.length === 0 && d.added.length > 0 &&
    d.added.every(r => r._legacyValue != null && r.value === r._legacyValue)
}

function formFromTenant(t) {
  const f = Object.fromEntries(PROFILE_FIELDS.map(k => [k, norm(t[k]) ?? '']))
  f.move_out_date = t.move_out_date?.slice(0, 10) || ''
  return f
}

function snapshotEntries(rows) {
  return rows.map(r => ({ id: r.id, value: r.value, label: norm(r.label), isPrimary: !!r.isPrimary }))
}

function finalEntries(d) {
  return d.clean.map(r => ({ id: r.id ?? null, value: r.value, label: r.label, isPrimary: r === d.primary }))
}

export default function EditTenantProfile() {
  const { isAdmin } = useAuth()
  const { show, ToastEl } = useToast()

  const [tenants,    setTenants]    = useState([])
  const [loading,    setLoading]    = useState(true)
  const [query,      setQuery]      = useState('')
  const [sel,        setSel]        = useState(null)
  const [loadingSel, setLoadingSel] = useState(false)
  const [baseline,   setBaseline]   = useState(null)
  const [form,       setForm]       = useState(null)
  const [contacts,   setContacts]   = useState([])
  const [emails,     setEmails]     = useState([])
  const [reason,     setReason]     = useState('')
  const [error,      setError]      = useState('')
  const [busy,       setBusy]       = useState(false)
  const pickSeq = useRef(0)

  async function loadTenants() {
    try {
      const all = await fetchTenants()
      const active = all.filter(t => t.is_active === true).map(t => ({
        ...t,
        room_no:    t.beds?.rooms?.room_no ?? null,
        bed_letter: t.beds?.bed_letter     ?? null,
      }))
      setTenants(active)
      return active
    } catch (err) {
      show(err.message, 'error')
      return null
    }
  }

  useEffect(() => { loadTenants().then(() => setLoading(false)) }, [])

  const results = useMemo(() => {
    const q = query.trim().toLowerCase()
    return tenants
      .filter(t => !q
        || (t.name || '').toLowerCase().includes(q)
        || String(t.room_no ?? '').toLowerCase().includes(q))
      .sort((a, b) =>
        (parseInt(a.room_no) || 0) - (parseInt(b.room_no) || 0)
        || String(a.room_no ?? '').localeCompare(String(b.room_no ?? ''))
        || (a.bed_letter || '').localeCompare(b.bed_letter || ''))
  }, [tenants, query])

  async function pick(t) {
    const seq = ++pickSeq.current
    setSel(t)
    setError('')
    setLoadingSel(true)
    try {
      const [c, e, pending] = await Promise.all([
        fetchTenantContacts(t.id),
        fetchTenantEmails(t.id),
        fetchPendingForEntity('TENANT', String(t.id)),
      ])
      if (seq !== pickSeq.current) return
      const cRows = toRows(c, t.contact_no, 'Mobile')
      const eRows = toRows(e, t.email, '')
      setBaseline({
        tenant:   t,
        contacts: cRows.filter(r => r.id != null),
        emails:   eRows.filter(r => r.id != null),
        pending:  pending.filter(p => PROFILE_REQUEST_FIELDS.includes(p.field_name)),
      })
      setContacts(cRows)
      setEmails(eRows)
      setForm(formFromTenant(t))
      setReason('')
    } catch (err) {
      if (seq !== pickSeq.current) return
      setSel(null)
      setBaseline(null)
      setForm(null)
      show(err.message, 'error')
    } finally {
      if (seq === pickSeq.current) setLoadingSel(false)
    }
  }

  async function refresh(id) {
    const list = await loadTenants()
    if (!list) return
    const t = list.find(x => x.id === id)
    if (t) {
      await pick(t)
    } else {
      setSel(null)
      setBaseline(null)
      setForm(null)
    }
  }

  const set = (k, v) => { setError(''); setForm(f => ({ ...f, [k]: v })) }

  async function handleSave(e) {
    e.preventDefault()
    if (busy || !baseline) return
    setError('')
    const orig = baseline.tenant

    const name = norm(form.name)
    if (!name) { setError('Full name is required.'); return }
    const cd = diffEntries(baseline.contacts, contacts)
    const ed = diffEntries(baseline.emails, emails)
    if (!cd.clean.length) { setError('Please enter at least one contact number.'); return }
    const oldMoveOut     = orig.move_out_date?.slice(0, 10) || ''
    const newMoveOut     = form.move_out_date || ''
    const moveOutChanged = newMoveOut !== oldMoveOut

    const fieldChanges = {}
    for (const k of PROFILE_FIELDS) {
      const o = norm(orig[k])
      const n = norm(form[k])
      if (o !== n) fieldChanges[k] = { old: o, new: n }
    }
    const userEdited = Object.keys(fieldChanges).length > 0 || moveOutChanged ||
      (cd.changed && !onlyUntouchedLegacy(cd)) || (ed.changed && !onlyUntouchedLegacy(ed))
    if (!userEdited) {
      show('No changes to save.', 'success')
      return
    }

    if (!isAdmin) {
      if (baseline.pending.length) {
        setError('A change request for this tenant is already pending approval.')
        return
      }
      if (!reason.trim()) { setError('Please provide a reason for the change.'); return }

      const oldValue = { fields: Object.fromEntries(Object.entries(fieldChanges).map(([k, c]) => [k, c.old])) }
      const newValue = {
        _tenant_name: orig.name,
        _room_no:     orig.room_no,
        _bed_letter:  orig.bed_letter,
        fields:       Object.fromEntries(Object.entries(fieldChanges).map(([k, c]) => [k, c.new])),
      }
      if (moveOutChanged) {
        oldValue.move_out_date = oldMoveOut || null
        newValue.move_out_date = newMoveOut || null
      }
      if (cd.changed) {
        oldValue.contacts = snapshotEntries(baseline.contacts)
        newValue.contacts = finalEntries(cd)
      }
      if (ed.changed) {
        oldValue.emails = snapshotEntries(baseline.emails)
        newValue.emails = finalEntries(ed)
      }

      setBusy(true)
      try {
        await requestApproval({
          entityType: 'TENANT',
          entityId:   String(orig.id),
          fieldName:  'tenant_profile',
          oldValue,
          newValue,
          reason:     reason.trim(),
        })
      } catch (err) {
        const msg = `Approval request failed: ${err.message}`
        setError(msg)
        show(msg, 'error')
        setBusy(false)
        return
      }
      await refresh(orig.id)
      show('Changes sent for admin approval.', 'success')
      setBusy(false)
      return
    }

    setBusy(true)
    const { wrote, saveError, logError } = await applyTenantProfileChange(orig, {
      fields:      Object.fromEntries(Object.entries(fieldChanges).map(([k, c]) => [k, c.new])),
      moveOutDate: moveOutChanged ? (newMoveOut || null) : undefined,
      contacts:    cd.changed ? cd.clean : null,
      emails:      ed.changed ? ed.clean : null,
    })

    let msg = null
    if (saveError) {
      msg = wrote ? `Save failed partway (some changes were saved): ${saveError}` : saveError
      if (logError) msg += ` Activity log also failed: ${logError}`
    } else if (logError) {
      msg = `Saved, but activity log failed: ${logError}`
    }

    if (saveError && !wrote) {
      setError(msg)
      show(msg, 'error')
      setBusy(false)
      return
    }

    await refresh(orig.id)

    if (msg) {
      setError(msg)
      show(msg, 'error')
    } else {
      show('Profile saved.', 'success')
    }
    setBusy(false)
  }

  if (loading) return (
    <div className="loading-screen"><div className="spinner" /></div>
  )

  const ready = sel && baseline && form && !loadingSel && baseline.tenant.id === sel.id
  const origGender   = ready ? norm(baseline.tenant.gender) : null
  const legacyGender = origGender && !GENDER_OPTIONS.some(o => o.value === origGender) ? origGender : null
  const origSource   = ready ? norm(baseline.tenant.source) : null
  const pending      = ready ? baseline.pending : []
  const blocked      = !isAdmin && pending.length > 0

  return (
    <div className="page">
      <div className="page-header">
        <div>
          <h1 className="page-title">Edit Tenant Profile</h1>
          <p className="page-sub">Search an active tenant by name or room, then update their details.</p>
        </div>
      </div>

      <div className="grid gap-5 lg:grid-cols-[320px_1fr] items-start">
        {/* ── Search ── */}
        <div className="card p-3">
          <div className="relative mb-3">
            <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" />
            <input
              type="search" placeholder="Search name or room…"
              value={query} onChange={e => setQuery(e.target.value)}
              className="pl-9 pr-3 py-2 border border-slate-200 rounded-lg text-[13px] bg-white w-full
                         focus:outline-none focus:ring-2 focus:ring-navy-700/25 focus:border-navy-600 transition-colors"
            />
          </div>
          <div className="max-h-[70vh] overflow-y-auto space-y-0.5">
            {results.length === 0 ? (
              <div className="empty">
                <SearchX size={28} className="mx-auto mb-3 text-slate-300" />
                <p>No tenants found</p>
              </div>
            ) : results.map(t => (
              <button
                key={t.id}
                type="button"
                disabled={busy}
                onClick={() => pick(t)}
                className={`w-full text-left px-3 py-2 rounded-lg transition-colors disabled:cursor-not-allowed ${
                  sel?.id === t.id ? 'bg-navy-500/15' : 'hover:bg-slate-50'
                }`}
              >
                <div className="text-[13px] font-semibold text-slate-900 truncate">{t.name}</div>
                <div className="text-[11px] text-slate-500 mt-0.5">
                  Room {t.room_no ?? '—'} · Bed {t.bed_letter ?? '—'} · Move-out {fmtDate(t.move_out_date)}
                </div>
              </button>
            ))}
          </div>
        </div>

        {/* ── Form ── */}
        <div className="card p-5">
          {!sel ? (
            <div className="empty">
              <UserPen size={28} className="mx-auto mb-3 text-slate-300" />
              <p>Select a tenant to edit their profile.</p>
            </div>
          ) : !ready ? (
            <div className="flex justify-center py-14"><div className="spinner" /></div>
          ) : (
            <form onSubmit={handleSave}>
              <div className="bg-slate-50 border border-slate-100 rounded-xl px-4 py-3 text-[13px] mb-4">
                <div className="font-semibold text-slate-900">{baseline.tenant.name}</div>
                <div className="text-slate-500 mt-0.5">
                  Room {baseline.tenant.room_no ?? '—'} · Bed {baseline.tenant.bed_letter ?? '—'}
                </div>
              </div>

              {pending.length > 0 && (
                <div className="bg-amber-50 border border-amber-100 rounded-xl px-3 py-2.5 text-[12px] text-amber-800 flex items-start gap-2 mb-4">
                  <Clock size={13} className="shrink-0 mt-px" />
                  <div className="space-y-0.5">
                    {pending.map(p => (
                      <div key={p.id}>
                        <span className="font-semibold">Pending approval:</span>{' '}
                        {PENDING_LABELS[p.field_name] || p.field_name} requested by {p.requester_email || 'Unknown User'} on {fmtDateTime(p.created_at)}.
                      </div>
                    ))}
                    {blocked && <div>You can submit another change once this is approved or rejected.</div>}
                  </div>
                </div>
              )}

              {!isAdmin && (
                <div className="bg-amber-50 border border-amber-100 rounded-xl px-3 py-2.5 text-[12px] text-amber-800 flex items-start gap-2 mb-4">
                  <AlertTriangle size={13} className="shrink-0 mt-px" />
                  All changes require admin approval and will only apply once reviewed.
                </div>
              )}

              <div className="form-grid">
                {/* ── Personal Info ── */}
                <div className="form-section">Personal Information</div>

                <div className="fg full">
                  <label>Full Name *</label>
                  <input type="text" value={form.name} onChange={e => set('name', e.target.value)} required placeholder="Last, First Middle" />
                </div>
                <div className="fg">
                  <label>Gender</label>
                  <select value={form.gender} onChange={e => set('gender', e.target.value)}>
                    {!origGender && <option value="">Not set</option>}
                    {legacyGender && <option value={legacyGender}>{legacyGender}</option>}
                    {GENDER_OPTIONS.map(o => (
                      <option key={o.value} value={o.value}>{o.label}</option>
                    ))}
                  </select>
                </div>
                <div className="fg">
                  <label>How did they find us?</label>
                  <select value={form.source} onChange={e => set('source', e.target.value)}>
                    {!origSource && <option value="">Not set</option>}
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
                <div className="form-section">Contact Numbers *</div>
                <div className="fg full">
                  <MultiEntryInput
                    entries={contacts}
                    onChange={v => { setError(''); setContacts(v) }}
                    placeholder="09xx-xxx-xxxx"
                    type="tel"
                    required
                    showLabel={false}
                  />
                </div>

                {/* ── Emails ── */}
                <div className="form-section">Email Addresses</div>
                <div className="fg full">
                  <MultiEntryInput
                    entries={emails}
                    onChange={v => { setError(''); setEmails(v) }}
                    placeholder="name@email.com"
                    type="email"
                    showLabel={false}
                  />
                </div>

                {/* ── Lease Dates ── */}
                <div className="form-section">Lease Dates</div>
                <div className="fg full">
                  <label>Planned Move-out Date</label>
                  <input type="date" value={form.move_out_date} onChange={e => set('move_out_date', e.target.value)} />
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

                {!isAdmin && (
                  <>
                    <div className="form-section">Approval</div>
                    <div className="fg full">
                      <label>Reason for change <span className="text-red-600">*</span></label>
                      <textarea rows={2} value={reason}
                        onChange={e => { setError(''); setReason(e.target.value) }}
                        placeholder="Briefly describe why this is being updated…" />
                    </div>
                  </>
                )}
              </div>

              {error && (
                <div className="mt-4 px-3 py-2.5 bg-red-50 border border-red-100 rounded-xl text-[13px] text-red-700 flex items-start gap-2">
                  <AlertTriangle size={13} className="shrink-0 mt-px" />
                  {error}
                </div>
              )}

              <div className="flex justify-end gap-2 mt-5">
                <button type="submit" className="btn primary" disabled={busy || blocked}>
                  {busy
                    ? (isAdmin ? 'Saving…' : 'Submitting…')
                    : (isAdmin ? 'Save Changes' : 'Submit for Approval')}
                </button>
              </div>
            </form>
          )}
        </div>
      </div>

      {ToastEl}
    </div>
  )
}
