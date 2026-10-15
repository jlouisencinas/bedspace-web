import { useEffect, useState, useCallback, useMemo } from 'react'
import { fetchApprovals, approveRequest, rejectRequest } from '../lib/approvals'
import { supabase, processTransfer, logTenantMoveOutDateChange, deleteInterimReading, processMoveOutWithBill, fetchTenantDeposits, fetchCutoffs, fetchStoredAdvanceCredits, verifyMoveOutApplied } from '../lib/supabase'
import { reconcileBill } from '../lib/finalBill'
import { applyTenantProfileChange, PROFILE_FIELD_LABELS } from '../lib/tenantProfile'
import { notifyAsync } from '../lib/notify'
import { FIELD_LABELS } from '../../supabase/functions/_shared/approval-labels.ts'
import { useAuth } from '../lib/auth'
import { useToast } from '../components/Toast'
import { CheckCircle, XCircle, Clock, X, ClipboardList } from 'lucide-react'

// ── Helpers ───────────────────────────────────────────────────────────────────

function fmtDate(d) {
  if (!d) return '—'
  return new Date(d).toLocaleDateString('en-PH', { month: 'short', day: 'numeric', year: 'numeric' })
}
const pesoText = n => '₱' + Number(n || 0).toLocaleString('en-PH', { minimumFractionDigits: 2, maximumFractionDigits: 2 })

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
  const typeLabel = { TENANT: 'Tenant', TENANT_STAY: 'Tenant', BED: 'Bed', ROOM: 'Room', PAYMENT: 'Payment', ADDON: 'Add-on', INTERIM_READING: 'Meter Reading' }
  return `${typeLabel[r.entity_type] || r.entity_type} #${r.entity_id}`
}

function entryValues(list) {
  return list?.length ? list.map(e => e.value).join(', ') : 'none'
}

function profileSummary(v) {
  return [
    ...Object.entries(v.fields || {}).map(([k, x]) => `${PROFILE_FIELD_LABELS[k] || k}: ${x ?? '—'}`),
    'move_out_date' in v && `Move-out: ${fmtDate(v.move_out_date)}`,
    v.contacts && `Contacts: ${entryValues(v.contacts)}`,
    v.emails   && `Emails: ${entryValues(v.emails)}`,
  ].filter(Boolean).join(' · ') || '—'
}

async function fetchTenantForApply(entityId) {
  const tenantId = parseInt(entityId, 10)
  if (!tenantId || isNaN(tenantId)) throw new Error(`Invalid tenant ID: "${entityId}"`)
  const { data, error } = await supabase
    .from('tenants')
    .select(`*, beds!bed_id(bed_letter, rooms(room_no))`)
    .eq('id', tenantId)
    .single()
  if (error) throw error
  if (!data) throw new Error('Tenant not found.')
  return { ...data, room_no: data.beds?.rooms?.room_no ?? null, bed_letter: data.beds?.bed_letter ?? null }
}

