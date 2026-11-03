import { useCallback, useEffect, useState } from 'react'
import { Filter, Trash2, Pencil, Ban } from 'lucide-react'
import SearchInput from './SearchInput'
import { BottomSheet } from './GuardShell'
import VisitorDetailDrawer from './VisitorDetailDrawer'
import VisitorCorrectModal from './VisitorCorrectModal'
import VisitorVoidModal from './VisitorVoidModal'
import { runPhotoPurge } from '../lib/idPhoto'
import {
  STATE_META, TONE_CHIP, contactKey, fetchHistory, fetchVisit, fmtDateTime, fmtDateYear, fmtDuration, fmtTime, idTypeLabel,
  manilaDateKey, sameLogDay, visitTargetText,
} from '../lib/visitors'

const PAGE = 100
const STATUS_OPTS = [['ACTIVE', 'Not voided'], ['INSIDE', 'Inside'], ['OUT', 'Checked out'], ['VOID', 'Voided'], ['ALL', 'All']]
const OVERNIGHT_OPTS = [['ANY', 'Any'], ['REQUESTED', 'Requested'], ['PENDING', 'Pending'], ['APPROVED', 'Approved'], ['REJECTED', 'Rejected'], ['PAST_CUTOFF', 'Past cut-off without approval']]
const KIND_OPTS = [['ALL', 'All'], ['TENANT', 'Tenant'], ['OFFICE', 'Office']]

function shiftDays(ymd, n) {
  const [y, m, d] = ymd.split('-').map(Number)
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10)
}

function Chip({ tone, children, title }) {
  return <span title={title} className={`inline-flex items-center px-2 py-0.5 rounded-full text-[11px] font-semibold whitespace-nowrap ${TONE_CHIP[tone]}`}>{children}</span>
}

function OvernightCell({ v }) {
  return (
    <div className="flex flex-wrap gap-1">
      {v.overnight_status !== 'NONE' && (
        <Chip tone={v.overnight_status === 'APPROVED' ? 'success' : v.overnight_status === 'REJECTED' ? 'danger' : 'warning'}>{v.overnight_status}</Chip>
      )}
      {v.overstay_unapproved && <Chip tone="danger">Past cut-off, no approval</Chip>}
      {v.overnight_status === 'NONE' && !v.overstay_unapproved && <span className="text-ink-faint">—</span>}
    </div>
  )
}

// visitor_history compares the text with contact_key, so a phone-looking search is normalized the same way first.
function normalizeSearch(s) {
  const t = s.trim()
  return /^[\d\s+\-()]+$/.test(t) && t.replace(/\D/g, '').length >= 7 ? contactKey(t) : t
}

const photoText = v => (v.id_photo_purged_at ? `Deleted ${fmtDateYear(v.id_photo_purged_at)}` : 'On file')

