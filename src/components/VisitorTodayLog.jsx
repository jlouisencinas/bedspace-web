import { TONE_CHIP, fmtWhen, logDayStartMs } from '../lib/visitors'

export default function VisitorTodayLog({ rows, nowMs, loading, error }) {
  const start = logDayStartMs(nowMs)
  const today = rows
    .filter(r => Date.parse(r.check_in_at) >= start || (r.check_out_at && Date.parse(r.check_out_at) >= start))
    .sort((a, b) => Date.parse(b.check_in_at) - Date.parse(a.check_in_at))

  return (
    <div className="space-y-3">
      <h2 className="text-[16px] font-semibold text-ink px-1">Since 6:00 AM ({today.length})</h2>
      {error && <div className="p-3 rounded-xl bg-danger-bg text-danger-text border border-danger-border text-[14px]">{error}</div>}
      {!loading && !error && today.length === 0 && (
        <div className="p-6 rounded-xl bg-surface border border-line text-center text-[14px] text-ink-muted">No visits since 6:00 AM.</div>
      )}
      {today.length > 0 && (
        <ul className="bg-surface border border-line rounded-xl overflow-hidden">
          {today.map(r => (
            <li key={r.id} className="min-h-[56px] px-4 py-2.5 border-b border-line-subtle last:border-b-0">
              <div className="flex items-center gap-2">
                <span className="text-[14px] font-semibold text-ink tabular-nums">
                  {fmtWhen(r.check_in_at, nowMs)} → {r.check_out_at ? fmtWhen(r.check_out_at, nowMs) : '…'}
                </span>
                {!r.check_out_at && <span className={`ml-auto px-2 py-0.5 rounded-full text-[12px] font-semibold ${TONE_CHIP.info}`}>Inside</span>}
              </div>
              <div className="text-[15px] text-ink break-words">{r.visitor_name}</div>
              <div className="text-[13px] text-ink-muted break-words">
                {r.visit_kind === 'OFFICE' ? `Office: ${r.purpose || '—'}` : `${r.tenant_name} · ${r.room_no}`}
                {' · '}in {r.check_in_guard_name}{r.check_out_guard_name ? ` / out ${r.check_out_guard_name}` : ''}
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