function proposedLabel(r) {
  const nv = r.new_value || {}
  if (r.field_name === 'tenant_profile') return profileSummary(nv)
  if (r.field_name === 'move_out') {
    return [
      nv.move_out_date        && `Move-out: ${fmtDate(nv.move_out_date)}`,
      nv.actual_move_out_date && `Actual: ${fmtDate(nv.actual_move_out_date)}`,
      nv.amount_paid          && `Amount: ₱${Number(nv.amount_paid).toLocaleString('en-PH')}`,
      nv.water_reading        && `Water: ${nv.water_reading}`,
      nv.electric_reading     && `Electric: ${nv.electric_reading}`,
      nv._bill && (Number(nv._bill.net_amount) < 0
        ? `Refund due ${pesoText(-nv._bill.net_amount)}`
        : `Bill due ${pesoText(nv._bill.net_amount)}`),
      nv._bill?.early_termination && 'Early termination',
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
  if (r.field_name === 'tenant_rate') {
    return nv.rate != null ? `Rate → ₱${Number(nv.rate).toLocaleString('en-PH')}` : '—'
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
  if (r.field_name === 'interim_reading_delete') {
    return [
      'Delete',
      nv._room_no != null && `Room ${nv._room_no}`,
      nv.utility,
      nv.reading_date && `Date: ${fmtDate(nv.reading_date)}`,
      nv.reading_value != null && `Reading: ${nv.reading_value}`,
    ].filter(Boolean).join(' · ') || '—'
  }
  const v = nv[r.field_name] ?? nv
  return typeof v === 'object' ? JSON.stringify(v) : (v != null ? String(v) : '—')
}

function currentLabel(r) {
  const ov = r.old_value || {}
  if (r.field_name === 'tenant_profile') return profileSummary(ov)
  if (r.field_name === 'move_out') return 'Active tenant'
  if (r.field_name === 'interim_reading_delete') {
    return [
      ov.room_no != null && `Room ${ov.room_no}`,
      ov.utility,
      ov.reading_date && `Date: ${fmtDate(ov.reading_date)}`,
      ov.reading_value != null && `Reading: ${ov.reading_value}`,
    ].filter(Boolean).join(' · ') || 'Reading exists'
  }
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
  if (r.field_name === 'room_config') {
    return [
      ov.room_type         && `Type: ${ov.room_type}`,
      ov.room_status       && `Status: ${ov.room_status}`,
      ov.original_bed_count != null && `Orig Beds: ${ov.original_bed_count}`,
      ov.is_management     && 'Management Room: Yes',
    ].filter(Boolean).join(' · ') || '—'
  }
  if (r.field_name === 'bed_rate') {
    return ov.default_rate != null ? `Rate: ₱${Number(ov.default_rate).toLocaleString('en-PH')}` : '—'
  }
  if (r.field_name === 'tenant_rate') {
    return ov.rate != null ? `Rate: ₱${Number(ov.rate).toLocaleString('en-PH')}` : '—'
  }
  const v = ov[r.field_name]
  return v != null ? String(v) : '—'
}

const STATUS_CONFIG = {
  PENDING:  { bg: 'bg-warning-bg',   text: 'text-warning-text',  icon: Clock,        dot: 'bg-amber-500'   },
  APPROVED: { bg: 'bg-success-bg', text: 'text-success-text',icon: CheckCircle,  dot: 'bg-emerald-500' },
  REJECTED: { bg: 'bg-danger-bg',     text: 'text-danger-text',    icon: XCircle,      dot: 'bg-red-400'     },
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

// ── Tenant profile change detail ─────────────────────────────────────────────

function EntryList({ list }) {
  if (!list?.length) return <div className="text-ink-faint italic">None</div>
  return list.map((e, i) => (
    <div key={e.id ?? `new-${i}`}>
      {e.value}
      {e.label && <span className="text-[11px] text-ink-faint"> {e.label}</span>}
      {e.isPrimary && <span className="text-[10px] font-bold text-navy-600"> (Primary)</span>}
    </div>
  ))
}

function EntryListChange({ title, before, after }) {
  return (
    <div>
      <div className="text-[10px] font-semibold text-ink-faint uppercase tracking-wider mb-1">{title}</div>
      <div className="grid grid-cols-2 gap-3">
        <div className="bg-danger-bg border border-danger-border rounded-xl p-3">
          <div className="text-[10px] font-bold text-danger-text uppercase tracking-wider mb-1.5">Current</div>
          <div className="text-ink-secondary"><EntryList list={before} /></div>
        </div>
        <div className="bg-success-bg border border-success-border rounded-xl p-3">
          <div className="text-[10px] font-bold text-success-text uppercase tracking-wider mb-1.5">Proposed</div>
          <div className="text-ink-secondary font-medium"><EntryList list={after} /></div>
        </div>
      </div>
    </div>
  )
}

function ProfileChangeDetail({ request }) {
  const ov = request.old_value || {}
  const nv = request.new_value || {}
  const fieldKeys = Object.keys(nv.fields || {})
  const hasMoveOut = 'move_out_date' in nv
  return (
    <div className="space-y-3 text-[13px]">
      {(fieldKeys.length > 0 || hasMoveOut) && (
        <div className="bg-surface-2 border border-line-subtle rounded-xl p-4 space-y-2">
          {fieldKeys.map(k => (
            <div key={k}>
              <div className="text-[10px] font-semibold text-ink-faint uppercase tracking-wider mb-0.5">{PROFILE_FIELD_LABELS[k] || k}</div>
              <span className="text-danger-text">{ov.fields?.[k] ?? '—'}</span>
              <span className="mx-2 text-ink-faint">→</span>
              <span className="text-success-text font-medium">{nv.fields[k] ?? '—'}</span>
            </div>
          ))}
          {hasMoveOut && (
            <div>
              <div className="text-[10px] font-semibold text-ink-faint uppercase tracking-wider mb-0.5">Planned Move-out Date</div>
              <span className="text-danger-text">{fmtDate(ov.move_out_date)}</span>
              <span className="mx-2 text-ink-faint">→</span>
              <span className="text-success-text font-medium">{fmtDate(nv.move_out_date)}</span>
            </div>
          )}
        </div>
      )}
      {nv.contacts && <EntryListChange title="Contact Numbers" before={ov.contacts} after={nv.contacts} />}
      {nv.emails   && <EntryListChange title="Email Addresses" before={ov.emails}   after={nv.emails} />}
    </div>
  )
}

// ── DecideModal ───────────────────────────────────────────────────────────────

function DecideModal({ request, onClose, onDone }) {
  const [notes,    setNotes]    = useState('')
  const [busy,     setBusy]     = useState(false)
  const [decision, setDecision] = useState(null)
  const [error,    setError]    = useState('')

  const nvReq = request.new_value || {}
  const moveOutBill = request.field_name === 'move_out' && nvReq._action === 'process_move_out' ? nvReq._bill : null
  const [waived,    setWaived]    = useState(false)
  const [waiveReason, setWaiveReason] = useState('')
  const [partialApplied, setPartialApplied] = useState(false)
  const [ctx, setCtx] = useState(null)

  async function loadMoveOutCtx() {
    const tenantId = parseInt(nvReq._tenant_id, 10)
    if (!tenantId || isNaN(tenantId)) throw new Error(`Invalid tenant ID: "${nvReq._tenant_id}"`)
    const [tRes, deposits, cutoffs, stored] = await Promise.all([
      supabase.from('tenants').select('*, beds!bed_id(bed_letter, room_id, rooms(room_no))').eq('id', tenantId).single(),
      fetchTenantDeposits(tenantId), fetchCutoffs(), fetchStoredAdvanceCredits(),
    ])
    if (tRes.error) throw tRes.error
    return { tenant: tRes.data, deposits, cutoffs, stored }
  }
  const moveOutDay = (nvReq.actual_move_out_date || nvReq.move_out_date || '').slice(0, 10)
  const reconcile = (c, w) => reconcileBill({ bill: moveOutBill, moveOut: moveOutDay, tenant: c.tenant, deposits: c.deposits, cutoffs: c.cutoffs, storedCredits: c.stored, waived: w })

  useEffect(() => {
    if (!moveOutBill) return
    loadMoveOutCtx().then(setCtx).catch(e => setError(`Could not load the tenant's current data: ${e.message}`))
  }, [])

  // What will actually be applied: the credit/forfeit lines, cutoff and early termination are recomputed from the DB.
  const rec = useMemo(() => (ctx ? reconcile(ctx, waived) : null), [ctx, waived])
  const billLines = rec ? rec.lines : (moveOutBill?.lines || [])
  const billTotals = rec ? rec.totals : null
  const earlyNow = rec ? rec.early_termination : !!moveOutBill?.early_termination

  async function decide(d) {
    setDecision(d); setBusy(true); setError('')
    try {
      let warning = null
      if (d === 'APPROVED' && request.field_name === 'tenant_profile') {
        // Apply before marking approved so a failed apply leaves the request PENDING.
        warning = await applyTenantProfileRequest()
        try {
          await approveRequest(request.id, notes || null)
        } catch (err) {
          throw new Error(`Changes were applied, but marking the request approved failed: ${err.message}`)
        }
      } else if (d === 'APPROVED' && moveOutBill) {
        // Apply before marking approved so a failed apply leaves the request PENDING.
        await applyMoveOutRequest()
        try {
          await approveRequest(request.id, notes || null)
        } catch (err) {
          throw new Error(`The move-out and final bill were applied, but marking the request approved failed: ${err.message}`)
        }
      } else if (d === 'APPROVED') {
        const approved = await approveRequest(request.id, notes || null)
        await applyApprovedChange(approved)
      } else {
        await rejectRequest(request.id, notes || null)
      }
      // Only after the whole path succeeded; a `warning` (change applied, log write failed) still counts.
      notifyAsync('approval_decision', request.id)
      onDone(d, warning)
    } catch (err) {
      let msg = err.message, markable = false
      if (err.orphanBill) {
        msg = `Final bill #${err.billId} was saved but the tenant is still ACTIVE (the move-out did not go through and the bill could not be voided automatically). Void bill #${err.billId} from the tenant profile (Advance & Deposit tab) before retrying this request.\n\n(${err.message})`
      } else if (moveOutBill) {
        // Decide from the database, not from the error: was the move-out really applied?
        try {
          const v = await verifyMoveOutApplied(parseInt(nvReq._tenant_id, 10), moveOutDay)
          if (v.ok) {
            markable = true
            msg = `${err.message}\n\nThe tenant HAS been moved out (final bill #${v.billId}) but this request is still PENDING. Check the bill on the tenant profile and finish any failed step by hand, then use "Mark approved (already applied)".`
          }
        } catch { /* keep the original message; no recovery button */ }
      }
      setError(msg)
      setPartialApplied(markable)
      setBusy(false); setDecision(null)
    }
  }

  async function applyTenantProfileRequest() {
    const { data: cur, error: sErr } = await supabase
      .from('approval_requests').select('status').eq('id', request.id).single()
    if (sErr) throw sErr
    if (cur.status !== 'PENDING') throw new Error('This request has already been decided.')

    const nv = request.new_value || {}
    const tenant = await fetchTenantForApply(request.entity_id)
    const { wrote, saveError, logError } = await applyTenantProfileChange(
      { ...tenant, room_no: tenant.room_no ?? nv._room_no ?? null, bed_letter: tenant.bed_letter ?? nv._bed_letter ?? null },
      {
        fields:      nv.fields || {},
        moveOutDate: 'move_out_date' in nv ? nv.move_out_date : undefined,
        contacts:    nv.contacts ?? null,
        emails:      nv.emails ?? null,
      },
    )
    if (saveError) {
      let msg = wrote
        ? `Apply failed partway (some changes were saved; request left pending): ${saveError}`
        : `Apply failed (request left pending): ${saveError}`
      if (logError) msg += ` Activity log also failed: ${logError}`
      throw new Error(msg)
    }
    return logError ? `Request approved and applied, but activity log failed: ${logError}` : null
  }

  async function applyMoveOutRequest() {
    const { data: cur, error: sErr } = await supabase
      .from('approval_requests').select('status').eq('id', request.id).single()
    if (sErr) throw sErr
    if (cur.status !== 'PENDING') throw new Error('This request has already been decided.')
    if (String(nvReq._tenant_id) !== String(request.entity_id)) throw new Error('The request is inconsistent: its tenant does not match the tenant it was filed against. Reject it.')

    // Re-read everything the money depends on and recompute it; nothing but staff-edited text/charges is trusted from the request.
    const c = await loadMoveOutCtx()
    const t = c.tenant
    if (!t.is_active) throw new Error('This tenant has already moved out.')
    const r = reconcile(c, waived)
    if (r.errors.length) throw new Error(`The request cannot be applied: ${r.errors.join(' ')}`)
    if (r.forfeit_waived && !waiveReason.trim()) throw new Error('Enter the reason management approved waiving the forfeiture.')
    const { data: { user } } = await supabase.auth.getUser()
    await processMoveOutWithBill(
      { ...t, room_id: t.beds?.room_id ?? null, _room_no: t.beds?.rooms?.room_no ?? nvReq._room_no, _bed_letter: t.beds?.bed_letter ?? nvReq._bed_letter },
      {
        move_out_date: nvReq.move_out_date, actual_move_out_date: nvReq.actual_move_out_date,
        amount_paid: nvReq.amount_paid, water_reading: nvReq.water_reading, electric_reading: nvReq.electric_reading,
      },
      {
        ...moveOutBill, lines: r.lines.map(({ _amt, ...l }) => l), cutoff_id: r.cutoff_id,
        early_termination: r.early_termination, forfeit_waived: r.forfeit_waived,
        waived_reason: r.forfeit_waived ? waiveReason.trim() : null,
      },
      user?.id,
    )
  }

  async function markApplied() {
    setBusy(true); setError('')
    try {
      if (String(nvReq._tenant_id) !== String(request.entity_id)) throw new Error('The request is inconsistent: its tenant does not match the tenant it was filed against.')
      const v = await verifyMoveOutApplied(parseInt(nvReq._tenant_id, 10), moveOutDay)
      if (!v.ok) throw new Error(`Not marked approved: ${v.reason}. This action only records a move-out that was really applied.`)
      await approveRequest(request.id, notes || null)
      notifyAsync('approval_decision', request.id)
      onDone('APPROVED', null)
    } catch (err) { setError(err.message); setBusy(false) }
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

    if (nv?._action === 'delete_interim_reading') {
      await deleteInterimReading(nv._reading_id)
      return
    }

    if (approved.entity_type === 'TENANT' && approved.field_name === 'move_out_date') {
      const tenant = await fetchTenantForApply(approved.entity_id)
      const newDate = nv?.move_out_date || null
      const { error } = await supabase.from('tenants').update({ move_out_date: newDate }).eq('id', tenant.id)
      if (error) throw error
      if (newDate !== (tenant.move_out_date?.slice(0, 10) || null)) {
        await logTenantMoveOutDateChange(
          { ...tenant, room_no: tenant.room_no ?? nv._room_no ?? null, bed_letter: tenant.bed_letter ?? nv._bed_letter ?? null },
          newDate,
        )
      }
      return
    }

    if (approved.entity_type === 'TENANT' && approved.field_name === 'tenant_rate') {
      // Tenant may have moved out between request submission and approval — the request
      // is already marked APPROVED (see caller) since it was legitimately reviewed, but
      // the rate write itself must not land on a closed tenancy (requirements §14).
      const tenant = await fetchTenantForApply(approved.entity_id)
      if (!tenant.is_active) {
        throw new Error('Request approved, but the rate was NOT applied: this tenant is no longer active.')
      }
      const { error } = await supabase.from('tenants').update({ rate: nv.rate }).eq('id', tenant.id)
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
          <div className="bg-surface-2 border border-line-subtle rounded-xl p-4 grid grid-cols-2 gap-x-6 gap-y-3 text-[13px]">
            <div>
              <div className="text-[10px] font-semibold text-ink-faint uppercase tracking-wider mb-0.5">Date Submitted</div>
              <div className="font-medium text-ink">{fmtDateTime(request.created_at)}</div>
            </div>
            <div>
              <div className="text-[10px] font-semibold text-ink-faint uppercase tracking-wider mb-0.5">Requested By</div>
              <div className="font-medium text-ink truncate">{requesterLabel(request)}</div>
            </div>
            <div>
              <div className="text-[10px] font-semibold text-ink-faint uppercase tracking-wider mb-0.5">Tenant / Entity</div>
              <div className="font-medium text-ink">{entityDesc(request)}</div>
            </div>
            <div>
              <div className="text-[10px] font-semibold text-ink-faint uppercase tracking-wider mb-0.5">Action</div>
              <div className="font-semibold text-navy-500">{fieldLabel}</div>
            </div>
          </div>

          {/* Current → Proposed */}
          {request.field_name === 'tenant_profile' ? (
            <ProfileChangeDetail request={request} />
          ) : (
            <div className="grid grid-cols-2 gap-3">
              <div className="bg-danger-bg border border-danger-border rounded-xl p-3 text-[13px]">
                <div className="text-[10px] font-bold text-danger-text uppercase tracking-wider mb-1.5">Current</div>
                <div className="text-ink-secondary">{currentLabel(request)}</div>
              </div>
              <div className="bg-success-bg border border-success-border rounded-xl p-3 text-[13px]">
                <div className="text-[10px] font-bold text-success-text uppercase tracking-wider mb-1.5">Proposed</div>
                <div className="text-ink-secondary font-medium">{proposedLabel(request)}</div>
              </div>
            </div>
          )}

          {moveOutBill && (
            <div className="bg-surface-2 border border-line-subtle rounded-xl p-4 space-y-2 text-[12px]">
              <div className="text-[10px] font-semibold text-ink-faint uppercase tracking-wider">Final bill</div>
              {!ctx && !error && <div className="text-ink-muted">Checking the bill against the tenant's current data…</div>}
              {rec && rec.diffs.length > 0 && (
                <div className="bg-warning-bg border border-warning-border rounded-lg px-3 py-2 text-warning-text space-y-1">
                  <div className="font-semibold">Differences between the request and what will be applied:</div>
                  {rec.diffs.map((x, i) => <div key={i}>{x}</div>)}
                </div>
              )}
              {rec && rec.errors.length > 0 && (
                <div className="bg-danger-bg border border-danger-border rounded-lg px-3 py-2 text-danger-text space-y-1">
                  <div className="font-semibold">This request cannot be approved as submitted. Reject it and ask for a new move-out.</div>
                  {rec.errors.map((x, i) => <div key={i}>{x}</div>)}
                </div>
              )}
              {earlyNow && (
                <div className="bg-danger-bg border border-danger-border rounded-lg px-3 py-2 space-y-2">
                  <div className="text-danger-text font-semibold">
                    Early termination (lease end {ctx?.tenant?.move_out_date?.slice(0, 10) || moveOutBill.planned_move_out || '—'}).{!waived && ' Advance and deposit are forfeited.'}
                  </div>
                  <label className="flex items-center gap-2 text-ink cursor-pointer">
                    <input type="checkbox" checked={waived} disabled={!ctx} onChange={e => setWaived(e.target.checked)} />
                    Management approved — do not forfeit
                  </label>
                  {waived && (
                    <input type="text" className="w-full" value={waiveReason} onChange={e => setWaiveReason(e.target.value)}
                      placeholder="Reason management approved the waiver (required)" />
                  )}
                </div>
              )}
              <table className="w-full">
                <tbody>
                  {billLines.map((l, i) => (
                    <tr key={i} className="border-t border-line-subtle">
                      <td className="py-1">{l.label}</td>
                      <td className="text-ink-muted">{l.mid}{l.kind === 'forfeit' && l.original != null && ` (${pesoText(l.original)} forfeited)`}</td>
                      <td className="text-right tabular-nums">{Number(l.amount) < 0 ? '-' + pesoText(-l.amount) : pesoText(l.amount)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {billTotals && (
                <div className={`text-right font-bold ${billTotals.net_amount < 0 ? 'text-success-text' : 'text-ink'}`}>
                  {billTotals.net_amount < 0 ? `Amount to be returned ${pesoText(-billTotals.net_amount)}` : `Total amount due ${pesoText(billTotals.net_amount)}`}
                </div>
              )}
              <div className="text-ink-muted">Readings: water {nvReq.water_reading} · electric {nvReq.electric_reading}. Approving executes the move-out and saves this bill.</div>
            </div>
          )}

          {/* Reason */}
          {request.reason && (
            <div className="bg-warning-bg border border-warning-border rounded-xl px-4 py-3 text-[13px] text-warning-text">
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
            <div className="bg-danger-bg border border-danger-border rounded-xl px-4 py-3 text-[13px] text-danger-text">
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
          {partialApplied && (
            <button className="btn secondary" onClick={markApplied} disabled={busy}>Mark approved (already applied)</button>
          )}
          <button className="btn primary" onClick={() => decide('APPROVED')} disabled={busy || partialApplied || (!!moveOutBill && (!rec || rec.errors.length > 0))}>
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

  async function onDone(decision, warning = null) {
    setSelected(null)
    if (warning) show(warning, 'error')
    else show(decision === 'APPROVED' ? 'Request approved and applied.' : 'Request rejected.', 'success')
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
        <div className="flex gap-1.5 p-1 bg-surface-3 rounded-lg">
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
                  ? 'bg-surface text-ink shadow-sm'
                  : 'text-ink-muted hover:text-ink-secondary'
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
            : <ClipboardList size={32} className="mx-auto mb-3 text-ink-faint" />}
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
                    <td className="text-[11px] text-ink-faint whitespace-nowrap">{fmtDateTime(r.created_at)}</td>
                    <td className="text-[12px] max-w-[150px] truncate">{requesterLabel(r)}</td>
                    <td className="text-[13px] font-medium text-ink">{entityDesc(r)}</td>
                    <td className="text-[12px] font-semibold text-navy-500">{fieldLabel}</td>
                    <td className="text-[12px] max-w-[200px]">
                      <span className="text-danger-text">{currentLabel(r)}</span>
                      <span className="mx-2 text-ink-faint">→</span>
                      <span className="text-success-text font-medium">{proposedLabel(r)}</span>
                    </td>
                    <td className="text-[12px] text-ink-muted max-w-[160px] truncate" title={r.reason}>
                      {r.reason || '—'}
                    </td>
                    <td><StatusBadge status={r.status} /></td>
                    {filterStatus !== 'PENDING' && (
                      <td className="text-[11px] text-ink-faint whitespace-nowrap">
                        {r.decided_at ? fmtDateTime(r.decided_at) : '—'}
                        {r.decision_maker?.email && (
                          <div className="text-[10px] text-ink-faint mt-0.5">{r.decision_maker.email}</div>
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
