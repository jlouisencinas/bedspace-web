import { useState, useEffect } from 'react'
import {
  Calculator, RefreshCw, ChevronDown, ChevronRight, AlertTriangle,
  Edit2, Check, X, Upload, Ban, Info,
} from 'lucide-react'
import {
  fetchSimSummary, updateSimBedRate, updateSimBedOutOfOrder, supabase,
} from '../lib/supabase'
import { useAuth } from '../lib/auth'
import { useToast } from '../components/Toast'
import SimImportModal from '../components/SimImportModal'

// No centralized currency helper exists in this repo — every page defines
// its own, mirroring Property.jsx.
function fmt(n) { return n != null ? '₱' + Number(n).toLocaleString('en-PH') : '—' }

const INPUT_SM = 'px-2 py-1 border border-line rounded-lg text-[12px] bg-surface focus:outline-none focus:border-navy-500 transition-colors'

function activeSum(rooms) {
  return rooms.reduce((s, r) =>
    s + (r.sim_beds || []).filter(b => !b.is_out_of_order).reduce((s2, b) => s2 + (Number(b.rate) || 0), 0), 0)
}

function roomTypeBreakdown(rooms) {
  const map = {}
  rooms.forEach(r => {
    const t = r.room_type || 'Other'
    const beds = r.sim_beds || []
    const active = beds.filter(b => !b.is_out_of_order)
    const e = (map[t] ||= { type: t, total: 0, active: 0, rate: 0 })
    e.total  += beds.length
    e.active += active.length
    e.rate   += active.reduce((s, b) => s + (Number(b.rate) || 0), 0)
  })
  return Object.values(map).sort((a, b) => a.type.localeCompare(b.type))
}

