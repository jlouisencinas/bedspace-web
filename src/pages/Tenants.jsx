import { useState, useEffect, useMemo, useRef } from 'react'
import {
  fetchBeds, fetchTenants, addTenant, processMoveOut, recordPayment, fetchPayments,
  fetchTicketsForTenant, fetchTenantContacts, addTenantContact, deleteTenantContact, setPrimaryContact,
  fetchTenantEmails, addTenantEmail, deleteTenantEmail, setPrimaryEmail,
  fetchTenantDocuments, addTenantDocument, deleteTenantDocument,
  fetchTenantHistory,
  supabase,
} from '../lib/supabase'
import { getOrCreateTenantFolder, uploadFileToDrive, isDriveConfigured, isDriveConnected, preloadDrive, connectDrive } from '../lib/googleDrive'
import { useAuth } from '../lib/auth'
import { requestApproval } from '../lib/approvals'
import { useToast } from '../components/Toast'
import MoveInModal    from '../components/MoveInModal'
import MoveOutModal   from '../components/MoveOutModal'
import TransferModal  from '../components/TransferModal'
import {
  Search, UserPlus, Eye, CreditCard, LogOut, Edit2, Clock, AlertTriangle, X, SearchX,
  Phone, Mail, Star, Trash2, FileUp, ExternalLink, Plus, FileText, ArrowRightLeft, History,
} from 'lucide-react'

const PAGE = 20

const PROFILE_TABS = [
  { id: 'overview',   label: 'Overview'   },
  { id: 'contacts',   label: 'Contacts'   },
  { id: 'documents',  label: 'Documents'  },
  { id: 'payments',   label: 'Payments'   },
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
}

const DOC_TYPES = [
  { value: 'GOVT_ID',          label: 'Government ID'   },
  { value: 'SIGNED_CONTRACT',  label: 'Signed Contract' },
  { value: 'OTHER',            label: 'Other'           },
]