function Filters({ f, set, idPrefix }) {
  const sel = (key, opts, label) => (
    <div className="fg">
      <label htmlFor={`${idPrefix}-${key}`}>{label}</label>
      <select id={`${idPrefix}-${key}`} value={f[key]} onChange={e => set(key, e.target.value)}>
        {opts.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
      </select>
    </div>
  )
  return (
    <div className="grid grid-cols-2 md:grid-cols-5 gap-3">
      <div className="fg">
        <label htmlFor={`${idPrefix}-from`}>From</label>
        <input id={`${idPrefix}-from`} type="date" value={f.from} max={f.to} onChange={e => e.target.value && set('from', e.target.value)} />
      </div>
      <div className="fg">
        <label htmlFor={`${idPrefix}-to`}>To</label>
        <input id={`${idPrefix}-to`} type="date" value={f.to} min={f.from} onChange={e => e.target.value && set('to', e.target.value)} />
      </div>
      {sel('status', STATUS_OPTS, 'Status')}
      {sel('overnight', OVERNIGHT_OPTS, 'Overnight')}
      {sel('kind', KIND_OPTS, 'Visiting')}
    </div>
  )
}

export default function VisitorHistory({ isAdmin, nowMs, show, onChanged }) {
  const today = manilaDateKey(nowMs)
  const [f, setF] = useState({ from: shiftDays(today, -6), to: today, status: 'ACTIVE', overnight: 'ANY', kind: 'ALL' })
  const [search, setSearch] = useState('')
  const [q, setQ] = useState('')
  const [rows, setRows] = useState([])
  const [hasMore, setHasMore] = useState(false)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [filtersOpen, setFiltersOpen] = useState(false)
  const [selected, setSelected] = useState(null)
  const [correcting, setCorrecting] = useState(null)
  const [voiding, setVoiding] = useState(null)
  const [purging, setPurging] = useState(false)

  const set = (k, v) => setF(prev => ({ ...prev, [k]: v }))

  useEffect(() => {
    const t = setTimeout(() => setQ(normalizeSearch(search)), 300)
    return () => clearTimeout(t)
  }, [search])

  const load = useCallback(async (count = PAGE) => {
    setLoading(true); setError('')
    try {
      const out = []
      for (let offset = 0; offset < count; offset += PAGE) {
        const page = await fetchHistory({ ...f, search: q, limit: PAGE, offset })
        out.push(...page)
        if (page.length < PAGE) break
      }
      setRows(out)
      setHasMore(out.length >= count && out.length % PAGE === 0 && out.length > 0)
    } catch (e) {
      setError(e.message)
    } finally { setLoading(false) }
  }, [f, q])

  useEffect(() => { load() }, [load])

  async function loadMore() {
    setLoading(true); setError('')
    try {
      const page = await fetchHistory({ ...f, search: q, limit: PAGE, offset: rows.length })
      setRows(r => [...r, ...page])
      setHasMore(page.length === PAGE)
    } catch (e) {
      setError(e.message)
    } finally { setLoading(false) }
  }

  async function afterEdit(id, message) {
    setCorrecting(null); setVoiding(null)
    show(message, 'success')
    onChanged?.()
    await load(Math.max(PAGE, Math.ceil(rows.length / PAGE) * PAGE))
    if (selected?.id === id) {
      try { setSelected(await fetchVisit(id)) } catch (e) { show(e.message, 'error') }
    }
  }

  async function purge() {
    setPurging(true)
    try {
      const r = await runPhotoPurge()
      show(`Removed ${r.expired} expired photo${r.expired === 1 ? '' : 's'} and ${r.orphans} unused upload${r.orphans === 1 ? '' : 's'}.`, 'success', { duration: 6000 })
      await load(Math.max(PAGE, rows.length))
    } catch (e) {
      show(`Photo purge failed: ${e.message}`, 'error', { duration: 8000 })
    } finally { setPurging(false) }
  }

  const actions = v => !v.voided_at && (
    <div className="flex flex-col items-start gap-1.5" onClick={e => e.stopPropagation()}>
      <button type="button" className="btn-xs blue" onClick={() => setCorrecting(v)}><Pencil size={11} /> Correct</button>
      <button type="button" className="btn-xs red" onClick={() => setVoiding(v)}><Ban size={11} /> Void</button>
    </div>
  )

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <div className="flex-1 min-w-[220px]">
          <SearchInput value={search} onChange={e => setSearch(e.target.value)} placeholder="Name, contact, ID no., tenant, room, purpose"
            className="w-full !text-[16px] md:!text-[13px]" />
        </div>
        <button type="button" className="btn secondary md:hidden !min-h-[44px]" onClick={() => setFiltersOpen(true)}><Filter size={14} /> Filters</button>
        {isAdmin && (
          <button type="button" className="btn secondary !min-h-[40px]" onClick={purge} disabled={purging}>
            <Trash2 size={14} /> {purging ? 'Purging…' : 'Purge old ID photos'}
          </button>
        )}
      </div>
      <div className="hidden md:block card p-4"><Filters f={f} set={set} idPrefix="vh" /></div>

      {error && <div className="p-3 rounded-xl bg-danger-bg text-danger-text border border-danger-border text-[13px]">{error}</div>}

      <div className="hidden md:block table-wrap">
        <table className="[&_td]:px-3 [&_th]:px-3 [&_td]:align-top">
          <thead>
            <tr>
              <th>Time</th><th>Visitor</th><th>ID / photo</th><th>Visiting</th><th>Front desk</th><th>Overnight</th><th></th>
            </tr>
          </thead>
          <tbody>
            {rows.map(v => {
              const voided = !!v.voided_at
              const end = v.check_out_at ? Date.parse(v.check_out_at) : Date.parse(v.server_now)
              return (
                <tr key={v.id} onClick={() => setSelected(v)} className={`cursor-pointer ${voided ? 'opacity-60' : ''}`}>
                  <td className="whitespace-nowrap text-[12px]">
                    <div className="text-ink">{fmtDateTime(v.check_in_at)}</div>
                    <div>→ {v.check_out_at ? (sameLogDay(v.check_out_at, v.check_in_at) ? fmtTime(v.check_out_at) : fmtDateTime(v.check_out_at))
                      : voided ? '—' : <Chip tone="info">Inside</Chip>}</div>
                    {!voided && <div className="text-ink-faint">{fmtDuration(end - Date.parse(v.check_in_at))}</div>}
                  </td>
                  <td className="text-[12px] min-w-[190px] max-w-[260px]">
                    <div className="text-[13px] font-medium text-ink break-normal">
                      <span className={voided ? 'line-through' : ''}>{v.visitor_name}</span>
                      {voided && <span className="ml-1.5"><Chip tone="neutral">Void</Chip></span>}
                    </div>
                    {voided && <div className="text-danger-text break-words">Voided: {v.void_reason}</div>}
                    <div className="whitespace-nowrap">{v.contact_no}</div>
                    <div className="truncate" title={v.email || ''}>{v.no_email ? 'No email' : v.email}</div>
                  </td>
                  <td className="text-[12px] min-w-[120px]">
                    {idTypeLabel(v.id_type, v.id_type_other)}
                    <div className="text-ink-faint">{v.id_number || 'No ID number'}</div>
                    <div className="text-ink-faint whitespace-nowrap">Photo {photoText(v).toLowerCase()}</div>
                  </td>
                  <td className="text-[12px] min-w-[140px] max-w-[220px]">{visitTargetText(v)}</td>
                  <td className="text-[12px] min-w-[110px]">in {v.check_in_guard_name}{v.check_out_guard_name ? <div>out {v.check_out_guard_name}</div> : null}</td>
                  <td className="text-[12px]"><OvernightCell v={v} /></td>
                  <td>{actions(v)}</td>
                </tr>
              )
            })}
            {!loading && rows.length === 0 && <tr><td colSpan={7} className="text-center text-ink-muted py-8">No visits match these filters.</td></tr>}
          </tbody>
        </table>
      </div>

      <div className="md:hidden space-y-2">
        {rows.map(v => {
          const voided = !!v.voided_at
          const meta = STATE_META[v.state] || STATE_META.OK
          return (
            <button type="button" key={v.id} onClick={() => setSelected(v)}
              className={`w-full text-left bg-surface border border-line rounded-xl p-4 space-y-1 focus:outline-none focus-visible:ring-2 focus-visible:ring-navy-500 ${voided ? 'opacity-60' : ''}`}>
              <div className="flex items-start gap-2">
                <span className={`flex-1 min-w-0 text-[15px] font-semibold text-ink break-words ${voided ? 'line-through' : ''}`}>{v.visitor_name}</span>
                <Chip tone={meta.tone}>{meta.label}</Chip>
              </div>
              {voided && <div className="text-[13px] text-danger-text break-words">Voided: {v.void_reason}</div>}
              <div className="text-[14px] text-ink-secondary break-words">{visitTargetText(v)}</div>
              <div className="text-[14px] text-ink-secondary">
                In {fmtDateTime(v.check_in_at)}{v.check_out_at ? ` → ${sameLogDay(v.check_out_at, v.check_in_at) ? fmtTime(v.check_out_at) : fmtDateTime(v.check_out_at)}` : ''}
              </div>
              <div className="text-[14px] text-ink-secondary break-words">☎ {v.contact_no} · {idTypeLabel(v.id_type, v.id_type_other)}{v.id_number ? ` ${v.id_number}` : ''} · Photo {photoText(v).toLowerCase()}</div>
              <OvernightCell v={v} />
            </button>
          )
        })}
        {!loading && rows.length === 0 && <div className="p-6 rounded-xl bg-surface border border-line text-center text-[14px] text-ink-muted">No visits match these filters.</div>}
      </div>

      <div className="flex items-center justify-center gap-3">
        {loading && <span className="text-[13px] text-ink-muted">Loading…</span>}
        {!loading && hasMore && <button type="button" className="btn secondary !min-h-[44px]" onClick={loadMore}>Load more</button>}
      </div>

      {filtersOpen && (
        <BottomSheet title="Filters" onClose={() => setFiltersOpen(false)}
          footer={<button type="button" className="btn primary w-full !min-h-[48px]" onClick={() => setFiltersOpen(false)}>Done</button>}>
          <Filters f={f} set={set} idPrefix="vh-sheet" />
        </BottomSheet>
      )}

      {selected && (
        <VisitorDetailDrawer visit={selected} isAdmin={isAdmin} onClose={() => setSelected(null)}
          onCorrect={() => setCorrecting(selected)} onVoid={() => setVoiding(selected)} />
      )}
      {correcting && (
        <VisitorCorrectModal visit={correcting} isAdmin={isAdmin} nowMs={nowMs} onClose={() => setCorrecting(null)}
          onDone={() => afterEdit(correcting.id, 'Correction saved.')} />
      )}
      {voiding && (
        <VisitorVoidModal visit={voiding} onClose={() => setVoiding(null)} onDone={() => afterEdit(voiding.id, 'Entry voided.')} />
      )}
    </div>
  )
}
