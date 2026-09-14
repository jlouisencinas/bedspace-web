import { useState, useEffect, useMemo } from 'react'
import { fetchBeds, updateBedStatus, logBedStatusChange } from '../lib/supabase'
import { useToast } from '../components/Toast'
import { useAuth } from '../lib/auth'
import { Search, SearchX, X } from 'lucide-react'

function statusClass(s) {
  if (!s) return 'vacant'
  switch (s.toUpperCase()) {
    case 'LEASED':       return 'leased'
    case 'RESERVED':     return 'reserved'
    case 'OUT OF ORDER': return 'oor'
    case 'REMOVED':      return 'removed'
    default:             return 'vacant'
  }
}

function BedStatusBadge({ status }) {
  const MAP = {
    'LEASED':        { label: 'Leased',   cls: 'bg-blue-50 text-blue-700 border border-blue-100' },
    'VACANT':        { label: 'Vacant',   cls: 'bg-emerald-50 text-emerald-700 border border-emerald-100' },
    'RESERVED':      { label: 'Reserved', cls: 'bg-navy-100 text-navy-700 border border-navy-200' },
    'OUT OF ORDER':  { label: 'OOO',      cls: 'bg-slate-100 text-slate-500 border border-slate-200' },
  }
  const s = status?.toUpperCase()
  const c = MAP[s] || MAP['VACANT']
  return (
    <span className={`text-[9px] font-bold uppercase tracking-wider px-1.5 py-0.5 rounded-full whitespace-nowrap shrink-0 ${c.cls}`}>
      {c.label}
    </span>
  )
}

// ── Status Change Modal ────────────────────────────────────────────────────────

const STATUS_ACTIONS = {
  VACANT:        [{ to: 'RESERVED', label: 'Reserve' }, { to: 'OUT OF ORDER', label: 'Out of Order' }],
  RESERVED:      [{ to: 'VACANT',   label: 'Remove Reservation' }, { to: 'OUT OF ORDER', label: 'Out of Order' }],
  'OUT OF ORDER': [{ to: 'VACANT',  label: 'Mark Vacant' }, { to: 'RESERVED', label: 'Reserve' }],
}

function BedStatusModal({ bed, onClose, onSaved }) {
  const [pending,  setPending]  = useState(null)
  const [name,     setName]     = useState(bed.reserved_name || '')
  const [saving,   setSaving]   = useState(false)
  const [error,    setError]    = useState('')

  const current  = (bed.status || 'VACANT').toUpperCase()
  const actions  = STATUS_ACTIONS[current] || STATUS_ACTIONS.VACANT
  const needName = pending === 'RESERVED'

  async function handleConfirm() {
    if (!pending) return
    if (needName && !name.trim()) { setError('Please enter the name of the person reserving this bed.'); return }
    setSaving(true)
    setError('')
    try {
      const resolvedName = needName ? name.trim() : null
      await updateBedStatus(bed.bed_id, pending, resolvedName)
      logBedStatusChange(bed, pending, resolvedName).catch(() => {})
      onSaved(bed.bed_id, pending, resolvedName)
      onClose()
    } catch(e) { setError(e.message) }
    setSaving(false)
  }

  return (
    <div className="overlay" onClick={e => e.stopPropagation()}>
      <div className="modal" style={{ maxWidth: 400 }}>
        <div className="modal-head">
          <h3>Bed {bed.bed_letter} · Room {bed.room_no}</h3>
          <button className="btn-close" onClick={onClose}><X size={16} /></button>
        </div>

        <div className="modal-body">
          <div className="flex items-center gap-2 mb-5">
            <span className="text-[13px] text-slate-500">Current status:</span>
            <BedStatusBadge status={bed.status || 'VACANT'} />
            {current === 'RESERVED' && bed.reserved_name && (
              <span className="text-[13px] text-slate-700 font-medium">— {bed.reserved_name}</span>
            )}
          </div>

          <div className="flex flex-col gap-2 mb-4">
            {actions.map(a => (
              <button
                key={a.to}
                type="button"
                onClick={() => { setPending(a.to); setError('') }}
                className={`w-full text-left px-4 py-3 rounded-xl border text-[13px] font-medium transition-colors ${
                  pending === a.to
                    ? 'border-navy-600 bg-navy-50 text-navy-800'
                    : 'border-slate-200 bg-white text-slate-700 hover:bg-slate-50'
                }`}
              >
                {a.to === 'RESERVED'      && '🔖 '}
                {a.to === 'VACANT'        && '✅ '}
                {a.to === 'OUT OF ORDER'  && '🔧 '}
                {a.label}
              </button>
            ))}
          </div>

          {needName && (
            <div className="mb-1">
              <label className="block text-[12px] font-semibold text-slate-600 mb-1.5">
                Reserved for *
              </label>
              <input
                type="text"
                value={name}
                onChange={e => { setName(e.target.value); setError('') }}
                placeholder="Full name of person reserving"
                autoFocus
                onKeyDown={e => e.key === 'Enter' && handleConfirm()}
                className="w-full px-3 py-2 text-[13px] rounded-lg border border-slate-200 focus:outline-none focus:ring-2 focus:ring-navy-700/25 focus:border-navy-600 transition-colors"
              />
            </div>
          )}

          {error && (
            <p className="mt-2 text-[12px] text-red-600">{error}</p>
          )}
        </div>

        <div className="modal-foot">
          <button className="btn secondary" onClick={onClose}>Cancel</button>
          <button
            className="btn primary"
            disabled={!pending || saving}
            onClick={handleConfirm}
          >
            {saving ? 'Saving…' : 'Confirm'}
          </button>
        </div>
      </div>
    </div>
  )
}

