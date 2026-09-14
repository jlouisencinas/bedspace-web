import { useState, useEffect } from 'react'
import {
  Building2, Settings2, DollarSign, Tag, RefreshCw,
  ChevronDown, ChevronRight, Plus, Trash2, Edit2, Check, X,
  RotateCcw, AlertTriangle, Clock, Wrench,
} from 'lucide-react'
import {
  fetchPropertySummary, updateRoomConfig, updateBedRate, removeBed, restoreBed,
  fetchAddonTypes, saveAddonType, deactivateAddonType, supabase,
} from '../lib/supabase'
import { requestApproval } from '../lib/approvals'
import { useAuth } from '../lib/auth'
import { useToast } from '../components/Toast'
import RoomReconfigureModal from '../components/RoomReconfigureModal'

// ── Helpers ───────────────────────────────────────────────────────────────────

function fmt(n) { return n != null ? '₱' + Number(n).toLocaleString('en-PH') : '—' }

const ROOM_TYPES = [
  'Solo Room', '2-Bed Sharing', '4-Bed Sharing', '6-Bed Sharing',
]
const ROOM_STATUSES = ['ACTIVE', 'CONVERTED', 'MAINTENANCE', 'RESERVED']
const ROOM_STATUS_LABELS = {
  ACTIVE: 'Active', CONVERTED: 'Converted',
  MAINTENANCE: 'Maintenance', RESERVED: 'Reserved',
}

function StatusPill({ status }) {
  const cls =
    status === 'ACTIVE'      ? 'bg-emerald-50 text-emerald-700' :
    status === 'MAINTENANCE' ? 'bg-amber-50 text-amber-700'     :
    status === 'CONVERTED'   ? 'bg-blue-50 text-blue-700'       :
    status === 'RESERVED'    ? 'bg-purple-50 text-purple-700'   :
                               'bg-slate-100 text-slate-500'
  return (
    <span className={`text-[11px] font-semibold px-2 py-0.5 rounded-full ${cls}`}>
      {ROOM_STATUS_LABELS[status] || status}
    </span>
  )
}

const INPUT_SM = 'px-2 py-1 border border-slate-200 rounded-lg text-[12px] bg-white focus:outline-none focus:border-navy-500 transition-colors'

// ── Confirm Modal ─────────────────────────────────────────────────────────────

function ConfirmModal({ message, confirmLabel = 'Confirm', danger = false, onConfirm, onClose }) {
  return (
    <div className="overlay" onClick={e => e.stopPropagation()}>
      <div className="modal modal-sm">
        <div className="modal-head">
          <h3>Confirm</h3>
          <button className="btn-close" onClick={onClose}><X size={16} /></button>
        </div>
        <div className="modal-body">
          <p className="text-[13px] text-slate-600">{message}</p>
        </div>
        <div className="modal-foot">
          <button type="button" className="btn secondary" onClick={onClose}>Cancel</button>
          <button
            type="button"
            className={`btn ${danger ? 'danger' : 'primary'}`}
            onClick={() => { onConfirm(); onClose() }}
          >
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  )
}

// ── Summary Tab ───────────────────────────────────────────────────────────────