export default function OccupancySimulator() {
  const { isAdmin } = useAuth()
  const { show: showToast, ToastEl } = useToast()

  const [rooms,          setRooms]          = useState([])
  const [loading,        setLoading]        = useState(true)
  const [error,          setError]          = useState('')
  const [occupancyRate,  setOccupancyRate]  = useState(100)
  const [collapsed,      setCollapsed]      = useState({})
  const [editingBed,     setEditingBed]     = useState(null)
  const [newRate,        setNewRate]        = useState('')
  const [saving,         setSaving]         = useState(false)
  const [importOpen,     setImportOpen]     = useState(false)

  async function load() {
    setLoading(true); setError('')
    try {
      setRooms(await fetchSimSummary())
    } catch (e) { setError(e.message) }
    setLoading(false)
  }

  useEffect(() => { load() }, [])

  function toggleRoom(id) { setCollapsed(c => ({ ...c, [id]: !c[id] })) }

  function startEdit(bed) {
    setEditingBed(bed.id)
    setNewRate(String(bed.rate ?? ''))
  }
  function cancelEdit() { setEditingBed(null); setNewRate('') }

  function patchBedInState(roomId, bedId, patch) {
    setRooms(rs => rs.map(r => r.id !== roomId ? r : {
      ...r,
      sim_beds: r.sim_beds.map(b => b.id !== bedId ? b : { ...b, ...patch }),
    }))
  }

  async function saveBedRate(room, bed) {
    if (newRate === '' || Number(newRate) < 0 || isNaN(Number(newRate))) {
      showToast('Enter a valid rate.', 'error'); return
    }
    setSaving(true)
    try {
      const { data: { user } } = await supabase.auth.getUser()
      await updateSimBedRate(bed.id, Number(newRate), user?.id)
      patchBedInState(room.id, bed.id, { rate: Number(newRate) })
      cancelEdit()
      showToast(`Bed ${bed.bed_letter} rate updated.`, 'success')
    } catch (e) { showToast(e.message, 'error') }
    setSaving(false)
  }

  async function toggleOutOfOrder(room, bed) {
    setSaving(true)
    try {
      const { data: { user } } = await supabase.auth.getUser()
      const next = !bed.is_out_of_order
      await updateSimBedOutOfOrder(bed.id, next, user?.id)
      patchBedInState(room.id, bed.id, { is_out_of_order: next, rate: next ? null : bed.rate })
      showToast(`Bed ${bed.bed_letter} ${next ? 'marked out of order' : 'restored'}.`, 'success')
    } catch (e) { showToast(e.message, 'error') }
    setSaving(false)
  }

  if (loading) return (
    <div className="loading-screen">
      <div className="spinner" />
      <span className="text-navy-500 font-semibold text-sm">Loading simulator data…</span>
    </div>
  )

  const baseline = activeSum(rooms)
  const headline = baseline * (occupancyRate / 100)
  const breakdown = roomTypeBreakdown(rooms)
  const totalBeds  = rooms.reduce((s, r) => s + (r.sim_beds || []).length, 0)
  const activeBeds = rooms.reduce((s, r) => s + (r.sim_beds || []).filter(b => !b.is_out_of_order).length, 0)

  return (
    <div className="page">
      <div className="page-header">
        <div>
          <h1 className="page-title flex items-center gap-2"><Calculator size={20} className="text-navy-500" /> Occupancy Simulator</h1>
          <p className="page-sub">What-if rent modeling on a standalone copy of room/bed rates</p>
        </div>
        <div className="flex items-center gap-2">
          {isAdmin && (
            <button onClick={() => setImportOpen(true)} className="btn secondary flex items-center gap-1.5">
              <Upload size={13} /> Import CSV
            </button>
          )}
          <button onClick={load} className="btn secondary flex items-center gap-1.5">
            <RefreshCw size={13} /> Refresh
          </button>
        </div>
      </div>

      <div className="mb-4 flex items-start gap-2 bg-info-bg border border-info-border rounded-xl px-4 py-3 text-[12px] text-info-text">
        <Info size={13} className="shrink-0 mt-0.5" />
        This is a what-if simulator — changes here never affect real bed rates, tenants, or billing.
      </div>

      {error && (
        <div className="mb-4 flex items-center gap-2 px-4 py-3 bg-danger-bg border border-danger-border rounded-xl text-[13px] text-danger-text">
          <AlertTriangle size={14} className="shrink-0" /> {error}
        </div>
      )}

      {/* Headline card */}
      <div className="bg-surface border border-line rounded-2xl p-6 mb-5">
        <div className="text-[11px] font-semibold uppercase tracking-widest text-ink-faint mb-1">
          Potential Monthly Rent at {occupancyRate}% Occupancy
        </div>
        <div className="text-3xl font-bold text-ink mb-3">{fmt(headline)}</div>
        <div className="text-[12px] text-ink-muted mb-4">
          Baseline (100%, excl. out-of-order beds): {fmt(baseline)} · {activeBeds} of {totalBeds} beds active
        </div>
        <div className="flex items-center gap-3 max-w-md">
          <input
            type="range" min="0" max="100" step="1"
            value={occupancyRate}
            onChange={e => setOccupancyRate(Number(e.target.value))}
            className="flex-1"
          />
          <input
            type="number" min="0" max="100" step="1"
            value={occupancyRate}
            onChange={e => setOccupancyRate(Math.max(0, Math.min(100, Number(e.target.value) || 0)))}
            className={`${INPUT_SM} w-16 text-center`}
          />
          <span className="text-[12px] text-ink-faint">%</span>
        </div>
        <p className="text-[11px] text-ink-faint mt-2">
          Coarse estimate: the slider scales the headline total pro-rata. It does not simulate which
          specific beds are occupied or vacant.
        </p>
      </div>

      {/* Room-type breakdown */}
      <div className="bg-surface border border-line rounded-2xl p-5 mb-5">
        <h3 className="text-[13px] font-semibold text-ink-secondary mb-3">By Room Type</h3>
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Room Type</th>
                <th className="text-right">Active / Total Beds</th>
                <th className="text-right">Active-Bed Rate Total</th>
              </tr>
            </thead>
            <tbody>
              {breakdown.map(b => (
                <tr key={b.type}>
                  <td className="text-[12px] text-ink">{b.type}</td>
                  <td className="text-right text-[12px]">{b.active} / {b.total}</td>
                  <td className="text-right text-[12px] font-semibold">{fmt(b.rate)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      {/* Expandable room/bed list */}
      <div className="space-y-2">
        {rooms.map(room => {
          const isOpen  = !collapsed[room.id]
          const beds    = room.sim_beds || []
          const active  = beds.filter(b => !b.is_out_of_order).length
          return (
            <div key={room.id} className="border border-line rounded-xl overflow-hidden">
              <button
                type="button"
                onClick={() => toggleRoom(room.id)}
                className="w-full flex items-center justify-between px-4 py-3 bg-surface-2 hover:bg-surface-3 transition-colors text-left"
              >
                <div className="flex items-center gap-3">
                  {isOpen ? <ChevronDown size={14} className="text-ink-faint" /> : <ChevronRight size={14} className="text-ink-faint" />}
                  <span className="font-semibold text-ink text-[13px]">Room {room.room_no}</span>
                  {room.room_type && <span className="text-[11px] text-ink-faint">{room.room_type}</span>}
                </div>
                <span className="text-[12px] text-ink-faint">{active} of {beds.length} active</span>
              </button>

              {isOpen && (
                <table className="w-full text-[13px]">
                  <thead>
                    <tr className="text-[10px] text-ink-faint uppercase tracking-widest bg-surface border-t border-line-subtle">
                      <th className="px-4 py-2 text-left font-semibold">Bed</th>
                      <th className="px-4 py-2 text-left font-semibold">Status</th>
                      <th className="px-4 py-2 text-right font-semibold">Rate</th>
                      <th className="px-4 py-2 text-right font-semibold w-[180px]">Actions</th>
                    </tr>
                  </thead>
                  <tbody>
                    {beds.length === 0 ? (
                      <tr><td colSpan={4} className="px-4 py-3 text-[12px] text-ink-faint text-center">No beds</td></tr>
                    ) : beds.map(bed => {
                      const isEditing = editingBed === bed.id
                      return (
                        <tr key={bed.id} className={`border-t border-line-subtle ${bed.is_out_of_order ? 'opacity-60 bg-surface-2' : ''}`}>
                          <td className="px-4 py-2.5 font-semibold">{bed.bed_letter}</td>
                          <td className="px-4 py-2.5">
                            {bed.is_out_of_order ? (
                              <span className="text-[11px] font-semibold px-2 py-0.5 rounded-full bg-badge-orange-bg text-badge-orange-text">Out of order</span>
                            ) : bed.rate == null ? (
                              <span className="text-[11px] font-semibold px-2 py-0.5 rounded-full bg-warning-bg text-warning-text">Needs rate</span>
                            ) : (
                              <span className="text-[11px] font-semibold px-2 py-0.5 rounded-full bg-success-bg text-success-text">Active</span>
                            )}
                          </td>
                          <td className="px-4 py-2.5 text-right">
                            {isEditing ? (
                              <div className="relative inline-flex items-center float-right">
                                <span className="absolute left-2 text-[12px] text-ink-faint pointer-events-none select-none">₱</span>
                                <input
                                  type="number" min="0" step="0.01" autoFocus
                                  value={newRate}
                                  onChange={e => setNewRate(e.target.value)}
                                  className={`${INPUT_SM} w-28 pl-6`}
                                />
                              </div>
                            ) : (
                              <span className="font-semibold">{fmt(bed.rate)}</span>
                            )}
                          </td>
                          <td className="px-4 py-2.5">
                            {isEditing ? (
                              <div className="flex gap-1 justify-end">
                                <button onClick={() => saveBedRate(room, bed)} disabled={saving} className="btn-xs green flex items-center gap-1">
                                  <Check size={11} /> Save
                                </button>
                                <button onClick={cancelEdit} className="btn-xs gray"><X size={11} /></button>
                              </div>
                            ) : (
                              <div className="flex gap-1 justify-end">
                                {!bed.is_out_of_order && (
                                  <button
                                    onClick={() => startEdit(bed)}
                                    disabled={!!editingBed || saving}
                                    className="btn-xs blue flex items-center gap-1"
                                  >
                                    <Edit2 size={10} /> Rate
                                  </button>
                                )}
                                <button
                                  onClick={() => toggleOutOfOrder(room, bed)}
                                  disabled={saving || !!editingBed}
                                  className={`btn-xs flex items-center gap-1 ${bed.is_out_of_order ? 'green' : 'red'}`}
                                >
                                  {bed.is_out_of_order ? <Check size={10} /> : <Ban size={10} />}
                                  {bed.is_out_of_order ? 'Restore' : 'Mark OOO'}
                                </button>
                              </div>
                            )}
                          </td>
                        </tr>
                      )
                    })}
                  </tbody>
                </table>
              )}
            </div>
          )
        })}
      </div>

      {importOpen && (
        <SimImportModal
          onClose={() => setImportOpen(false)}
          onDone={() => { setImportOpen(false); load() }}
        />
      )}
      {ToastEl}
    </div>
  )
}
