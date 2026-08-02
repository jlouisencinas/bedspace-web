import { useState, useEffect } from 'react'
import {
  Building2, Settings2, DollarSign, Tag, RefreshCw,
  ChevronDown, ChevronRight, Plus, Trash2, Edit2, Check, X,
  RotateCcw, AlertTriangle, Clock, Info,
} from 'lucide-react'
import {
  fetchPropertySummary, updateRoomConfig, updateBedRate, removeBed, restoreBed,
  fetchAddonTypes, saveAddonType, deactivateAddonType,
  fetchAllAddons, addTenantAddon, removeTenantAddon,
  fetchTenants, fetchCutoffs, supabase,
} from '../lib/supabase'
import { requestApproval } from '../lib/approvals'
import { useAuth } from '../lib/auth'
import { useToast } from '../components/Toast'

// ── Helpers ───────────────────────────────────────────────────────────────────

function fmt(n) { return n != null ? '₱' + Number(n).toLocaleString('en-PH') : '—' }

const ROOM_TYPES = [
  'Solo Room', 'Two Bed Sharing', 'Three Bed Sharing',
  'Four Bed Sharing', 'Studio', 'Commercial',
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
  const { showToast } = useToast()
  const [editing,   setEditing]   = useState(null)
  const [form,      setForm]      = useState({})
  const [reason,    setReason]    = useState('')
  const [saving,    setSaving]    = useState(false)
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
        showToast(`Room ${room.room_no} updated.`, 'success')
        cancelEdit()
        onDone()
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
    </div>
  )
}

// ── Bed Rates Tab ─────────────────────────────────────────────────────────────

