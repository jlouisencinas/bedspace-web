import { useState } from 'react'
import { X, Upload, AlertTriangle, CheckCircle2 } from 'lucide-react'
import { parseSimCsv, validateSimRows } from '../lib/simCsv'
import { replaceSimDataset } from '../lib/supabase'
import { useToast } from './Toast'

function fmt(n) { return n != null ? '₱' + Number(n).toLocaleString('en-PH') : '—' }

export default function SimImportModal({ onClose, onDone }) {
  const { show: showToast, ToastEl } = useToast()
  const [fileName, setFileName] = useState('')
  const [rooms,    setRooms]    = useState([])
  const [errors,   setErrors]   = useState([])
  const [saving,   setSaving]   = useState(false)

  function handleFile(e) {
    const file = e.target.files?.[0]
    if (!file) return
    setFileName(file.name)
    const reader = new FileReader()
    reader.onload = () => {
      const parsed = parseSimCsv(String(reader.result))
      const { rooms: r, errors: errs } = validateSimRows(parsed)
      setRooms(r)
      setErrors(errs)
    }
    reader.onerror = () => setErrors(['Could not read the file.'])
    reader.readAsText(file)
  }

  const bedCount   = rooms.reduce((s, r) => s + r.beds.length, 0)
  const activeCount = rooms.reduce((s, r) => s + r.beds.filter(b => !b.is_out_of_order).length, 0)
  const rateTotal  = rooms.reduce((s, r) =>
    s + r.beds.filter(b => !b.is_out_of_order).reduce((s2, b) => s2 + (Number(b.rate) || 0), 0), 0)

  const canConfirm = fileName && errors.length === 0 && rooms.length > 0 && !saving

  async function handleConfirm() {
    setSaving(true)
    try {
      await replaceSimDataset(rooms)
      showToast('Simulator dataset replaced.', 'success')
      onDone()
    } catch (e) { showToast(e.message, 'error') }
    setSaving(false)
  }

  return (
    <div className="overlay" onClick={e => e.stopPropagation()}>
      <div className="modal" style={{ maxWidth: 560 }}>
        <div className="modal-head">
          <h3>Import Occupancy Simulator CSV</h3>
          <button className="btn-close" onClick={onClose}><X size={16} /></button>
        </div>

        <div className="modal-body">
          <p className="text-[12px] text-ink-faint mb-3">
            Replaces the entire simulator dataset atomically. Never touches real rooms, beds,
            tenants, or billing data.
          </p>

          <label className="flex items-center justify-center gap-2 border-2 border-dashed border-line rounded-xl px-4 py-6 cursor-pointer hover:border-navy-500 transition-colors mb-4">
            <Upload size={16} className="text-ink-faint" />
            <span className="text-[13px] text-ink-secondary">{fileName || 'Choose a CSV file…'}</span>
            <input type="file" accept=".csv,text/csv" onChange={handleFile} className="hidden" />
          </label>

          {errors.length > 0 && (
            <div className="mb-4 px-3 py-2.5 bg-danger-bg border border-danger-border rounded-xl text-[12px] text-danger-text">
              <div className="flex items-center gap-1.5 font-semibold mb-1.5">
                <AlertTriangle size={13} className="shrink-0" /> {errors.length} error{errors.length !== 1 ? 's' : ''} found — nothing was imported
              </div>
              <ul className="list-disc pl-5 space-y-0.5 max-h-40 overflow-y-auto">
                {errors.map((e, i) => <li key={i}>{e}</li>)}
              </ul>
            </div>
          )}

          {fileName && errors.length === 0 && rooms.length > 0 && (
            <div className="px-3 py-3 bg-success-bg border border-success-border rounded-xl text-[12px] text-success-text">
              <div className="flex items-center gap-1.5 font-semibold mb-1.5">
                <CheckCircle2 size={13} className="shrink-0" /> Valid — preview before confirming
              </div>
              <div>{rooms.length} rooms, {bedCount} beds ({activeCount} active)</div>
              <div className="font-semibold mt-1">New headline total (100% occupancy): {fmt(rateTotal)}</div>
            </div>
          )}

          {fileName && errors.length === 0 && rooms.length === 0 && (
            <div className="px-3 py-2.5 bg-warning-bg border border-warning-border rounded-xl text-[12px] text-warning-text flex items-center gap-2">
              <AlertTriangle size={13} className="shrink-0" /> No rows found in this file.
            </div>
          )}
        </div>

        <div className="modal-foot">
          <button type="button" className="btn secondary" onClick={onClose} disabled={saving}>Cancel</button>
          <button type="button" className="btn primary" onClick={handleConfirm} disabled={!canConfirm}>
            {saving ? 'Importing…' : 'Confirm & Replace Dataset'}
          </button>
        </div>
      </div>
      {ToastEl}
    </div>
  )
}
