import { computeOccupancySnapshot } from '../../supabase/functions/_shared/occupancy.ts'

// Business runs in Asia/Manila: derive "today" in that zone explicitly (not the browser/server's local
// timezone) via Intl, then step forward one day with pure-UTC arithmetic, matching PrintElectricity.jsx/
// PrintRentWater.jsx's addDays() convention. Mixing local Date fields with toISOString() (as an earlier
// version of this did) silently lands back on today's date for any positive UTC offset, permanently
// excluding today from the average.
export function manilaMonthToDateWindow(now) {
  const todayISO = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Manila', year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(now)
  const monthStartISO = todayISO.slice(0, 8) + '01'
  const tomorrowISO = new Date(Date.parse(todayISO + 'T00:00:00Z') + 86400000).toISOString().slice(0, 10)
  return { todayISO, monthStartISO, tomorrowISO }
}

// The Dashboard Occupancy tile: the month-to-date day-weighted average (headline) and today's
// point-in-time LEASED / sellable rate (secondary). The two can differ on the same day: the average counts
// tenant records by their dates, today's rate counts bed statuses.
export function occupancyTileFigures({ beds, tenants, now }) {
  const { todayISO, monthStartISO, tomorrowISO } = manilaMonthToDateWindow(now)
  const snap = computeOccupancySnapshot(monthStartISO, tomorrowISO, beds, tenants)
  const sellableBeds = snap.sellableBeds
  const leasedNow = beds.filter(b => b.status === 'LEASED').length
  const todayPct = sellableBeds > 0 ? Math.round((leasedNow / sellableBeds) * 100) : 0
  return {
    mtdPct: snap.occupancyPct,
    mtdBedsAvg: snap.occupiedBedsAvg,
    sellableBeds,
    periodDays: snap.periodDays,
    monthStartISO,
    todayISO,
    tomorrowISO,
    todayPct,
    leasedNow,
    detail: snap.detail,
    hasBeds: sellableBeds > 0,
  }
}

export function formatNum1(n) {
  return (Math.round(Number(n) * 10) / 10).toFixed(1)
}

export function formatPct1(n) {
  return `${(Math.round(Number(n) * 10) / 10).toFixed(1)}%`
}