// ── BedMap Page ────────────────────────────────────────────────────────────────

export default function BedMap() {
  const [beds,        setBeds]        = useState([])
  const [loading,     setLoading]     = useState(true)
  const [search,      setSearch]      = useState('')
  const [typeFilter,  setTypeFilter]  = useState('')
  const [statFilter,  setStatFilter]  = useState('')
  const [statusModal, setStatusModal] = useState(null)
  const { show, ToastEl } = useToast()
  const { isViewer } = useAuth()

  async function load() {
    setLoading(true)
    try { setBeds(await fetchBeds()) } catch (e) { show(e.message, 'error') }
    setLoading(false)
  }
  useEffect(() => { load() }, [])

  function handleSaved(bedId, newStatus, newName) {
    setBeds(prev => prev.map(b =>
      b.bed_id === bedId
        ? { ...b, status: newStatus, reserved_name: newStatus === 'RESERVED' ? newName : null }
        : b
    ))
    const label = newStatus === 'OUT OF ORDER' ? 'Out of Order' : newStatus.charAt(0) + newStatus.slice(1).toLowerCase()
    show(`Bed updated to ${label}.`, 'success')
  }

  const roomTypes = useMemo(() =>
    [...new Set(beds.map(b => b.room_type).filter(Boolean))].sort(), [beds])

  const grouped = useMemo(() => {
    const q = search.toLowerCase()
    const map = {}
    beds.forEach(b => {
      if (b.status === 'REMOVED') return
      if (typeFilter && b.room_type !== typeFilter) return
      if (statFilter && b.status !== statFilter)    return
      if (q && !b.room_no.includes(q)
           && !(b.tenant_name   || '').toLowerCase().includes(q)
           && !(b.reserved_name || '').toLowerCase().includes(q)) return
      if (!map[b.room_no]) map[b.room_no] = { room_type: b.room_type, floor: b.floor, beds: [] }
      map[b.room_no].beds.push(b)
    })
    Object.values(map).forEach(r => r.beds.sort((a,b) => a.bed_letter.localeCompare(b.bed_letter)))
    return Object.entries(map).sort((a,b) => parseInt(a[0]) - parseInt(b[0]))
  }, [beds, search, typeFilter, statFilter])

  if (loading) return (
    <div className="loading-screen">
      <div className="spinner" />
      <span className="text-navy-500 font-semibold text-sm">Loading…</span>
    </div>
  )

  const totalBeds = beds.filter(b => b.status !== 'REMOVED').length
  const leased    = beds.filter(b => b.status === 'LEASED').length
  const vacant    = beds.filter(b => b.status === 'VACANT').length
  const reserved  = beds.filter(b => b.status === 'RESERVED').length

  return (
    <div className="page max-w-[1600px]">
      {ToastEl}

      {/* ── Header ── */}
      <div className="page-header">
        <div>
          <h1 className="page-title">Bed Map</h1>
          <p className="page-sub">
            {totalBeds} beds · {leased} occupied · {vacant} vacant · {reserved} reserved
          </p>
        </div>
        <div className="hidden md:flex items-center gap-4 text-[11px] font-semibold">
          {[
            { cls: 'bg-blue-500',    label: 'Leased'   },
            { cls: 'bg-emerald-500', label: 'Vacant'   },
            { cls: 'bg-navy-500',    label: 'Reserved' },
            { cls: 'bg-slate-300',   label: 'OOO'      },
          ].map(({ cls, label }) => (
            <div key={label} className="flex items-center gap-1.5 text-slate-500">
              <span className={`w-2.5 h-2.5 rounded-full ${cls}`} />
              {label}
            </div>
          ))}
        </div>
      </div>

      {/* ── Toolbar ── */}
      <div className="toolbar">
        <div className="relative">
          <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" />
          <input
            type="search"
            placeholder="Search room, tenant or reserved name…"
            value={search}
            onChange={e => setSearch(e.target.value)}
            className="pl-9 pr-3 py-2 rounded-lg text-[13px] bg-white w-64
                       focus:outline-none focus:ring-2 focus:ring-navy-700/25 focus:border-navy-600 transition-colors"
            style={{ border: '1px solid #E8E2D9' }}
          />
        </div>
        <select
          value={typeFilter}
          onChange={e => setTypeFilter(e.target.value)}
          className="px-3 py-2 rounded-lg text-[13px] bg-white
                     focus:outline-none focus:ring-2 focus:ring-navy-700/25 focus:border-navy-600 transition-colors"
          style={{ border: '1px solid #E8E2D9' }}
        >
          <option value="">All Room Types</option>
          {roomTypes.map(t => <option key={t} value={t}>{t}</option>)}
        </select>
        <select
          value={statFilter}
          onChange={e => setStatFilter(e.target.value)}
          className="px-3 py-2 rounded-lg text-[13px] bg-white
                     focus:outline-none focus:ring-2 focus:ring-navy-700/25 focus:border-navy-600 transition-colors"
          style={{ border: '1px solid #E8E2D9' }}
        >
          <option value="">All Statuses</option>
          <option value="LEASED">Leased</option>
          <option value="VACANT">Vacant</option>
          <option value="RESERVED">Reserved</option>
          <option value="OUT OF ORDER">Out of Order</option>
        </select>
      </div>

      {/* ── Grid ── */}
      {grouped.length === 0 ? (
        <div className="empty">
          <SearchX size={32} className="mx-auto mb-3 text-slate-300" />
          <p>No rooms match your filter</p>
        </div>
      ) : (
        <div className="rooms-grid">
          {grouped.map(([roomNo, room]) => {
            const occ = room.beds.filter(b => b.status === 'LEASED').length
            return (
              <div key={roomNo} className="room-card">
                <div className="room-card-head">
                  <div>
                    <div className="room-no">Room {roomNo}</div>
                    <div className="room-type">{room.room_type}</div>
                  </div>
                  <div className="text-right">
                    <div className="room-occ">{occ}/{room.beds.length}</div>
                    <div className="text-[10px] text-right" style={{ color: 'rgba(28,23,20,0.50)' }}>occupied</div>
                  </div>
                </div>

                <div className="bed-list">
                  {room.beds.map(b => {
                    const cls       = statusClass(b.status)
                    const rate      = b.rate || b.default_rate
                    const isLeased  = b.status === 'LEASED'
                    const clickable = !isLeased && !isViewer
                    return (
                      <div
                        key={b.bed_id}
                        className={`bed-row transition-colors ${clickable ? 'cursor-pointer hover:bg-slate-50 rounded-lg -mx-1 px-1' : ''}`}
                        onClick={clickable ? () => setStatusModal(b) : undefined}
                        title={clickable ? 'Click to change status' : undefined}
                      >
                        <div className={`bed-dot ${cls}`}>{b.bed_letter}</div>
                        <div className="bed-info">
                          {b.bed_location && (
                            <div className="bed-location">{b.bed_location}</div>
                          )}
                          {isLeased && b.tenant_name ? (
                            <div className="bed-name">{b.tenant_name}</div>
                          ) : b.status === 'RESERVED' && b.reserved_name ? (
                            <div className="bed-name text-navy-600">{b.reserved_name}</div>
                          ) : null}
                          {rate ? (
                            <div className="bed-rate">
                              ₱{Number(rate).toLocaleString('en-PH')}
                            </div>
                          ) : null}
                        </div>
                        <BedStatusBadge status={b.status} />
                      </div>
                    )
                  })}
                </div>
              </div>
            )
          })}
        </div>
      )}

      {statusModal && (
        <BedStatusModal
          bed={statusModal}
          onClose={() => setStatusModal(null)}
          onSaved={handleSaved}
        />
      )}
    </div>
  )
}