const DOC_TYPE_COLORS = {
  GOVT_ID:         'bg-blue-50 text-blue-700',
  SIGNED_CONTRACT: 'bg-emerald-50 text-emerald-700',
  OTHER:           'bg-slate-100 text-slate-600',
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

// ── Edit Details Modal ─────────────────────────────────────────────────────────

function EditDetailsModal({ tenant, onClose, onDone }) {
  const { isAdmin } = useAuth()
  const [moveOutDate, setMoveOutDate] = useState(tenant.move_out_date?.slice(0, 10) || '')
  const [reason,      setReason]      = useState('')
  const [error,       setError]       = useState('')
  const [busy,        setBusy]        = useState(false)
  const [submitted,   setSubmitted]   = useState(false)

  async function handleSubmit(e) {
    e.preventDefault()
    setError('')

    const changed = moveOutDate !== (tenant.move_out_date?.slice(0, 10) || '')
    if (!changed) { onClose(); return }

    const patch = { move_out_date: moveOutDate || null }

    if (!isAdmin) {
      if (!reason.trim()) { setError('Please provide a reason for the change.'); return }
      setBusy(true)
      try {
        await requestApproval({
          entityType: 'TENANT',
          entityId:   String(tenant.id),
          fieldName:  'move_out_date',
          oldValue:   { move_out_date: tenant.move_out_date?.slice(0, 10) || null },
          newValue:   { _tenant_name: tenant.name, _room_no: tenant.room_no, _bed_letter: tenant.bed_letter, ...patch },
          reason:     reason.trim(),
        })
        setSubmitted(true)
      } catch(err) { setError(err.message) } finally { setBusy(false) }
      return
    }

    setBusy(true)
    try {
      const { error: err } = await supabase.from('tenants').update(patch).eq('id', tenant.id)
      if (err) throw err
      onDone()
    } catch(err) { setError(err.message) } finally { setBusy(false) }
  }

  if (submitted) {
    return (
      <div className="overlay" onClick={e => e.stopPropagation()}>
        <div className="modal modal-sm">
          <div className="modal-head">
            <h3>Edit Tenant Details</h3>
            <button className="btn-close" onClick={onClose}><X size={16} /></button>
          </div>
          <div className="modal-body text-center py-8">
            <Clock size={36} className="mx-auto mb-3 text-amber-400" />
            <h4 className="text-[15px] font-semibold text-slate-900 mb-2">Sent for Approval</h4>
            <p className="text-[13px] text-slate-500 leading-relaxed">
              The change has been submitted to an admin for review.
            </p>
          </div>
          <div className="modal-foot">
            <button className="btn primary" onClick={onClose}>Close</button>
          </div>
        </div>
      </div>
    )
  }

  return (
    <div className="overlay" onClick={e => e.stopPropagation()}>
      <div className="modal modal-sm">
        <div className="modal-head">
          <h3>Edit Tenant Details</h3>
          <button className="btn-close" onClick={onClose}><X size={16} /></button>
        </div>
        <form onSubmit={handleSubmit}>
          <div className="modal-body space-y-4">
            <div className="bg-slate-50 border border-slate-100 rounded-xl px-4 py-3 text-[13px]">
              <div className="font-semibold text-slate-900">{tenant.name}</div>
              <div className="text-slate-500 mt-0.5">Room {tenant.room_no} · Bed {tenant.bed_letter}</div>
            </div>
            <div className="form-grid">
              <div className="fg full">
                <label>Planned Move-out Date</label>
                <input type="date" value={moveOutDate} onChange={e => setMoveOutDate(e.target.value)} />
              </div>
              {!isAdmin && (
                <div className="fg full space-y-2">
                  <div className="bg-amber-50 border border-amber-100 rounded-xl px-3 py-2.5 text-[12px] text-amber-800 flex items-start gap-2">
                    <AlertTriangle size={13} className="shrink-0 mt-px" />
                    Changes require admin approval and will only apply once reviewed.
                  </div>
                  <label>Reason for change <span className="text-red-600">*</span></label>
                  <textarea rows={2} value={reason}
                    onChange={e => { setError(''); setReason(e.target.value) }}
                    placeholder="Briefly describe why this is being updated…" />
                </div>
              )}
            </div>
            {error && (
              <div className="p-3 bg-red-50 text-red-700 text-[13px] rounded-xl border border-red-100">{error}</div>
            )}
          </div>
          <div className="modal-foot">
            <button type="button" className="btn secondary" onClick={onClose}>Cancel</button>
            <button type="submit" className="btn primary" disabled={busy}>
              {busy ? 'Saving…' : isAdmin ? 'Save Changes' : 'Submit for Approval'}
            </button>
          </div>
        </form>
      </div>
    </div>
  )
}

// ── Tenants Page ───────────────────────────────────────────────────────────────

export default function Tenants() {
  const { isAdmin } = useAuth()
  const docFileRef = useRef(null)

  const [beds,       setBeds]       = useState([])
  const [tenants,    setTenants]    = useState([])
  const [loading,    setLoading]    = useState(true)
  const [search,     setSearch]     = useState('')
  const [statFilter, setStatFilter] = useState('LEASED')
  const [roomFilter, setRoomFilter] = useState('')
  const [page,       setPage]       = useState(0)
  const [sortKey,    setSortKey]    = useState('room')
  const [sortDir,    setSortDir]    = useState('asc')

  const [detail,        setDetail]        = useState(null)
  const [profileTab,    setProfileTab]    = useState('overview')
  const [detailPays,    setDetailPays]    = useState([])
  const [detailTickets, setDetailTickets] = useState([])
  const [detailContacts,setDetailContacts]= useState([])
  const [detailEmails,  setDetailEmails]  = useState([])
  const [detailDocs,    setDetailDocs]    = useState([])
  const [detailHistory, setDetailHistory] = useState([])

  const [docUploading,   setDocUploading]   = useState(false)
  const [newDocType,     setNewDocType]     = useState('GOVT_ID')
  const [driveConnected, setDriveConnected] = useState(isDriveConnected)
  const [drivePreloaded, setDrivePreloaded] = useState(false)
  const [newContactVal,  setNewContactVal]  = useState('')
  const [newContactLbl,  setNewContactLbl]  = useState('')
  const [newEmailVal,    setNewEmailVal]    = useState('')
  const [newEmailLbl,    setNewEmailLbl]    = useState('')

  const [editT,      setEditT]      = useState(null)
  const [moveInBed,  setMoveInBed]  = useState(null)
  const [moveOutT,   setMoveOutT]   = useState(null)
  const [transferT,  setTransferT]  = useState(null)
  const [payModal,   setPayModal]   = useState(null)
  const [payDate,   setPayDate]   = useState(today())
  const [payAmount, setPayAmount] = useState('')
  const [payNotes,  setPayNotes]  = useState('')
  const [payCategory, setPayCategory] = useState('RENT_WATER')
  const [saving,    setSaving]    = useState(false)

  const { show, ToastEl } = useToast()

  function today() { return new Date().toISOString().slice(0, 10) }

  function closePayModal() {
    setPayModal(null)
    setPayDate(today())
    setPayAmount('')
    setPayNotes('')
    setPayCategory('RENT_WATER')
  }

  async function load() {
    setLoading(true)
    try {
      const [b, t] = await Promise.all([fetchBeds(), fetchTenants()])
      setBeds(b); setTenants(t)
    } catch(e) { show(e.message, 'error') }
    setLoading(false)
  }
  useEffect(() => { load() }, [])

  // Preload Drive only when the Documents tab is opened (avoids Google popup on every View click)
  useEffect(() => {
    if (detail && profileTab === 'documents' && isDriveConfigured()) {
      preloadDrive().then(() => {
        setDrivePreloaded(true)
        setDriveConnected(isDriveConnected())
      }).catch(() => {})
    }
  }, [detail, profileTab])

  const rooms = useMemo(() =>
    [...new Set(beds.map(b => b.room_no).filter(Boolean))].sort((a, b) => parseInt(a) - parseInt(b)),
  [beds])

  const enriched = useMemo(() =>
    tenants.filter(t => t.is_active).map(t => ({
      ...t,
      room_no:      t.beds?.rooms?.room_no   || '',
      room_type:    t.beds?.rooms?.room_type || '',
      room_id:      t.beds?.room_id          || null,
      bed_letter:   t.beds?.bed_letter       || '',
      bed_location: t.beds?.bed_location     || '',
    })),
  [tenants])

  const filtered = useMemo(() => {
    const q = search.toLowerCase()
    return enriched.filter(t => {
      if (statFilter && statFilter !== 'ALL' && t.is_active !== (statFilter === 'LEASED')) return false
      if (roomFilter && t.room_no !== roomFilter) return false
      if (q && !(t.name || '').toLowerCase().includes(q)
           && !(t.room_no || '').includes(q)
           && !(t.bed_letter || '').toLowerCase().includes(q)) return false
      return true
    })
  }, [enriched, search, statFilter, roomFilter])

  const sorted = useMemo(() => {
    const val = (t, key) => {
      switch (key) {
        case 'name':    return (t.name || '').toLowerCase()
        case 'room':    return parseInt(t.room_no) || 0
        case 'bed':     return (t.bed_letter || '')
        case 'rate':    return Number(t.rate) || 0
        case 'movein':  return t.move_in_date  || ''
        case 'moveout': return t.move_out_date || ''
        default:        return ''
      }
    }
    return [...filtered].sort((a, b) => {
      const av = val(a, sortKey), bv = val(b, sortKey)
      let c = av < bv ? -1 : av > bv ? 1 : 0
      if (c !== 0) return sortDir === 'asc' ? c : -c
      const ra = parseInt(a.room_no) || 0, rb = parseInt(b.room_no) || 0
      if (ra !== rb) return ra - rb
      return (a.bed_letter || '').localeCompare(b.bed_letter || '')
    })
  }, [filtered, sortKey, sortDir])

  function handleSort(key) {
    if (key === sortKey) setSortDir(d => d === 'asc' ? 'desc' : 'asc')
    else { setSortKey(key); setSortDir('asc') }
    setPage(0)
  }
  const arrow = key => key === sortKey ? (sortDir === 'asc' ? ' ▲' : ' ▼') : ''

  const pageRows   = sorted.slice(page * PAGE, (page + 1) * PAGE)
  const totalPages = Math.ceil(sorted.length / PAGE)

  async function openDetail(t) {
    setDetail(t)
    setProfileTab('overview')
    setDetailPays([])
    setDetailTickets([])
    setDetailContacts([])
    setDetailEmails([])
    setDetailDocs([])
    setDetailHistory([])
    setNewContactVal('')
    setNewContactLbl('')
    setNewEmailVal('')
    setNewEmailLbl('')

    const results = await Promise.allSettled([
      fetchPayments(t.id),
      fetchTicketsForTenant(t.id),
      fetchTenantContacts(t.id),
      fetchTenantEmails(t.id),
      fetchTenantDocuments(t.id),
      fetchTenantHistory(t.id),
    ])
    if (results[0].status === 'fulfilled') setDetailPays(results[0].value)
    if (results[1].status === 'fulfilled') setDetailTickets(results[1].value)
    if (results[2].status === 'fulfilled') setDetailContacts(results[2].value)
    if (results[3].status === 'fulfilled') setDetailEmails(results[3].value)
    if (results[4].status === 'fulfilled') setDetailDocs(results[4].value)
    if (results[5].status === 'fulfilled') setDetailHistory(results[5].value)
  }

  async function handleMoveIn(data) {
    if (!moveInBed) return
    setSaving(true)
    try {
      const { contacts = [], emails = [], docs = [], ...tenantData } = data
      const tenant = await addTenant(moveInBed.bed_id, {
        ...tenantData,
        _room_no:    moveInBed.room_no,
        _bed_letter: moveInBed.bed_letter,
      })

      const validContacts = contacts.filter(c => c.value.trim())
      if (validContacts.length) {
        await supabase.from('tenant_contacts').insert(
          validContacts.map((c, i) => ({
            tenant_id:  tenant.id,
            value:      c.value.trim(),
            label:      c.label?.trim() || null,
            is_primary: c.isPrimary || i === 0,
          }))
        )
      }

      const validEmails = emails.filter(e => e.value.trim())
      if (validEmails.length) {
        await supabase.from('tenant_emails').insert(
          validEmails.map((e, i) => ({
            tenant_id:  tenant.id,
            value:      e.value.trim(),
            label:      e.label?.trim() || null,
            is_primary: e.isPrimary || i === 0,
          }))
        )
      }

      const validDocs = docs.filter(d => d.file)
      if (validDocs.length) {
        if (!isDriveConfigured()) {
          show('Documents skipped — Google Drive not configured. Upload via tenant profile later.', 'error')
        } else {
          try {
            const folderId = await getOrCreateTenantFolder(tenant.name, moveInBed.room_no)
            for (const d of validDocs) {
              const driveFile = await uploadFileToDrive(d.file, folderId)
              await addTenantDocument(tenant.id, {
                docType:     d.docType,
                filename:    d.file.name,
                driveFileId: driveFile.id,
                driveUrl:    driveFile.webViewLink,
                sizeBytes:   d.file.size || null,
              })
            }
          } catch(driveErr) {
            show(`Documents not uploaded: ${driveErr.message}. Upload via tenant profile later.`, 'error')
          }
        }
      }

      setMoveInBed(null)
      show('Tenant moved in!', 'success')
      load()
    } catch(e) { show(e.message, 'error') }
    setSaving(false)
  }

  async function handleMoveOut(data) {
    if (!moveOutT) return
    setSaving(true)
    try {
      await processMoveOut(
        { ...moveOutT, _room_no: moveOutT.room_no, _bed_letter: moveOutT.bed_letter },
        data
      )
      setMoveOutT(null)
      show('Move-out processed.', 'success')
      load()
    } catch(e) { show(e.message, 'error') }
    setSaving(false)
  }

  async function handlePayment() {
    if (!payModal) return
    setSaving(true)
    try {
      await recordPayment(payModal.id, {
        payment_date: payDate,
        amount:       Number(payAmount),
        notes:        payNotes.trim() || null,
        category:     payCategory,
        cutoff_id:    null,
        _tenant_name: payModal.name,
        _room_no:     payModal.room_no,
        _bed_letter:  payModal.bed_letter,
      })
      closePayModal()
      show('Payment recorded.', 'success')
      load()
    } catch(e) { show(e.message, 'error') }
    setSaving(false)
  }

  // ── Contact handlers ──────────────────────────────────────────────────────────

  async function handleAddContact() {
    if (!newContactVal.trim() || !detail) return
    try {
      const row = await addTenantContact(detail.id, {
        value:     newContactVal.trim(),
        label:     newContactLbl.trim() || null,
        isPrimary: detailContacts.length === 0,
      })
      setDetailContacts(prev => [...prev, row])
      setNewContactVal('')
      setNewContactLbl('')
    } catch(e) { show(e.message, 'error') }
  }

  async function handleDeleteContact(id) {
    try {
      await deleteTenantContact(id)
      setDetailContacts(prev => {
        const next      = prev.filter(c => c.id !== id)
        const wasPrimary = prev.find(c => c.id === id)?.is_primary
        if (wasPrimary && next.length > 0) {
          next[0] = { ...next[0], is_primary: true }
          setPrimaryContact(detail.id, next[0].id)
        }
        return next
      })
    } catch(e) { show(e.message, 'error') }
  }

  async function handleSetPrimaryContact(id) {
    try {
      await setPrimaryContact(detail.id, id)
      setDetailContacts(prev => prev.map(c => ({ ...c, is_primary: c.id === id })))
    } catch(e) { show(e.message, 'error') }
  }

  // ── Email handlers ────────────────────────────────────────────────────────────

  async function handleAddEmail() {
    if (!newEmailVal.trim() || !detail) return
    try {
      const row = await addTenantEmail(detail.id, {
        value:     newEmailVal.trim(),
        label:     newEmailLbl.trim() || null,
        isPrimary: detailEmails.length === 0,
      })
      setDetailEmails(prev => [...prev, row])
      setNewEmailVal('')
      setNewEmailLbl('')
    } catch(e) { show(e.message, 'error') }
  }

  async function handleDeleteEmail(id) {
    try {
      await deleteTenantEmail(id)
      setDetailEmails(prev => {
        const next      = prev.filter(e => e.id !== id)
        const wasPrimary = prev.find(e => e.id === id)?.is_primary
        if (wasPrimary && next.length > 0) {
          next[0] = { ...next[0], is_primary: true }
          setPrimaryEmail(detail.id, next[0].id)
        }
        return next
      })
    } catch(e) { show(e.message, 'error') }
  }

  async function handleSetPrimaryEmail(id) {
    try {
      await setPrimaryEmail(detail.id, id)
      setDetailEmails(prev => prev.map(e => ({ ...e, is_primary: e.id === id })))
    } catch(e) { show(e.message, 'error') }
  }

  // ── Document handlers ─────────────────────────────────────────────────────────

  async function handleDocFileSelect(e) {
    const file = e.target.files?.[0]
    if (!file || !detail) return
    docFileRef.current.value = ''
    setDocUploading(true)
    try {
      const folderId  = await getOrCreateTenantFolder(detail.name, detail.room_no)
      const driveFile = await uploadFileToDrive(file, folderId)
      const row = await addTenantDocument(detail.id, {
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

  if (loading) return (
    <div className="loading-screen"><div className="spinner" /></div>
  )

  return (
    <div className="page">
      {/* ── Header ── */}
      <div className="page-header">
        <div>
          <h1 className="page-title">Tenants</h1>
          <p className="page-sub">
            {sorted.length} {statFilter === 'LEASED' ? 'active' : ''} tenants
          </p>
        </div>
        <button
          className="btn primary"
          onClick={() => {
            const vacant = beds.find(b => b.status === 'VACANT' && (!roomFilter || b.room_no === roomFilter))
            if (vacant) setMoveInBed(vacant)
            else show('No vacant beds available.', 'error')
          }}
        >
          <UserPlus size={14} /> Move In
        </button>
      </div>

      {/* ── Toolbar ── */}
      <div className="toolbar">
        <div className="relative">
          <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" />
          <input
            type="search" placeholder="Search name, room, bed…"
            value={search} onChange={e => { setSearch(e.target.value); setPage(0) }}
            className="pl-9 pr-3 py-2 border border-slate-200 rounded-lg text-[13px] bg-white w-60
                       focus:outline-none focus:ring-2 focus:ring-navy-700/25 focus:border-navy-600 transition-colors"
          />
        </div>
        <select value={statFilter} onChange={e => { setStatFilter(e.target.value); setPage(0) }}
          className="px-3 py-2 border border-slate-200 rounded-lg text-[13px] bg-white focus:outline-none focus:ring-2 focus:ring-navy-700/25 focus:border-navy-600 transition-colors">
          <option value="LEASED">Active (Leased)</option>
          <option value="ALL">All Tenants</option>
        </select>
        <select value={roomFilter} onChange={e => { setRoomFilter(e.target.value); setPage(0) }}
          className="px-3 py-2 border border-slate-200 rounded-lg text-[13px] bg-white focus:outline-none focus:ring-2 focus:ring-navy-700/25 focus:border-navy-600 transition-colors">
          <option value="">All Rooms</option>
          {rooms.map(r => <option key={r} value={r}>Room {r}</option>)}
        </select>
      </div>

      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th onClick={() => handleSort('name')}    className="cursor-pointer select-none">Name{arrow('name')}</th>
              <th onClick={() => handleSort('room')}    className="cursor-pointer select-none">Room{arrow('room')}</th>
              <th onClick={() => handleSort('bed')}     className="cursor-pointer select-none">Bed{arrow('bed')}</th>
              <th onClick={() => handleSort('rate')}    className="cursor-pointer select-none">Rate{arrow('rate')}</th>
              <th onClick={() => handleSort('movein')}  className="cursor-pointer select-none">Move In{arrow('movein')}</th>
              <th onClick={() => handleSort('moveout')} className="cursor-pointer select-none">Move Out{arrow('moveout')}</th>
              <th>Actions</th>
            </tr>
          </thead>
          <tbody>
            {pageRows.length === 0
              ? <tr><td colSpan={7}><div className="empty"><SearchX size={28} className="mx-auto mb-3 text-slate-300" /><p>No tenants found</p></div></td></tr>
              : pageRows.map(t => (
                <tr key={t.id} className="group">
                  <td className="td-name">{t.name}</td>
                  <td className="font-medium text-slate-700">{t.room_no}</td>
                  <td>
                    <span className="font-bold text-slate-900">{t.bed_letter}</span>
                    {t.bed_location && <span className="text-slate-400 text-[11px] ml-1">{t.bed_location}</span>}
                  </td>
                  <td className="td-rate">{fmt(t.rate)}</td>
                  <td className="text-[12px] text-slate-500">{fmtDate(t.move_in_date)}</td>
                  <td className="text-[12px] text-slate-500">{fmtDate(t.move_out_date)}</td>
                  <td>
                    <div className="flex gap-1.5 opacity-0 group-hover:opacity-100 transition-opacity duration-150">
                      <button className="btn-xs blue"  onClick={() => openDetail(t)}>
                        <Eye size={10} /> View
                      </button>
                      <button className="btn-xs green" onClick={() => { setPayModal(t); setPayDate(today()); setPayAmount(String(t.rate || '')) }}>
                        <CreditCard size={10} /> Record
                      </button>
                      <button className="btn-xs red" onClick={() => setMoveOutT(t)}>
                        <LogOut size={10} /> Move Out
                      </button>
                    </div>
                  </td>
                </tr>
              ))
            }
          </tbody>
        </table>
      </div>

      {totalPages > 1 && (
        <div className="pager">
          {Array.from({ length: totalPages }, (_, i) => (
            <button key={i} className={i === page ? 'active' : ''} onClick={() => setPage(i)}>{i + 1}</button>
          ))}
          <span className="pager-info">{filtered.length} tenants</span>
        </div>
      )}

      {/* ── Profile Modal ── */}
      {detail && (
        <div className="overlay" onClick={e => e.stopPropagation()}>
          <div className="modal" style={{ maxWidth: '680px' }}>
            {/* Header */}
            <div className="modal-head">
              <div className="flex items-center gap-3">
                <div className="w-9 h-9 rounded-full bg-navy-500/15 text-navy-600 flex items-center justify-center text-[13px] font-bold shrink-0">
                  {detail.name.slice(0, 2).toUpperCase()}
                </div>
                <div>
                  <h3 className="text-[15px] font-semibold text-slate-900">{detail.name}</h3>
                  <div className="text-[11px] text-slate-400 font-normal mt-0.5">
                    Room {detail.room_no} · Bed {detail.bed_letter}
                    {detail.bed_location && ` (${detail.bed_location})`}
                    {' · '}{fmt(detail.rate)}/mo
                  </div>
                </div>
              </div>
              <button className="btn-close" onClick={() => setDetail(null)}><X size={16} /></button>
            </div>

            {/* Tab bar */}
            <div className="flex gap-0 px-4" style={{ borderBottom: '1px solid #E8E2D9' }}>
              {PROFILE_TABS.map(t => (
                <button
                  key={t.id}
                  onClick={() => setProfileTab(t.id)}
                  className={`px-3 py-2 text-[12px] font-medium border-b-2 -mb-px transition-colors ${
                    profileTab === t.id
                      ? 'border-navy-500 text-navy-700 font-semibold'
                      : 'border-transparent text-slate-500 hover:text-slate-700'
                  }`}
                >
                  {t.label}
                  {t.id === 'payments'  && detailPays.length    > 0 && <span className="ml-1 text-[10px] text-slate-400">{detailPays.length}</span>}
                  {t.id === 'tickets'   && detailTickets.length  > 0 && <span className="ml-1 text-[10px] text-slate-400">{detailTickets.length}</span>}
                  {t.id === 'documents' && detailDocs.length     > 0 && <span className="ml-1 text-[10px] text-slate-400">{detailDocs.length}</span>}
                  {t.id === 'history'   && detailHistory.length  > 0 && <span className="ml-1 text-[10px] text-slate-400">{detailHistory.length}</span>}
                </button>
              ))}
            </div>

            {/* Tab body */}
            <div className="modal-body">

              {/* ── Overview ── */}
              {profileTab === 'overview' && (
                <>
                  {[
                    ['Room',             `${detail.room_no} · Bed ${detail.bed_letter}${detail.bed_location ? ` (${detail.bed_location})` : ''}`],
                    ['Room Type',        detail.room_type],
                    ['Rate',             fmt(detail.rate)],
                    ['Gender',           detail.gender],
                    ['Source',           detail.source?.replace('_', '-')],
                    ['Duration',         detail.duration],
                    ['Move In',          fmtDate(detail.move_in_date)],
                    ['Move Out',         fmtDate(detail.move_out_date)],
                    ['Permanent Address',detail.permanent_address],
                    ['Occupation',       detail.occupation],
                    ['Employer',         detail.employer],
                    ['Employer Address', detail.employer_address],
                    ['Employer Tel',     detail.employer_contact_no],
                    ['Location of Work', detail.location_of_work],
                    ['Work Schedule',    detail.work_schedule],
                    ['Emergency Name',   detail.emergency_contact_name],
                    ['Emergency No',     detail.emergency_contact_no],
                    ['Comments',         detail.comments],
                  ].filter(([, v]) => v).map(([l, v]) => (
                    <div key={l} className="detail-row">
                      <div className="detail-label">{l}</div>
                      <div className="detail-value">{v}</div>
                    </div>
                  ))}
                  {/* Quick contact summary if available */}
                  {(detailContacts.length > 0 || detailEmails.length > 0) && (
                    <div className="mt-3 pt-3" style={{ borderTop: '1px solid #E8E2D9' }}>
                      <div className="text-[10px] font-bold text-slate-400 uppercase tracking-widest mb-2">Contact</div>
                      {detailContacts.filter(c => c.is_primary).map(c => (
                        <div key={c.id} className="flex items-center gap-2 text-[13px] text-slate-700 mb-1">
                          <Phone size={12} className="text-slate-400 shrink-0" />
                          {c.value}
                          {c.label && <span className="text-[11px] text-slate-400">{c.label}</span>}
                        </div>
                      ))}
                      {detailEmails.filter(e => e.is_primary).map(e => (
                        <div key={e.id} className="flex items-center gap-2 text-[13px] text-slate-700 mb-1">
                          <Mail size={12} className="text-slate-400 shrink-0" />
                          {e.value}
                          {e.label && <span className="text-[11px] text-slate-400">{e.label}</span>}
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
                    <div className="text-[10px] font-bold text-slate-400 uppercase tracking-widest mb-3 flex items-center gap-1.5">
                      <Phone size={11} /> Phone Numbers
                    </div>
                    {detailContacts.length === 0 ? (
                      <p className="text-[13px] text-slate-400 italic">No contacts on file.</p>
                    ) : (
                      <div className="space-y-1">
                        {detailContacts.map(c => (
                          <div key={c.id} className="flex items-center gap-2 py-1.5 group/row">
                            <button
                              onClick={() => handleSetPrimaryContact(c.id)}
                              title={c.is_primary ? 'Primary' : 'Set as primary'}
                              className={`shrink-0 w-5 h-5 flex items-center justify-center rounded-full transition-colors ${
                                c.is_primary ? 'bg-navy-500 text-white' : 'bg-slate-100 text-slate-400 hover:bg-slate-200'
                              }`}
                            >
                              <Star size={9} fill={c.is_primary ? 'currentColor' : 'none'} />
                            </button>
                            <Phone size={12} className="text-slate-400 shrink-0" />
                            <span className="text-[13px] text-slate-900 flex-1">{c.value}</span>
                            {c.label && (
                              <span className="text-[11px] text-slate-500 bg-slate-100 px-1.5 py-0.5 rounded">{c.label}</span>
                            )}
                            {c.is_primary && (
                              <span className="text-[10px] font-bold text-navy-600 bg-navy-50 border border-navy-100 px-1.5 py-0.5 rounded">Primary</span>
                            )}
                            <button
                              onClick={() => handleDeleteContact(c.id)}
                              className="opacity-0 group-hover/row:opacity-100 text-slate-300 hover:text-red-500 transition-all"
                            >
                              <Trash2 size={13} />
                            </button>
                          </div>
                        ))}
                      </div>
                    )}
                    <div className="mt-3 pt-3 flex items-center gap-1.5" style={{ borderTop: '1px solid #F0ECE4' }}>
                      <input
                        type="tel"
                        value={newContactVal}
                        onChange={e => setNewContactVal(e.target.value)}
                        onKeyDown={e => e.key === 'Enter' && (e.preventDefault(), handleAddContact())}
                        placeholder="09xx-xxx-xxxx"
                        className="flex-1 px-2.5 py-1.5 text-[13px] rounded-lg border border-slate-200 bg-white focus:outline-none focus:ring-2 focus:ring-navy-700/25 focus:border-navy-600 transition-colors"
                      />
                      <input
                        type="text"
                        value={newContactLbl}
                        onChange={e => setNewContactLbl(e.target.value)}
                        placeholder="Label"
                        className="w-24 px-2.5 py-1.5 text-[13px] rounded-lg border border-slate-200 bg-white focus:outline-none focus:ring-2 focus:ring-navy-700/25 focus:border-navy-600 transition-colors"
                      />
                      <button
                        onClick={handleAddContact}
                        disabled={!newContactVal.trim()}
                        className="btn-xs blue disabled:opacity-40 disabled:cursor-not-allowed"
                      >
                        <Plus size={11} /> Add
                      </button>
                    </div>
                  </div>

                  {/* Emails */}
                  <div>
                    <div className="text-[10px] font-bold text-slate-400 uppercase tracking-widest mb-3 flex items-center gap-1.5">
                      <Mail size={11} /> Email Addresses
                    </div>
                    {detailEmails.length === 0 ? (
                      <p className="text-[13px] text-slate-400 italic">No emails on file.</p>
                    ) : (
                      <div className="space-y-1">
                        {detailEmails.map(e => (
                          <div key={e.id} className="flex items-center gap-2 py-1.5 group/row">
                            <button
                              onClick={() => handleSetPrimaryEmail(e.id)}
                              title={e.is_primary ? 'Primary' : 'Set as primary'}
                              className={`shrink-0 w-5 h-5 flex items-center justify-center rounded-full transition-colors ${
                                e.is_primary ? 'bg-navy-500 text-white' : 'bg-slate-100 text-slate-400 hover:bg-slate-200'
                              }`}
                            >
                              <Star size={9} fill={e.is_primary ? 'currentColor' : 'none'} />
                            </button>
                            <Mail size={12} className="text-slate-400 shrink-0" />
                            <span className="text-[13px] text-slate-900 flex-1">{e.value}</span>
                            {e.label && (
                              <span className="text-[11px] text-slate-500 bg-slate-100 px-1.5 py-0.5 rounded">{e.label}</span>
                            )}
                            {e.is_primary && (
                              <span className="text-[10px] font-bold text-navy-600 bg-navy-50 border border-navy-100 px-1.5 py-0.5 rounded">Primary</span>
                            )}
                            <button
                              onClick={() => handleDeleteEmail(e.id)}
                              className="opacity-0 group-hover/row:opacity-100 text-slate-300 hover:text-red-500 transition-all"
                            >
                              <Trash2 size={13} />
                            </button>
                          </div>
                        ))}
                      </div>
                    )}
                    <div className="mt-3 pt-3 flex items-center gap-1.5" style={{ borderTop: '1px solid #F0ECE4' }}>
                      <input
                        type="email"
                        value={newEmailVal}
                        onChange={e => setNewEmailVal(e.target.value)}
                        onKeyDown={e => e.key === 'Enter' && (e.preventDefault(), handleAddEmail())}
                        placeholder="name@email.com"
                        className="flex-1 px-2.5 py-1.5 text-[13px] rounded-lg border border-slate-200 bg-white focus:outline-none focus:ring-2 focus:ring-navy-700/25 focus:border-navy-600 transition-colors"
                      />
                      <input
                        type="text"
                        value={newEmailLbl}
                        onChange={e => setNewEmailLbl(e.target.value)}
                        placeholder="Label"
                        className="w-24 px-2.5 py-1.5 text-[13px] rounded-lg border border-slate-200 bg-white focus:outline-none focus:ring-2 focus:ring-navy-700/25 focus:border-navy-600 transition-colors"
                      />
                      <button
                        onClick={handleAddEmail}
                        disabled={!newEmailVal.trim()}
                        className="btn-xs blue disabled:opacity-40 disabled:cursor-not-allowed"
                      >
                        <Plus size={11} /> Add
                      </button>
                    </div>
                  </div>
                </div>
              )}

              {/* ── Documents ── */}
              {profileTab === 'documents' && (
                <div>
                  {/* Upload row */}
                  {!isDriveConfigured() ? (
                    <div className="text-[12px] text-amber-800 bg-amber-50 border border-amber-100 rounded-lg px-3 py-2.5 flex items-start gap-2 mb-4">
                      <AlertTriangle size={13} className="text-amber-500 shrink-0 mt-px" />
                      Google Drive not configured. Add <code className="font-mono">VITE_GOOGLE_API_KEY</code>,{' '}
                      <code className="font-mono">VITE_GOOGLE_CLIENT_ID</code>, and{' '}
                      <code className="font-mono">VITE_GOOGLE_DRIVE_PARENT_FOLDER_ID</code> to your .env file.
                    </div>
                  ) : !driveConnected ? (
                    <div className="flex items-center gap-3 mb-4 pb-4 bg-amber-50 border border-amber-100 rounded-lg px-3 py-2.5" style={{ borderBottom: '1px solid #F0ECE4' }}>
                      <AlertTriangle size={13} className="text-amber-500 shrink-0" />
                      <span className="text-[12px] text-amber-800 flex-1">Connect Google Drive to upload documents.</span>
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
                    <div className="flex items-center gap-2 mb-4 pb-4" style={{ borderBottom: '1px solid #F0ECE4' }}>
                      <select
                        value={newDocType}
                        onChange={e => setNewDocType(e.target.value)}
                        className="px-2.5 py-1.5 text-[13px] rounded-lg border border-slate-200 bg-white focus:outline-none focus:ring-2 focus:ring-navy-700/25 transition-colors"
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
                      <span className="text-[11px] text-slate-400">
                        Folder: Room {detail.room_no} - {detail.name}
                      </span>
                    </div>
                  )}

                  {/* Document list */}
                  {detailDocs.length === 0 ? (
                    <div className="text-center py-6">
                      <FileText size={28} className="mx-auto mb-2 text-slate-200" />
                      <p className="text-[13px] text-slate-400">No documents uploaded yet.</p>
                    </div>
                  ) : (
                    <div className="space-y-2">
                      {detailDocs.map(d => (
                        <div key={d.id} className="flex items-center gap-3 p-3 rounded-xl bg-slate-50 hover:bg-slate-100 transition-colors group/doc">
                          <FileText size={18} className="text-slate-400 shrink-0" />
                          <div className="flex-1 min-w-0">
                            <div className="text-[13px] font-medium text-slate-900 truncate">{d.filename}</div>
                            <div className="flex items-center gap-2 mt-0.5">
                              <span className={`text-[10px] font-bold px-1.5 py-0.5 rounded ${DOC_TYPE_COLORS[d.doc_type] || DOC_TYPE_COLORS.OTHER}`}>
                                {DOC_TYPES.find(t => t.value === d.doc_type)?.label || d.doc_type}
                              </span>
                              {d.size_bytes && <span className="text-[11px] text-slate-400">{fmtSize(d.size_bytes)}</span>}
                              <span className="text-[11px] text-slate-400">{fmtDate(d.uploaded_at)}</span>
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
                    <CreditCard size={28} className="mx-auto mb-2 text-slate-200" />
                    <p className="text-[13px] text-slate-400">No payments recorded yet.</p>
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
                          <td className="text-slate-500">{p.notes || '—'}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                )
              )}

              {/* ── Tickets ── */}
              {profileTab === 'tickets' && (
                detailTickets.length === 0 ? (
                  <div className="text-center py-6">
                    <p className="text-[13px] text-slate-400">No maintenance tickets.</p>
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
                              tk.status === 'PENDING' ? 'bg-amber-50 text-amber-700' : 'bg-emerald-50 text-emerald-700'
                            }`}>
                              {tk.status}
                            </span>
                          </td>
                          <td className="text-[11px] text-slate-400">
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
                    <History size={28} className="mx-auto mb-2 text-slate-200" />
                    <p className="text-[13px] text-slate-400">No activity history yet.</p>
                    <p className="text-[11px] text-slate-300 mt-1">Actions like moves, transfers, tickets, and payments will appear here.</p>
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
                            <div className="absolute left-[8px] top-5 bottom-0 w-px bg-slate-100" />
                          )}
                          <div className={`shrink-0 mt-1.5 w-[18px] h-[18px] rounded-full border-2 border-white ring-1 ring-slate-100 flex items-center justify-center bg-white`}>
                            <span className={`w-2 h-2 rounded-full ${dotColor}`} />
                          </div>
                          <div className="pb-4 flex-1 min-w-0">
                            <div className="flex items-start justify-between gap-2">
                              <span className="text-[12px] font-semibold text-slate-900 leading-snug">
                                {entry.activity_type}
                              </span>
                              <span className="text-[10px] text-slate-400 shrink-0 whitespace-nowrap mt-0.5">
                                {fmtDate(entry.recorded_at)}
                              </span>
                            </div>
                            {entry.notes && (
                              <p className="text-[12px] text-slate-500 mt-0.5 leading-snug">{entry.notes}</p>
                            )}
                            {isPayment && entry.amount_paid && (
                              <p className="text-[12px] font-medium text-slate-700 mt-0.5">
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
              <button className="btn secondary" onClick={() => setDetail(null)}>Close</button>
              <button className="btn success"
                onClick={() => { setDetail(null); setPayModal(detail); setPayDate(today()); setPayAmount(String(detail.rate || '')) }}>
                <CreditCard size={13} /> Record Payment
              </button>
              <button className="btn primary"
                onClick={() => { setEditT(detail); setDetail(null) }}>
                <Edit2 size={13} /> Edit Details
              </button>
              <button className="btn primary"
                onClick={() => { setTransferT(detail); setDetail(null) }}>
                <ArrowRightLeft size={13} /> Transfer
              </button>
              <button className="btn danger"
                onClick={() => { setDetail(null); setMoveOutT(detail) }}>
                <LogOut size={13} /> Move Out
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ── Edit Details Modal ── */}
      {editT && (
        <EditDetailsModal
          tenant={editT}
          onClose={() => setEditT(null)}
          onDone={() => { setEditT(null); show('Details updated.', 'success'); load() }}
        />
      )}

      {/* ── Payment Modal ── */}
      {payModal && (
        <div className="overlay" onClick={e => e.stopPropagation()}>
          <div className="modal modal-sm">
            <div className="modal-head">
              <h3 className="flex items-center gap-2"><CreditCard size={15} className="text-slate-400" /> Record Payment</h3>
              <button className="btn-close" onClick={closePayModal}><X size={16} /></button>
            </div>
            <div className="modal-body space-y-4">
              <div className="bg-slate-50 border border-slate-100 rounded-xl px-4 py-3 text-[13px]">
                <div className="font-semibold text-slate-900">{payModal.name}</div>
                <div className="text-slate-500 mt-0.5">Room {payModal.room_no} · Bed {payModal.bed_letter} · {fmt(payModal.rate)}/mo</div>
              </div>
              <div className="form-grid">
                <div className="fg">
                  <label>Payment For</label>
                  <select value={payCategory} onChange={e => setPayCategory(e.target.value)}>
                    <option value="RENT_WATER">Rent + Water (due EOM)</option>
                    <option value="ELECTRICITY">Electricity (due 10th)</option>
                    <option value="OTHER">Other</option>
                  </select>
                </div>
                <div className="fg">
                  <label>Date Paid *</label>
                  <input type="date" value={payDate} onChange={e => setPayDate(e.target.value)} required />
                </div>
                <div className="fg full">
                  <label>Amount (₱) *</label>
                  <input
                    type="number" min="1" step="0.01"
                    value={payAmount} onChange={e => setPayAmount(e.target.value)}
                    placeholder={payModal.rate ? String(payModal.rate) : '0'}
                    required
                  />
                </div>
                <div className="fg full">
                  <label>Notes (optional)</label>
                  <textarea
                    rows={2} value={payNotes} onChange={e => setPayNotes(e.target.value)}
                    placeholder="e.g. partial only, advance for next month…"
                  />
                </div>
              </div>
            </div>
            <div className="modal-foot">
              <button className="btn secondary" onClick={closePayModal}>Cancel</button>
              <button
                className="btn primary"
                disabled={saving || !payDate || !payAmount || Number(payAmount) <= 0}
                onClick={handlePayment}
              >
                {saving ? 'Saving…' : 'Record'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Move In / Move Out / Transfer modals */}
      {moveInBed && (
        <MoveInModal
          bed={moveInBed}
          allBeds={beds.filter(b => b.status === 'VACANT')}
          onBedChange={setMoveInBed}
          onClose={() => setMoveInBed(null)}
          onSubmit={handleMoveIn}
          saving={saving}
        />
      )}
      {moveOutT && (
        <MoveOutModal
          bed={{ ...moveOutT, tenant_name: moveOutT.name, move_out_date: moveOutT.move_out_date }}
          onClose={() => setMoveOutT(null)}
          onSubmit={handleMoveOut}
          saving={saving}
        />
      )}
      {transferT && (
        <TransferModal
          tenant={transferT}
          vacantBeds={beds.filter(b => b.status === 'VACANT' && String(b.room_no) !== String(transferT.room_no))}
          onClose={() => setTransferT(null)}
          onDone={() => {
            setTransferT(null)
            show('Tenant transferred successfully.', 'success')
            load()
          }}
        />
      )}

      {ToastEl}
    </div>
  )
}
