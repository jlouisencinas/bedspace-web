import { useEffect, useState, useCallback } from 'react'
import { fetchApprovals, approveRequest, rejectRequest } from '../lib/approvals'
import { supabase, processTransfer } from '../lib/supabase'
import { useAuth } from '../lib/auth'
import { useToast } from '../components/Toast'
import { CheckCircle, XCircle, Clock, X, ClipboardList } from 'lucide-react'

// ── Helpers ───────────────────────────────────────────────────────────────────

function fmtDate(d) {
  if (!d) return '—'
  return new Date(d).toLocaleDateString('en-PH', { month: 'short', day: 'numeric', year: 'numeric' })
}
function fmtDateTime(d) {
  if (!d) return '—'
  return new Date(d).toLocaleString('en-PH', {
    month: 'short', day: 'numeric', year: 'numeric',
    hour: 'numeric', minute: '2-digit',
  })
}

function requesterLabel(r) {
  if (r.requester_email) return r.requester_email
  const email = r.requester?.email
  if (email && email !== r.requester_id) return email
  return 'Unknown User'
}

function entityDesc(r) {
  const nv = r.new_value || {}
  const name = nv._tenant_name, room = nv._room_no, bed = nv._bed_letter
  if (name) return [name, room && `Room ${room}`, bed && `Bed ${bed}`].filter(Boolean).join(' · ')
  const typeLabel = { TENANT: 'Tenant', TENANT_STAY: 'Tenant', BED: 'Bed', ROOM: 'Room', PAYMENT: 'Payment', ADDON: 'Add-on' }
  return `${typeLabel[r.entity_type] || r.entity_type} #${r.entity_id}`
}

function proposedLabel(r) {
  const nv = r.new_value || {}
  if (r.field_name === 'move_out') {
    return [
      nv.move_out_date        && `Move-out: ${fmtDate(nv.move_out_date)}`,
      nv.actual_move_out_date && `Actual: ${fmtDate(nv.actual_move_out_date)}`,
      nv.amount_paid          && `Amount: ₱${Number(nv.amount_paid).toLocaleString('en-PH')}`,
    ].filter(Boolean).join(' · ') || '—'
  }
  if (r.field_name === 'tenant_details') {
    return [
      nv.move_out_date && `Move-out: ${fmtDate(nv.move_out_date)}`,
      nv.contact_no    && `Contact: ${nv.contact_no}`,
      nv.email         && `Email: ${nv.email}`,
    ].filter(Boolean).join(' · ') || '—'
  }
  if (r.field_name === 'transfer') {
    return [
      nv.transfer_date && `On: ${fmtDate(nv.transfer_date)}`,
      nv.new_rate      && `Rate: ₱${Number(nv.new_rate).toLocaleString('en-PH')}`,
      nv.water_reading    && `Water: ${nv.water_reading}`,
      nv.electric_reading && `Electric: ${nv.electric_reading}`,
    ].filter(Boolean).join(' · ') || '—'
  }
  if (r.field_name === 'room_config') {
    return [
      nv.room_type         && `Type: ${nv.room_type}`,
      nv.room_status       && `Status: ${nv.room_status}`,
      nv.original_bed_count != null && `Orig Beds: ${nv.original_bed_count}`,
      nv.is_management     && 'Management Room: Yes',
    ].filter(Boolean).join(' · ') || '—'
  }
  if (r.field_name === 'bed_rate') {
    return nv.default_rate != null ? `Rate → ₱${Number(nv.default_rate).toLocaleString('en-PH')}` : '—'
  }
  if (r.field_name === 'remove_bed') {
    return 'Remove bed (soft-delete → REMOVED)'
  }
  if (r.field_name === 'add_addon') {
    return [
      nv.label  && `"${nv.label}"`,
      nv.amount && `₱${Number(nv.amount).toLocaleString('en-PH')}`,
      nv.recurring ? 'Recurring' : 'One-time',
    ].filter(Boolean).join(' · ') || '—'
  }
  if (r.field_name === 'delete_addon') {
    return `Delete add-on #${nv._addon_id}`
  }
  const v = nv[r.field_name] ?? nv
  return typeof v === 'object' ? JSON.stringify(v) : (v != null ? String(v) : '—')
}

