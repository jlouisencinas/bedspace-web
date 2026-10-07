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
  rate?: number | string | null
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

interface OccupancyInterval {
  start: number, end: number, roomId: number | string | null, tenantKey: string,
  tenantId: string | number | null, tenantName: string, bedId: number | string,
  rate: number,
}

// Shared by computeOccupancySnapshot and computeDailyOccupancy so both resolve a
// tenant's occupied span identically.
function buildIntervals(
  periodStart: number,
  periodEndExcl: number,
  beds: OccupancyBed[],
  tenants: OccupancyTenant[],
): OccupancyInterval[] {
  const bedRoomMap = new Map<number | string, number | string>()
  beds.forEach(b => bedRoomMap.set(b.bed_id, b.room_id))

  const intervals: OccupancyInterval[] = []
  tenants.forEach(t => {
    if (t.bed_id == null) return
    const inNum = dayNum(t.move_in_date)
    if (inNum == null) return
    const rawOut = t.actual_move_out_date || t.move_out_date
    const outExcl = rawOut ? (dayNum(rawOut) as number) + 1 : periodEndExcl
    const start = Math.max(inNum, periodStart)
    const end = Math.min(outExcl, periodEndExcl)
    if (end <= start) return

    const rate = Number(t.rate) || 0
    const pushInterval = (segStart: number, segEnd: number, bedId: number | string) => {
      if (segEnd <= segStart) return
      const roomId = bedRoomMap.get(bedId) ?? null
      intervals.push({
        start: segStart, end: segEnd, roomId,
        tenantKey: `${roomId}|${String(t.name || '').trim().toUpperCase()}`,
        tenantId: t.id ?? null, tenantName: t.name || '', bedId, rate,
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
  return intervals
}

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

  const intervals = buildIntervals(periodStart as number, periodEndExcl as number, beds, tenants)

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

export interface DailyOccupancyRow {
  date: string
  beds: number
  tenants: number
  rooms: number
  revenue: number
  occupancyPct: number
}

export interface DailyOccupancyLine {
  totalBeds: number
  sellableBeds: number
  vacantBeds: number
  rooms: number
  tenants: number
  beds: number
  revenue: number
  occupancyPct: number
}

export interface DailyOccupancy {
  totalBeds: number
  sellableBeds: number
  periodDays: number
  days: DailyOccupancyRow[]
  lastDay: DailyOccupancyLine | null
  average: DailyOccupancyLine | null
}

/**
 * Per-day occupancy over [periodStartISO, periodEndExclISO), using the same
 * tenant interval rules as computeOccupancySnapshot (inclusive last day, transfer
 * split, clamped to period). A day's revenue is the sum of each present
 * tenant-bed's tenants.rate. Values are unrounded; callers format for display.
 *
 * totalBeds/sellableBeds are today's inventory (same approximation as above).
 * `average` is the plain mean of each daily line across every day in the period
 * (occupancyPct = mean(beds) / sellableBeds); `lastDay` is the final day's line.
 */
export function computeDailyOccupancy(
  periodStartISO: string | null | undefined,
  periodEndExclISO: string | null | undefined,
  beds: OccupancyBed[],
  tenants: OccupancyTenant[],
): DailyOccupancy {
  const totalBeds = beds.filter(b => b.status !== 'REMOVED').length
  const sellableBeds = beds.filter(b => b.status !== 'REMOVED' && b.status !== 'OUT OF ORDER').length

  const periodStart = dayNum(periodStartISO)
  const periodEndExcl = dayNum(periodEndExclISO)
  const periodDays = (periodStart != null && periodEndExcl != null) ? periodEndExcl - periodStart : 0
  if (periodDays <= 0) {
    return { totalBeds, sellableBeds, periodDays: 0, days: [], lastDay: null, average: null }
  }

  const intervals = buildIntervals(periodStart as number, periodEndExcl as number, beds, tenants)
  const pct = (occupied: number) => sellableBeds > 0 ? occupied / sellableBeds * 100 : 0

  const days: DailyOccupancyRow[] = []
  let bedSum = 0, tenantSum = 0, roomSum = 0, revenueSum = 0
  for (let d = periodStart as number; d < (periodEndExcl as number); d++) {
    let bedsToday = 0, revenueToday = 0
    const tenantKeysToday = new Set<string>()
    const roomsToday = new Set<number | string>()
    for (const iv of intervals) {
      if (d >= iv.start && d < iv.end) {
        bedsToday++
        revenueToday += iv.rate
        tenantKeysToday.add(iv.tenantKey)
        if (iv.roomId != null) roomsToday.add(iv.roomId)
      }
    }
    days.push({
      date: isoFromDayNum(d), beds: bedsToday, tenants: tenantKeysToday.size,
      rooms: roomsToday.size, revenue: revenueToday, occupancyPct: pct(bedsToday),
    })
    bedSum += bedsToday; tenantSum += tenantKeysToday.size
    roomSum += roomsToday.size; revenueSum += revenueToday
  }

  const last = days[days.length - 1]
  const lastDay: DailyOccupancyLine = {
    totalBeds, sellableBeds, vacantBeds: sellableBeds - last.beds, rooms: last.rooms,
    tenants: last.tenants, beds: last.beds, revenue: last.revenue, occupancyPct: last.occupancyPct,
  }
  const avgBeds = bedSum / periodDays
  const average: DailyOccupancyLine = {
    totalBeds, sellableBeds, vacantBeds: sellableBeds - avgBeds, rooms: roomSum / periodDays,
    tenants: tenantSum / periodDays, beds: avgBeds, revenue: revenueSum / periodDays,
    occupancyPct: pct(avgBeds),
  }
  return { totalBeds, sellableBeds, periodDays, days, lastDay, average }
}