function SummaryTab({ summary }) {
  if (!summary) return null

  const nonMgmt = summary.filter(r => !r.is_management)
  const totals = {
    current:  nonMgmt.reduce((s, r) => s + r.current_bed_count,  0),
    occupied: nonMgmt.reduce((s, r) => s + r.occupied_beds,       0),
    tenants:  nonMgmt.reduce((s, r) => s + r.tenant_count,        0),
    rate:     nonMgmt.reduce((s, r) => s + r.room_rate,           0),
    actual:   nonMgmt.reduce((s, r) => s + r.actual_collected,    0),
  }

  return (
    <div className="table-wrap">
      <table>
        <thead>
          <tr>
            <th>Room</th>
            <th>Type</th>
            <th>Status</th>
            <th className="text-right">Lower Rate</th>
            <th className="text-right">Upper Rate</th>
            <th className="text-right">Orig. Beds</th>
            <th className="text-right">Current Setup</th>
            <th className="text-right">Occupied</th>
            <th className="text-right">Tenants</th>
            <th className="text-right">Room Rate</th>
            <th className="text-right">Actual</th>
          </tr>
        </thead>
        <tbody>
          {summary.map(r => (
            <tr key={r.id} className={r.is_management ? 'opacity-50 bg-slate-50' : ''}>
              <td className="font-semibold text-slate-900 whitespace-nowrap">
                {r.room_no}
                {r.is_management && (
                  <span className="ml-1.5 text-[10px] font-bold bg-slate-200 text-slate-500 px-1.5 py-0.5 rounded normal-case tracking-normal">
                    MGMT
                  </span>
                )}
              </td>
              <td className="text-[12px] text-slate-500">{r.room_type || <span className="text-slate-300">—</span>}</td>
              <td><StatusPill status={r.room_status || 'ACTIVE'} /></td>
              <td className="text-right text-[12px]">{r.lower_rate != null ? fmt(r.lower_rate) : '—'}</td>
              <td className="text-right text-[12px]">{r.upper_rate != null ? fmt(r.upper_rate) : '—'}</td>
              <td className="text-right text-[12px] text-slate-500">
                {r.original_bed_count != null ? r.original_bed_count : <span className="text-slate-300">—</span>}
              </td>
              <td className="text-right text-[12px] font-medium">{r.is_management ? '—' : r.current_bed_count}</td>
              <td className="text-right text-[12px]">
                {r.is_management ? '—' : (
                  <span className={r.occupied_beds > 0 ? 'font-semibold text-emerald-700' : 'text-slate-400'}>
                    {r.occupied_beds}
                  </span>
                )}
              </td>
              <td className="text-right text-[12px]">{r.is_management ? '—' : r.tenant_count}</td>
              <td className="text-right text-[12px] font-semibold">{r.is_management ? '—' : fmt(r.room_rate)}</td>
              <td className="text-right text-[12px] font-semibold text-emerald-700">
                {r.is_management ? '—' : (r.actual_collected > 0 ? fmt(r.actual_collected) : <span className="text-slate-300">—</span>)}
              </td>
            </tr>
          ))}
        </tbody>
        <tfoot>
          <tr className="bg-slate-50 font-semibold">
            <td colSpan={5} className="text-[11px] text-slate-400 font-semibold uppercase tracking-wider">
              Totals (excl. management)
            </td>
            <td className="text-right text-[12px] text-slate-400">—</td>
            <td className="text-right text-[12px]">{totals.current}</td>
            <td className="text-right text-[12px] text-emerald-700">{totals.occupied}</td>
            <td className="text-right text-[12px]">{totals.tenants}</td>
            <td className="text-right text-[12px]">{fmt(totals.rate)}</td>
            <td className="text-right text-[12px] text-emerald-700">{fmt(totals.actual)}</td>
          </tr>
        </tfoot>
      </table>
    </div>
  )
}

// ── Room Config Tab ───────────────────────────────────────────────────────────

