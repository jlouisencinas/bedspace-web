import { useState } from 'react'
import { Link } from 'react-router-dom'
import { X } from 'lucide-react'
import SearchInput from './SearchInput'

// Shared table/list drill-down modal for the Dashboard KPI tiles. Reuses the
// app's existing modal chrome (.overlay/.modal/.modal-head/.table-wrap/
// .upcoming-item) exactly — no click-outside-to-close, no Escape handling,
// consistent with every other modal in this codebase.
export default function DrillDownModal({
  open, onClose, shape, icon: Icon, title, subtitle,
  rows, rowKey, emptyMessage, canNavigate, footerLink, onRowClick,
  columns, searchFields,
  renderItem,
}) {
  const [search, setSearch] = useState('')

  // The modal stays mounted across opens/closes (rendered via `open`, not
  // conditionally instantiated), so leftover search text from a previous tile
  // — or a previous open of the SAME tile — would otherwise persist. Reset
  // synchronously during render (React's "adjusting state on prop change"
  // pattern, via a prevOpen ref-in-state) rather than in a useEffect, so the
  // very first paint of the newly-opened modal already reflects the reset —
  // no stale-content flash. Reopening the same tile always transitions
  // false→true too (you must close before you can click it again), so this
  // covers both "reopen same tile" and "open a different tile".
  const [prevOpen, setPrevOpen] = useState(open)
  if (open !== prevOpen) {
    setPrevOpen(open)
    if (open) setSearch('')
  }

  if (!open) return null

  const q = search.trim().toLowerCase()
  const filteredRows = (shape === 'table' && searchFields && q)
    ? rows.filter(row => searchFields.some(f => String(row[f] ?? '').toLowerCase().includes(q)))
    : rows

  const clickable = canNavigate && !!onRowClick

  return (
    <div className="overlay" onClick={e => e.stopPropagation()}>
      <div className={`modal ${shape === 'table' ? 'modal-lg' : ''}`}>
        <div className="modal-head">
          <div className="flex items-center gap-2.5">
            {Icon && (
              <div className="p-1.5 rounded-lg bg-navy-100">
                <Icon size={15} className="text-navy-500" />
              </div>
            )}
            <div>
              <h3>{title}</h3>
              {subtitle && <div className="text-[11px] text-ink-faint mt-0.5">{subtitle}</div>}
            </div>
          </div>
          <button className="btn-close" onClick={onClose}><X size={16} /></button>
        </div>

        <div className="modal-body">
          {shape === 'table' && searchFields && (
            <div className="mb-4">
              <SearchInput
                value={search}
                onChange={e => setSearch(e.target.value)}
                placeholder="Search…"
                className="w-full"
              />
            </div>
          )}

          {shape === 'table' ? (
            filteredRows.length === 0 ? (
              <div className="empty"><p>{emptyMessage}</p></div>
            ) : (
              <div className="table-wrap max-h-[50vh] overflow-y-auto">
                <table>
                  <thead className="sticky top-0 z-10">
                    <tr>
                      {columns.map(col => (
                        <th key={col.key} className={col.align === 'right' ? 'text-right' : ''}>{col.label}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {filteredRows.map(row => (
                      <tr
                        key={rowKey(row)}
                        className={clickable ? 'cursor-pointer' : ''}
                        onClick={clickable ? () => onRowClick(row) : undefined}
                      >
                        {columns.map(col => (
                          <td key={col.key} className={col.align === 'right' ? 'text-right' : ''}>
                            {col.render ? col.render(row) : row[col.key]}
                          </td>
                        ))}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )
          ) : (
            rows.length === 0 ? (
              <div className="empty"><p>{emptyMessage}</p></div>
            ) : (
              <div>
                {rows.map(row => (
                  <div
                    key={rowKey(row)}
                    className={`upcoming-item ${clickable ? 'cursor-pointer' : ''}`}
                    onClick={clickable ? () => onRowClick(row) : undefined}
                  >
                    {renderItem(row)}
                  </div>
                ))}
              </div>
            )
          )}
        </div>

        {(canNavigate && footerLink) && (
          <div className="modal-foot">
            <Link to={footerLink.to} state={footerLink.state} className="btn secondary mr-auto" onClick={onClose}>
              {footerLink.label}
            </Link>
            <button className="btn secondary" onClick={onClose}>Close</button>
          </div>
        )}
      </div>
    </div>
  )
}
