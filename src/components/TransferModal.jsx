import { useState, useEffect } from 'react'
import { ArrowRightLeft, X, AlertTriangle, Clock, Info } from 'lucide-react'
import { processTransfer, fetchCutoffs, fetchUtilityBill, supabase } from '../lib/supabase'
import { requestApproval } from '../lib/approvals'
import { useAuth } from '../lib/auth'

function today() { return new Date().toISOString().slice(0, 10) }

function fmt(n) { return n ? '₱' + Number(n).toLocaleString('en-PH') : '—' }

function fmtDate(d) {
  if (!d) return '—'
  return new Date(d).toLocaleDateString('en-PH', { month: 'short', day: 'numeric', year: 'numeric' })
}

export default function TransferModal({ tenant, vacantBeds, onClose, onDone }) {
  const { isAdmin } = useAuth()

  const [toBedId,         setToBedId]         = useState('')
  const [transferDate,    setTransferDate]    = useState(today())
  const [newRate,         setNewRate]         = useState(String(tenant.rate || ''))
  const [waterReading,      setWaterReading]      = useState('')
  const [electricReading,   setElectricReading]   = useState('')
  const [toWaterReading,    setToWaterReading]    = useState('')
  const [toElectricReading, setToElectricReading] = useState('')
  const [notes,             setNotes]             = useState('')
  const [reason,            setReason]            = useState('')
  const [saving,            setSaving]            = useState(false)
  const [submitted,         setSubmitted]         = useState(false)
  const [error,             setError]             = useState('')
  const [minWater,          setMinWater]          = useState(null)
  const [minElec,           setMinElec]           = useState(null)
  const [minToWater,        setMinToWater]        = useState(null)
  const [minToElec,         setMinToElec]         = useState(null)
  const [billData,          setBillData]          = useState([])

  const selectedBed = vacantBeds.find(b => String(b.bed_id) === String(toBedId))

  // Load current-period starting readings so we can validate entered readings
  useEffect(() => {
    async function loadMinReadings() {
      try {
        const cutoffs = await fetchCutoffs()
        const active = cutoffs.find(c => c.is_active)
        if (!active) return
        const bill = await fetchUtilityBill(active.id)
        setBillData(bill)
        const row = bill.find(b => b.room_id === tenant.room_id)
        if (row) {
          if (row.water_prev != null) setMinWater(Number(row.water_prev))
          if (row.elec_prev  != null) setMinElec(Number(row.elec_prev))
        }
      } catch { /* non-critical */ }
    }
    loadMinReadings()
  }, [tenant.room_id])

  // Update new-room min readings whenever a destination bed is selected
  useEffect(() => {
    if (!selectedBed || !billData.length) { setMinToWater(null); setMinToElec(null); return }
    const row = billData.find(b => b.room_no === String(selectedBed.room_no))
    setMinToWater(row?.water_prev != null ? Number(row.water_prev) : null)
    setMinToElec(row?.elec_prev  != null ? Number(row.elec_prev)  : null)
  }, [selectedBed, billData])

  // Pre-fill rate from selected bed's default rate
  useEffect(() => {
    if (selectedBed) setNewRate(String(selectedBed.default_rate || tenant.rate || ''))
  }, [toBedId])

  function validate() {
    if (!toBedId) return 'Please select a destination bed.'
    if (transferDate < today()) return 'Transfer date cannot be in the past.'
    if (!transferDate) return 'Transfer date is required.'
    if (!newRate || Number(newRate) <= 0) return 'Please enter a valid rate.'
    if (!waterReading || Number(waterReading) < 0) return 'Water meter reading is required.'
    if (minWater !== null && Number(waterReading) < minWater)
      return `Water reading (${waterReading}) cannot be less than the current period's starting reading (${minWater}).`
    if (!electricReading || Number(electricReading) < 0) return 'Electricity meter reading is required.'
    if (minElec !== null && Number(electricReading) < minElec)
      return `Electricity reading (${electricReading}) cannot be less than the current period's starting reading (${minElec}).`
    if (toWaterReading && minToWater !== null && Number(toWaterReading) < minToWater)
      return `New room water reading (${toWaterReading}) must be ≥ its period start (${minToWater}).`
    if (toElectricReading && minToElec !== null && Number(toElectricReading) < minToElec)
      return `New room electricity reading (${toElectricReading}) must be ≥ its period start (${minToElec}).`
    if (!isAdmin && !reason.trim()) return 'Please provide a reason for the transfer request.'
    return null
  }

  async function handleSubmit(e) {
    e.preventDefault()
    const err = validate()
    if (err) { setError(err); return }

    setSaving(true)
    setError('')

    const transferData = {
      to_bed_id:           Number(toBedId),
      transfer_date:       transferDate,
      new_rate:            Number(newRate),
      water_reading:       Number(waterReading),
      electric_reading:    Number(electricReading),
      to_water_reading:    toWaterReading    ? Number(toWaterReading)    : null,
      to_electric_reading: toElectricReading ? Number(toElectricReading) : null,
      notes:               notes.trim() || null,
    }

    try {
      if (!isAdmin) {
        await requestApproval({
          entityType: 'TENANT',
          entityId:   String(tenant.id),
          fieldName:  'transfer',
          oldValue: {
            bed_id:     tenant.bed_id,
            rate:       tenant.rate,
            room_no:    tenant.room_no,
            bed_letter: tenant.bed_letter,
          },
          newValue: {
            _action:      'process_transfer',
            _tenant_id:   String(tenant.id),
            _tenant_name: tenant.name,
            _room_no:     tenant.room_no,
            _bed_letter:  tenant.bed_letter,
            ...transferData,
          },
          reason: reason.trim(),
        })
        setSubmitted(true)
      } else {
        const { data: { user } } = await supabase.auth.getUser()
        await processTransfer(
          {
            id:           tenant.id,
            bed_id:       tenant.bed_id,
            room_id:      tenant.room_id,
            room_no:      tenant.room_no,
            bed_letter:   tenant.bed_letter,
            name:         tenant.name,
            rate:         tenant.rate,
            move_in_date: tenant.move_in_date  || null,
            move_out_date: tenant.move_out_date || null,
          },
          transferData,
          user?.id
        )
        onDone()
      }
    } catch (err) {
      setError(err.message)
    }
    setSaving(false)
  }

  const rateChanged = selectedBed && Number(newRate) !== Number(tenant.rate)

  if (submitted) {
    return (
      <div className="overlay" onClick={e => e.stopPropagation()}>
        <div className="modal modal-sm">
          <div className="modal-head">
            <h3>Room Transfer</h3>
            <button className="btn-close" onClick={onClose}><X size={16} /></button>
          </div>
          <div className="modal-body text-center py-8">
            <Clock size={36} className="mx-auto mb-3 text-amber-400" />
            <h4 className="text-[15px] font-semibold text-slate-900 mb-2">Sent for Approval</h4>
            <p className="text-[13px] text-slate-500 leading-relaxed max-w-[260px] mx-auto">
              Transfer request for <strong>{tenant.name}</strong> has been submitted.
              An admin will review and process it.
            </p>
          </div>
          <div className="modal-foot">
            <button className="btn primary" onClick={onClose}>Close</button>
          </div>
        </div>
      </div>
    )
  }

  return (
    <div className="overlay" onClick={e => e.stopPropagation()}>
      <div className="modal" style={{ maxWidth: 520 }}>
        <div className="modal-head">
          <h3 className="flex items-center gap-2">
            <ArrowRightLeft size={15} className="text-slate-400" /> Room Transfer
          </h3>
          <button className="btn-close" onClick={onClose}><X size={16} /></button>
        </div>

        <form onSubmit={handleSubmit}>
          <div className="modal-body">
            {/* Current placement banner */}
            <div className="bg-slate-50 border border-slate-100 rounded-xl px-4 py-3 text-[13px] mb-5">
              <div className="font-semibold text-slate-900">{tenant.name}</div>
              <div className="text-slate-500 mt-0.5">
                Currently: Room {tenant.room_no} · Bed {tenant.bed_letter}
                {tenant.bed_location ? ` (${tenant.bed_location})` : ''} · {fmt(tenant.rate)}/mo
              </div>
            </div>

            <div className="form-grid">
              {/* ── Destination ── */}
              <div className="form-section">Destination</div>

              <div className="fg">
                <label>Transfer Date *</label>
                <input
                  type="date"
                  value={transferDate}
                  min={today()}
                  onChange={e => { setTransferDate(e.target.value); setError('') }}
                  required
                />
              </div>

              <div className="fg">
                <label>New Bed *</label>
                <select
                  value={toBedId}
                  onChange={e => { setToBedId(e.target.value); setError('') }}
                  required
                >
                  <option value="">Select vacant bed…</option>
                  {vacantBeds.map(b => (
                    <option key={b.bed_id} value={b.bed_id}>
                      Room {b.room_no} · Bed {b.bed_letter}
                      {b.bed_location ? ` (${b.bed_location})` : ''} — {b.room_type}
                    </option>
                  ))}
                </select>
              </div>

              <div className="fg full">
                <label>New Rate (₱) *</label>
                <input
                  type="number"
                  value={newRate}
                  min="0"
                  step="0.01"
                  onChange={e => { setNewRate(e.target.value); setError('') }}
                  required
                />
                {rateChanged && (
                  <div className="mt-1 text-[11px] text-amber-600 font-medium">
                    Rate change: {fmt(tenant.rate)} → {fmt(newRate)}
                    {!isAdmin && ' — requires admin approval'}
                  </div>
                )}
              </div>

              {/* ── Meter Readings ── */}
              <div className="form-section">Meter Readings at Transfer — Old Room</div>

              <div className="fg">
                <label>Water Reading *</label>
                <input
                  type="number"
                  value={waterReading}
                  min="0"
                  step="0.0001"
                  placeholder="e.g. 1234.50"
                  onChange={e => { setWaterReading(e.target.value); setError('') }}
                  required
                />
                <span className="block text-[11px] text-slate-400 mt-1">
                  Closing reading for Room {tenant.room_no}
                  {minWater !== null && (
                    <> · <span className="text-slate-500 font-medium">min: {minWater}</span></>
                  )}
                </span>
              </div>

              <div className="fg">
                <label>Electricity Reading *</label>
                <input
                  type="number"
                  value={electricReading}
                  min="0"
                  step="0.0001"
                  placeholder="e.g. 5678.90"
                  onChange={e => { setElectricReading(e.target.value); setError('') }}
                  required
                />
                <span className="block text-[11px] text-slate-400 mt-1">
                  Closing reading for Room {tenant.room_no}
                  {minElec !== null && (
                    <> · <span className="text-slate-500 font-medium">min: {minElec}</span></>
                  )}
                </span>
              </div>

              {/* Info banner */}
              <div className="fg full">
                <div className="flex items-start gap-2 bg-blue-50 border border-blue-100 rounded-xl px-3 py-2.5 text-[12px] text-blue-800">
                  <Info size={13} className="shrink-0 mt-px text-blue-500" />
                  Utility contributions through {transferDate ? fmtDate(transferDate) : 'the transfer date'} will be
                  allocated to Room {tenant.room_no}'s current billing statement.
                </div>
              </div>

              {/* ── Opening Reading — New Room ── */}
              <div className="form-section">
                Opening Reading — New Room
                <span className="text-slate-400 font-normal text-[11px] ml-1">(optional)</span>
              </div>

              <div className="fg">
                <label>Water Reading at Arrival</label>
                <input
                  type="number"
                  value={toWaterReading}
                  min="0"
                  step="0.0001"
                  placeholder="e.g. 430.00"
                  onChange={e => { setToWaterReading(e.target.value); setError('') }}
                />
                <span className="block text-[11px] text-slate-400 mt-1">
                  Meter reading at the new room when you arrived
                  {selectedBed && minToWater !== null && (
                    <> · <span className="text-slate-500 font-medium">period start: {minToWater}</span></>
                  )}
                </span>
              </div>

              <div className="fg">
                <label>Electricity Reading at Arrival</label>
                <input
                  type="number"
                  value={toElectricReading}
                  min="0"
                  step="0.0001"
                  placeholder="e.g. 413.00"
                  onChange={e => { setToElectricReading(e.target.value); setError('') }}
                />
                <span className="block text-[11px] text-slate-400 mt-1">
                  Meter reading at the new room when you arrived
                  {selectedBed && minToElec !== null && (
                    <> · <span className="text-slate-500 font-medium">period start: {minToElec}</span></>
                  )}
                </span>
              </div>

              {/* Notes */}
              <div className="fg full">
                <label>Notes</label>
                <textarea
                  rows={2}
                  value={notes}
                  onChange={e => setNotes(e.target.value)}
                  placeholder="Optional reason or remarks…"
                />
              </div>

              {/* Non-admin approval section */}
              {!isAdmin && (
                <>
                  <div className="fg full">
                    <div className="flex items-start gap-2 bg-amber-50 border border-amber-100 rounded-xl px-3 py-2.5 text-[12px] text-amber-800">
                      <AlertTriangle size={13} className="shrink-0 mt-px text-amber-500" />
                      Transfer requests require admin approval before taking effect.
                      All details entered above will be reviewed.
                    </div>
                  </div>
                  <div className="fg full">
                    <label>Reason for Transfer *</label>
                    <textarea
                      rows={2}
                      value={reason}
                      onChange={e => { setReason(e.target.value); setError('') }}
                      placeholder="Briefly describe why this transfer is needed…"
                      required
                    />
                  </div>
                </>
              )}
            </div>

            {error && (
              <div className="mt-3 px-3 py-2.5 bg-red-50 border border-red-100 rounded-xl text-[13px] text-red-700 flex items-start gap-2">
                <span className="shrink-0 mt-px">⚠</span>
                {error}
              </div>
            )}
          </div>

          <div className="modal-foot">
            <button type="button" className="btn secondary" onClick={onClose}>Cancel</button>
            <button type="submit" className="btn primary" disabled={saving}>
              {saving
                ? 'Processing…'
                : isAdmin ? 'Transfer Now' : 'Submit for Approval'}
            </button>
          </div>
        </form>
      </div>
    </div>
  )
}
