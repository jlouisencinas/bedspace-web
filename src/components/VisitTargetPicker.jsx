import { useEffect, useMemo, useRef, useState } from 'react'
import { ChevronLeft, Search, Building2, ChevronRight, RefreshCw } from 'lucide-react'
import { fetchTenantDirectory, getRecentTargets } from '../lib/visitors'

const DIRECTORY_TTL_MS = 5 * 60 * 1000
let cache = { at: 0, rows: null }

const tenantTarget = t => ({ kind: 'TENANT', tenant_id: t.tenant_id, tenant_name: t.tenant_name, room_id: t.room_id, room_no: t.room_no, bed_letters: t.bed_letters })

function TenantRow({ t, onPick }) {
  return (
    <button type="button" onClick={() => onPick(tenantTarget(t))}
      className="w-full min-h-[56px] px-4 py-2 flex items-center gap-3 text-left bg-surface hover:bg-surface-2 border-b border-line-subtle last:border-b-0 focus:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-navy-500">
      <div className="flex-1 min-w-0">
        <div className="text-[15px] font-medium text-ink truncate">{t.tenant_name}</div>
        <div className="text-[13px] text-ink-muted">Room {t.room_no} · Bed {t.bed_letters}</div>
      </div>
      <ChevronRight size={18} className="text-ink-faint shrink-0" />
    </button>
  )
}

