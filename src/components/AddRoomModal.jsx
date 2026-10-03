import { useRef, useState } from 'react'
import { X, Plus, Trash2, AlertTriangle } from 'lucide-react'
import { createRoom, supabase } from '../lib/supabase'
import { useToast } from './Toast'

// Same list RoomReconfigureModal.jsx uses — duplicated (not imported) to avoid
// a components/ → pages/ circular import. Offered here as a <datalist>
// suggestion, not a rigid <select>: room_type has no CHECK constraint, and the
// owner may introduce new labels (e.g. "1-Bed Loft-Type") with no migration.
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

export default function AddRoomModal({ onClose, onDone }) {
  const { show: showToast, ToastEl } = useToast()

  const [roomNo,   setRoomNo]   = useState('')
  const [roomType, setRoomType] = useState('')
  const [floor,    setFloor]    = useState('')
  const [beds,     setBeds]     = useState([{ key: 0, bed_letter: 'A', bed_location: '', default_rate: '' }])
  const [error,    setError]    = useState('')
  const [saving,   setSaving]   = useState(false)
  const [confirm,  setConfirm]  = useState(null) // { summary }
  const nextKey = useRef(1)

  function usedLetters() {
    const s = new Set()
    beds.forEach(r => { if (r.bed_letter.trim()) s.add(r.bed_letter.trim().toUpperCase()) })
    return s
  }

  function addBedRow() {
    const letter = nextLetter(usedLetters())
    setBeds(rows => [...rows, { key: nextKey.current++, bed_letter: letter, bed_location: '', default_rate: '' }])
  }

  function updateBedRow(key, patch) {
    setBeds(rows => rows.map(r => (r.key === key ? { ...r, ...patch } : r)))
  }

  function removeBedRow(key) {
    setBeds(rows => rows.filter(r => r.key !== key))
  }

  function buildBedsPayload() {
    return beds
      .filter(r => r.bed_letter.trim() !== '')
      .map(r => ({
        bed_letter:   r.bed_letter.trim().toUpperCase(),
        bed_location: r.bed_location.trim() || null,
        default_rate: Number(r.default_rate),
      }))
  }

  function validate() {
    if (!roomNo.trim()) return 'Room number is required.'
    const seen = new Set()
    const active = beds.filter(r => r.bed_letter.trim() !== '')
    if (active.length === 0) return 'A new room must have at least one bed.'
    for (const row of active) {
      const letter = row.bed_letter.trim().toUpperCase()
      if (!letter) return 'Bed letter is required for every bed.'
      if (row.default_rate === '' || isNaN(Number(row.default_rate)) || Number(row.default_rate) < 0) {
        return `Enter a valid rate for Bed ${letter}.`
      }
      if (seen.has(letter)) return `Duplicate bed letter "${letter}" in the new room.`
      seen.add(letter)
    }
    return null
  }

  function handleReview() {
    setError('')
    const err = validate()
    if (err) { setError(err); return }

    const payload = buildBedsPayload()
    const bedList = payload.map(b => `${b.bed_letter} (₱${Number(b.default_rate).toLocaleString('en-PH')})`).join(', ')
    setConfirm({
      summary: `Room ${roomNo.trim()}: ${payload.length} bed${payload.length !== 1 ? 's' : ''} — ${bedList}.`,
    })
  }

  async function handleSubmit() {
    setSaving(true)
    setError('')
    try {
      const { data: { user } } = await supabase.auth.getUser()
      await createRoom(
        roomNo.trim(),
        roomType.trim(),
        floor !== '' ? Number(floor) : null,
        buildBedsPayload(),
        { summary: confirm?.summary },
        user?.id
      )
      showToast(`Room ${roomNo.trim()} created.`, 'success')
      onDone()
    } catch (e) {
      setError(e.message)
    }
    setSaving(false)
  }

  // Confirmation step — mirrors RoomReconfigureModal.jsx's early-return pattern.
  if (confirm) {
    return (
      <div className="overlay" onClick={e => e.stopPropagation()}>
        <div className="modal modal-sm">
          <div className="modal-head">
            <h3>Confirm New Room</h3>
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
              {saving ? 'Saving…' : 'Confirm & Create'}
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
          <h3>Add Room</h3>
          <button className="btn-close" onClick={onClose}><X size={16} /></button>
        </div>

        <div className="modal-body">
          <div className="form-grid">
            <div className="fg">
              <label>Room No. *</label>
              <input
                type="text" value={roomNo}
                onChange={e => setRoomNo(e.target.value)}
                placeholder="e.g. 501 A"
                className={`${INPUT_SM} w-full`}
                autoFocus
              />
            </div>
            <div className="fg">
              <label>Floor</label>
              <input
                type="number" value={floor}
                onChange={e => setFloor(e.target.value)}
                className={`${INPUT_SM} w-full`}
              />
            </div>
            <div className="fg">
              <label>Room Type</label>
              <input
                type="text" list="add-room-types" value={roomType}
                onChange={e => setRoomType(e.target.value)}
                placeholder="e.g. Solo Room"
                className={`${INPUT_SM} w-full`}
              />
              <datalist id="add-room-types">
                {ROOM_TYPES.map(t => <option key={t} value={t} />)}
              </datalist>
            </div>
          </div>

          <div className="flex items-center justify-between mt-5 mb-2">
            <h4 className="text-[12px] font-semibold text-ink-secondary">Beds</h4>
            <button type="button" onClick={addBedRow} className="btn-xs blue flex items-center gap-1">
              <Plus size={10} /> Add Row
            </button>
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
                {beds.length === 0 ? (
                  <tr><td colSpan={4} className="px-3 py-3 text-center text-ink-faint">No beds added</td></tr>
                ) : beds.map(row => (
                  <tr key={row.key} className="border-t border-line-subtle">
                    <td className="px-3 py-2">
                      <input
                        type="text" maxLength={2}
                        value={row.bed_letter}
                        onChange={e => updateBedRow(row.key, { bed_letter: e.target.value.toUpperCase() })}
                        className={`${INPUT_SM} w-14 text-center`}
                      />
                    </td>
                    <td className="px-3 py-2">
                      <input
                        type="text"
                        value={row.bed_location}
                        onChange={e => updateBedRow(row.key, { bed_location: e.target.value })}
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
                          onChange={e => updateBedRow(row.key, { default_rate: e.target.value })}
                          className={`${INPUT_SM} w-28 pl-6`}
                        />
                      </div>
                    </td>
                    <td className="px-3 py-2 text-right">
                      <button type="button" onClick={() => removeBedRow(row.key)} className="btn-xs red">
                        <Trash2 size={10} />
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

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
