import { Plus, Trash2, Star } from 'lucide-react'

export default function MultiEntryInput({ entries, onChange, placeholder = 'Value', labelPlaceholder = 'Label', type = 'text', required = false, showLabel = true }) {
  function addRow() {
    onChange([...entries, { value: '', label: '', isPrimary: entries.length === 0 }])
  }

  function removeRow(i) {
    const next = entries.filter((_, idx) => idx !== i)
    if (entries[i].isPrimary && next.length > 0) {
      next[0] = { ...next[0], isPrimary: true }
    }
    onChange(next)
  }

  function setField(i, field, val) {
    onChange(entries.map((e, idx) => idx === i ? { ...e, [field]: val } : e))
  }

  function setPrimary(i) {
    onChange(entries.map((e, idx) => ({ ...e, isPrimary: idx === i })))
  }

  return (
    <div className="space-y-2">
      {entries.map((e, i) => (
        <div key={i} className="flex items-center gap-1.5">
          <button
            type="button"
            onClick={() => setPrimary(i)}
            title={e.isPrimary ? 'Primary (click to change)' : 'Set as primary'}
            className={`shrink-0 w-6 h-6 flex items-center justify-center rounded-full transition-colors ${
              e.isPrimary ? 'bg-navy-500 text-white' : 'bg-surface-3 text-ink-faint hover:bg-surface-3'
            }`}
          >
            <Star size={10} fill={e.isPrimary ? 'currentColor' : 'none'} />
          </button>
          <input
            type={type}
            value={e.value}
            onChange={ev => setField(i, 'value', ev.target.value)}
            placeholder={placeholder}
            required={required && i === 0}
            className="flex-1 px-2.5 py-1.5 text-[13px] rounded-lg border border-line bg-surface focus:outline-none focus:ring-2 focus:ring-navy-700/25 focus:border-navy-600 transition-colors"
          />
          {showLabel && (
            <input
              type="text"
              value={e.label}
              onChange={ev => setField(i, 'label', ev.target.value)}
              placeholder={labelPlaceholder}
              className="w-28 px-2.5 py-1.5 text-[13px] rounded-lg border border-line bg-surface focus:outline-none focus:ring-2 focus:ring-navy-700/25 focus:border-navy-600 transition-colors"
            />
          )}
          <button
            type="button"
            onClick={() => removeRow(i)}
            disabled={entries.length === 1}
            className="shrink-0 w-7 h-7 flex items-center justify-center rounded-lg text-ink-faint hover:text-red-500 hover:bg-danger-bg transition-colors disabled:opacity-30 disabled:cursor-not-allowed"
          >
            <Trash2 size={13} />
          </button>
        </div>
      ))}
      <button
        type="button"
        onClick={addRow}
        className="flex items-center gap-1.5 text-[12px] text-navy-600 hover:text-navy-700 font-medium transition-colors"
      >
        <Plus size={13} />
        Add {entries.length === 0 ? 'entry' : 'another'}
      </button>
    </div>
  )
}
