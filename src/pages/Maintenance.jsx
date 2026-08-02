import { useState, useEffect, useMemo, useCallback } from 'react'
import { fetchTickets, fetchTenants, addTicket, resolveTicket, supabase } from '../lib/supabase'
import { useAuth } from '../lib/auth'
import { useToast } from '../components/Toast'
import { Wrench, Plus, CheckCircle, Search, Hammer, X } from 'lucide-react'

function fmtDateTime(d) {
  if (!d) return '—'
  return new Date(d).toLocaleString('en-PH', {
    month: 'short', day: 'numeric', year: 'numeric',
    hour: 'numeric', minute: '2-digit',
  })
}

// ── New Ticket Modal ───────────────────────────────────────────────────────────

function NewTicketModal({ rooms, tenants, onClose, onSaved }) {
  const [form, setForm] = useState({ room_id: '', tenant_id: '', concern: '', remarks: '' })
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  const set = (k, v) => setForm(f => ({ ...f, [k]: v }))

  // Tenants that live in the selected room
  const roomTenants = useMemo(() => {
    if (!form.room_id) return tenants
    return tenants.filter(t => String(t.beds?.room_id) === String(form.room_id))
  }, [tenants, form.room_id])

  async function handleSubmit(e) {
    e.preventDefault()
    if (!form.room_id) { setError('Please select a room.'); return }
    if (!form.concern.trim()) { setError('Concern is required.'); return }
    setBusy(true); setError('')
    try {
      await addTicket({
        roomId:    Number(form.room_id),
        tenantId:  form.tenant_id ? Number(form.tenant_id) : null,
        concern:   form.concern.trim(),
        remarks:   form.remarks.trim() || null,
      })
      onSaved()
    } catch(err) {
      setError(err.message)
      setBusy(false)
    }
  }

  return (
    <div className="overlay" onClick={e => e.stopPropagation()}>
      <div className="modal modal-sm">
        <div className="modal-head">
          <h3>New Maintenance Ticket</h3>
          <button className="btn-close" onClick={onClose}><X size={16} /></button>
        </div>
        <form onSubmit={handleSubmit}>
          <div className="modal-body">
            <div className="form-grid">
              <div className="fg full">
                <label>Room <span className="text-red-600">*</span></label>
                <select
                  value={form.room_id}
                  onChange={e => { set('room_id', e.target.value); set('tenant_id', '') }}
                  required
                >
                  <option value="">— Select room —</option>
                  {rooms.map(r => (
                    <option key={r.id} value={r.id}>Room {r.room_no} · {r.room_type}</option>
                  ))}
                </select>
              </div>
              <div className="fg full">
                <label>Raised by Tenant (optional)</label>
                <select
                  value={form.tenant_id}
                  onChange={e => set('tenant_id', e.target.value)}
                >
                  <option value="">— Staff-raised / anonymous —</option>
                  {roomTenants.map(t => (
                    <option key={t.id} value={t.id}>{t.name}</option>
                  ))}
                </select>
              </div>
              <div className="fg full">
                <label>Concern <span className="text-red-600">*</span></label>
                <input
                  type="text"
                  value={form.concern}
                  onChange={e => { setError(''); set('concern', e.target.value) }}
                  placeholder="e.g. aircon leak, clogged drain"
                  required
                />
              </div>
              <div className="fg full">
                <label>Remarks (optional)</label>
                <textarea rows={2} value={form.remarks} onChange={e => set('remarks', e.target.value)} placeholder="Additional details…" />
              </div>
            </div>
            {error && (
              <div className="mt-3 p-3 bg-red-50 text-red-700 text-[13px] rounded-xl border border-red-100">{error}</div>
            )}
          </div>
          <div className="modal-foot">
            <button type="button" className="btn secondary" onClick={onClose}>Cancel</button>
            <button type="submit" className="btn primary" disabled={busy}>
              {busy ? 'Saving…' : '+ Raise Ticket'}
            </button>
          </div>
        </form>
      </div>
    </div>
  )
}

// ── Resolve Modal ─────────────────────────────────────────────────────────────

