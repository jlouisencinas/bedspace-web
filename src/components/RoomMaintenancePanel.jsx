import { useState, useEffect, useCallback } from 'react'
import { Link } from 'react-router-dom'
import { fetchTickets, fetchTenants, fetchRooms } from '../lib/supabase'
import { useAuth } from '../lib/auth'
import { useToast } from './Toast'
import NewTicketModal     from './NewTicketModal'
import ResolveTicketModal from './ResolveTicketModal'
import { Wrench, Plus, CheckCircle, ArrowRight } from 'lucide-react'

function fmtDate(d) {
  if (!d) return '—'
  return new Date(d).toLocaleDateString('en-PH', { month: 'short', day: 'numeric', year: 'numeric' })
}

// Compact ticket list for the Dashboard — same underlying data as Maintenance.jsx,
// default-filtered to PENDING tickets.
export default function RoomMaintenancePanel() {
  const { isAdmin, isUser } = useAuth()
  const canWrite = isAdmin || isUser
  const [tickets, setTickets] = useState([])
  const [rooms,   setRooms]   = useState([])
  const [tenants, setTenants] = useState([])
  const [loading, setLoading] = useState(true)
  const [newModal, setNewModal] = useState(false)
  const [resolveT, setResolveT] = useState(null)
  const { show, ToastEl } = useToast()

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const [t, roomRows, tenantRows] = await Promise.all([
        fetchTickets({ status: 'PENDING' }),
        fetchRooms(),
        fetchTenants(),
      ])
      setTickets(t)
      setRooms(roomRows || [])
      setTenants(tenantRows.filter(x => x.is_active))
    } catch(e) { show(e.message, 'error') }
    setLoading(false)
  }, [])

  useEffect(() => { load() }, [load])

  return (
    <div className="bg-white rounded-xl border border-slate-200 shadow-card">
      <div className="px-5 py-3.5 border-b border-slate-100 flex items-center gap-2">
        <Wrench size={13} className="text-amber-500" />
        <span className="text-[11px] font-bold text-slate-400 uppercase tracking-widest">Room Maintenance</span>
        {tickets.length > 0 && (
          <span className="inline-flex items-center px-2 py-0.5 rounded-full text-[10px] font-bold bg-red-600 text-white">
            {tickets.length}
          </span>
        )}
        {canWrite && (
          <button className="ml-auto btn-xs blue" onClick={() => setNewModal(true)}>
            <Plus size={11} /> Raise Ticket
          </button>
        )}
      </div>
      <div>
        {loading ? (
          <div className="p-5 text-[13px] text-slate-400">Loading…</div>
        ) : tickets.length === 0 ? (
          <div className="empty"><CheckCircle size={28} className="mx-auto mb-2 text-emerald-400 opacity-70" /><p>No pending tickets</p></div>
        ) : (
          <div className="divide-y divide-slate-100">
            {tickets.slice(0, 6).map(t => (
              <div key={t.id} className="px-5 py-3 flex items-center justify-between gap-3">
                <div className="min-w-0">
                  <div className="text-[13px] font-semibold text-slate-900 truncate">
                    {t.rooms?.room_no ? `Room ${t.rooms.room_no}` : '—'} — {t.concern}
                  </div>
                  <div className="text-[11px] text-slate-400 mt-0.5">
                    {t.tenants?.name || 'Staff-raised'} · {fmtDate(t.raised_at)}
                  </div>
                </div>
                {canWrite && (
                  <button className="btn-xs green shrink-0" onClick={() => setResolveT(t)}>
                    <CheckCircle size={11} /> Resolve
                  </button>
                )}
              </div>
            ))}
          </div>
        )}
      </div>
      <div className="px-5 py-3 border-t border-slate-100">
        <Link to="/maintenance" className="text-[12px] font-medium text-navy-600 hover:text-navy-700 inline-flex items-center gap-1">
          View all in Maintenance <ArrowRight size={12} />
        </Link>
      </div>

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
      {ToastEl}
    </div>
  )
}
