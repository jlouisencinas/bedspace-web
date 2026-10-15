import { useState, useEffect, useRef } from 'react'
import {
  fetchPayments, fetchTicketsForTenant, fetchTenantContacts, fetchTenantEmails,
  fetchTenantDocuments, addTenantDocument, deleteTenantDocument, fetchTenantHistory,
  fetchTenantDeposits, addTenantDeposit, updateTenantDeposit, DEPOSIT_KIND_LABEL, DEPOSIT_REF_LABEL,
  fetchFinalBills, voidFinalBill,
} from '../lib/supabase'
import { Link } from 'react-router-dom'
import { getOrCreateTenantFolder, uploadFileToDrive, isDriveConfigured, isDriveConnected, preloadDrive, connectDrive } from '../lib/googleDrive'
import { useAuth } from '../lib/auth'
import { useToast } from './Toast'
import { GENDER_OPTIONS, SOURCE_OPTIONS } from './MoveInModal'
import {
  CreditCard, LogOut, AlertTriangle, X,
  Phone, Mail, Trash2, FileUp, ExternalLink, FileText, ArrowRightLeft, History, Pencil,
} from 'lucide-react'

const PROFILE_TABS = [
  { id: 'overview',   label: 'Overview'   },
  { id: 'contacts',   label: 'Contacts'   },
  { id: 'documents',  label: 'Documents'  },
  { id: 'payments',   label: 'Payments'   },
  { id: 'advance',    label: 'Advance & Deposit' },
  { id: 'tickets',    label: 'Tickets'    },
  { id: 'history',    label: 'History'    },
]

const HISTORY_COLORS = {
  'Move In':                 'bg-emerald-500',
  'Move Out':                'bg-slate-400',
  'Room Transfer':           'bg-blue-500',
  'Ticket Raised':           'bg-amber-500',
  'Ticket Resolved':         'bg-emerald-400',
  'Bed Status Changed':      'bg-slate-300',
  'Approval Requested':      'bg-amber-400',
  'Approval Approved':       'bg-emerald-400',
  'Approval Rejected':       'bg-red-400',
  'Tenant Profile Updated':  'bg-blue-400',
  'Move-out Date Changed':   'bg-amber-300',
  'Tenant Move-in Date Corrected': 'bg-amber-300',
}

const DOC_TYPES = [
  { value: 'GOVT_ID',          label: 'Government ID'   },
  { value: 'SIGNED_CONTRACT',  label: 'Signed Contract' },
  { value: 'OTHER',            label: 'Other'           },
]

const DOC_TYPE_COLORS = {
  GOVT_ID:         'bg-info-bg text-info-text',
  SIGNED_CONTRACT: 'bg-success-bg text-success-text',
  OTHER:           'bg-surface-3 text-ink-secondary',
}

const DEPOSIT_STATUS_COLORS = {
  HELD:      'bg-info-bg text-info-text',
  APPLIED:   'bg-success-bg text-success-text',
  FORFEITED: 'bg-danger-bg text-danger-text',
  REFUNDED:  'bg-surface-3 text-ink-secondary',
}

