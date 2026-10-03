import { useState } from 'react'
import { X, AlertTriangle } from 'lucide-react'
import { retireRoom, supabase } from '../lib/supabase'
import { useToast } from './Toast'

function fmt(n) { return n != null ? '₱' + Number(n).toLocaleString('en-PH') : '—' }

export default function RetireRoomModal({ room, onClose, onDone }) {
  const { show: showToast, ToastEl } = useToast()
  const activeBeds = (room.beds || []).filter(b => b.status !== 'REMOVED')
  const hasLeased  = activeBeds.some(b => b.status === 'LEASED')

  const [confirmText, setConfirmText] = useState('')
  const [error,   setError]   = useState('')
  const [saving,  setSaving]  = useState(false)

  const requiredText = `RETIRE ${room.room_no}`

  async function handleSubmit() {
    if (hasLeased) return
    if (confirmText.trim().toUpperCase() !== requiredText.toUpperCase()) {
      setError(`Type "${requiredText}" to confirm.`)
      return
    }
    setSaving(true)
    setError('')
    try {
      const { data: { user } } = await supabase.auth.getUser()
      await retireRoom(
        room.id,
        'CONVERTED',
        { room_no: room.room_no, summary: `Room ${room.room_no} retired — ${activeBeds.length} bed${activeBeds.length !== 1 ? 's' : ''} removed, status set to Converted.` },
        user?.id
      )
      showToast(`Room ${room.room_no} retired.`, 'success')
      onDone()
    } catch (e) {
      setError(e.message)
    }
    setSaving(false)
  }

  return (
    <div className="overlay" onClick={e => e.stopPropagation()}>
      <div className="modal modal-sm">
        <div className="modal-head">
          <h3>Retire Room {room.room_no}</h3>
          <button className="btn-close" onClick={onClose}><X size={16} /></button>
        </div>

        <div className="modal-body">
          <p className="text-[13px] text-ink-secondary">
            This will remove all {activeBeds.length} active bed{activeBeds.length !== 1 ? 's' : ''} from
            Room {room.room_no} and mark it Converted. This is reversible — beds can be restored individually later.
          </p>

          <div className="border border-line rounded-xl overflow-hidden my-3">
            <table className="w-full text-[12px]">
              <thead>
                <tr className="text-[10px] text-ink-faint uppercase tracking-widest bg-surface-2">
                  <th className="px-3 py-2 text-left font-semibold">Bed</th>
                  <th className="px-3 py-2 text-left font-semibold">Status</th>
                  <th className="px-3 py-2 text-right font-semibold">Rate</th>
                </tr>
              </thead>
              <tbody>
                {activeBeds.length === 0 ? (
                  <tr><td colSpan={3} className="px-3 py-3 text-center text-ink-faint">No active beds</td></tr>
                ) : activeBeds.map(bed => (
                  <tr key={bed.id} className="border-t border-line-subtle">
                    <td className="px-3 py-2 font-semibold">{bed.bed_letter}</td>
                    <td className={`px-3 py-2 ${bed.status === 'LEASED' ? 'text-danger-text font-semibold' : 'text-ink-muted'}`}>{bed.status}</td>
                    <td className="px-3 py-2 text-right">{fmt(bed.default_rate)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {hasLeased ? (
            <div className="px-3 py-2.5 bg-danger-bg border border-danger-border rounded-xl text-[13px] text-danger-text flex items-start gap-2">
              <AlertTriangle size={13} className="shrink-0 mt-px text-red-500" />
              Cannot retire — one or more beds are currently LEASED. Move out or transfer the tenant(s) first.
            </div>
          ) : (
            <div className="fg mt-1">
              <label>Type "{requiredText}" to confirm</label>
              <input
                type="text"
                value={confirmText}
                onChange={e => setConfirmText(e.target.value)}
                placeholder={requiredText}
                className="px-2 py-1 border border-line rounded-lg text-[12px] bg-surface focus:outline-none focus:border-navy-500 transition-colors w-full"
                autoFocus
              />
            </div>
          )}

          {error && (
            <div className="mt-3 px-3 py-2.5 bg-danger-bg border border-danger-border rounded-xl text-[13px] text-danger-text flex items-start gap-2">
              <AlertTriangle size={13} className="shrink-0 mt-px text-red-500" />
              {error}
            </div>
          )}
        </div>

        <div className="modal-foot">
          <button type="button" className="btn secondary" onClick={onClose} disabled={saving}>Cancel</button>
          <button type="button" className="btn danger" onClick={handleSubmit} disabled={saving || hasLeased}>
            {saving ? 'Retiring…' : 'Retire Room'}
          </button>
        </div>
      </div>
      {ToastEl}
    </div>
  )
}
