import { useState, useEffect, useMemo, useRef } from 'react'
import { useLocation, useNavigate } from 'react-router-dom'
import {
  fetchBeds, fetchTenants, addTenant, processMoveOutGroup, addTenantDocument,
  fetchReservationPayments, fetchAllReservationPayments, recordMoveInReceipts, assertMoveInReceiptsAvailable,
  supabase,
} from '../lib/supabase'
import { dbToCents } from '../lib/receiptLines'
import { getOrCreateTenantFolder, uploadFileToDrive, isDriveConfigured } from '../lib/googleDrive'
import { moveInEligibleBeds } from '../lib/bedEligibility'
import { isInHouse, siblingIdsFor, CATEGORY_LABEL } from '../lib/tenantHistory'
import { useAuth } from '../lib/auth'
import { useToast } from '../components/Toast'
import MoveInModal          from '../components/MoveInModal'
import MoveOutModal         from '../components/MoveOutModal'
import TransferModal        from '../components/TransferModal'
import TenantProfileModal   from '../components/TenantProfileModal'
import CorrectRateModal     from '../components/CorrectRateModal'
import CorrectMoveInModal   from '../components/CorrectMoveInModal'
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

// No-bed rows (commercial / parking) sort after every room.
const roomKey = t => (t.bed_id ? (parseInt(t.room_no) || 0) : Number.MAX_SAFE_INTEGER)

