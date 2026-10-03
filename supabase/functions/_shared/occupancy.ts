// Pure day-weighted occupancy formula, shared by the Vite client (snapshot.js,
// Dashboard.jsx) and admin-triggered snapshot writes. No imports, no Deno/browser
// globals — mirrors approval-labels.ts's sharing convention.

const MS_DAY = 86400000

// Self-contained copy of billing.js's dayNum() (same inclusive-last-day /
// exclusive-period-end convention). Kept separate rather than imported so the
// _shared/ -> src/ sharing direction stays one-way, matching the existing
// approval-labels.ts precedent, not reversed.
export function dayNum(iso: string | null | undefined): number | null {
  if (!iso) return null
  return Math.floor(Date.parse(String(iso).slice(0, 10) + 'T00:00:00Z') / MS_DAY)
}

// Inverse of dayNum() — same UTC-midnight convention.
export function isoFromDayNum(n: number): string {
  return new Date(n * MS_DAY).toISOString().slice(0, 10)
}

export interface OccupancyBed {
  bed_id: number | string
  room_id: number | string
  status: string
}

export interface OccupancyTenant {
  id?: string | number | null
  bed_id: number | string | null
  name: string | null
  move_in_date: string | null
  move_out_date: string | null
  actual_move_out_date: string | null
  previous_bed_id?: number | string | null
  transfer_date?: string | null
}

export interface OccupancyDetailRow {
  tenantId: string | number | null
  tenantName: string
  bedId: number | string
  roomId: number | string | null
  days: number
  startISO: string   // inclusive
  endISO: string      // inclusive (interval.end is exclusive internally; endISO = isoFromDayNum(end - 1))
}

export interface OccupancySnapshot {
  totalBeds: number
  sellableBeds: number
  periodDays: number
  occupiedBedsAvg: number
  activeTenantsAvg: number
  occupiedRoomsAvg: number
  occupancyPct: number
  detail: OccupancyDetailRow[]
}

const round1 = (n: number) => Math.round(n * 10) / 10

/**
 * Day-weighted occupancy over [periodStartISO, periodEndExclISO). A tenant's
 * effective interval resolves to actual_move_out_date || move_out_date (or the
 * period end, if still active), clamped to the period — the same rule for a
 * closed historical period as for a still-open one (only periodEnd differs).
 *
 * totalBeds/sellableBeds are current-inventory counts (property structure, not
 * tenancy-driven, so not day-weighted) with REMOVED excluded from both and
 * OUT OF ORDER additionally excluded from sellableBeds.
 *
 * The historical denominator (sellableBeds) is always today's bed count, not a
 * reconstruction of what it was during periodStart..periodEnd — a documented
 * approximation (activity_log can't reliably reconstruct bed-status history).
 */
export function computeOccupancySnapshot(
  periodStartISO: string | null | undefined,
  periodEndExclISO: string | null | undefined,
  beds: OccupancyBed[],
  tenants: OccupancyTenant[],
): OccupancySnapshot {
  const totalBeds = beds.filter(b => b.status !== 'REMOVED').length
  const sellableBeds = beds.filter(b => b.status !== 'REMOVED' && b.status !== 'OUT OF ORDER').length

  const periodStart = dayNum(periodStartISO)
  const periodEndExcl = dayNum(periodEndExclISO)
  const periodDays = (periodStart != null && periodEndExcl != null) ? periodEndExcl - periodStart : 0

  if (sellableBeds === 0 || periodDays <= 0) {
    return {
      totalBeds, sellableBeds, periodDays: Math.max(periodDays, 0),
      occupiedBedsAvg: 0, activeTenantsAvg: 0, occupiedRoomsAvg: 0, occupancyPct: 0,
      detail: [],
    }
  }

  const bedRoomMap = new Map<number | string, number | string>()
  beds.forEach(b => bedRoomMap.set(b.bed_id, b.room_id))

  const intervals: {
    start: number, end: number, roomId: number | string | null, tenantKey: string,
    tenantId: string | number | null, tenantName: string, bedId: number | string,
  }[] = []
  tenants.forEach(t => {
    if (t.bed_id == null) return
    const inNum = dayNum(t.move_in_date)
    if (inNum == null) return
    const rawOut = t.actual_move_out_date || t.move_out_date
    const outExcl = rawOut ? (dayNum(rawOut) as number) + 1 : periodEndExcl
    const start = Math.max(inNum, periodStart as number)
    const end = Math.min(outExcl as number, periodEndExcl as number)
    if (end <= start) return

    const pushInterval = (segStart: number, segEnd: number, bedId: number | string) => {
      if (segEnd <= segStart) return
      const roomId = bedRoomMap.get(bedId) ?? null
      intervals.push({
        start: segStart, end: segEnd, roomId,
        tenantKey: `${roomId}|${String(t.name || '').trim().toUpperCase()}`,
        tenantId: t.id ?? null, tenantName: t.name || '', bedId,
      })
    }

    // A mid-period transfer attributes pre-transfer days to the tenant's
    // previous bed/room, not their current one — [start,end) is split into two
    // contiguous, non-overlapping segments so bedDaySum/tenantDaySum (and thus
    // occupiedBedsAvg/occupancyPct) are unaffected; only the per-row room/bed
    // breakdown gains detail. Only one hop back is reconstructed (previous_bed_id
    // is a single column, not a full transfer history) — a tenant who
    // transferred twice within the same period still shows their earliest days
    // attributed to the wrong (2nd) bed.
    const transferDay = (t.previous_bed_id != null && t.previous_bed_id !== t.bed_id)
      ? dayNum(t.transfer_date) : null
    if (transferDay != null && transferDay > start && transferDay < end) {
      pushInterval(start, transferDay, t.previous_bed_id as number | string)
      pushInterval(transferDay, end, t.bed_id)
    } else {
      pushInterval(start, end, t.bed_id)
    }
  })

  let bedDaySum = 0, tenantDaySum = 0, roomDaySum = 0
  for (let d = periodStart as number; d < (periodEndExcl as number); d++) {
    let bedsToday = 0
    const tenantKeysToday = new Set<string>()
    const roomsToday = new Set<number | string>()
    for (const iv of intervals) {
      if (d >= iv.start && d < iv.end) {
        bedsToday++
        tenantKeysToday.add(iv.tenantKey)
        if (iv.roomId != null) roomsToday.add(iv.roomId)
      }
    }
    bedDaySum += bedsToday
    tenantDaySum += tenantKeysToday.size
    roomDaySum += roomsToday.size
  }

  const occupiedBedsAvg = round1(bedDaySum / periodDays)
  const activeTenantsAvg = round1(tenantDaySum / periodDays)
  const occupiedRoomsAvg = round1(roomDaySum / periodDays)
  const occupancyPct = round1((bedDaySum / periodDays) / sellableBeds * 100)

  const detail: OccupancyDetailRow[] = intervals.map(iv => ({
    tenantId: iv.tenantId,
    tenantName: iv.tenantName,
    bedId: iv.bedId,
    roomId: iv.roomId,
    days: iv.end - iv.start,
    startISO: isoFromDayNum(iv.start),
    endISO: isoFromDayNum(iv.end - 1),
  }))

  return {
    totalBeds, sellableBeds, periodDays, occupiedBedsAvg, activeTenantsAvg, occupiedRoomsAvg, occupancyPct,
    detail,
  }
}
