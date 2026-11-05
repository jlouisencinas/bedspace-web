import { CATEGORY_LABEL } from '../../lib/tenantHistory'

function fmtDate(d) {
  if (!d) return '—'
  return new Date(d).toLocaleDateString('en-PH', { month: 'short', day: 'numeric', year: 'numeric' })
}
function fmtRate(n) { return n != null ? '₱' + Number(n).toLocaleString('en-PH') : '—' }
const place = (room, bed) => (room ? `Room ${room}${bed ? ` · Bed ${bed}` : ''}` : '—')

export default function StayTimeline({ tenant, transfers, transfersError, bills }) {
  const first = transfers?.[0]
  const startPlace = !tenant.bed_id
    ? (tenant.unit_label || CATEGORY_LABEL[tenant.category] || '—')
    : first ? place(first.from_room?.room_no, first.from_bed?.bed_letter)
    : place(tenant.room_no, tenant.bed_letter)
  const outDate = tenant.actual_move_out_date || tenant.move_out_date
  const finalIds = (bills || []).filter(b => b.status === 'FINAL').map(b => `#${b.id}`)
  const voidIds = (bills || []).filter(b => b.status === 'VOID').map(b => `#${b.id}`)

  const steps = [
    { key: 'in', dot: 'bg-success-text', title: 'Move in', date: tenant.move_in_date, text: startPlace },
    ...(transfers || []).map(x => ({
      key: `x${x.id}`, dot: 'bg-info-text', title: 'Room transfer', date: x.transfer_date,
      text: `${place(x.from_room?.room_no, x.from_bed?.bed_letter)} → ${place(x.to_room?.room_no, x.to_bed?.bed_letter)}`
        + (x.old_rate != null && x.new_rate != null && Number(x.old_rate) !== Number(x.new_rate) ? ` · ${fmtRate(x.old_rate)} → ${fmtRate(x.new_rate)}` : ''),
    })),
    tenant.is_active
      ? { key: 'out', dot: 'bg-line', title: 'Planned move-out', date: tenant.move_out_date, text: tenant.move_out_date ? 'Still in-house' : 'No planned date' }
      : {
          key: 'out', dot: 'bg-ink-faint', title: 'Moved out', date: outDate,
          text: [finalIds.length ? `Final bill ${finalIds.join(', ')}` : 'No final bill on record', voidIds.length ? `voided ${voidIds.join(', ')}` : '']
            .filter(Boolean).join(' · '),
        },
  ]

  return (
    <div className="mb-4">
      <div className="text-[10px] font-bold text-ink-faint uppercase tracking-widest mb-2">Stay</div>
      {transfersError && (
        <div className="text-[12px] text-danger-text bg-danger-bg border border-danger-border rounded-lg px-3 py-2 mb-2">
          Could not load transfers: {transfersError}
        </div>
      )}
      <div className="rounded-xl bg-surface-2 px-3 py-2">
        {steps.map(s => (
          <div key={s.key} className="flex items-start gap-3 py-1">
            <span className={`shrink-0 mt-1.5 w-2 h-2 rounded-full ${s.dot}`} />
            <div className="flex-1 min-w-0">
              <div className="flex items-start justify-between gap-2">
                <span className="text-[12px] font-semibold text-ink">{s.title}</span>
                <span className="text-[11px] text-ink-faint whitespace-nowrap">{fmtDate(s.date)}</span>
              </div>
              <div className="text-[12px] text-ink-muted">{s.text}</div>
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}