function currentLabel(r) {
  const ov = r.old_value || {}
  if (r.field_name === 'move_out') return 'Active tenant'
  if (r.field_name === 'tenant_details') {
    return [
      ov.move_out_date !== undefined && `Move-out: ${fmtDate(ov.move_out_date)}`,
      ov.contact_no    !== undefined && `Contact: ${ov.contact_no || '—'}`,
      ov.email         !== undefined && `Email: ${ov.email || '—'}`,
    ].filter(Boolean).join(' · ') || '—'
  }
  if (r.field_name === 'transfer') {
    return [
      ov.room_no     && `Room ${ov.room_no}`,
      ov.bed_letter  && `Bed ${ov.bed_letter}`,
      ov.rate        && `₱${Number(ov.rate).toLocaleString('en-PH')}/mo`,
    ].filter(Boolean).join(' · ') || 'Current bed'
  }
  const v = ov[r.field_name]
  return v != null ? String(v) : '—'
}

const FIELD_LABELS = {
  move_out:       'Process Move-out',
  move_out_date:  'Move-out Date',
  tenant_details: 'Update Details',
  transfer:       'Room Transfer',
  rate:           'Rate',
  amount:         'Amount',
  room_config:    'Room Configuration',
  bed_rate:       'Bed Rate Change',
  remove_bed:     'Remove Bed',
  add_addon:      'Add Add-on',
  delete_addon:   'Delete Add-on',
}

const STATUS_CONFIG = {
  PENDING:  { bg: 'bg-amber-50',   text: 'text-amber-700',  icon: Clock,        dot: 'bg-amber-500'   },
  APPROVED: { bg: 'bg-emerald-50', text: 'text-emerald-700',icon: CheckCircle,  dot: 'bg-emerald-500' },
  REJECTED: { bg: 'bg-red-50',     text: 'text-red-700',    icon: XCircle,      dot: 'bg-red-400'     },
}