// scope 'all' = every tenant past and present (/tenants); 'current' = in-house only (/current-tenants).
export default function Tenants({ scope = 'all' }) {
  const isCurrentScope = scope === 'current'
  const { isAdmin, user } = useAuth()
  const location = useLocation()
  const navigate = useNavigate()

  const [beds,       setBeds]       = useState([])
  const [tenants,    setTenants]    = useState([])
  const [loading,    setLoading]    = useState(true)
  const [search,     setSearch]     = useState('')
  const [statFilter, setStatFilter] = useState(isCurrentScope ? 'CURRENT' : 'ALL')
  const [roomFilter, setRoomFilter] = useState('')
  const [page,       setPage]       = useState(0)
  const [sortKey,    setSortKey]    = useState('room')
  const [sortDir,    setSortDir]    = useState('asc')

  const [detail,     setDetail]     = useState(null)

  const [moveInBed,  setMoveInBed]  = useState(null)
  const [moveOutT,   setMoveOutT]   = useState(null)
  const [transferT,  setTransferT]  = useState(null)
  const [correctRateT, setCorrectRateT] = useState(null)
  const [correctMoveInT, setCorrectMoveInT] = useState(null)
  const [saving,    setSaving]    = useState(false)
  const [resPayments, setResPayments] = useState([])
  const [resLoading,  setResLoading]  = useState(false)
  const [resError,    setResError]    = useState('')
  const [otherReserved, setOtherReserved] = useState([])

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

  const allEnriched = useMemo(() =>
    tenants.map(t => ({
      ...t,
      room_no:      t.beds?.rooms?.room_no   || '',
      room_type:    t.beds?.rooms?.room_type || '',
      room_id:      t.beds?.room_id          || null,
      bed_letter:   t.beds?.bed_letter       || '',
      bed_location: t.beds?.bed_location     || '',
      outDate:      t.is_active ? t.move_out_date : (t.actual_move_out_date || t.move_out_date),
    })),
  [tenants])

  const enriched = useMemo(() => allEnriched.filter(t => t.is_active), [allEnriched])
  const inHouse  = useMemo(() => allEnriched.filter(isInHouse), [allEnriched])
  const movedOutCount = useMemo(() => allEnriched.filter(t => !t.is_active).length, [allEnriched])
  const detailSiblingIds = useMemo(() => (detail ? siblingIdsFor(detail, allEnriched) : []), [detail, allEnriched])

  const eligibleBeds = useMemo(() => moveInEligibleBeds(beds, tenants), [beds, tenants])

  // HELD reservation money belongs to the selected bed; re-fetched whenever another bed is picked.
  const moveInBedId = moveInBed?.bed_id ?? null
  const moveInReserved = moveInBed?.status === 'RESERVED'
  useEffect(() => {
    setResPayments([]); setResError('')
    if (moveInBedId == null || !moveInReserved) { setResLoading(false); return }
    let cancelled = false
    setResLoading(true)
    fetchReservationPayments({ bedId: moveInBedId, statuses: ['HELD'] })
      .then(rows => { if (!cancelled) setResPayments(rows) })
      .catch(e => { if (!cancelled) setResError(e.message) })
      .finally(() => { if (!cancelled) setResLoading(false) })
    return () => { cancelled = true }
  }, [moveInBedId, moveInReserved])

  // For the "name matches a different reserved bed that holds money" warning; best-effort.
  const moveInOpen = moveInBedId != null
  useEffect(() => {
    if (!moveInOpen) { setOtherReserved([]); return }
    let cancelled = false
    fetchAllReservationPayments({ statuses: ['HELD'] })
      .then(rows => {
        if (cancelled) return
        const byBed = new Map()
        for (const r of rows) {
          const cur = byBed.get(r.bed_id) || {
            bed_id: r.bed_id, reserved_name: r.reserved_name,
            room_no: r.beds?.rooms?.room_no, bed_letter: r.beds?.bed_letter, totalCents: 0,
          }
          cur.totalCents += dbToCents(r.amount)
          byBed.set(r.bed_id, cur)
        }
        setOtherReserved([...byBed.values()])
      })
      .catch(() => { if (!cancelled) setOtherReserved([]) })
    return () => { cancelled = true }
  }, [moveInOpen])

  // Deep-link from Dashboard drill-down modals — resolves the tenant whether
  // currently active or since moved out (allEnriched is unfiltered). Consumes
  // location.state once (replace-navigates it away) so a later, unrelated
  // reload/refetch doesn't re-trigger this effect and pop the modal back open
  // after the user has explicitly closed it.
  useEffect(() => {
    const id = location.state?.openTenantId
    if (id == null || loading) return
    const t = allEnriched.find(t => t.id === id)
    if (t) {
      setDetail(t)
      navigate(location.pathname, { replace: true, state: null })
    }
  }, [location.state, allEnriched, loading, location.pathname, navigate])

  const filtered = useMemo(() => {
    const q = search.toLowerCase()
    const base = isCurrentScope || statFilter === 'CURRENT' ? inHouse
               : statFilter === 'MOVED_OUT' ? allEnriched.filter(t => !t.is_active)
               : allEnriched
    return base.filter(t => {
      if (roomFilter && t.room_no !== roomFilter) return false
      if (q && !(t.name || '').toLowerCase().includes(q)
           && !(t.room_no || '').includes(q)
           && !(t.bed_letter || '').toLowerCase().includes(q)
           && !(t.unit_label || '').toLowerCase().includes(q)) return false
      return true
    })
  }, [allEnriched, inHouse, isCurrentScope, search, statFilter, roomFilter])

  const sorted = useMemo(() => {
    const val = (t, key) => {
      switch (key) {
        case 'name':    return (t.name || '').toLowerCase()
        case 'room':    return roomKey(t)
        case 'bed':     return (t.bed_letter || '')
        case 'rate':    return Number(t.rate) || 0
        case 'movein':  return t.move_in_date  || ''
        case 'moveout': return t.outDate || ''
        default:        return ''
      }
    }
    return [...filtered].sort((a, b) => {
      const av = val(a, sortKey), bv = val(b, sortKey)
      let c = av < bv ? -1 : av > bv ? 1 : 0
      if (c !== 0) return sortDir === 'asc' ? c : -c
      const ra = roomKey(a), rb = roomKey(b)
      if (ra !== rb) return ra - rb
      return (a.bed_letter || '').localeCompare(b.bed_letter || '')
    })
  }, [filtered, sortKey, sortDir])

  function handleSort(key) {
    if (key === sortKey) setSortDir(d => d === 'asc' ? 'desc' : 'asc')
    else { setSortKey(key); setSortDir('asc') }
    setPage(0)
  }
  function handleStatFilter(value) {
    setStatFilter(value)
    setSortKey('room'); setSortDir('asc')
    setPage(0)
  }
  const arrow = key => key === sortKey ? (sortDir === 'asc' ? ' ▲' : ' ▼') : ''

  const pageRows   = sorted.slice(page * PAGE, (page + 1) * PAGE)
  const totalPages = Math.ceil(sorted.length / PAGE)

  async function handleMoveIn(data) {
    if (!moveInBed) return
    setSaving(true)
    try {
      const { contacts = [], emails = [], docs = [], receipts, ...tenantData } = data
      // Stops BEFORE the tenant is created if the receipts RPC is not deployed yet.
      await assertMoveInReceiptsAvailable()
      const tenant = await addTenant(moveInBed.bed_id, {
        ...tenantData,
        _room_no:    moveInBed.room_no,
        _bed_letter: moveInBed.bed_letter,
      })

      let depositError = null
      try {
        await recordMoveInReceipts(tenant.id, receipts)
      } catch(depErr) {
        depositError = depErr
      }

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
      if (depositError) {
        show(`${tenant.name} was moved in, but the advance/deposit was NOT recorded: ${depositError.message}. An admin can add them from the tenant profile (Advance & Deposit tab). If this bed already had a reservation payment recorded, do not retype it: open the tenant's Advance & Deposit tab and use Apply reservation payment. Any reservation payment lines typed in Move In were NOT saved either; an admin can add them as Deposit receipts from that tab.`, 'error', { duration: 20000 })
      } else {
        show('Tenant moved in!', 'success')
      }
      load()
    } catch(e) { show(e.message, 'error') }
    setSaving(false)
  }

  // Errors propagate to the modal, which shows them in full (they say exactly which steps ran).
  // The list reloads when the modal closes: reloading now would unmount the modal's result screen.
  const moveOutAttempted = useRef(false)
  async function handleMoveOut({ moveOut, items, vacated, groupTenantIds }) {
    moveOutAttempted.current = true
    return processMoveOutGroup(
      items.map(i => ({ ...i, tenant: { ...i.tenant, _room_no: i.tenant.room_no, _bed_letter: i.tenant.bed_letter } })),
      moveOut, user?.id, { vacated: { ...vacated, by: user?.email || user?.id }, groupTenantIds },
    )
  }
  function closeMoveOut() {
    setMoveOutT(null)
    if (moveOutAttempted.current) { moveOutAttempted.current = false; load() }
  }

  if (loading) return (
    <div className="loading-screen"><div className="spinner" /></div>
  )

  return (
    <div className="page">
      {/* ── Header ── */}
      <div className="page-header">
        <div>
          <h1 className="page-title">{isCurrentScope ? 'Current Tenants' : 'Tenants'}</h1>
          <p className="page-sub">
            {isCurrentScope
              ? `${inHouse.length} in-house tenants · ${inHouse.filter(t => t.category !== 'COMMERCIAL').length} bed · ${inHouse.filter(t => t.category === 'COMMERCIAL').length} commercial`
              : `${allEnriched.length} tenants · ${inHouse.length} in-house · ${movedOutCount} moved out`
                + (enriched.length > inHouse.length ? ` · ${enriched.length - inHouse.length} active parking/other` : '')}
          </p>
        </div>
        <button
          className="btn primary"
          onClick={() => {
            const inRoom = eligibleBeds.filter(b => !roomFilter || b.room_no === roomFilter)
            const free = inRoom.find(b => b.status === 'VACANT') || inRoom[0]
            if (free) setMoveInBed(free)
            else show('No vacant or reserved beds available.', 'error')
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
        {!isCurrentScope && (
          <select value={statFilter} onChange={e => handleStatFilter(e.target.value)}
            className="px-3 py-2 border border-line rounded-lg text-[13px] bg-surface focus:outline-none focus:ring-2 focus:ring-navy-700/25 focus:border-navy-600 transition-colors">
            <option value="ALL">All tenants</option>
            <option value="CURRENT">Current (in-house)</option>
            <option value="MOVED_OUT">Moved out</option>
          </select>
        )}
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
              <th onClick={() => handleSort('moveout')} className="cursor-pointer select-none">{statFilter === 'MOVED_OUT' ? 'Moved Out' : 'Move Out'}{arrow('moveout')}</th>
              <th>Actions</th>
            </tr>
          </thead>
          <tbody>
            {pageRows.length === 0
              ? <tr><td colSpan={7}><div className="empty"><SearchX size={28} className="mx-auto mb-3 text-ink-faint" /><p>No tenants found</p></div></td></tr>
              : pageRows.map(t => (
                <tr key={t.id} className="group">
                  <td className="td-name">
                    {t.name}
                    {statFilter === 'ALL' && !t.is_active && (
                      <span className="ml-2 text-[10px] font-bold px-1.5 py-0.5 rounded bg-surface-3 text-ink-muted">Moved out</span>
                    )}
                    {!t.bed_id && CATEGORY_LABEL[t.category] && (
                      <span className="ml-2 text-[10px] font-bold px-1.5 py-0.5 rounded bg-info-bg text-info-text">{CATEGORY_LABEL[t.category]}</span>
                    )}
                  </td>
                  <td className="font-medium text-ink-secondary">{t.bed_id ? (t.room_no || '—') : (t.unit_label || '—')}</td>
                  <td>
                    <span className="font-bold text-ink">{t.bed_letter || '—'}</span>
                    {t.bed_location && <span className="text-ink-faint text-[11px] ml-1">{t.bed_location}</span>}
                  </td>
                  <td className="td-rate">{fmt(t.rate)}</td>
                  <td className="text-[12px] text-ink-muted">{fmtDate(t.move_in_date)}</td>
                  <td className="text-[12px] text-ink-muted">{fmtDate(t.outDate)}</td>
                  <td>
                    <div className="flex gap-1.5 opacity-0 group-hover:opacity-100 transition-opacity duration-150">
                      <button className="btn-xs blue"  onClick={() => setDetail(t)}>
                        <Eye size={10} /> View
                      </button>
                      {t.is_active && t.bed_id && (
                        <button className="btn-xs red" onClick={() => setMoveOutT(t)}>
                          <LogOut size={10} /> Move Out
                        </button>
                      )}
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
          siblingIds={detailSiblingIds}
          onClose={() => setDetail(null)}
          onTransfer={t => { setDetail(null); setTransferT(t) }}
          onMoveOut={t => { setDetail(null); setMoveOutT(t) }}
          onCorrectRate={t => { setDetail(null); setCorrectRateT(t) }}
          onCorrectMoveIn={t => { setDetail(null); setCorrectMoveInT(t) }}
        />
      )}

      {/* Move In / Move Out / Transfer modals */}
      {moveInBed && (
        <MoveInModal
          bed={moveInBed}
          allBeds={eligibleBeds}
          onBedChange={setMoveInBed}
          onClose={() => setMoveInBed(null)}
          onSubmit={handleMoveIn}
          saving={saving}
          reservationPayments={resPayments}
          reservationLoading={resLoading}
          reservationError={resError}
          otherReservedWithMoney={otherReserved}
        />
      )}
      {moveOutT && (
        <MoveOutModal
          bed={moveOutT}
          tenants={enriched}
          onClose={closeMoveOut}
          onSubmit={handleMoveOut}
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
      {correctRateT && (
        <CorrectRateModal
          tenant={correctRateT}
          onClose={() => setCorrectRateT(null)}
          onDone={() => {
            setCorrectRateT(null)
            show('Tenant rate corrected.', 'success')
            load()
          }}
        />
      )}

      {correctMoveInT && (
        <CorrectMoveInModal
          tenant={correctMoveInT}
          onClose={() => setCorrectMoveInT(null)}
          onDone={() => {
            setCorrectMoveInT(null)
            show('Tenant move-in date corrected.', 'success')
            load()
          }}
        />
      )}

      {ToastEl}
    </div>
  )
}
