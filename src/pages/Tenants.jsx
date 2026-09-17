import { useState, useEffect, useMemo } from 'react'
import {
  fetchBeds, fetchTenants, addTenant, processMoveOut, addTenantDocument,
  supabase,
} from '../lib/supabase'
import { getOrCreateTenantFolder, uploadFileToDrive, isDriveConfigured } from '../lib/googleDrive'
import { useAuth } from '../lib/auth'
import { useToast } from '../components/Toast'
import MoveInModal          from '../components/MoveInModal'
import MoveOutModal         from '../components/MoveOutModal'
import TransferModal        from '../components/TransferModal'
import TenantProfileModal   from '../components/TenantProfileModal'
import SearchInput          from '../components/SearchInput'
import {
  UserPlus, Eye, LogOut, SearchX,
} from 'lucide-react'

const PAGE = 20

function fmt(n)      { return n ? '₱' + Number(n).toLocaleString('en-PH') : '—' }
function fmtDate(d)  {
  if (!d) return '—'
  return new Date(d).toLocaleDateString('en-PH', { month: 'short', day: 'numeric', year: 'numeric' })
}

// ── Tenants Page ───────────────────────────────────────────────────────────────

export default function Tenants() {
  const { isAdmin } = useAuth()

  const [beds,       setBeds]       = useState([])
  const [tenants,    setTenants]    = useState([])
  const [loading,    setLoading]    = useState(true)
  const [search,     setSearch]     = useState('')
  const [statFilter, setStatFilter] = useState('LEASED')
  const [roomFilter, setRoomFilter] = useState('')
  const [page,       setPage]       = useState(0)
  const [sortKey,    setSortKey]    = useState('room')
  const [sortDir,    setSortDir]    = useState('asc')

  const [detail,     setDetail]     = useState(null)

  const [moveInBed,  setMoveInBed]  = useState(null)
  const [moveOutT,   setMoveOutT]   = useState(null)
  const [transferT,  setTransferT]  = useState(null)
  const [saving,    setSaving]    = useState(false)

  const { show, ToastEl } = useToast()

  async function load() {
    setLoading(true)
    try {
      const [b, t] = await Promise.all([fetchBeds(), fetchTenants()])
      setBeds(b); setTenants(t)
    } catch(e) { show(e.message, 'error') }
    setLoading(false)
  }
  useEffect(() => { load() }, [])

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
        <SearchInput
          placeholder="Search name, room, bed…"
          value={search} onChange={e => { setSearch(e.target.value); setPage(0) }}
          className="w-60"
        />
        <select value={statFilter} onChange={e => { setStatFilter(e.target.value); setPage(0) }}
          className="px-3 py-2 border border-line rounded-lg text-[13px] bg-surface focus:outline-none focus:ring-2 focus:ring-navy-700/25 focus:border-navy-600 transition-colors">
          <option value="LEASED">Active (Leased)</option>
          <option value="ALL">All Tenants</option>
        </select>
        <select value={roomFilter} onChange={e => { setRoomFilter(e.target.value); setPage(0) }}
          className="px-3 py-2 border border-line rounded-lg text-[13px] bg-surface focus:outline-none focus:ring-2 focus:ring-navy-700/25 focus:border-navy-600 transition-colors">
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
              ? <tr><td colSpan={7}><div className="empty"><SearchX size={28} className="mx-auto mb-3 text-ink-faint" /><p>No tenants found</p></div></td></tr>
              : pageRows.map(t => (
                <tr key={t.id} className="group">
                  <td className="td-name">{t.name}</td>
                  <td className="font-medium text-ink-secondary">{t.room_no}</td>
                  <td>
                    <span className="font-bold text-ink">{t.bed_letter}</span>
                    {t.bed_location && <span className="text-ink-faint text-[11px] ml-1">{t.bed_location}</span>}
                  </td>
                  <td className="td-rate">{fmt(t.rate)}</td>
                  <td className="text-[12px] text-ink-muted">{fmtDate(t.move_in_date)}</td>
                  <td className="text-[12px] text-ink-muted">{fmtDate(t.move_out_date)}</td>
                  <td>
                    <div className="flex gap-1.5 opacity-0 group-hover:opacity-100 transition-opacity duration-150">
                      <button className="btn-xs blue"  onClick={() => setDetail(t)}>
                        <Eye size={10} /> View
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
        <TenantProfileModal
          tenant={detail}
          onClose={() => setDetail(null)}
          onTransfer={t => { setDetail(null); setTransferT(t) }}
          onMoveOut={t => { setDetail(null); setMoveOutT(t) }}
        />
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