function StatusBadge({ status }) {
  const c = STATUS_CONFIG[status] || STATUS_CONFIG.PENDING
  return (
    <span className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-[11px] font-semibold ${c.bg} ${c.text}`}>
      <span className={`w-1.5 h-1.5 rounded-full ${c.dot}`} />
      {status}
    </span>
  )
}

// ── DecideModal ───────────────────────────────────────────────────────────────

function DecideModal({ request, onClose, onDone }) {
  const [notes,    setNotes]    = useState('')
  const [busy,     setBusy]     = useState(false)
  const [decision, setDecision] = useState(null)
  const [error,    setError]    = useState('')

  async function decide(d) {
    setDecision(d); setBusy(true); setError('')
    try {
      if (d === 'APPROVED') {
        const approved = await approveRequest(request.id, notes || null)
        await applyApprovedChange(approved)
      } else {
        await rejectRequest(request.id, notes || null)
      }
      onDone(d)
    } catch (err) { setError(err.message); setBusy(false); setDecision(null) }
  }

  async function applyApprovedChange(approved) {
    const nv = approved.new_value

    if (nv?._action === 'process_transfer') {
      const tenantId = parseInt(nv._tenant_id, 10)
      if (!tenantId || isNaN(tenantId)) throw new Error(`Invalid tenant ID: "${nv._tenant_id}"`)
      // Fetch current tenant state (they may have moved since request was submitted)
      const { data: tenant, error: tErr } = await supabase
        .from('tenants')
        .select(`*, beds!bed_id(bed_letter, bed_location, room_id, rooms(room_no))`)
        .eq('id', tenantId)
        .single()
      if (tErr) throw tErr
      if (!tenant) throw new Error('Tenant not found.')
      const { data: { user } } = await supabase.auth.getUser()
      await processTransfer(
        {
          id:         tenant.id,
          bed_id:     tenant.bed_id,
          room_id:    tenant.beds?.room_id,
          room_no:    tenant.beds?.rooms?.room_no || nv._room_no,
          bed_letter: tenant.beds?.bed_letter     || nv._bed_letter,
          name:       tenant.name,
          rate:       tenant.rate,
        },
        {
          to_bed_id:        nv.to_bed_id,
          transfer_date:    nv.transfer_date,
          new_rate:         nv.new_rate,
          water_reading:    nv.water_reading,
          electric_reading: nv.electric_reading,
          notes:            nv.notes,
        },
        user?.id
      )
      return
    }

    if (nv?._action === 'process_move_out') {
      const tenantId = parseInt(nv._tenant_id, 10)
      if (!tenantId || isNaN(tenantId)) throw new Error(`Invalid tenant ID: "${nv._tenant_id}"`)
      const { error } = await supabase.from('tenants')
        .update({ move_out_date: nv.move_out_date || null, actual_move_out_date: nv.actual_move_out_date || nv.move_out_date || null })
        .eq('id', tenantId)
      if (error) throw error
      return
    }

    if (nv?._action === 'add_addon') {
      const { _action, _tenant_name, _room_no, _bed_letter, ...addonRow } = nv
      const { error } = await supabase.from('addons').insert(addonRow)
      if (error) throw error
      return
    }

    if (nv?._action === 'delete_addon') {
      const { error } = await supabase.from('addons').delete().eq('id', nv._addon_id)
      if (error) throw error
      return
    }

    const tableMap = { TENANT: 'tenants', TENANT_STAY: 'tenants', BED: 'beds', ROOM: 'rooms', PAYMENT: 'payments' }
    const tableName = tableMap[approved.entity_type]
    if (!tableName) return
    const { _action, _tenant_id, _bed_id, _room_no, _bed_letter, _tenant_name, _rate, _move_in_date, ...dbPatch } = nv
    const entityId = parseInt(approved.entity_id, 10) || approved.entity_id
    const { error } = await supabase.from(tableName).update(dbPatch).eq('id', entityId)
    if (error) throw error
  }

  const fieldLabel = FIELD_LABELS[request.field_name] || request.field_name

  return (
    <div className="overlay" onClick={e => e.stopPropagation()}>
      <div className="modal modal-sm">
        <div className="modal-head">
          <h3>Review Override Request</h3>
          <button className="btn-close" onClick={onClose}><X size={16} /></button>
        </div>
        <div className="modal-body space-y-4">

          {/* Request metadata 2×2 grid */}
          <div className="bg-slate-50 border border-slate-100 rounded-xl p-4 grid grid-cols-2 gap-x-6 gap-y-3 text-[13px]">
            <div>
              <div className="text-[10px] font-semibold text-slate-400 uppercase tracking-wider mb-0.5">Date Submitted</div>
              <div className="font-medium text-slate-900">{fmtDateTime(request.created_at)}</div>
            </div>
            <div>
              <div className="text-[10px] font-semibold text-slate-400 uppercase tracking-wider mb-0.5">Requested By</div>
              <div className="font-medium text-slate-900 truncate">{requesterLabel(request)}</div>
            </div>
            <div>
              <div className="text-[10px] font-semibold text-slate-400 uppercase tracking-wider mb-0.5">Tenant / Entity</div>
              <div className="font-medium text-slate-900">{entityDesc(request)}</div>
            </div>
            <div>
              <div className="text-[10px] font-semibold text-slate-400 uppercase tracking-wider mb-0.5">Action</div>
              <div className="font-semibold text-navy-500">{fieldLabel}</div>
            </div>
          </div>

          {/* Current → Proposed */}
          <div className="grid grid-cols-2 gap-3">
            <div className="bg-red-50 border border-red-100 rounded-xl p-3 text-[13px]">
              <div className="text-[10px] font-bold text-red-600 uppercase tracking-wider mb-1.5">Current</div>
              <div className="text-slate-700">{currentLabel(request)}</div>
            </div>
            <div className="bg-emerald-50 border border-emerald-100 rounded-xl p-3 text-[13px]">
              <div className="text-[10px] font-bold text-emerald-700 uppercase tracking-wider mb-1.5">Proposed</div>
              <div className="text-slate-700 font-medium">{proposedLabel(request)}</div>
            </div>
          </div>

          {/* Reason */}
          {request.reason && (
            <div className="bg-amber-50 border border-amber-100 rounded-xl px-4 py-3 text-[13px] text-amber-800">
              <span className="font-semibold">Reason: </span>{request.reason}
            </div>
          )}

          {/* Decision notes */}
          <div className="fg">
            <label>Decision notes (optional)</label>
            <textarea
              rows={2}
              value={notes}
              onChange={e => setNotes(e.target.value)}
              placeholder="Add a note visible in the activity log…"
            />
          </div>

          {error && (
            <div className="bg-red-50 border border-red-100 rounded-xl px-4 py-3 text-[13px] text-red-700">
              {error}
            </div>
          )}
        </div>
        <div className="modal-foot">
          <button className="btn secondary" onClick={onClose} disabled={busy}>Cancel</button>
          <button className="btn danger" onClick={() => decide('REJECTED')} disabled={busy}>
            <XCircle size={14} />
            {busy && decision === 'REJECTED' ? 'Rejecting…' : 'Reject'}
          </button>
          <button className="btn primary" onClick={() => decide('APPROVED')} disabled={busy}>
            <CheckCircle size={14} />
            {busy && decision === 'APPROVED' ? 'Approving…' : 'Approve'}
          </button>
        </div>
      </div>
    </div>
  )
}

// ── Approvals Page ────────────────────────────────────────────────────────────

export default function Approvals() {
  const { isAdmin } = useAuth()
  const [requests,     setRequests]     = useState([])
  const [loading,      setLoading]      = useState(true)
  const [filterStatus, setFilterStatus] = useState('PENDING')
  const [selected,     setSelected]     = useState(null)
  const { show, ToastEl } = useToast()

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const data = await fetchApprovals({ status: filterStatus || undefined })
      setRequests(data)
    } finally { setLoading(false) }
  }, [filterStatus])

  useEffect(() => { load() }, [load])

  async function onDone(decision) {
    setSelected(null)
    show(decision === 'APPROVED' ? 'Request approved and applied.' : 'Request rejected.', 'success')
    await load()
  }

  if (!isAdmin) return (
    <div className="page">
      <div className="empty"><p>You do not have permission to view this page.</p></div>
    </div>
  )

  const pending = requests.filter(r => r.status === 'PENDING').length

  return (
    <div className="page">
      {ToastEl}

      {/* ── Header ── */}
      <div className="page-header">
        <div>
          <h1 className="page-title">
            Override Approvals
            {pending > 0 && (
              <span className="ml-2 inline-flex items-center px-2 py-0.5 rounded-full text-[11px] font-bold bg-red-600 text-white align-middle">
                {pending}
              </span>
            )}
          </h1>
          <p className="page-sub">Protected-field changes submitted by staff for admin review</p>
        </div>

        {/* Filter tabs */}
        <div className="flex gap-1.5 p-1 bg-slate-100 rounded-lg">
          {[
            { value: 'PENDING',  label: 'Pending'  },
            { value: 'APPROVED', label: 'Approved' },
            { value: 'REJECTED', label: 'Rejected' },
            { value: '',         label: 'All'      },
          ].map(({ value, label }) => (
            <button
              key={value}
              onClick={() => setFilterStatus(value)}
              className={`px-3 py-1.5 rounded-md text-[12px] font-semibold transition-all ${
                filterStatus === value
                  ? 'bg-white text-slate-900 shadow-sm'
                  : 'text-slate-500 hover:text-slate-700'
              }`}
            >
              {label}
            </button>
          ))}
        </div>
      </div>

      {/* ── Content ── */}
      {loading ? (
        <div className="loading-screen"><div className="spinner" /></div>
      ) : requests.length === 0 ? (
        <div className="empty">
          {filterStatus === 'PENDING'
            ? <CheckCircle size={32} className="mx-auto mb-3 text-emerald-400" />
            : <ClipboardList size={32} className="mx-auto mb-3 text-slate-300" />}
          <p>{filterStatus === 'PENDING' ? 'No pending requests — all caught up!' : 'No requests found.'}</p>
        </div>
      ) : (
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Date Submitted</th>
                <th>Requested By</th>
                <th>Tenant / Entity</th>
                <th>Action</th>
                <th>Current → Proposed</th>
                <th>Reason</th>
                <th>Status</th>
                {filterStatus !== 'PENDING' && <th>Decided</th>}
                <th></th>
              </tr>
            </thead>
            <tbody>
              {requests.map(r => {
                const fieldLabel = FIELD_LABELS[r.field_name] || r.field_name
                return (
                  <tr key={r.id}>
                    <td className="text-[11px] text-slate-400 whitespace-nowrap">{fmtDateTime(r.created_at)}</td>
                    <td className="text-[12px] max-w-[150px] truncate">{requesterLabel(r)}</td>
                    <td className="text-[13px] font-medium text-slate-800">{entityDesc(r)}</td>
                    <td className="text-[12px] font-semibold text-navy-500">{fieldLabel}</td>
                    <td className="text-[12px] max-w-[200px]">
                      <span className="text-red-600">{currentLabel(r)}</span>
                      <span className="mx-2 text-slate-300">→</span>
                      <span className="text-emerald-700 font-medium">{proposedLabel(r)}</span>
                    </td>
                    <td className="text-[12px] text-slate-500 max-w-[160px] truncate" title={r.reason}>
                      {r.reason || '—'}
                    </td>
                    <td><StatusBadge status={r.status} /></td>
                    {filterStatus !== 'PENDING' && (
                      <td className="text-[11px] text-slate-400 whitespace-nowrap">
                        {r.decided_at ? fmtDateTime(r.decided_at) : '—'}
                        {r.decision_maker?.email && (
                          <div className="text-[10px] text-slate-300 mt-0.5">{r.decision_maker.email}</div>
                        )}
                      </td>
                    )}
                    <td>
                      {r.status === 'PENDING' && (
                        <button
                          className="btn-xs blue whitespace-nowrap"
                          onClick={() => setSelected(r)}
                        >
                          Review →
                        </button>
                      )}
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      )}

      {selected && (
        <DecideModal request={selected} onClose={() => setSelected(null)} onDone={onDone} />
      )}
    </div>
  )
}
