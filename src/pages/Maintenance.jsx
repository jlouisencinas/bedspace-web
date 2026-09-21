import { useState, useEffect, useMemo, useCallback } from 'react'
import { fetchTickets, fetchTenants, fetchRooms } from '../lib/supabase'
import { useAuth } from '../lib/auth'
import { useToast } from '../components/Toast'
import NewTicketModal     from '../components/NewTicketModal'
import ResolveTicketModal from '../components/ResolveTicketModal'
import TicketDetailModal  from '../components/TicketDetailModal'
import SearchInput from '../components/SearchInput'
import { Wrench, Plus, CheckCircle, Hammer } from 'lucide-react'

function fmtDateTime(d) {
  if (!d) return '—'
  return new Date(d).toLocaleString('en-PH', {
    month: 'short', day: 'numeric', year: 'numeric',
    hour: 'numeric', minute: '2-digit',
  })
}

// ── Maintenance Page ──────────────────────────────────────────────────────────

export default function Maintenance() {
  const { isAdmin, isUser } = useAuth()
  const [tickets,      setTickets]      = useState([])
  const [rooms,        setRooms]        = useState([])
  const [tenants,      setTenants]      = useState([])
  const [loading,      setLoading]      = useState(true)
  const [roomFilter,   setRoomFilter]   = useState('')
  const [statusFilter, setStatusFilter] = useState('PENDING')
  const [search,       setSearch]       = useState('')
  const [newModal,     setNewModal]     = useState(false)
  const [resolveT,     setResolveT]     = useState(null)
  const [detailT,      setDetailT]      = useState(null)
  const { show, ToastEl } = useToast()

  const canWrite = isAdmin || isUser

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const [t, roomRows, tenantRows] = await Promise.all([
        fetchTickets({ roomId: roomFilter || undefined, status: statusFilter || undefined }),
        fetchRooms(),
        fetchTenants(),
      ])
      setTickets(t)
      setRooms(roomRows || [])
      setTenants(tenantRows.filter(t => t.is_active))
    } catch(e) { show(e.message, 'error') }
    setLoading(false)
  }, [roomFilter, statusFilter])

  useEffect(() => { load() }, [load])

  const filtered = useMemo(() => {
    const q = search.toLowerCase()
    if (!q) return tickets
    return tickets.filter(t =>
      (t.concern || '').toLowerCase().includes(q) ||
      (t.tenants?.name || '').toLowerCase().includes(q) ||
      (t.rooms?.room_no || '').includes(q)
    )
  }, [tickets, search])

  const pendingCount = tickets.filter(t => t.status === 'PENDING').length

  return (
    <div className="page">
      {ToastEl}

      {/* ── Header ── */}
      <div className="page-header">
        <div>
          <h1 className="page-title">
            Room Maintenance
            {pendingCount > 0 && (
              <span className="ml-2 inline-flex items-center px-2 py-0.5 rounded-full text-[11px] font-bold bg-red-600 text-white align-middle">
                {pendingCount}
              </span>
            )}
          </h1>
          <p className="page-sub">Track and resolve maintenance concerns for rooms and tenants</p>
        </div>
        {canWrite && (
          <button className="btn primary" onClick={() => setNewModal(true)}>
            <Plus size={14} /> New Ticket
          </button>
        )}
      </div>

      {/* ── Toolbar ── */}
      <div className="toolbar">
        <SearchInput
          placeholder="Search concern, tenant, room…"
          value={search} onChange={e => setSearch(e.target.value)}
          className="w-64"
        />
        <select value={roomFilter} onChange={e => setRoomFilter(e.target.value)}
          className="px-3 py-2 border border-line rounded-lg text-[13px] bg-surface focus:outline-none focus:ring-2 focus:ring-navy-700/25 transition-colors">
          <option value="">All Rooms</option>
          {rooms.map(r => <option key={r.id} value={r.id}>Room {r.room_no}</option>)}
        </select>
        <select value={statusFilter} onChange={e => setStatusFilter(e.target.value)}
          className="px-3 py-2 border border-line rounded-lg text-[13px] bg-surface focus:outline-none focus:ring-2 focus:ring-navy-700/25 transition-colors">
          <option value="PENDING">Pending</option>
          <option value="RESOLVED">Resolved</option>
          <option value="">All</option>
        </select>
      </div>

      {loading ? (
        <div className="loading-screen"><div className="spinner" /></div>
      ) : filtered.length === 0 ? (
        <div className="empty">
          <Hammer size={32} className="mx-auto mb-3 text-ink-faint" />
          <p>{statusFilter === 'PENDING' ? 'No open tickets — all clear!' : 'No tickets found.'}</p>
        </div>
      ) : (
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Room</th>
                <th>Tenant</th>
                <th>Concern</th>
                <th>Remarks</th>
                <th>Raised</th>
                <th>Status</th>
                <th>Resolution</th>
                {canWrite && <th></th>}
              </tr>
            </thead>
            <tbody>
              {filtered.map(t => (
                <tr key={t.id} className="cursor-pointer hover:bg-surface-2" onClick={() => setDetailT(t)}>
                  <td className="font-semibold text-ink whitespace-nowrap">
                    {t.rooms?.room_no ? `Room ${t.rooms.room_no}` : '—'}
                  </td>
                  <td>
                    {t.tenants?.name || <span className="text-ink-faint italic">Staff-raised</span>}
                  </td>
                  <td className="font-medium text-ink">{t.concern}</td>
                  <td className="text-[12px] max-w-[160px] truncate" title={t.remarks}>
                    {t.remarks || '—'}
                  </td>
                  <td className="text-[11px] text-ink-faint whitespace-nowrap">{fmtDateTime(t.raised_at)}</td>
                  <td>
                    {t.status === 'PENDING' ? (
                      <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-[11px] font-semibold bg-warning-bg text-warning-text">
                        <span className="w-1.5 h-1.5 rounded-full bg-amber-500" />PENDING
                      </span>
                    ) : (
                      <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-[11px] font-semibold bg-success-bg text-success-text">
                        <span className="w-1.5 h-1.5 rounded-full bg-emerald-500" />RESOLVED
                      </span>
                    )}
                  </td>
                  <td className="text-[12px] text-ink-muted max-w-[200px]">
                    {t.resolution_notes
                      ? <span title={t.resolution_notes}>{t.resolution_notes}</span>
                      : t.status === 'RESOLVED'
                        ? <span className="text-ink-faint">—</span>
                        : null}
                    {t.resolved_at && (
                      <div className="text-[11px] text-ink-faint mt-0.5">{fmtDateTime(t.resolved_at)}</div>
                    )}
                  </td>
                  {canWrite && (
                    <td>
                      {t.status === 'PENDING' && (
                        <button className="btn-xs green" onClick={e => { e.stopPropagation(); setResolveT(t) }}>
                          <CheckCircle size={11} /> Resolve
                        </button>
                      )}
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {newModal && (
        <NewTicketModal
          rooms={rooms}
          tenants={tenants}
          onClose={() => setNewModal(false)}
          onSaved={() => { setNewModal(false); show('Ticket raised.', 'success'); load() }}
        />
      )}

      {resolveT && (
        <ResolveTicketModal
          ticket={resolveT}
          onClose={() => setResolveT(null)}
          onSaved={() => { setResolveT(null); show('Ticket resolved.', 'success'); load() }}
        />
      )}

      {detailT && (
        <TicketDetailModal
          ticket={detailT}
          canWrite={canWrite}
          onClose={() => setDetailT(null)}
          onResolve={(t) => { setDetailT(null); setResolveT(t) }}
        />
      )}
    </div>
  )
}