function BedRatesTab({ summary, onDone }) {
  const { isAdmin } = useAuth()
  const { showToast } = useToast()
  const [collapsed,  setCollapsed]  = useState({})
  const [editingBed, setEditingBed] = useState(null)
  const [newRate,    setNewRate]    = useState('')
  const [reason,     setReason]     = useState('')
  const [saving,     setSaving]     = useState(false)
  const [pendingBeds, setPendingBeds] = useState({})

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
        showToast(`Bed ${bed.bed_letter} rate updated.`, 'success')
        cancelEdit(); onDone()
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

  async function handleRemove(bed, room) {
    if (bed.status === 'LEASED') { showToast('Cannot remove a leased bed.', 'error'); return }
    if (!window.confirm(`Remove Bed ${bed.bed_letter} from Room ${room.room_no}?\nThis is reversible — you can restore it later.`)) return
    setSaving(true)
    try {
      const { data: { user } } = await supabase.auth.getUser()
      if (isAdmin) {
        await removeBed(bed.id, { room_no: room.room_no, bed_letter: bed.bed_letter }, user?.id)
        showToast(`Bed ${bed.bed_letter} removed.`, 'success')
        onDone()
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

  async function handleRestore(bed, room) {
    if (!window.confirm(`Restore Bed ${bed.bed_letter} in Room ${room.room_no}?`)) return
    setSaving(true)
    try {
      const { data: { user } } = await supabase.auth.getUser()
      await restoreBed(bed.id, { room_no: room.room_no, bed_letter: bed.bed_letter }, user?.id)
      showToast(`Bed ${bed.bed_letter} restored.`, 'success')
      onDone()
    } catch (e) { showToast(e.message, 'error') }
    setSaving(false)
  }

  return (
    <div className="space-y-2">
      {summary.map(room => {
        const isOpen    = !collapsed[room.id]
        const allBeds   = room.beds || []
        const activeCnt = allBeds.filter(b => b.status !== 'REMOVED').length

        return (
          <div key={room.id} className="border border-slate-200 rounded-xl overflow-hidden">
            <button
              onClick={() => toggleRoom(room.id)}
              className="w-full flex items-center justify-between px-4 py-3 bg-slate-50 hover:bg-slate-100 transition-colors text-left"
            >
              <div className="flex items-center gap-3">
                {isOpen
                  ? <ChevronDown size={14} className="text-slate-400" />
                  : <ChevronRight size={14} className="text-slate-400" />}
                <span className="font-semibold text-slate-900 text-[13px]">Room {room.room_no}</span>
                {room.room_type && <span className="text-[11px] text-slate-400">{room.room_type}</span>}
                {room.is_management && (
                  <span className="text-[10px] font-bold bg-slate-200 text-slate-500 px-1.5 py-0.5 rounded">MGMT</span>
                )}
              </div>
              <span className="text-[12px] text-slate-400">{activeCnt} active bed{activeCnt !== 1 ? 's' : ''}</span>
            </button>

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
                      isRemoved           ? 'bg-red-50 text-red-500'       :
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
                            <input
                              type="number" min="0" step="0.01" autoFocus
                              value={newRate}
                              onChange={e => setNewRate(e.target.value)}
                              className={`${INPUT_SM} w-28 text-right`}
                            />
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
    </div>
  )
}

// ── Add-ons Tab ───────────────────────────────────────────────────────────────

function AddAddonModal({ tenants, addonTypes, cutoffs, onClose, onSaved }) {
  const { isAdmin } = useAuth()
  const { showToast } = useToast()
  const [tenantId,   setTenantId]   = useState('')
  const [typeId,     setTypeId]     = useState('')
  const [amount,     setAmount]     = useState('')
  const [recurring,  setRecurring]  = useState(false)
  const [cutoffId,   setCutoffId]   = useState('')
  const [reason,     setReason]     = useState('')
  const [saving,     setSaving]     = useState(false)
  const [submitted,  setSubmitted]  = useState(false)
  const [error,      setError]      = useState('')

  const selectedType   = addonTypes.find(t => String(t.id) === String(typeId))
  const activeCutoffs  = cutoffs.filter(c => c.is_active)
  const activeTenants  = tenants.filter(t => !t.actual_move_out_date).sort((a, b) => a.name.localeCompare(b.name))

  async function handleSubmit(e) {
    e.preventDefault()
    setError('')
    if (!tenantId)                     { setError('Select a tenant.');              return }
    if (!typeId)                       { setError('Select an add-on type.');        return }
    if (!amount || Number(amount) <= 0){ setError('Enter a valid amount.');         return }
    if (!isAdmin && !reason.trim())    { setError('Reason is required.');           return }

    const tenant = tenants.find(t => String(t.id) === String(tenantId))
    const row = {
      tenant_id: Number(tenantId),
      label:     selectedType.label,
      category:  selectedType.category,
      bill_on:   selectedType.bill_on,
      amount:    Number(amount),
      recurring,
      cutoff_id: recurring ? null : (cutoffId ? Number(cutoffId) : null),
    }

    setSaving(true)
    try {
      if (isAdmin) {
        const { data: { user } } = await supabase.auth.getUser()
        await addTenantAddon(row, user?.id)
        showToast('Add-on saved.', 'success')
        onSaved()
      } else {
        await requestApproval({
          entityType: 'ADDON', entityId: String(tenantId),
          fieldName: 'add_addon',
          oldValue: null,
          newValue: { _action: 'add_addon', _tenant_name: tenant?.name, ...row },
          reason: reason.trim(),
        })
        setSubmitted(true)
      }
    } catch (err) { setError(err.message) }
    setSaving(false)
  }

  if (submitted) {
    return (
      <div className="overlay" onClick={e => e.stopPropagation()}>
        <div className="modal modal-sm">
          <div className="modal-head">
            <h3>Add-on Request Sent</h3>
            <button className="btn-close" onClick={onClose}><X size={16} /></button>
          </div>
          <div className="modal-body text-center py-8">
            <Clock size={36} className="mx-auto mb-3 text-amber-400" />
            <p className="text-[13px] text-slate-500">Your add-on request has been submitted for admin approval.</p>
          </div>
          <div className="modal-foot"><button className="btn primary" onClick={onClose}>Close</button></div>
        </div>
      </div>
    )
  }

  return (
    <div className="overlay" onClick={e => e.stopPropagation()}>
      <div className="modal" style={{ maxWidth: 460 }}>
        <div className="modal-head">
          <h3 className="flex items-center gap-2"><Plus size={15} className="text-slate-400" /> Add Add-on</h3>
          <button className="btn-close" onClick={onClose}><X size={16} /></button>
        </div>
        <form onSubmit={handleSubmit}>
          <div className="modal-body">
            {addonTypes.length === 0 && (
              <div className="mb-4 flex items-start gap-2 bg-amber-50 border border-amber-100 rounded-xl px-3 py-2.5 text-[12px] text-amber-800">
                <Info size={13} className="shrink-0 mt-0.5 text-amber-500" />
                No add-on types defined yet. An admin needs to create types first.
              </div>
            )}
            <div className="form-grid">
              <div className="fg full">
                <label>Tenant *</label>
                <select value={tenantId} onChange={e => setTenantId(e.target.value)} required>
                  <option value="">Select tenant…</option>
                  {activeTenants.map(t => (
                    <option key={t.id} value={t.id}>{t.name}</option>
                  ))}
                </select>
              </div>
              <div className="fg full">
                <label>Add-on Type *</label>
                <select value={typeId} onChange={e => setTypeId(e.target.value)} required disabled={addonTypes.length === 0}>
                  <option value="">Select type…</option>
                  {addonTypes.map(t => (
                    <option key={t.id} value={t.id}>{t.label} ({t.category === 'ELECTRIC' ? 'Electric' : 'Rent+Water'})</option>
                  ))}
                </select>
              </div>
              <div className="fg">
                <label>Amount (₱) *</label>
                <input
                  type="number" min="0.01" step="0.01"
                  value={amount}
                  onChange={e => setAmount(e.target.value)}
                  required
                />
              </div>
              <div className="fg">
                <label>Frequency</label>
                <label className="flex items-center gap-2 cursor-pointer mt-1">
                  <input
                    type="checkbox" checked={recurring}
                    onChange={e => { setRecurring(e.target.checked); setCutoffId('') }}
                    className="rounded"
                  />
                  <span className="text-[13px] text-slate-700">Recurring every period</span>
                </label>
              </div>
              {!recurring && (
                <div className="fg full">
                  <label>Apply to Period</label>
                  <select value={cutoffId} onChange={e => setCutoffId(e.target.value)}>
                    <option value="">Current active period</option>
                    {activeCutoffs.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
                  </select>
                </div>
              )}
              {selectedType && (
                <div className="fg full">
                  <div className="bg-slate-50 border border-slate-100 rounded-xl px-3 py-2 text-[12px] text-slate-600 flex items-center gap-2">
                    <Info size={12} className="text-slate-400 shrink-0" />
                    Billed under: <strong>{selectedType.bill_on === 'ELECTRIC' ? 'Electricity statement' : 'Rent + Water statement'}</strong>
                  </div>
                </div>
              )}
              {!isAdmin && (
                <div className="fg full">
                  <label>Reason *</label>
                  <textarea
                    rows={2} value={reason}
                    onChange={e => setReason(e.target.value)}
                    placeholder="Explain why this add-on is needed…"
                    required
                  />
                </div>
              )}
            </div>
            {error && (
              <div className="mt-3 px-3 py-2 bg-red-50 border border-red-100 rounded-xl text-[12px] text-red-700 flex items-center gap-2">
                <AlertTriangle size={12} className="shrink-0" /> {error}
              </div>
            )}
          </div>
          <div className="modal-foot">
            <button type="button" className="btn secondary" onClick={onClose}>Cancel</button>
            <button type="submit" className="btn primary" disabled={saving || addonTypes.length === 0}>
              {saving ? 'Saving…' : isAdmin ? 'Add Add-on' : 'Submit for Approval'}
            </button>
          </div>
        </form>
      </div>
    </div>
  )
}

function AddonTypeModal({ existing, onClose, onSaved }) {
  const { showToast } = useToast()
  const [label,    setLabel]    = useState(existing?.label    || '')
  const [category, setCategory] = useState(existing?.category || 'RENT_WATER')
  const [billOn,   setBillOn]   = useState(existing?.bill_on  || 'RENT_WATER')
  const [saving,   setSaving]   = useState(false)

  async function handleSubmit(e) {
    e.preventDefault()
    if (!label.trim()) { showToast('Label is required.', 'error'); return }
    setSaving(true)
    try {
      const { data: { user } } = await supabase.auth.getUser()
      await saveAddonType(
        { id: existing?.id, label: label.trim(), category, bill_on: billOn },
        user?.id
      )
      showToast(existing ? 'Add-on type updated.' : 'Add-on type created.', 'success')
      onSaved()
    } catch (e) { showToast(e.message, 'error') }
    setSaving(false)
  }

  return (
    <div className="overlay" onClick={e => e.stopPropagation()}>
      <div className="modal modal-sm">
        <div className="modal-head">
          <h3>{existing ? 'Edit Add-on Type' : 'New Add-on Type'}</h3>
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
                <label>Category</label>
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
    </div>
  )
}

function AddonsTab({ addons, addonTypes, tenants, cutoffs, onDone }) {
  const { isAdmin } = useAuth()
  const { showToast } = useToast()
  const [showAdd,     setShowAdd]     = useState(false)
  const [typeModal,   setTypeModal]   = useState(null) // null | 'new' | existing type object
  const [deleting,    setDeleting]    = useState(null)
  const [deactivating, setDeactivating] = useState(null)

  async function handleDeleteAddon(addon) {
    if (!window.confirm(`Delete "${addon.label}" add-on?`)) return
    setDeleting(addon.id)
    try {
      if (isAdmin) {
        const { data: { user } } = await supabase.auth.getUser()
        await removeTenantAddon(addon.id, user?.id)
        showToast('Add-on deleted.', 'success')
        onDone()
      } else {
        const t = addon.tenants
        await requestApproval({
          entityType: 'ADDON', entityId: String(addon.id),
          fieldName: 'delete_addon',
          oldValue: { label: addon.label, amount: addon.amount, tenant_id: addon.tenant_id },
          newValue: { _action: 'delete_addon', _addon_id: addon.id, _tenant_name: t?.name },
          reason: `Delete add-on "${addon.label}" for ${t?.name || 'tenant'}`,
        })
        showToast('Delete request submitted for approval.', 'info')
        onDone()
      }
    } catch (e) { showToast(e.message, 'error') }
    setDeleting(null)
  }

  async function handleDeactivateType(type) {
    if (!window.confirm(`Deactivate add-on type "${type.label}"?\nExisting add-ons using this type are unaffected.`)) return
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
    <div className="space-y-6">
      {/* ── Add-on Type Catalog (admin only) ── */}
      {isAdmin && (
        <div>
          <div className="flex items-center justify-between mb-3">
            <h3 className="text-[13px] font-semibold text-slate-700">Add-on Type Catalog</h3>
            <button onClick={() => setTypeModal('new')} className="btn-xs green flex items-center gap-1">
              <Plus size={11} /> New Type
            </button>
          </div>
          <div className="border border-slate-200 rounded-xl overflow-hidden">
            <table className="w-full text-[12px]">
              <thead>
                <tr className="text-[10px] text-slate-400 uppercase tracking-widest bg-slate-50">
                  <th className="px-4 py-2 text-left font-semibold">Label</th>
                  <th className="px-4 py-2 text-left font-semibold">Category</th>
                  <th className="px-4 py-2 text-left font-semibold">Billed Under</th>
                  <th className="px-4 py-2 w-[80px]"></th>
                </tr>
              </thead>
              <tbody>
                {addonTypes.length === 0 ? (
                  <tr><td colSpan={4} className="px-4 py-3 text-center text-slate-300">No types yet</td></tr>
                ) : addonTypes.map(t => (
                  <tr key={t.id} className="border-t border-slate-50">
                    <td className="px-4 py-2.5 font-medium text-slate-800">{t.label}</td>
                    <td className="px-4 py-2.5">
                      <span className={`text-[11px] font-semibold px-2 py-0.5 rounded-full ${
                        t.category === 'ELECTRIC' ? 'bg-blue-50 text-blue-700' : 'bg-teal-50 text-teal-700'
                      }`}>{t.category === 'ELECTRIC' ? 'Electric' : 'Rent+Water'}</span>
                    </td>
                    <td className="px-4 py-2.5 text-slate-500">{t.bill_on === 'ELECTRIC' ? 'Electricity stmt' : 'Rent+Water stmt'}</td>
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
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* ── Tenant Add-ons ── */}
      <div>
        <div className="flex items-center justify-between mb-3">
          <h3 className="text-[13px] font-semibold text-slate-700">Tenant Add-ons</h3>
          <button onClick={() => setShowAdd(true)} className="btn primary flex items-center gap-1.5 text-[12px] py-1.5 px-3">
            <Plus size={13} /> New Add-on
          </button>
        </div>
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Tenant</th>
                <th>Room</th>
                <th>Label</th>
                <th>Category</th>
                <th className="text-right">Amount</th>
                <th>Frequency</th>
                <th>Period</th>
                <th className="w-[60px]"></th>
              </tr>
            </thead>
            <tbody>
              {addons.length === 0 ? (
                <tr>
                  <td colSpan={8} className="text-center py-10 text-slate-300 text-[13px]">
                    No add-ons recorded
                  </td>
                </tr>
              ) : addons.map(a => {
                const t = a.tenants
                const bed  = t?.beds
                const room = bed?.rooms
                return (
                  <tr key={a.id}>
                    <td className="td-name">{t?.name || '—'}</td>
                    <td className="text-[12px] text-slate-500 whitespace-nowrap">
                      {room ? `Rm ${room.room_no}` : '—'}{bed ? ` · ${bed.bed_letter}` : ''}
                    </td>
                    <td className="text-[12px] font-medium">{a.label}</td>
                    <td>
                      <span className={`text-[11px] font-semibold px-2 py-0.5 rounded-full ${
                        a.category === 'ELECTRIC' ? 'bg-blue-50 text-blue-700' : 'bg-teal-50 text-teal-700'
                      }`}>{a.category === 'ELECTRIC' ? 'Electric' : 'Rent+Water'}</span>
                    </td>
                    <td className="text-right text-[12px] font-semibold">₱{Number(a.amount).toLocaleString('en-PH')}</td>
                    <td>
                      <span className={`text-[11px] font-semibold px-2 py-0.5 rounded-full ${
                        a.recurring ? 'bg-emerald-50 text-emerald-700' : 'bg-slate-100 text-slate-500'
                      }`}>{a.recurring ? 'Recurring' : 'One-time'}</span>
                    </td>
                    <td className="text-[11px] text-slate-400">
                      {a.cutoff_id ? `Period #${a.cutoff_id}` : (a.recurring ? 'All periods' : '—')}
                    </td>
                    <td>
                      <button
                        onClick={() => handleDeleteAddon(a)}
                        disabled={deleting === a.id}
                        className="btn-xs red"
                      ><Trash2 size={11} /></button>
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      </div>

      {showAdd && (
        <AddAddonModal
          tenants={tenants}
          addonTypes={addonTypes}
          cutoffs={cutoffs}
          onClose={() => setShowAdd(false)}
          onSaved={() => { setShowAdd(false); onDone() }}
        />
      )}

      {typeModal && (
        <AddonTypeModal
          existing={typeModal === 'new' ? null : typeModal}
          onClose={() => setTypeModal(null)}
          onSaved={() => { setTypeModal(null); onDone() }}
        />
      )}
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
  const [addons,     setAddons]    = useState([])
  const [addonTypes, setAddonTypes] = useState([])
  const [tenants,    setTenants]   = useState([])
  const [cutoffs,    setCutoffs]   = useState([])
  const [loading,    setLoading]   = useState(true)
  const [error,      setError]     = useState('')

  async function load() {
    setLoading(true); setError('')
    try {
      const [s, a, at, t, c] = await Promise.all([
        fetchPropertySummary(),
        fetchAllAddons(),
        fetchAddonTypes(),
        fetchTenants(),
        fetchCutoffs(),
      ])
      setSummary(s); setAddons(a); setAddonTypes(at); setTenants(t); setCutoffs(c)
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
          <p className="page-sub">Rooms, bed rates, and tenant add-ons</p>
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

      {/* Tabs */}
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
      {tab === 'addons'  && (
        <AddonsTab
          addons={addons} addonTypes={addonTypes}
          tenants={tenants} cutoffs={cutoffs}
          onDone={load}
        />
      )}
    </div>
  )
}
