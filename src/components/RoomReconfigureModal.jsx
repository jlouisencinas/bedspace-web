import { useRef, useState } from 'react'
import { X, Plus, Trash2, AlertTriangle } from 'lucide-react'
import { reconfigureRoom, supabase } from '../lib/supabase'
import { useToast } from './Toast'

// Same list Property.jsx's RoomConfigTab uses for its room-type dropdown —
// must match the actual room_type values seeded/used in the DB (init.sql),
// not arbitrary labels. Duplicated (not imported) to avoid a components/ →
// pages/ circular import.
const ROOM_TYPES = [
  'Solo Room', '2-Bed Sharing', '4-Bed Sharing', '6-Bed Sharing',
]

const INPUT_SM = 'px-2 py-1 border border-line rounded-lg text-[12px] bg-surface focus:outline-none focus:border-navy-500 transition-colors'

function nextLetter(usedLetters) {
  for (let i = 0; i < 26; i++) {
    const letter = String.fromCharCode(65 + i)
    if (!usedLetters.has(letter)) return letter
  }
  return ''
}

export default function RoomReconfigureModal({ room, onClose, onDone }) {
  const { show: showToast, ToastEl } = useToast()
  const activeBeds = (room.beds || []).filter(b => b.status !== 'REMOVED')

  const [roomType,  setRoomType]  = useState(room.room_type || '')
  const [removeIds, setRemoveIds] = useState(new Set())
  const [rates,      setRates]    = useState(() =>
    Object.fromEntries(activeBeds.map(b => [b.id, String(b.default_rate ?? '')])))
  const [newBeds,   setNewBeds]   = useState([])
  const [bulkRate,  setBulkRate]  = useState('')
  const [error,     setError]     = useState('')
  const [saving,    setSaving]    = useState(false)
  const [confirm,   setConfirm]   = useState(null) // { summary }
  const nextKey = useRef(0)

  function usedLetters() {
    const s = new Set()
    activeBeds.forEach(b => { if (!removeIds.has(b.id)) s.add(b.bed_letter.toUpperCase()) })
    newBeds.forEach(r => { if (r.bed_letter.trim()) s.add(r.bed_letter.trim().toUpperCase()) })
    return s
  }

  function addNewBedRow() {
    const letter = nextLetter(usedLetters())
    setNewBeds(rows => [...rows, { key: nextKey.current++, bed_letter: letter, bed_location: '', default_rate: '' }])
  }

  function updateNewBedRow(key, patch) {
    setNewBeds(rows => rows.map(r => (r.key === key ? { ...r, ...patch } : r)))
  }

  function removeNewBedRow(key) {
    setNewBeds(rows => rows.filter(r => r.key !== key))
  }

  function applyBulkRate() {
    if (!bulkRate || Number(bulkRate) < 0) { showToast('Enter a valid rate to apply.', 'error'); return }
    setNewBeds(rows => rows.map(r => ({ ...r, default_rate: bulkRate })))
  }

  function toggleRemove(bed) {
    if (bed.status === 'LEASED') return
    setRemoveIds(s => {
      const next = new Set(s)
      if (next.has(bed.id)) next.delete(bed.id); else next.add(bed.id)
      return next
    })
  }

  function buildAddBedsPayload() {
    return newBeds
      .filter(r => r.bed_letter.trim() !== '')
      .map(r => ({
        bed_letter:   r.bed_letter.trim().toUpperCase(),
        bed_location: r.bed_location.trim() || null,
        default_rate: Number(r.default_rate),
      }))
  }

  function buildRateUpdatesPayload() {
    return activeBeds
      .filter(b => !removeIds.has(b.id))
      .filter(b => rates[b.id] !== '' && Number(rates[b.id]) !== Number(b.default_rate))
      .map(b => ({ bed_id: b.id, default_rate: Number(rates[b.id]) }))
  }

  function validate() {
    for (const b of activeBeds) {
      if (removeIds.has(b.id)) continue
      const v = rates[b.id]
      if (v === '' || v == null || isNaN(Number(v)) || Number(v) < 0) return `Enter a valid rate for Bed ${b.bed_letter}.`
    }
    const seen = new Set()
    activeBeds.forEach(b => { if (!removeIds.has(b.id)) seen.add(b.bed_letter.toUpperCase()) })
    for (const row of newBeds) {
      const letter = row.bed_letter.trim().toUpperCase()
      const isBlankRow = !letter && row.default_rate === '' && !row.bed_location.trim()
      if (isBlankRow) continue
      if (!letter) return 'Bed letter is required for every added bed.'
      if (row.default_rate === '' || isNaN(Number(row.default_rate)) || Number(row.default_rate) < 0) {
        return `Enter a valid rate for new Bed ${letter}.`
      }
      if (seen.has(letter)) return `Bed letter "${letter}" is already used in this room. Choose a different letter.`
      seen.add(letter)
    }
    if (activeBeds.filter(b => !removeIds.has(b.id)).length === 0 &&
        newBeds.filter(r => r.bed_letter.trim() !== '').length === 0) {
      return 'A room must have at least one bed after reconfiguration.'
    }
    return null
  }

  function handleReview() {
    setError('')
    const err = validate()
    if (err) { setError(err); return }

    const oldCount = activeBeds.length
    const newCount = activeBeds.filter(b => !removeIds.has(b.id)).length
                    + newBeds.filter(r => r.bed_letter.trim() !== '').length
    const bedPart = oldCount === newCount
      ? `${newCount} bed${newCount !== 1 ? 's' : ''} (unchanged)`
      : `${oldCount} bed${oldCount !== 1 ? 's' : ''} → ${newCount} bed${newCount !== 1 ? 's' : ''}`
    const typeChanged = roomType !== (room.room_type || '')
    const typePart = typeChanged ? `, ${room.room_type || 'no type set'} → ${roomType || 'no type set'}` : ''
    setConfirm({ summary: `Room ${room.room_no}: ${bedPart}${typePart}.` })
  }

  async function handleSubmit() {
    setSaving(true)
    setError('')
    try {
      const { data: { user } } = await supabase.auth.getUser()
      await reconfigureRoom(
        room.id,
        {
          roomType:     roomType || null,
          addBeds:      buildAddBedsPayload(),
          removeBedIds: [...removeIds],
          rateUpdates:  buildRateUpdatesPayload(),
        },
        { room_no: room.room_no, summary: confirm?.summary },
        user?.id
      )
      showToast(`Room ${room.room_no} reconfigured.`, 'success')
      onDone()
    } catch (e) {
      setError(e.message)
    }
    setSaving(false)
  }

  // Confirmation step — reuses Property.jsx's ConfirmModal markup/classes,
  // rendered here (not nested inside the form overlay) matching the
  // early-return step pattern already used by MoveOutModal/TransferModal.
  if (confirm) {
    return (
      <div className="overlay" onClick={e => e.stopPropagation()}>
        <div className="modal modal-sm">
          <div className="modal-head">
            <h3>Confirm Reconfiguration</h3>
          </div>
          <div className="modal-body">
            <p className="text-[13px] text-ink-secondary">{confirm.summary}</p>
            <p className="text-[12px] text-ink-faint mt-2">This is a structural, admin-only change and takes effect immediately.</p>
            {error && (
              <div className="mt-3 px-3 py-2.5 bg-danger-bg border border-danger-border rounded-xl text-[13px] text-danger-text flex items-start gap-2">
                <AlertTriangle size={13} className="shrink-0 mt-px text-red-500" />
                {error}
              </div>
            )}
          </div>
          <div className="modal-foot">
            <button type="button" className="btn secondary" onClick={() => setConfirm(null)} disabled={saving}>Back</button>
            <button type="button" className="btn primary" onClick={handleSubmit} disabled={saving}>
              {saving ? 'Saving…' : 'Confirm & Reconfigure'}
            </button>
          </div>
        </div>
        {ToastEl}
      </div>
    )
  }

  return (
    <div className="overlay" onClick={e => e.stopPropagation()}>
      <div className="modal" style={{ maxWidth: 640 }}>
        <div className="modal-head">
          <h3>Reconfigure Room {room.room_no}</h3>
          <button className="btn-close" onClick={onClose}><X size={16} /></button>
        </div>

        <div className="modal-body">
          <div className="fg mb-4">
            <label>Room Type</label>
            <select value={roomType} onChange={e => setRoomType(e.target.value)} className={`${INPUT_SM} w-full`}>
              <option value="">— no type —</option>
              {ROOM_TYPES.map(t => <option key={t} value={t}>{t}</option>)}
            </select>
          </div>

          <h4 className="text-[12px] font-semibold text-ink-secondary mb-2">Existing Beds</h4>
          <div className="border border-line rounded-xl overflow-hidden mb-5">
            <table className="w-full text-[12px]">
              <thead>
                <tr className="text-[10px] text-ink-faint uppercase tracking-widest bg-surface-2">
                  <th className="px-3 py-2 text-left font-semibold">Bed</th>
                  <th className="px-3 py-2 text-left font-semibold">Status</th>
                  <th className="px-3 py-2 text-right font-semibold">Rate</th>
                  <th className="px-3 py-2 text-center font-semibold">Remove</th>
                </tr>
              </thead>
              <tbody>
                {activeBeds.length === 0 ? (
                  <tr><td colSpan={4} className="px-3 py-3 text-center text-ink-faint">No active beds</td></tr>
                ) : activeBeds.map(bed => {
                  const marked = removeIds.has(bed.id)
                  const isLeased = bed.status === 'LEASED'
                  return (
                    <tr key={bed.id} className={`border-t border-line-subtle ${marked ? 'opacity-40 bg-surface-2' : ''}`}>
                      <td className="px-3 py-2 font-semibold">{bed.bed_letter}</td>
                      <td className="px-3 py-2 text-ink-muted">{bed.status}</td>
                      <td className="px-3 py-2 text-right">
                        <div className="relative inline-flex items-center float-right">
                          <span className="absolute left-2 text-[12px] text-ink-faint pointer-events-none select-none">₱</span>
                          <input
                            type="number" min="0" step="0.01"
                            value={rates[bed.id] ?? ''}
                            disabled={marked}
                            onChange={e => setRates(r => ({ ...r, [bed.id]: e.target.value }))}
                            className={`${INPUT_SM} w-28 pl-6`}
                          />
                        </div>
                      </td>
                      <td className="px-3 py-2 text-center" title={isLeased ? 'Cannot remove — bed is currently LEASED. Move out or transfer the tenant first.' : ''}>
                        <input
                          type="checkbox"
                          checked={marked}
                          disabled={isLeased}
                          onChange={() => toggleRemove(bed)}
                          className="rounded"
                        />
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>

          <div className="flex items-center justify-between mb-2">
            <h4 className="text-[12px] font-semibold text-ink-secondary">Add Beds</h4>
            <button type="button" onClick={addNewBedRow} className="btn-xs blue flex items-center gap-1">
              <Plus size={10} /> Add Row
            </button>
          </div>

          {newBeds.length > 0 && (
            <>
              <div className="flex items-center gap-2 mb-2">
                <div className="relative inline-flex items-center">
                  <span className="absolute left-2 text-[12px] text-ink-faint pointer-events-none select-none">₱</span>
                  <input
                    type="number" min="0" step="0.01"
                    value={bulkRate}
                    onChange={e => setBulkRate(e.target.value)}
                    placeholder="Rate for all new beds"
                    className={`${INPUT_SM} w-44 pl-6`}
                  />
                </div>
                <button type="button" onClick={applyBulkRate} className="btn-xs gray">Apply to all new beds</button>
              </div>

              <div className="border border-line rounded-xl overflow-hidden mb-4">
                <table className="w-full text-[12px]">
                  <thead>
                    <tr className="text-[10px] text-ink-faint uppercase tracking-widest bg-surface-2">
                      <th className="px-3 py-2 text-left font-semibold">Letter</th>
                      <th className="px-3 py-2 text-left font-semibold">Location</th>
                      <th className="px-3 py-2 text-right font-semibold">Rate</th>
                      <th className="px-3 py-2 w-[40px]"></th>
                    </tr>
                  </thead>
                  <tbody>
                    {newBeds.map(row => (
                      <tr key={row.key} className="border-t border-line-subtle">
                        <td className="px-3 py-2">
                          <input
                            type="text" maxLength={2}
                            value={row.bed_letter}
                            onChange={e => updateNewBedRow(row.key, { bed_letter: e.target.value.toUpperCase() })}
                            className={`${INPUT_SM} w-14 text-center`}
                          />
                        </td>
                        <td className="px-3 py-2">
                          <input
                            type="text"
                            value={row.bed_location}
                            onChange={e => updateNewBedRow(row.key, { bed_location: e.target.value })}
                            placeholder="e.g. Lower"
                            className={`${INPUT_SM} w-full`}
                          />
                        </td>
                        <td className="px-3 py-2 text-right">
                          <div className="relative inline-flex items-center float-right">
                            <span className="absolute left-2 text-[12px] text-ink-faint pointer-events-none select-none">₱</span>
                            <input
                              type="number" min="0" step="0.01"
                              value={row.default_rate}
                              onChange={e => updateNewBedRow(row.key, { default_rate: e.target.value })}
                              className={`${INPUT_SM} w-28 pl-6`}
                            />
                          </div>
                        </td>
                        <td className="px-3 py-2 text-right">
                          <button type="button" onClick={() => removeNewBedRow(row.key)} className="btn-xs red">
                            <Trash2 size={10} />
                          </button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </>
          )}

          {error && (
            <div className="mt-1 px-3 py-2.5 bg-danger-bg border border-danger-border rounded-xl text-[13px] text-danger-text flex items-start gap-2">
              <AlertTriangle size={13} className="shrink-0 mt-px text-red-500" />
              {error}
            </div>
          )}
        </div>

        <div className="modal-foot">
          <button type="button" className="btn secondary" onClick={onClose}>Cancel</button>
          <button type="button" className="btn primary" onClick={handleReview} disabled={saving}>
            Review &amp; Submit
          </button>
        </div>
      </div>
      {ToastEl}
    </div>
  )
}