function money(n) {
  return '₱' + Number(n).toLocaleString('en-PH', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
}
function fmt(n)      { return n ? '₱' + Number(n).toLocaleString('en-PH') : '—' }
function fmtDate(d)  {
  if (!d) return '—'
  return new Date(d).toLocaleDateString('en-PH', { month: 'short', day: 'numeric', year: 'numeric' })
}
function fmtSize(b)  {
  if (!b) return ''
  if (b < 1024)    return `${b} B`
  if (b < 1048576) return `${(b / 1024).toFixed(1)} KB`
  return `${(b / 1048576).toFixed(1)} MB`
}

// Parent owns what happens when each footer button is clicked (opens its own
// modal state) — this component just calls the callback.
export default function TenantProfileModal({ tenant, onClose, onTransfer, onMoveOut, onCorrectRate, onCorrectMoveIn }) {
  const { isAdmin, user } = useAuth()
  const docFileRef = useRef(null)
  const { show, ToastEl } = useToast()

  const [profileTab,    setProfileTab]    = useState('overview')
  const [detailPays,    setDetailPays]    = useState([])
  const [detailTickets, setDetailTickets] = useState([])
  const [detailContacts,setDetailContacts]= useState([])
  const [detailEmails,  setDetailEmails]  = useState([])
  const [detailDocs,    setDetailDocs]    = useState([])
  const [detailHistory, setDetailHistory] = useState([])
  const [detailDeposits,setDetailDeposits]= useState([])
  const [detailBills,   setDetailBills]   = useState([])
  const [voidId,        setVoidId]        = useState(null)
  const [voidReason,    setVoidReason]    = useState('')
  const [billBusy,      setBillBusy]      = useState(false)
  const [depLoadError,  setDepLoadError]  = useState('')
  const [depEditId,     setDepEditId]     = useState(null)
  const [depForm,       setDepForm]       = useState(null)
  const [depSaving,     setDepSaving]     = useState(false)

  const [docUploading,   setDocUploading]   = useState(false)
  const [newDocType,     setNewDocType]     = useState('GOVT_ID')
  const [driveConnected, setDriveConnected] = useState(isDriveConnected)
  const [drivePreloaded, setDrivePreloaded] = useState(false)

  useEffect(() => {
    let cancelled = false
    setProfileTab('overview')
    setDetailPays([])
    setDetailTickets([])
    setDetailContacts([])
    setDetailEmails([])
    setDetailDocs([])
    setDetailHistory([])
    setDetailDeposits([])
    setDetailBills([])
    setVoidId(null)
    setDepLoadError('')
    setDepEditId(null)
    setDepForm(null)

    async function load() {
      const results = await Promise.allSettled([
        fetchPayments(tenant.id),
        fetchTicketsForTenant(tenant.id),
        fetchTenantContacts(tenant.id),
        fetchTenantEmails(tenant.id),
        fetchTenantDocuments(tenant.id),
        fetchTenantHistory(tenant.id),
        fetchTenantDeposits(tenant.id),
        fetchFinalBills(tenant.id),
      ])
      if (cancelled) return
      if (results[0].status === 'fulfilled') setDetailPays(results[0].value)
      if (results[1].status === 'fulfilled') setDetailTickets(results[1].value)
      if (results[2].status === 'fulfilled') setDetailContacts(results[2].value)
      if (results[3].status === 'fulfilled') setDetailEmails(results[3].value)
      if (results[4].status === 'fulfilled') setDetailDocs(results[4].value)
      if (results[5].status === 'fulfilled') setDetailHistory(results[5].value)
      if (results[6].status === 'fulfilled') setDetailDeposits(results[6].value)
      else setDepLoadError(results[6].reason?.message || 'unknown error')
      if (results[7].status === 'fulfilled') setDetailBills(results[7].value)
    }
    load()
    return () => { cancelled = true }
  }, [tenant.id])

  // Preload Drive only when the Documents tab is opened (avoids Google popup on every View click)
  useEffect(() => {
    if (profileTab === 'documents' && isDriveConfigured()) {
      preloadDrive().then(() => {
        setDrivePreloaded(true)
        setDriveConnected(isDriveConnected())
      }).catch(() => {})
    }
  }, [profileTab])

  // ── Document handlers ─────────────────────────────────────────────────────────

  async function handleDocFileSelect(e) {
    const file = e.target.files?.[0]
    if (!file) return
    docFileRef.current.value = ''
    setDocUploading(true)
    try {
      const folderId  = await getOrCreateTenantFolder(tenant.name, tenant.room_no)
      const driveFile = await uploadFileToDrive(file, folderId)
      const row = await addTenantDocument(tenant.id, {
        docType:     newDocType,
        filename:    file.name,
        driveFileId: driveFile.id,
        driveUrl:    driveFile.webViewLink,
        sizeBytes:   driveFile.size ? Number(driveFile.size) : null,
      })
      setDetailDocs(prev => [row, ...prev])
      show('Document uploaded.', 'success')
    } catch(e) { show(e.message, 'error') }
    setDocUploading(false)
  }

  async function handleDeleteDoc(id) {
    try {
      await deleteTenantDocument(id)
      setDetailDocs(prev => prev.filter(d => d.id !== id))
    } catch(e) { show(e.message, 'error') }
  }

  // ── Advance & Deposit handlers ────────────────────────────────────────────────

  function startEditDeposit(d) {
    setDepEditId(d.id)
    setDepForm({ amount: String(d.amount), ref_no: d.ref_no || '', received_date: d.received_date || '', notes: d.notes || '' })
  }

  function startAddDeposit() {
    setDepEditId('new')
    setDepForm({ kind: 'DEPOSIT', amount: '', ref_no: '', received_date: new Date().toISOString().slice(0, 10), notes: '' })
  }

  function cancelDepositForm() { setDepEditId(null); setDepForm(null) }

  async function saveDeposit(e) {
    e.preventDefault()
    setDepSaving(true)
    try {
      if (depEditId === 'new') {
        const row = await addTenantDeposit({
          tenantId: tenant.id, kind: depForm.kind, amount: depForm.amount,
          refNo: depForm.ref_no, receivedDate: depForm.received_date, notes: depForm.notes,
        }, user?.id)
        setDetailDeposits(prev => [...prev, row])
        show('Receipt added.', 'success')
      } else {
        const row = await updateTenantDeposit(depEditId, {
          amount: depForm.amount, ref_no: depForm.ref_no,
          received_date: depForm.received_date, notes: depForm.notes,
        }, user?.id)
        setDetailDeposits(prev => prev.map(d => d.id === row.id ? row : d))
        show('Receipt updated.', 'success')
      }
      cancelDepositForm()
    } catch(err) { show(err.message, 'error') }
    setDepSaving(false)
  }

  async function doVoidBill() {
    setBillBusy(true)
    try {
      await voidFinalBill(voidId, voidReason, user?.id)
      const [bills, deps] = await Promise.all([fetchFinalBills(tenant.id), fetchTenantDeposits(tenant.id)])
      setDetailBills(bills); setDetailDeposits(deps)
      setVoidId(null); setVoidReason('')
      show('Final bill voided. Its advance/deposit receipts are HELD again.', 'success')
    } catch(err) { show(err.message, 'error') }
    setBillBusy(false)
  }

  const heldTotal = kind => detailDeposits
    .filter(d => d.kind === kind && d.status === 'HELD')
    .reduce((sum, d) => sum + Number(d.amount), 0)

  return (
    <div className="overlay" onClick={e => e.stopPropagation()}>
      <div className="modal" style={{ maxWidth: '680px' }}>
        {/* Header */}
        <div className="modal-head">
          <div className="flex items-center gap-3">
            <div className="w-9 h-9 rounded-full bg-navy-500/15 text-navy-600 flex items-center justify-center text-[13px] font-bold shrink-0">
              {tenant.name.slice(0, 2).toUpperCase()}
            </div>
            <div>
              <h3 className="text-[15px] font-semibold text-ink">{tenant.name}</h3>
              <div className="text-[11px] text-ink-faint font-normal mt-0.5">
                Room {tenant.room_no} · Bed {tenant.bed_letter}
                {tenant.bed_location && ` (${tenant.bed_location})`}
                {' · '}{fmt(tenant.rate)}/mo
              </div>
            </div>
          </div>
          <button className="btn-close" onClick={onClose}><X size={16} /></button>
        </div>

        {/* Tab bar */}
        <div className="flex gap-0 px-4" style={{ borderBottom: '1px solid var(--border)' }}>
          {PROFILE_TABS.map(t => (
            <button
              key={t.id}
              onClick={() => setProfileTab(t.id)}
              className={`px-3 py-2 text-[12px] font-medium border-b-2 -mb-px transition-colors ${
                profileTab === t.id
                  ? 'border-navy-500 text-navy-700 font-semibold'
                  : 'border-transparent text-ink-muted hover:text-ink-secondary'
              }`}
            >
              {t.label}
              {t.id === 'payments'  && detailPays.length    > 0 && <span className="ml-1 text-[10px] text-ink-faint">{detailPays.length}</span>}
              {t.id === 'tickets'   && detailTickets.length  > 0 && <span className="ml-1 text-[10px] text-ink-faint">{detailTickets.length}</span>}
              {t.id === 'advance'   && detailDeposits.length > 0 && <span className="ml-1 text-[10px] text-ink-faint">{detailDeposits.length}</span>}
              {t.id === 'documents' && detailDocs.length     > 0 && <span className="ml-1 text-[10px] text-ink-faint">{detailDocs.length}</span>}
              {t.id === 'history'   && detailHistory.length  > 0 && <span className="ml-1 text-[10px] text-ink-faint">{detailHistory.length}</span>}
            </button>
          ))}
        </div>

        {/* Tab body */}
        <div className="modal-body">

          {/* ── Overview ── */}
          {profileTab === 'overview' && (
            <>
              {[
                ['Room',             `${tenant.room_no} · Bed ${tenant.bed_letter}${tenant.bed_location ? ` (${tenant.bed_location})` : ''}`],
                ['Room Type',        tenant.room_type],
                ['Rate',             fmt(tenant.rate)],
                ['Gender',           GENDER_OPTIONS.find(g => g.value === tenant.gender)?.label ?? tenant.gender],
                ['Source',           SOURCE_OPTIONS.find(s => s.value === tenant.source)?.label ?? tenant.source],
                ['Duration',         tenant.duration],
                ['Move In',          fmtDate(tenant.move_in_date)],
                ['Move Out',         fmtDate(tenant.move_out_date)],
                ['Permanent Address',tenant.permanent_address],
                ['Occupation',       tenant.occupation],
                ['Employer',         tenant.employer],
                ['Employer Address', tenant.employer_address],
                ['Employer Tel',     tenant.employer_contact_no],
                ['Location of Work', tenant.location_of_work],
                ['Work Schedule',    tenant.work_schedule],
                ['Emergency Name',   tenant.emergency_contact_name],
                ['Emergency No',     tenant.emergency_contact_no],
                ['Comments',         tenant.comments],
              ].filter(([, v]) => v).map(([l, v]) => (
                <div key={l} className="detail-row">
                  <div className="detail-label">{l}</div>
                  <div className="detail-value flex items-center gap-2">
                    {v}
                    {l === 'Rate' && tenant.is_active && onCorrectRate && (
                      <button
                        className="btn-xs blue inline-flex items-center gap-1"
                        onClick={() => onCorrectRate(tenant)}
                      >
                        <Pencil size={10} /> Correct
                      </button>
                    )}
                    {l === 'Move In' && tenant.is_active && isAdmin && onCorrectMoveIn && (
                      <button
                        className="btn-xs blue inline-flex items-center gap-1"
                        onClick={() => onCorrectMoveIn(tenant)}
                      >
                        <Pencil size={10} /> Correct
                      </button>
                    )}
                  </div>
                </div>
              ))}
              {/* Quick contact summary if available */}
              {(detailContacts.length > 0 || detailEmails.length > 0) && (
                <div className="mt-3 pt-3" style={{ borderTop: '1px solid var(--border)' }}>
                  <div className="text-[10px] font-bold text-ink-faint uppercase tracking-widest mb-2">Contact</div>
                  {detailContacts.filter(c => c.is_primary).map(c => (
                    <div key={c.id} className="flex items-center gap-2 text-[13px] text-ink-secondary mb-1">
                      <Phone size={12} className="text-ink-faint shrink-0" />
                      {c.value}
                      {c.label && <span className="text-[11px] text-ink-faint">{c.label}</span>}
                    </div>
                  ))}
                  {detailEmails.filter(e => e.is_primary).map(e => (
                    <div key={e.id} className="flex items-center gap-2 text-[13px] text-ink-secondary mb-1">
                      <Mail size={12} className="text-ink-faint shrink-0" />
                      {e.value}
                      {e.label && <span className="text-[11px] text-ink-faint">{e.label}</span>}
                    </div>
                  ))}
                </div>
              )}
            </>
          )}

          {/* ── Contacts ── */}
          {profileTab === 'contacts' && (
            <div className="space-y-5">
              {/* Phone numbers */}
              <div>
                <div className="text-[10px] font-bold text-ink-faint uppercase tracking-widest mb-3 flex items-center gap-1.5">
                  <Phone size={11} /> Phone Numbers
                </div>
                {detailContacts.length === 0 ? (
                  <p className="text-[13px] text-ink-faint italic">No contacts on file.</p>
                ) : (
                  <div className="space-y-1">
                    {detailContacts.map(c => (
                      <div key={c.id} className="flex items-center gap-2 py-1.5">
                        <Phone size={12} className="text-ink-faint shrink-0" />
                        <span className="text-[13px] text-ink flex-1">{c.value}</span>
                        {c.label && (
                          <span className="text-[11px] text-ink-muted bg-surface-3 px-1.5 py-0.5 rounded">{c.label}</span>
                        )}
                        {c.is_primary && (
                          <span className="text-[10px] font-bold text-navy-600 bg-navy-50 border border-navy-100 px-1.5 py-0.5 rounded">Primary</span>
                        )}
                      </div>
                    ))}
                  </div>
                )}
              </div>

              {/* Emails */}
              <div>
                <div className="text-[10px] font-bold text-ink-faint uppercase tracking-widest mb-3 flex items-center gap-1.5">
                  <Mail size={11} /> Email Addresses
                </div>
                {detailEmails.length === 0 ? (
                  <p className="text-[13px] text-ink-faint italic">No emails on file.</p>
                ) : (
                  <div className="space-y-1">
                    {detailEmails.map(e => (
                      <div key={e.id} className="flex items-center gap-2 py-1.5">
                        <Mail size={12} className="text-ink-faint shrink-0" />
                        <span className="text-[13px] text-ink flex-1">{e.value}</span>
                        {e.label && (
                          <span className="text-[11px] text-ink-muted bg-surface-3 px-1.5 py-0.5 rounded">{e.label}</span>
                        )}
                        {e.is_primary && (
                          <span className="text-[10px] font-bold text-navy-600 bg-navy-50 border border-navy-100 px-1.5 py-0.5 rounded">Primary</span>
                        )}
                      </div>
                    ))}
                  </div>
                )}
              </div>

              <p className="text-[11px] text-ink-faint pt-3" style={{ borderTop: '1px solid var(--border-lite)' }}>
                Edit contacts in Edit Tenant Profile.
              </p>
            </div>
          )}

          {/* ── Documents ── */}
          {profileTab === 'documents' && (
            <div>
              {/* Upload row */}
              {!isDriveConfigured() ? (
                <div className="text-[12px] text-warning-text bg-warning-bg border border-warning-border rounded-lg px-3 py-2.5 flex items-start gap-2 mb-4">
                  <AlertTriangle size={13} className="text-amber-500 shrink-0 mt-px" />
                  Google Drive not configured. Add <code className="font-mono">VITE_GOOGLE_API_KEY</code>,{' '}
                  <code className="font-mono">VITE_GOOGLE_CLIENT_ID</code>, and{' '}
                  <code className="font-mono">VITE_GOOGLE_DRIVE_PARENT_FOLDER_ID</code> to your .env file.
                </div>
              ) : !driveConnected ? (
                <div className="flex items-center gap-3 mb-4 pb-4 bg-warning-bg border border-warning-border rounded-lg px-3 py-2.5" style={{ borderBottom: '1px solid var(--border-lite)' }}>
                  <AlertTriangle size={13} className="text-amber-500 shrink-0" />
                  <span className="text-[12px] text-warning-text flex-1">Connect Google Drive to upload documents.</span>
                  <button
                    className="shrink-0 btn-xs blue"
                    disabled={!drivePreloaded}
                    onClick={() => {
                      connectDrive()
                        .then(() => setDriveConnected(true))
                        .catch(e => show(e.message, 'error'))
                    }}
                  >
                    {drivePreloaded ? 'Connect Google Drive' : 'Loading…'}
                  </button>
                </div>
              ) : (
                <div className="flex items-center gap-2 mb-4 pb-4" style={{ borderBottom: '1px solid var(--border-lite)' }}>
                  <select
                    value={newDocType}
                    onChange={e => setNewDocType(e.target.value)}
                    className="px-2.5 py-1.5 text-[13px] rounded-lg border border-line bg-surface focus:outline-none focus:ring-2 focus:ring-navy-700/25 transition-colors"
                  >
                    {DOC_TYPES.map(dt => (
                      <option key={dt.value} value={dt.value}>{dt.label}</option>
                    ))}
                  </select>
                  <label
                    className={`btn-xs blue cursor-pointer inline-flex items-center gap-1 ${docUploading ? 'opacity-50 pointer-events-none' : ''}`}
                  >
                    {docUploading
                      ? <><span className="w-3 h-3 border-2 border-current border-t-transparent rounded-full animate-spin" /> Uploading…</>
                      : <><FileUp size={11} /> Upload to Drive</>
                    }
                    <input
                      ref={docFileRef}
                      type="file"
                      className="hidden"
                      accept="image/*,.pdf,.doc,.docx,.jpg,.jpeg,.png"
                      onChange={handleDocFileSelect}
                      disabled={docUploading}
                    />
                  </label>
                  <span className="text-[11px] text-ink-faint">
                    Folder: Room {tenant.room_no} - {tenant.name}
                  </span>
                </div>
              )}

              {/* Document list */}
              {detailDocs.length === 0 ? (
                <div className="text-center py-6">
                  <FileText size={28} className="mx-auto mb-2 text-ink-faint" />
                  <p className="text-[13px] text-ink-faint">No documents uploaded yet.</p>
                </div>
              ) : (
                <div className="space-y-2">
                  {detailDocs.map(d => (
                    <div key={d.id} className="flex items-center gap-3 p-3 rounded-xl bg-surface-2 hover:bg-surface-3 transition-colors group/doc">
                      <FileText size={18} className="text-ink-faint shrink-0" />
                      <div className="flex-1 min-w-0">
                        <div className="text-[13px] font-medium text-ink truncate">{d.filename}</div>
                        <div className="flex items-center gap-2 mt-0.5">
                          <span className={`text-[10px] font-bold px-1.5 py-0.5 rounded ${DOC_TYPE_COLORS[d.doc_type] || DOC_TYPE_COLORS.OTHER}`}>
                            {DOC_TYPES.find(t => t.value === d.doc_type)?.label || d.doc_type}
                          </span>
                          {d.size_bytes && <span className="text-[11px] text-ink-faint">{fmtSize(d.size_bytes)}</span>}
                          <span className="text-[11px] text-ink-faint">{fmtDate(d.uploaded_at)}</span>
                        </div>
                      </div>
                      <div className="flex items-center gap-1.5 shrink-0">
                        <a
                          href={d.drive_url}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="btn-xs blue inline-flex items-center gap-1"
                        >
                          <ExternalLink size={10} /> View
                        </a>
                        {isAdmin && (
                          <button
                            onClick={() => handleDeleteDoc(d.id)}
                            className="btn-xs red opacity-0 group-hover/doc:opacity-100 transition-opacity"
                          >
                            <Trash2 size={10} /> Remove
                          </button>
                        )}
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}

          {/* ── Payments ── */}
          {profileTab === 'payments' && (
            detailPays.length === 0 ? (
              <div className="text-center py-6">
                <CreditCard size={28} className="mx-auto mb-2 text-ink-faint" />
                <p className="text-[13px] text-ink-faint">No payments recorded yet.</p>
              </div>
            ) : (
              <table className="payments-table">
                <thead><tr><th>Date</th><th>Type</th><th>Amount</th><th>Notes</th></tr></thead>
                <tbody>
                  {detailPays.map(p => (
                    <tr key={p.id}>
                      <td>{fmtDate(p.payment_date)}</td>
                      <td>{p.pay_type}</td>
                      <td>{'₱' + Number(p.amount).toLocaleString('en-PH', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</td>
                      <td className="text-ink-muted">{p.notes || '—'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )
          )}

          {/* ── Advance & Deposit ── */}
          {profileTab === 'advance' && (
            <div>
              {depLoadError && (
                <div className="text-[12px] text-danger-text bg-danger-bg border border-danger-border rounded-lg px-3 py-2.5 mb-3">
                  Could not load advance/deposit records: {depLoadError}
                </div>
              )}

              {!depLoadError && (
                <div className="grid grid-cols-3 gap-2 mb-4">
                  {[
                    ['Advance held', heldTotal('ADVANCE')],
                    ['Deposit held', heldTotal('DEPOSIT')],
                    ['Total held',   heldTotal('ADVANCE') + heldTotal('DEPOSIT')],
                  ].map(([label, val]) => (
                    <div key={label} className="rounded-xl bg-surface-2 px-3 py-2">
                      <div className="text-[10px] font-bold text-ink-faint uppercase tracking-widest">{label}</div>
                      <div className="text-[14px] font-semibold text-ink mt-0.5">{money(val)}</div>
                    </div>
                  ))}
                </div>
              )}

              {!depLoadError && detailDeposits.length === 0 && depEditId !== 'new' && (
                <div className="text-center py-6">
                  <CreditCard size={28} className="mx-auto mb-2 text-ink-faint" />
                  <p className="text-[13px] text-ink-faint">No advance or deposit receipts recorded.</p>
                </div>
              )}

              <div className="space-y-2">
                {detailDeposits.map(d => (
                  depEditId === d.id ? (
                    <form key={d.id} onSubmit={saveDeposit} className="p-3 rounded-xl bg-surface-2">
                      <div className="text-[12px] font-semibold text-ink mb-2">
                        Edit {DEPOSIT_KIND_LABEL[d.kind]} receipt
                      </div>
                      <div className="form-grid">
                        <div className="fg">
                          <label>Amount (PHP) *</label>
                          <input type="number" min="0" step="0.01" required value={depForm.amount}
                            onChange={e => setDepForm(f => ({ ...f, amount: e.target.value }))} />
                        </div>
                        <div className="fg">
                          <label>{DEPOSIT_REF_LABEL[d.kind]}</label>
                          <input type="text" value={depForm.ref_no}
                            onChange={e => setDepForm(f => ({ ...f, ref_no: e.target.value }))} />
                        </div>
                        <div className="fg">
                          <label>Received date</label>
                          <input type="date" value={depForm.received_date}
                            onChange={e => setDepForm(f => ({ ...f, received_date: e.target.value }))} />
                        </div>
                        <div className="fg">
                          <label>Notes</label>
                          <input type="text" value={depForm.notes}
                            onChange={e => setDepForm(f => ({ ...f, notes: e.target.value }))} />
                        </div>
                      </div>
                      <div className="flex justify-end gap-2 mt-3">
                        <button type="button" className="btn-xs" onClick={cancelDepositForm} disabled={depSaving}>Cancel</button>
                        <button type="submit" className="btn-xs blue" disabled={depSaving}>{depSaving ? 'Saving…' : 'Save'}</button>
                      </div>
                    </form>
                  ) : (
                    <div key={d.id} className="flex items-start gap-3 p-3 rounded-xl bg-surface-2">
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2 flex-wrap">
                          <span className="text-[13px] font-semibold text-ink">{DEPOSIT_KIND_LABEL[d.kind]}</span>
                          <span className="text-[13px] text-ink">{money(d.amount)}</span>
                          <span className={`text-[10px] font-bold px-1.5 py-0.5 rounded ${DEPOSIT_STATUS_COLORS[d.status] || DEPOSIT_STATUS_COLORS.REFUNDED}`}>
                            {d.status}
                          </span>
                        </div>
                        <div className="text-[11px] text-ink-faint mt-0.5">
                          {DEPOSIT_REF_LABEL[d.kind]} {d.ref_no || '—'} · Received {fmtDate(d.received_date)}
                        </div>
                        {d.notes && <div className="text-[11px] text-ink-muted mt-0.5">{d.notes}</div>}
                        {d.settled_note && <div className="text-[11px] text-ink-muted mt-0.5">Settlement: {d.settled_note}</div>}
                      </div>
                      {isAdmin && depEditId === null && d.status === 'HELD' && (
                        <button className="btn-xs blue inline-flex items-center gap-1 shrink-0" onClick={() => startEditDeposit(d)}>
                          <Pencil size={10} /> Edit
                        </button>
                      )}
                    </div>
                  )
                ))}

                {depEditId === 'new' && (
                  <form onSubmit={saveDeposit} className="p-3 rounded-xl bg-surface-2">
                    <div className="text-[12px] font-semibold text-ink mb-2">Add receipt</div>
                    <div className="form-grid">
                      <div className="fg">
                        <label>Type *</label>
                        <select value={depForm.kind} onChange={e => setDepForm(f => ({ ...f, kind: e.target.value }))}>
                          <option value="ADVANCE">Advance (S.I#)</option>
                          <option value="DEPOSIT">Deposit (T.R#)</option>
                        </select>
                      </div>
                      <div className="fg">
                        <label>Amount (PHP) *</label>
                        <input type="number" min="0" step="0.01" required value={depForm.amount}
                          onChange={e => setDepForm(f => ({ ...f, amount: e.target.value }))} />
                      </div>
                      <div className="fg">
                        <label>{DEPOSIT_REF_LABEL[depForm.kind]}</label>
                        <input type="text" value={depForm.ref_no}
                          onChange={e => setDepForm(f => ({ ...f, ref_no: e.target.value }))} />
                      </div>
                      <div className="fg">
                        <label>Received date</label>
                        <input type="date" value={depForm.received_date}
                          onChange={e => setDepForm(f => ({ ...f, received_date: e.target.value }))} />
                      </div>
                      <div className="fg full">
                        <label>Notes</label>
                        <input type="text" value={depForm.notes}
                          onChange={e => setDepForm(f => ({ ...f, notes: e.target.value }))} />
                      </div>
                    </div>
                    <div className="flex justify-end gap-2 mt-3">
                      <button type="button" className="btn-xs" onClick={cancelDepositForm} disabled={depSaving}>Cancel</button>
                      <button type="submit" className="btn-xs blue" disabled={depSaving}>{depSaving ? 'Saving…' : 'Add'}</button>
                    </div>
                  </form>
                )}
              </div>

              {isAdmin && !depLoadError && depEditId === null && (
                <div className="mt-3">
                  <button className="btn-xs blue" onClick={startAddDeposit}>+ Add receipt</button>
                </div>
              )}

              {detailBills.length > 0 && (
                <div className="mt-5">
                  <div className="text-[10px] font-bold text-ink-faint uppercase tracking-widest mb-2">Final bills</div>
                  <div className="space-y-2">
                    {detailBills.map(b => {
                      const net = Number(b.net_amount)
                      return (
                        <div key={b.id} className="p-3 rounded-xl bg-surface-2">
                          <div className="flex items-center gap-2 flex-wrap">
                            <span className="text-[13px] font-semibold text-ink">Final bill #{b.id}</span>
                            <span className="text-[12px] text-ink-muted">{fmtDate(b.move_out_date)}</span>
                            <span className={`text-[10px] font-bold px-1.5 py-0.5 rounded ${b.status === 'VOID' ? 'bg-danger-bg text-danger-text' : 'bg-success-bg text-success-text'}`}>{b.status}</span>
                            <span className={`text-[13px] font-semibold ml-auto ${net < 0 ? 'text-success-text' : 'text-ink'}`}>
                              {net < 0 ? `Refund ${money(-net)}` : `Due ${money(net)}`}
                            </span>
                          </div>
                          {b.early_termination && (
                            <div className="text-[11px] text-ink-muted mt-0.5">
                              Early termination — {b.forfeit_waived ? `forfeiture waived: ${b.waived_reason}` : 'advance and deposit forfeited'}
                            </div>
                          )}
                          {b.status === 'VOID' && <div className="text-[11px] text-danger-text mt-0.5">Voided: {b.void_reason}</div>}
                          {isAdmin && (
                            <div className="flex items-center gap-2 mt-2">
                              <Link className="btn-xs blue" to={`/print/final-bill?id=${b.id}`}>Print</Link>
                              {b.status === 'FINAL' && voidId !== b.id && (
                                <button className="btn-xs red" onClick={() => { setVoidId(b.id); setVoidReason('') }}>Void</button>
                              )}
                            </div>
                          )}
                          {isAdmin && voidId === b.id && (
                            <div className="flex items-center gap-2 mt-2">
                              <input type="text" className="flex-1" placeholder="Reason for voiding (required)" value={voidReason}
                                onChange={e => setVoidReason(e.target.value)} />
                              <button className="btn-xs red" disabled={billBusy || !voidReason.trim()} onClick={doVoidBill}>{billBusy ? 'Voiding…' : 'Confirm void'}</button>
                              <button className="btn-xs" disabled={billBusy} onClick={() => setVoidId(null)}>Cancel</button>
                            </div>
                          )}
                        </div>
                      )
                    })}
                  </div>
                </div>
              )}
            </div>
          )}

          {/* ── Tickets ── */}
          {profileTab === 'tickets' && (
            detailTickets.length === 0 ? (
              <div className="text-center py-6">
                <p className="text-[13px] text-ink-faint">No maintenance tickets.</p>
              </div>
            ) : (
              <table className="payments-table">
                <thead><tr><th>Room</th><th>Concern</th><th>Status</th><th>Raised</th></tr></thead>
                <tbody>
                  {detailTickets.map(tk => (
                    <tr key={tk.id}>
                      <td>{tk.rooms?.room_no ? `Rm ${tk.rooms.room_no}` : '—'}</td>
                      <td>{tk.concern}</td>
                      <td>
                        <span className={`inline-flex items-center px-2 py-0.5 rounded-full text-[10px] font-bold ${
                          tk.status === 'PENDING' ? 'bg-warning-bg text-warning-text' : 'bg-success-bg text-success-text'
                        }`}>
                          {tk.status}
                        </span>
                      </td>
                      <td className="text-[11px] text-ink-faint">
                        {tk.raised_at ? new Date(tk.raised_at).toLocaleDateString('en-PH', { month: 'short', day: 'numeric', year: 'numeric' }) : '—'}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )
          )}

          {/* ── History ── */}
          {profileTab === 'history' && (
            detailHistory.length === 0 ? (
              <div className="text-center py-6">
                <History size={28} className="mx-auto mb-2 text-ink-faint" />
                <p className="text-[13px] text-ink-faint">No activity history yet.</p>
                <p className="text-[11px] text-ink-faint mt-1">Actions like moves, transfers, tickets, and payments will appear here.</p>
              </div>
            ) : (
              <div className="py-1">
                {detailHistory.map((entry, i) => {
                  const dotColor = HISTORY_COLORS[entry.activity_type] || 'bg-navy-400'
                  const isLast   = i === detailHistory.length - 1
                  const isPayment = entry.activity_type?.startsWith('Payment')
                  return (
                    <div key={entry.id} className="flex gap-3 relative">
                      {!isLast && (
                        <div className="absolute left-[8px] top-5 bottom-0 w-px bg-surface-3" />
                      )}
                      <div className={`shrink-0 mt-1.5 w-[18px] h-[18px] rounded-full border-2 ring-1 ring-line-subtle flex items-center justify-center bg-surface`} style={{ borderColor: 'var(--surface)' }}>
                        <span className={`w-2 h-2 rounded-full ${dotColor}`} />
                      </div>
                      <div className="pb-4 flex-1 min-w-0">
                        <div className="flex items-start justify-between gap-2">
                          <span className="text-[12px] font-semibold text-ink leading-snug">
                            {entry.activity_type}
                          </span>
                          <span className="text-[10px] text-ink-faint shrink-0 whitespace-nowrap mt-0.5">
                            {fmtDate(entry.recorded_at)}
                          </span>
                        </div>
                        {entry.notes && (
                          <p className="text-[12px] text-ink-muted mt-0.5 leading-snug">{entry.notes}</p>
                        )}
                        {isPayment && entry.amount_paid && (
                          <p className="text-[12px] font-medium text-ink-secondary mt-0.5">
                            ₱{Number(entry.amount_paid).toLocaleString('en-PH', { minimumFractionDigits: 2 })}
                          </p>
                        )}
                      </div>
                    </div>
                  )
                })}
              </div>
            )
          )}
        </div>

        {/* Footer */}
        <div className="modal-foot">
          <button className="btn secondary" onClick={onClose}>Close</button>
          {tenant.is_active && (
            <>
              <button className="btn primary" onClick={() => onTransfer(tenant)}>
                <ArrowRightLeft size={13} /> Transfer
              </button>
              <button className="btn danger" onClick={() => onMoveOut(tenant)}>
                <LogOut size={13} /> Move Out
              </button>
            </>
          )}
        </div>
      </div>
      {ToastEl}
    </div>
  )
}