export default function VisitTargetPicker({ onClose, onPick, initialPurpose = '' }) {
  const [rows, setRows] = useState(cache.rows)
  const [loading, setLoading] = useState(!cache.rows)
  const [error, setError] = useState('')
  const [q, setQ] = useState('')
  const [room, setRoom] = useState(null)
  const [officeOpen, setOfficeOpen] = useState(false)
  const purposeRef = useRef(null)
  const [purpose, setPurpose] = useState(initialPurpose)

  async function load(force = false) {
    if (!force && cache.rows && Date.now() - cache.at < DIRECTORY_TTL_MS) { setRows(cache.rows); setLoading(false); return }
    setLoading(true); setError('')
    try {
      const data = await fetchTenantDirectory()
      cache = { at: Date.now(), rows: data }
      setRows(data)
    } catch (e) {
      setError(`Could not load tenants: ${e.message}`)
    } finally { setLoading(false) }
  }

  useEffect(() => { load() }, [])
  // On a phone the revealed field sits below the fold; bring it into view before focusing.
  useEffect(() => {
    if (!officeOpen || !purposeRef.current) return
    purposeRef.current.scrollIntoView({ behavior: 'smooth', block: 'center' })
    purposeRef.current.focus({ preventScroll: true })
  }, [officeOpen])
  useEffect(() => {
    const prev = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    return () => { document.body.style.overflow = prev }
  }, [])

  const list = rows || []
  const query = q.trim().toLowerCase()
  const matches = useMemo(() => !query ? [] : list.filter(t =>
    t.tenant_name.toLowerCase().includes(query) || String(t.room_no).toLowerCase().startsWith(query)), [list, query])
  const rooms = useMemo(() => [...new Set(list.map(t => t.room_no))], [list])
  const recent = useMemo(() => getRecentTargets()
    .map(r => list.find(t => t.tenant_id === r.tenant_id && t.room_id === r.room_id)).filter(Boolean), [list])
  const purposeOk = purpose.trim().length >= 3 && purpose.trim().length <= 200

  const office = (
    <div className="bg-surface border border-line rounded-xl overflow-hidden">
      <button type="button" onClick={() => setOfficeOpen(o => !o)}
        className="w-full min-h-[56px] px-4 flex items-center gap-3 text-left focus:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-navy-500">
        <Building2 size={20} className="text-ink-muted shrink-0" />
        <span className="flex-1 text-[15px] font-medium text-ink">Office / delivery / repair</span>
        <ChevronRight size={18} className={`text-ink-faint transition-transform ${officeOpen ? 'rotate-90' : ''}`} />
      </button>
      {officeOpen && (
        <div className="px-4 pb-4 space-y-3">
          <div className="fg">
            <label htmlFor="visit-purpose">Purpose of visit</label>
            <input id="visit-purpose" ref={purposeRef} type="text" value={purpose} maxLength={200}
              onChange={e => setPurpose(e.target.value)} placeholder="e.g. Aircon repair, LBC delivery, room viewing"
              className="!text-[16px] !py-3" />
          </div>
          <button type="button" disabled={!purposeOk} onClick={() => onPick({ kind: 'OFFICE', purpose: purpose.trim().replace(/\s+/g, ' ') })}
            className="btn primary w-full !min-h-[48px] !text-[15px]">Use</button>
        </div>
      )}
    </div>
  )

  return (
    <div className="guard-form fixed inset-0 z-50 bg-surface-2 flex flex-col" role="dialog" aria-modal="true" aria-label="Choose who they are visiting">
      <div className="bg-surface border-b border-line" style={{ paddingTop: 'env(safe-area-inset-top)' }}>
        <div className="max-w-xl mx-auto px-2 h-16 flex items-center gap-2">
          <button type="button" onClick={onClose} aria-label="Back"
            className="w-12 h-12 flex items-center justify-center rounded-lg text-ink-muted hover:bg-surface-2 focus:outline-none focus-visible:ring-2 focus-visible:ring-navy-500">
            <ChevronLeft size={24} />
          </button>
          <div className="relative flex-1">
            <Search size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-ink-faint pointer-events-none" />
            <input type="search" value={q} onChange={e => { setQ(e.target.value); setRoom(null) }} autoFocus
              placeholder="Tenant name or room no." aria-label="Search tenant name or room number"
              className="w-full h-12 pl-9 pr-3 rounded-lg text-[16px] bg-surface text-ink border border-line placeholder:text-ink-faint focus:outline-none focus:ring-2 focus:ring-navy-700/25 focus:border-navy-600" />
          </div>
        </div>
      </div>

      <div className="flex-1 overflow-y-auto">
        <div className="max-w-xl mx-auto p-3 space-y-4" style={{ paddingBottom: 'calc(16px + env(safe-area-inset-bottom))' }}>
          {error && (
            <div className="p-3 rounded-xl bg-danger-bg text-danger-text border border-danger-border text-[14px] flex items-center gap-3">
              <span className="flex-1">{error}</span>
              <button type="button" onClick={() => load(true)} className="btn secondary !min-h-[48px]"><RefreshCw size={14} /> Retry</button>
            </div>
          )}
          {loading && <div className="text-[14px] text-ink-muted px-1">Loading tenants…</div>}

          {query ? (
            <>
              {matches.length > 0 ? (
                <div className="bg-surface border border-line rounded-xl overflow-hidden">
                  {matches.map(t => <TenantRow key={`${t.tenant_id}-${t.room_id}`} t={t} onPick={onPick} />)}
                </div>
              ) : !loading && (
                <div className="p-4 rounded-xl bg-surface border border-line text-[14px] text-ink-secondary">
                  No active tenant found. Use Office / delivery / repair if they're not visiting a tenant.
                </div>
              )}
              {office}
            </>
          ) : (
            <>
              {recent.length > 0 && (
                <section>
                  <h3 className="text-[13px] font-semibold text-ink-muted px-1 mb-2">Recent</h3>
                  <div className="bg-surface border border-line rounded-xl overflow-hidden">
                    {recent.map(t => <TenantRow key={`r-${t.tenant_id}-${t.room_id}`} t={t} onPick={onPick} />)}
                  </div>
                </section>
              )}
              {rooms.length > 0 && (
                <section>
                  <h3 className="text-[13px] font-semibold text-ink-muted px-1 mb-2">Rooms</h3>
                  <div className="grid grid-cols-4 gap-2">
                    {rooms.map(no => (
                      <button key={no} type="button" onClick={() => setRoom(r => (r === no ? null : no))} aria-pressed={room === no}
                        className={`min-h-[48px] px-1 rounded-lg border text-[15px] font-semibold truncate focus:outline-none focus-visible:ring-2 focus-visible:ring-navy-500
                          ${room === no ? 'bg-navy-500 text-navy-950 border-navy-500' : 'bg-surface text-ink border-line hover:bg-surface-hover'}`}>
                        {no}
                      </button>
                    ))}
                  </div>
                  {room && (
                    <div className="mt-3 bg-surface border border-line rounded-xl overflow-hidden">
                      <div className="px-4 py-2 text-[13px] font-semibold text-ink-muted border-b border-line-subtle">Room {room}</div>
                      {list.filter(t => t.room_no === room).map(t => <TenantRow key={`${t.tenant_id}-${t.room_id}`} t={t} onPick={onPick} />)}
                    </div>
                  )}
                </section>
              )}
              {!loading && !error && list.length === 0 && (
                <div className="p-4 rounded-xl bg-surface border border-line text-[14px] text-ink-secondary">
                  No active tenant found. Use Office / delivery / repair if they're not visiting a tenant.
                </div>
              )}
              {office}
            </>
          )}
        </div>
      </div>
    </div>
  )
}