function RoomConfigTab({ summary, onDone }) {
  const { isAdmin } = useAuth()
  const { show: showToast, ToastEl } = useToast()
  const [editing,    setEditing]    = useState(null)
  const [form,       setForm]       = useState({})
  const [reason,     setReason]     = useState('')
  const [saving,     setSaving]     = useState(false)
  const [pendingIds, setPendingIds] = useState(new Set())

  if (!summary) return null

  function startEdit(room) {
    setEditing(room.id)
    setForm({
      room_type:          room.room_type          || '',
      room_status:        room.room_status        || 'ACTIVE',
      original_bed_count: room.original_bed_count != null ? String(room.original_bed_count) : '',
      is_management:      !!room.is_management,
    })
    setReason('')
  }

  function cancelEdit() { setEditing(null); setForm({}); setReason('') }

  async function saveConfig(room) {
    if (!isAdmin && !reason.trim()) { showToast('Reason is required.', 'error'); return }
    setSaving(true)
    const patch = {
      room_type:          form.room_type || null,
      room_status:        form.room_status || 'ACTIVE',
      original_bed_count: form.original_bed_count !== '' ? Number(form.original_bed_count) : null,
      is_management:      form.is_management,
    }
    try {
      if (isAdmin) {
        const { data: { user } } = await supabase.auth.getUser()
        await updateRoomConfig(room.id, patch, user?.id)
        cancelEdit()
        onDone()
        showToast(`Room ${room.room_no} updated.`, 'success')
      } else {
        await requestApproval({
          entityType: 'ROOM', entityId: String(room.id),
          fieldName: 'room_config',
          oldValue: {
            room_type: room.room_type, room_status: room.room_status,
            original_bed_count: room.original_bed_count, is_management: room.is_management,
          },
          newValue: { ...patch, _room_no: room.room_no },
          reason: reason.trim(),
        })
        setPendingIds(s => new Set([...s, room.id]))
        cancelEdit()
        showToast('Room config change submitted for approval.', 'info')
      }
    } catch (e) { showToast(e.message, 'error') }
    setSaving(false)
  }

  return (
    <div>
      {!isAdmin && (
        <div className="mb-4 flex items-start gap-2 bg-amber-50 border border-amber-100 rounded-xl px-4 py-3 text-[12px] text-amber-800">
          <AlertTriangle size={13} className="shrink-0 mt-0.5 text-amber-500" />
          As a user, your changes will be submitted for admin approval before taking effect.
        </div>
      )}
      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th>Room</th>
              <th>Room Type</th>
              <th>Status</th>
              <th>Original Beds</th>
              <th>Management</th>
              <th className="w-[160px]"></th>
            </tr>
          </thead>
          <tbody>
            {summary.map(room => {
              const isEditing = editing === room.id
              const isPending = pendingIds.has(room.id)
              return (
                <tr key={room.id} className={room.is_management ? 'bg-slate-50' : ''}>
                  <td className="font-semibold text-slate-900">{room.room_no}</td>

                  {isEditing ? (
                    <>
                      <td>
                        <select
                          value={form.room_type}
                          onChange={e => setForm(f => ({ ...f, room_type: e.target.value }))}
                          className={`${INPUT_SM} w-full`}
                        >
                          <option value="">— select —</option>
                          {ROOM_TYPES.map(t => <option key={t} value={t}>{t}</option>)}
                        </select>
                      </td>
                      <td>
                        <select
                          value={form.room_status}
                          onChange={e => setForm(f => ({ ...f, room_status: e.target.value }))}
                          className={`${INPUT_SM} w-full`}
                        >
                          {ROOM_STATUSES.map(s => <option key={s} value={s}>{ROOM_STATUS_LABELS[s]}</option>)}
                        </select>
                      </td>
                      <td>
                        <input
                          type="number" min="0"
                          value={form.original_bed_count}
                          onChange={e => setForm(f => ({ ...f, original_bed_count: e.target.value }))}
                          className={`${INPUT_SM} w-20`}
                          placeholder="—"
                        />
                      </td>
                      <td>
                        <label className="flex items-center gap-2 cursor-pointer">
                          <input
                            type="checkbox"
                            checked={form.is_management}
                            onChange={e => setForm(f => ({ ...f, is_management: e.target.checked }))}
                            className="rounded"
                          />
                          <span className="text-[12px] text-slate-600">Yes</span>
                        </label>
                      </td>
                      <td>
                        <div className="flex flex-col gap-1.5">
                          {!isAdmin && (
                            <input
                              type="text"
                              value={reason}
                              onChange={e => setReason(e.target.value)}
                              placeholder="Reason for change *"
                              className={`${INPUT_SM} w-full`}
                            />
                          )}
                          <div className="flex gap-1">
                            <button
                              onClick={() => saveConfig(room)}
                              disabled={saving}
                              className="btn-xs green flex items-center gap-1"
                            >
                              {isAdmin ? <Check size={11} /> : <Clock size={11} />}
                              {isAdmin ? 'Save' : 'Request'}
                            </button>
                            <button onClick={cancelEdit} className="btn-xs gray"><X size={11} /></button>
                          </div>
                        </div>
                      </td>
                    </>
                  ) : (
                    <>
                      <td className="text-[12px]">{room.room_type || <span className="text-slate-300">—</span>}</td>
                      <td><StatusPill status={room.room_status || 'ACTIVE'} /></td>
                      <td className="text-[12px] text-slate-600">
                        {room.original_bed_count != null ? room.original_bed_count : <span className="text-slate-300">—</span>}
                      </td>
                      <td>
                        {room.is_management
                          ? <span className="text-[11px] font-semibold px-2 py-0.5 rounded-full bg-slate-200 text-slate-600">Yes</span>
                          : <span className="text-slate-300 text-[12px]">—</span>}
                      </td>
                      <td>
                        {isPending ? (
                          <span className="flex items-center gap-1 text-[11px] text-amber-600 font-medium">
                            <Clock size={11} /> Pending
                          </span>
                        ) : (
                          <button
                            onClick={() => startEdit(room)}
                            disabled={!!editing}
                            className="btn-xs gray flex items-center gap-1"
                          >
                            <Edit2 size={11} /> Edit
                          </button>
                        )}
                      </td>
                    </>
                  )}
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>
      {ToastEl}
    </div>
  )
}

// ── Bed Rates Tab ─────────────────────────────────────────────────────────────

function BedRatesTab({ summary, onDone }) {
  const { isAdmin } = useAuth()
  const { show: showToast, ToastEl } = useToast()
  const [collapsed,   setCollapsed]   = useState({})
  const [editingBed,  setEditingBed]  = useState(null)
  const [newRate,     setNewRate]     = useState('')
  const [reason,      setReason]      = useState('')
  const [saving,      setSaving]      = useState(false)
  const [pendingBeds, setPendingBeds] = useState({})
  const [confirm,     setConfirm]     = useState(null)
  const [reconfigRoom, setReconfigRoom] = useState(null)

  if (!summary) return null

  function toggleRoom(id) { setCollapsed(c => ({ ...c, [id]: !c[id] })) }

  function startEdit(bed) {
    setEditingBed(bed.id)
    setNewRate(String(bed.default_rate ?? ''))
    setReason('')
  }
  function cancelEdit() { setEditingBed(null); setNewRate(''); setReason('') }

  async function saveBedRate(bed, room) {
    if (!newRate || Number(newRate) < 0) { showToast('Enter a valid rate.', 'error'); return }
    if (!isAdmin && !reason.trim()) { showToast('Reason is required.', 'error'); return }
    setSaving(true)
    try {
      const { data: { user } } = await supabase.auth.getUser()
      const meta = { room_no: room.room_no, bed_letter: bed.bed_letter }
      if (isAdmin) {
        await updateBedRate(bed.id, Number(newRate), meta, user?.id)
        cancelEdit()
        onDone()
        showToast(`Bed ${bed.bed_letter} rate updated.`, 'success')
      } else {
        await requestApproval({
          entityType: 'BED', entityId: String(bed.id),
          fieldName: 'bed_rate',
          oldValue: { default_rate: bed.default_rate },
          newValue: { default_rate: Number(newRate), _room_no: room.room_no, _bed_letter: bed.bed_letter },
          reason: reason.trim(),
        })
        setPendingBeds(p => ({ ...p, [bed.id]: true }))
        cancelEdit()
        showToast('Rate change submitted for approval.', 'info')
      }
    } catch (e) { showToast(e.message, 'error') }
    setSaving(false)
  }

  async function doRemove(bed, room) {
    setSaving(true)
    try {
      const { data: { user } } = await supabase.auth.getUser()
      if (isAdmin) {
        await removeBed(bed.id, { room_no: room.room_no, bed_letter: bed.bed_letter }, user?.id)
        onDone()
        showToast(`Bed ${bed.bed_letter} removed.`, 'success')
      } else {
        await requestApproval({
          entityType: 'BED', entityId: String(bed.id),
          fieldName: 'remove_bed',
          oldValue: { status: bed.status },
          newValue: { status: 'REMOVED', _room_no: room.room_no, _bed_letter: bed.bed_letter },
          reason: `Remove Bed ${bed.bed_letter} from Room ${room.room_no}`,
        })
        setPendingBeds(p => ({ ...p, [bed.id]: true }))
        showToast('Bed removal submitted for approval.', 'info')
      }
    } catch (e) { showToast(e.message, 'error') }
    setSaving(false)
  }

  async function doRestore(bed, room) {
    setSaving(true)
    try {
      const { data: { user } } = await supabase.auth.getUser()
      await restoreBed(bed.id, { room_no: room.room_no, bed_letter: bed.bed_letter }, user?.id)
      onDone()
      showToast(`Bed ${bed.bed_letter} restored.`, 'success')
    } catch (e) { showToast(e.message, 'error') }
    setSaving(false)
  }

  function handleRemove(bed, room) {
    if (bed.status === 'LEASED') { showToast('Cannot remove a leased bed.', 'error'); return }
    setConfirm({
      message: `Remove Bed ${bed.bed_letter} from Room ${room.room_no}? This is reversible — you can restore it later.`,
      confirmLabel: 'Remove',
      danger: true,
      onConfirm: () => doRemove(bed, room),
    })
  }

  function handleRestore(bed, room) {
    setConfirm({
      message: `Restore Bed ${bed.bed_letter} in Room ${room.room_no}?`,
      confirmLabel: 'Restore',
      danger: false,
      onConfirm: () => doRestore(bed, room),
    })
  }

  return (
    <div className="space-y-2">
      {summary.map(room => {
        const isOpen    = !collapsed[room.id]
        const allBeds   = room.beds || []
        const activeCnt = allBeds.filter(b => b.status !== 'REMOVED').length

        return (
          <div key={room.id} className="border border-slate-200 rounded-xl overflow-hidden">
            <div className="w-full flex items-center justify-between px-4 py-3 bg-slate-50 hover:bg-slate-100 transition-colors">
              <button
                type="button"
                onClick={() => toggleRoom(room.id)}
                className="flex items-center gap-3 text-left flex-1 bg-transparent border-none"
              >
                {isOpen
                  ? <ChevronDown size={14} className="text-slate-400" />
                  : <ChevronRight size={14} className="text-slate-400" />}
                <span className="font-semibold text-slate-900 text-[13px]">Room {room.room_no}</span>
                {room.room_type && <span className="text-[11px] text-slate-400">{room.room_type}</span>}
                {room.is_management && (
                  <span className="text-[10px] font-bold bg-slate-200 text-slate-500 px-1.5 py-0.5 rounded">MGMT</span>
                )}
              </button>
              <div className="flex items-center gap-3">
                <span className="text-[12px] text-slate-400">{activeCnt} active bed{activeCnt !== 1 ? 's' : ''}</span>
                {isAdmin && (
                  <button
                    type="button"
                    onClick={() => setReconfigRoom(room)}
                    className="btn-xs blue flex items-center gap-1"
                  >
                    <Wrench size={10} /> Reconfigure
                  </button>
                )}
              </div>
            </div>

            {isOpen && (
              <table className="w-full text-[13px]">
                <thead>
                  <tr className="text-[10px] text-slate-400 uppercase tracking-widest bg-white border-t border-slate-100">
                    <th className="px-4 py-2 text-left font-semibold">Bed</th>
                    <th className="px-4 py-2 text-left font-semibold">Location</th>
                    <th className="px-4 py-2 text-left font-semibold">Status</th>
                    <th className="px-4 py-2 text-right font-semibold">Rate</th>
                    <th className="px-4 py-2 text-right font-semibold w-[200px]">Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {allBeds.length === 0 ? (
                    <tr><td colSpan={5} className="px-4 py-3 text-[12px] text-slate-300 text-center">No beds configured</td></tr>
                  ) : allBeds.map(bed => {
                    const isRemoved = bed.status === 'REMOVED'
                    const isEditing = editingBed === bed.id
                    const isPending = pendingBeds[bed.id]
                    const bedStatusCls =
                      isRemoved               ? 'bg-red-50 text-red-500'           :
                      bed.status === 'LEASED'       ? 'bg-emerald-50 text-emerald-700' :
                      bed.status === 'RESERVED'     ? 'bg-amber-50 text-amber-700'     :
                      bed.status === 'OUT OF ORDER' ? 'bg-orange-50 text-orange-700'   :
                                                      'bg-slate-100 text-slate-500'

                    return (
                      <tr key={bed.id} className={`border-t border-slate-50 ${isRemoved ? 'opacity-40 bg-slate-50' : ''}`}>
                        <td className="px-4 py-2.5 font-semibold">{bed.bed_letter}</td>
                        <td className="px-4 py-2.5 text-slate-400 text-[12px]">{bed.bed_location || '—'}</td>
                        <td className="px-4 py-2.5">
                          <span className={`text-[11px] font-semibold px-2 py-0.5 rounded-full ${bedStatusCls}`}>
                            {isRemoved ? 'Removed' : bed.status}
                          </span>
                        </td>
                        <td className="px-4 py-2.5 text-right">
                          {isEditing ? (
                            <div className="relative inline-flex items-center float-right">
                              <span className="absolute left-2 text-[12px] text-slate-400 pointer-events-none select-none">₱</span>
                              <input
                                type="number" min="0" step="0.01" autoFocus
                                value={newRate}
                                onChange={e => setNewRate(e.target.value)}
                                className={`${INPUT_SM} w-28 pl-6`}
                              />
                            </div>
                          ) : (
                            <span className="font-semibold">{fmt(bed.default_rate)}</span>
                          )}
                        </td>
                        <td className="px-4 py-2.5">
                          {isPending ? (
                            <div className="flex items-center gap-1 justify-end text-[11px] text-amber-600 font-medium">
                              <Clock size={11} /> Pending
                            </div>
                          ) : isEditing ? (
                            <div className="flex flex-col items-end gap-1.5">
                              {!isAdmin && (
                                <input
                                  type="text" value={reason}
                                  onChange={e => setReason(e.target.value)}
                                  placeholder="Reason *"
                                  className={`${INPUT_SM} w-40`}
                                />
                              )}
                              <div className="flex gap-1">
                                <button
                                  onClick={() => saveBedRate(bed, room)}
                                  disabled={saving}
                                  className="btn-xs green flex items-center gap-1"
                                >
                                  {isAdmin ? <Check size={11} /> : <Clock size={11} />}
                                  {isAdmin ? 'Save' : 'Request'}
                                </button>
                                <button onClick={cancelEdit} className="btn-xs gray"><X size={11} /></button>
                              </div>
                            </div>
                          ) : (
                            <div className="flex gap-1 justify-end">
                              {!isRemoved && (
                                <>
                                  <button
                                    onClick={() => startEdit(bed)}
                                    disabled={!!editingBed || saving}
                                    className="btn-xs blue flex items-center gap-1"
                                  >
                                    <Edit2 size={10} /> Rate
                                  </button>
                                  {bed.status !== 'LEASED' && (
                                    <button
                                      onClick={() => handleRemove(bed, room)}
                                      disabled={saving || !!editingBed}
                                      className="btn-xs red flex items-center gap-1"
                                    >
                                      <Trash2 size={10} />
                                    </button>
                                  )}
                                </>
                              )}
                              {isRemoved && isAdmin && (
                                <button
                                  onClick={() => handleRestore(bed, room)}
                                  disabled={saving}
                                  className="btn-xs green flex items-center gap-1"
                                >
                                  <RotateCcw size={10} /> Restore
                                </button>
                              )}
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

      {confirm && (
        <ConfirmModal
          message={confirm.message}
          confirmLabel={confirm.confirmLabel}
          danger={confirm.danger}
          onConfirm={confirm.onConfirm}
          onClose={() => setConfirm(null)}
        />
      )}
      {reconfigRoom && (
        <RoomReconfigureModal
          room={reconfigRoom}
          onClose={() => setReconfigRoom(null)}
          onDone={() => { setReconfigRoom(null); onDone() }}
        />
      )}
      {ToastEl}
    </div>
  )
}

// ── Add-on Type Modal ─────────────────────────────────────────────────────────

function AddonTypeModal({ existing, onClose, onSaved }) {
  const { show: showToast, ToastEl } = useToast()
  const [label,   setLabel]   = useState(existing?.label          || '')
  const [category, setCategory] = useState(existing?.category    || 'RENT_WATER')
  const [billOn,  setBillOn]  = useState(existing?.bill_on        || 'RENT_WATER')
  const [amount,  setAmount]  = useState(
    existing?.default_amount != null ? String(existing.default_amount) : ''
  )
  const [saving,  setSaving]  = useState(false)

  async function handleSubmit(e) {
    e.preventDefault()
    if (!label.trim()) { showToast('Label is required.', 'error'); return }
    setSaving(true)
    try {
      const { data: { user } } = await supabase.auth.getUser()
      await saveAddonType(
        {
          id:             existing?.id,
          label:          label.trim(),
          category,
          bill_on:        billOn,
          default_amount: amount !== '' ? Number(amount) : null,
        },
        user?.id
      )
      showToast(existing ? 'Add-on updated.' : 'Add-on created.', 'success')
      onSaved()
    } catch (e) { showToast(e.message, 'error') }
    setSaving(false)
  }

  return (
    <div className="overlay" onClick={e => e.stopPropagation()}>
      <div className="modal modal-sm">
        <div className="modal-head">
          <h3>{existing ? 'Edit Add-on' : 'New Add-on'}</h3>
          <button className="btn-close" onClick={onClose}><X size={16} /></button>
        </div>
        <form onSubmit={handleSubmit}>
          <div className="modal-body">
            <div className="form-grid single">
              <div className="fg">
                <label>Label *</label>
                <input
                  type="text" value={label}
                  onChange={e => setLabel(e.target.value)}
                  placeholder="e.g. Parking, Aircon Surcharge…"
                  required autoFocus
                />
              </div>
              <div className="fg">
                <label>Type</label>
                <select value={category} onChange={e => { setCategory(e.target.value); setBillOn(e.target.value) }}>
                  <option value="RENT_WATER">Rent + Water</option>
                  <option value="ELECTRIC">Electricity</option>
                </select>
              </div>
              <div className="fg">
                <label>Bill Under</label>
                <select value={billOn} onChange={e => setBillOn(e.target.value)}>
                  <option value="RENT_WATER">Rent + Water statement</option>
                  <option value="ELECTRIC">Electricity statement</option>
                </select>
              </div>
              <div className="fg">
                <label>Default Amount (₱)</label>
                <input
                  type="number" min="0" step="0.01"
                  value={amount}
                  onChange={e => setAmount(e.target.value)}
                  placeholder="e.g. 500"
                />
              </div>
            </div>
          </div>
          <div className="modal-foot">
            <button type="button" className="btn secondary" onClick={onClose}>Cancel</button>
            <button type="submit" className="btn primary" disabled={saving}>
              {saving ? 'Saving…' : existing ? 'Update' : 'Create'}
            </button>
          </div>
        </form>
      </div>
      {ToastEl}
    </div>
  )
}

// ── Add-ons Tab ───────────────────────────────────────────────────────────────

function AddonsTab({ addonTypes, onDone }) {
  const { isAdmin } = useAuth()
  const { show: showToast, ToastEl } = useToast()
  const [typeModal,    setTypeModal]    = useState(null) // null | 'new' | existing type object
  const [confirm,      setConfirm]      = useState(null)
  const [deactivating, setDeactivating] = useState(null)

  function handleDeactivateType(type) {
    setConfirm({
      message: `Deactivate add-on "${type.label}"? Existing add-ons using this type are unaffected.`,
      confirmLabel: 'Deactivate',
      danger: true,
      onConfirm: () => doDeactivate(type),
    })
  }

  async function doDeactivate(type) {
    setDeactivating(type.id)
    try {
      const { data: { user } } = await supabase.auth.getUser()
      await deactivateAddonType(type.id, type.label, user?.id)
      showToast(`"${type.label}" deactivated.`, 'success')
      onDone()
    } catch (e) { showToast(e.message, 'error') }
    setDeactivating(null)
  }

  return (
    <div>
      <div className="flex items-center justify-between mb-3">
        <div>
          <h3 className="text-[13px] font-semibold text-slate-700">Add-on Catalog</h3>
          <p className="text-[12px] text-slate-400 mt-0.5">
            Define available add-ons. These will be selectable in Billing when assigning charges to tenants.
          </p>
        </div>
        {isAdmin && (
          <button onClick={() => setTypeModal('new')} className="btn primary flex items-center gap-1.5 text-[12px] py-1.5 px-3">
            <Plus size={13} /> New Add-on
          </button>
        )}
      </div>

      <div className="border border-slate-200 rounded-xl overflow-hidden">
        <table className="w-full text-[12px]">
          <thead>
            <tr className="text-[10px] text-slate-400 uppercase tracking-widest bg-slate-50">
              <th className="px-4 py-2 text-left font-semibold">Label</th>
              <th className="px-4 py-2 text-left font-semibold">Type</th>
              <th className="px-4 py-2 text-left font-semibold">Billed Under</th>
              <th className="px-4 py-2 text-right font-semibold">Default Amount</th>
              {isAdmin && <th className="px-4 py-2 w-[80px]"></th>}
            </tr>
          </thead>
          <tbody>
            {addonTypes.length === 0 ? (
              <tr>
                <td colSpan={isAdmin ? 5 : 4} className="px-4 py-8 text-center text-slate-300 text-[13px]">
                  No add-ons defined yet.{isAdmin ? ' Click "New Add-on" to get started.' : ''}
                </td>
              </tr>
            ) : addonTypes.map(t => (
              <tr key={t.id} className="border-t border-slate-50">
                <td className="px-4 py-2.5 font-medium text-slate-800">{t.label}</td>
                <td className="px-4 py-2.5">
                  <span className={`text-[11px] font-semibold px-2 py-0.5 rounded-full ${
                    t.category === 'ELECTRIC' ? 'bg-blue-50 text-blue-700' : 'bg-teal-50 text-teal-700'
                  }`}>{t.category === 'ELECTRIC' ? 'Electric' : 'Rent+Water'}</span>
                </td>
                <td className="px-4 py-2.5 text-slate-500">
                  {t.bill_on === 'ELECTRIC' ? 'Electricity stmt' : 'Rent+Water stmt'}
                </td>
                <td className="px-4 py-2.5 text-right font-semibold text-slate-700">
                  {t.default_amount != null ? fmt(t.default_amount) : <span className="text-slate-300 font-normal">—</span>}
                </td>
                {isAdmin && (
                  <td className="px-4 py-2.5">
                    <div className="flex gap-1 justify-end">
                      <button onClick={() => setTypeModal(t)} className="btn-xs gray"><Edit2 size={10} /></button>
                      <button
                        onClick={() => handleDeactivateType(t)}
                        disabled={deactivating === t.id}
                        className="btn-xs red"
                      ><Trash2 size={10} /></button>
                    </div>
                  </td>
                )}
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {typeModal && (
        <AddonTypeModal
          existing={typeModal === 'new' ? null : typeModal}
          onClose={() => setTypeModal(null)}
          onSaved={() => { setTypeModal(null); onDone() }}
        />
      )}
      {confirm && (
        <ConfirmModal
          message={confirm.message}
          confirmLabel={confirm.confirmLabel}
          danger={confirm.danger}
          onConfirm={confirm.onConfirm}
          onClose={() => setConfirm(null)}
        />
      )}
      {ToastEl}
    </div>
  )
}

// ── Main Page ─────────────────────────────────────────────────────────────────

const TABS = [
  { id: 'summary', label: 'Property Summary', Icon: Building2 },
  { id: 'config',  label: 'Room Config',       Icon: Settings2  },
  { id: 'rates',   label: 'Bed Rates',          Icon: DollarSign },
  { id: 'addons',  label: 'Add-ons',            Icon: Tag        },
]

export default function Property() {
  const [tab,        setTab]       = useState('summary')
  const [summary,    setSummary]   = useState(null)
  const [addonTypes, setAddonTypes] = useState([])
  const [loading,    setLoading]   = useState(true)
  const [error,      setError]     = useState('')

  async function load() {
    setLoading(true); setError('')
    try {
      const [s, at] = await Promise.all([
        fetchPropertySummary(),
        fetchAddonTypes(),
      ])
      setSummary(s); setAddonTypes(at)
    } catch (e) { setError(e.message) }
    setLoading(false)
  }

  useEffect(() => { load() }, [])

  if (loading) return (
    <div className="loading-screen">
      <div className="spinner" />
      <span className="text-navy-500 font-semibold text-sm">Loading property data…</span>
    </div>
  )

  return (
    <div className="page">
      <div className="page-header">
        <div>
          <h1 className="page-title">Property Management</h1>
          <p className="page-sub">Rooms, bed rates, and add-on catalog</p>
        </div>
        <button onClick={load} className="btn secondary flex items-center gap-1.5">
          <RefreshCw size={13} /> Refresh
        </button>
      </div>

      {error && (
        <div className="mb-4 flex items-center gap-2 px-4 py-3 bg-red-50 border border-red-100 rounded-xl text-[13px] text-red-700">
          <AlertTriangle size={14} className="shrink-0" /> {error}
        </div>
      )}

      <div className="flex gap-0.5 mb-5 border-b border-slate-200">
        {TABS.map(({ id, label, Icon }) => (
          <button
            key={id}
            onClick={() => setTab(id)}
            className={`flex items-center gap-1.5 px-4 py-2.5 text-[13px] font-medium border-b-2 -mb-px transition-colors ${
              tab === id
                ? 'border-navy-600 text-navy-900'
                : 'border-transparent text-slate-400 hover:text-slate-600 hover:border-slate-300'
            }`}
          >
            <Icon size={14} />
            {label}
          </button>
        ))}
      </div>

      {tab === 'summary' && <SummaryTab summary={summary} />}
      {tab === 'config'  && <RoomConfigTab summary={summary} onDone={load} />}
      {tab === 'rates'   && <BedRatesTab   summary={summary} onDone={load} />}
      {tab === 'addons'  && <AddonsTab addonTypes={addonTypes} onDone={load} />}
    </div>
  )
}