function ResolveModal({ ticket, onClose, onSaved }) {
  const [notes, setNotes] = useState('')
  const [busy,  setBusy]  = useState(false)
  const [error, setError] = useState('')

  async function handleSubmit(e) {
    e.preventDefault()
    setBusy(true); setError('')
    try {
      await resolveTicket(ticket.id, notes.trim() || null)
      onSaved()
    } catch(err) {
      setError(err.message)
      setBusy(false)
    }
  }

  const room   = ticket.rooms?.room_no  ? `Room ${ticket.rooms.room_no}` : '—'
  const tenant = ticket.tenants?.name   || 'Staff-raised'

  return (
    <div className="overlay" onClick={e => e.stopPropagation()}>
      <div className="modal modal-sm">
        <div className="modal-head">
          <h3>Resolve Ticket</h3>
          <button className="btn-close" onClick={onClose}><X size={16} /></button>
        </div>
        <form onSubmit={handleSubmit}>
          <div className="modal-body space-y-4">
            <div className="bg-slate-50 border border-slate-100 rounded-xl px-4 py-3 text-[13px]">
              <div className="font-semibold text-slate-900 mb-1">{ticket.concern}</div>
              <div className="text-slate-500">{room} · {tenant} · Raised {fmtDateTime(ticket.raised_at)}</div>
              {ticket.remarks && <div className="mt-1.5 text-slate-600 italic">{ticket.remarks}</div>}
            </div>
            <div className="fg">
              <label>Resolution notes (optional)</label>
              <textarea
                rows={3}
                value={notes}
                onChange={e => setNotes(e.target.value)}
                placeholder="Describe what was done to resolve this issue…"
              />
            </div>
            {error && (
              <div className="p-3 bg-red-50 text-red-700 text-[13px] rounded-xl border border-red-100">{error}</div>
            )}
          </div>
          <div className="modal-foot">
            <button type="button" className="btn secondary" onClick={onClose}>Cancel</button>
            <button type="submit" className="btn success" disabled={busy}>
              {busy ? 'Saving…' : 'Mark Resolved'}
            </button>
          </div>
        </form>
      </div>
    </div>
  )
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
  const { show, ToastEl } = useToast()

  const canWrite = isAdmin || isUser

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const [t, roomRows, tenantRows] = await Promise.all([
        fetchTickets({ roomId: roomFilter || undefined, status: statusFilter || undefined }),
        supabase.from('rooms').select('id, room_no, room_type').order('room_no'),
        fetchTenants(),
      ])
      setTickets(t)
      setRooms(roomRows.data || [])
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
        <div className="relative">
          <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" />
          <input
            type="search" placeholder="Search concern, tenant, room…"
            value={search} onChange={e => setSearch(e.target.value)}
            className="pl-9 pr-3 py-2 border border-slate-200 rounded-lg text-[13px] bg-white w-64
                       focus:outline-none focus:ring-2 focus:ring-navy-700/25 focus:border-navy-600 transition-colors"
          />
        </div>
        <select value={roomFilter} onChange={e => setRoomFilter(e.target.value)}
          className="px-3 py-2 border border-slate-200 rounded-lg text-[13px] bg-white focus:outline-none focus:ring-2 focus:ring-navy-700/25 transition-colors">
          <option value="">All Rooms</option>
          {rooms.map(r => <option key={r.id} value={r.id}>Room {r.room_no}</option>)}
        </select>
        <select value={statusFilter} onChange={e => setStatusFilter(e.target.value)}
          className="px-3 py-2 border border-slate-200 rounded-lg text-[13px] bg-white focus:outline-none focus:ring-2 focus:ring-navy-700/25 transition-colors">
          <option value="PENDING">Pending</option>
          <option value="RESOLVED">Resolved</option>
          <option value="">All</option>
        </select>
      </div>

      {loading ? (
        <div className="loading-screen"><div className="spinner" /></div>
      ) : filtered.length === 0 ? (
        <div className="empty">
          <Hammer size={32} className="mx-auto mb-3 text-slate-300" />
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
                <tr key={t.id}>
                  <td className="font-semibold text-slate-900 whitespace-nowrap">
                    {t.rooms?.room_no ? `Room ${t.rooms.room_no}` : '—'}
                  </td>
                  <td>
                    {t.tenants?.name || <span className="text-slate-400 italic">Staff-raised</span>}
                  </td>
                  <td className="font-medium text-slate-800">{t.concern}</td>
                  <td className="text-[12px] max-w-[160px] truncate" title={t.remarks}>
                    {t.remarks || '—'}
                  </td>
                  <td className="text-[11px] text-slate-400 whitespace-nowrap">{fmtDateTime(t.raised_at)}</td>
                  <td>
                    {t.status === 'PENDING' ? (
                      <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-[11px] font-semibold bg-amber-50 text-amber-700">
                        <span className="w-1.5 h-1.5 rounded-full bg-amber-500" />PENDING
                      </span>
                    ) : (
                      <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-[11px] font-semibold bg-emerald-50 text-emerald-700">
                        <span className="w-1.5 h-1.5 rounded-full bg-emerald-500" />RESOLVED
                      </span>
                    )}
                  </td>
                  <td className="text-[12px] text-slate-500 max-w-[200px]">
                    {t.resolution_notes
                      ? <span title={t.resolution_notes}>{t.resolution_notes}</span>
                      : t.status === 'RESOLVED'
                        ? <span className="text-slate-300">—</span>
                        : null}
                    {t.resolved_at && (
                      <div className="text-[11px] text-slate-300 mt-0.5">{fmtDateTime(t.resolved_at)}</div>
                    )}
                  </td>
                  {canWrite && (
                    <td>
                      {t.status === 'PENDING' && (
                        <button className="btn-xs green" onClick={() => setResolveT(t)}>
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
        <ResolveModal
          ticket={resolveT}
          onClose={() => setResolveT(null)}
          onSaved={() => { setResolveT(null); show('Ticket resolved.', 'success'); load() }}
        />
      )}
    </div>
  )
}
