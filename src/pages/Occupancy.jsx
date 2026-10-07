import { useState, useEffect, useMemo } from 'react'
import { PieChart } from 'lucide-react'
import { fetchBeds, fetchTenants } from '../lib/supabase'
import { computeDailyOccupancy, isoFromDayNum, dayNum } from '../../supabase/functions/_shared/occupancy.ts'
import { useToast } from '../components/Toast'

const MIN_MONTH = '2026-09'
const MONTHS = ['January','February','March','April','May','June','July','August','September','October','November','December']

const peso = n => '₱' + Number(n || 0).toLocaleString('en-PH', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
const int = n => String(Math.round(n))
const dec1 = n => Number(n).toFixed(1)
const pct2 = n => Number(n).toFixed(2) + '%'

function localISO(d) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

function monthsFrom(minMonth, todayISO) {
  const curMonth = todayISO.slice(0, 7)
  const out = []
  let [y, m] = minMonth.split('-').map(Number)
  while (`${y}-${String(m).padStart(2, '0')}` <= curMonth) {
    const ym = `${y}-${String(m).padStart(2, '0')}`
    const start = `${ym}-01`
    const nextY = m === 12 ? y + 1 : y
    const nextM = m === 12 ? 1 : m + 1
    const isCurrent = ym === curMonth
    const endExcl = isCurrent
      ? isoFromDayNum(dayNum(todayISO) + 1)
      : `${nextY}-${String(nextM).padStart(2, '0')}-01`
    out.push({ ym, label: `${MONTHS[m - 1]} ${y}`, start, endExcl, isCurrent })
    m = nextM; y = nextY
  }
  return out.reverse()
}

const ROWS = [
  { label: 'Total number of beds based on current bed setup', key: 'totalBeds', fmtLast: int, fmtAvg: int },
  { label: 'Total number of sellable beds',                   key: 'sellableBeds', fmtLast: int, fmtAvg: int },
  { label: 'Total number of available beds (vacant)',         key: 'vacantBeds', fmtLast: int, fmtAvg: dec1 },
  { label: 'Total number of rooms occupied',                  key: 'rooms', fmtLast: int, fmtAvg: dec1 },
  { label: 'Total number of bedspace tenants', key: 'tenants', fmtLast: int, fmtAvg: dec1 },
  { label: 'Total number of beds occupied',                   key: 'beds', fmtLast: int, fmtAvg: dec1 },
  { label: 'Revenue from beds leased',                        key: 'revenue', fmtLast: peso, fmtAvg: peso },
  { label: 'Occupancy rate',                                  key: 'occupancyPct', fmtLast: pct2, fmtAvg: pct2, bold: true },
]

function DayStrip({ days }) {
  return (
    <div className="flex items-end gap-px h-16 mb-3" aria-hidden="true">
      {days.map(d => (
        <div
          key={d.date}
          title={`${d.date}: ${d.beds} beds, ${d.occupancyPct.toFixed(1)}%`}
          className="flex-1 bg-navy-500/70 rounded-t-sm min-w-[2px]"
          style={{ height: `${Math.max(Math.min(d.occupancyPct, 100), 1)}%` }}
        />
      ))}
    </div>
  )
}

function MonthCard({ month, beds, tenants }) {
  const [open, setOpen] = useState(false)
  const occ = useMemo(
    () => computeDailyOccupancy(month.start, month.endExcl, beds, tenants),
    [month, beds, tenants],
  )
  const { average, lastDay, days } = occ
  if (!average) return null

  return (
    <div className="card overflow-hidden mb-4">
      <div className="card-header flex items-center justify-between">
        <span>{month.label}{month.isCurrent ? ' — Month to date' : ''}</span>
        <span className="text-[11px] font-medium text-ink-faint">{occ.periodDays} day{occ.periodDays === 1 ? '' : 's'} counted</span>
      </div>
      <div className="px-4 pt-4 pb-3">
        <div className="text-[10px] font-bold text-ink-faint uppercase tracking-widest">Occupancy rate (daily weighted average)</div>
        <div className="text-3xl font-extrabold text-navy-500 mt-1">{pct2(average.occupancyPct)}</div>
      </div>
      <div className="table-wrap" style={{ border: 'none', boxShadow: 'none', borderRadius: 0 }}>
        <table>
          <thead>
            <tr>
              <th>Metric</th>
              <th className="text-right">{month.isCurrent ? 'Today' : 'Month-end (last day)'}</th>
              <th className="text-right bg-surface-3">Weighted daily average</th>
            </tr>
          </thead>
          <tbody>
            {ROWS.map(row => (
              <tr key={row.key}>
                <td className={row.bold ? 'font-extrabold' : 'font-medium'}>{row.label}</td>
                <td className={`text-right ${row.bold ? 'font-extrabold' : ''}`}>{row.fmtLast(lastDay[row.key])}</td>
                <td className={`text-right bg-surface-2 font-semibold ${row.bold ? 'font-extrabold text-navy-500' : ''}`}>{row.fmtAvg(average[row.key])}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="px-4 py-3 border-t border-line-subtle">
        <button className="btn-xs blue" onClick={() => setOpen(o => !o)}>
          {open ? 'Hide daily detail' : 'Show daily detail'}
        </button>
        {open && (
          <div className="mt-3">
            <DayStrip days={days} />
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>Date</th>
                    <th className="text-right">Beds occupied</th>
                    <th className="text-right">Tenants</th>
                    <th className="text-right">Rooms</th>
                    <th className="text-right">Revenue</th>
                    <th className="text-right">Occupancy %</th>
                  </tr>
                </thead>
                <tbody>
                  {days.map(d => (
                    <tr key={d.date}>
                      <td className="font-medium">{d.date}</td>
                      <td className="text-right">{d.beds}</td>
                      <td className="text-right">{d.tenants}</td>
                      <td className="text-right">{d.rooms}</td>
                      <td className="text-right">{peso(d.revenue)}</td>
                      <td className="text-right">{pct2(d.occupancyPct)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}

export default function Occupancy() {
  const [beds, setBeds] = useState([])
  const [tenants, setTenants] = useState([])
  const [loading, setLoading] = useState(true)
  const { show, ToastEl } = useToast()

  useEffect(() => {
    (async () => {
      try {
        const [b, t] = await Promise.all([fetchBeds(), fetchTenants()])
        setBeds(b); setTenants(t)
      } catch (e) { show(e.message, 'error') }
      setLoading(false)
    })()
  }, [])

  const months = monthsFrom(MIN_MONTH, localISO(new Date()))

  if (loading) return <div className="loading-screen"><div className="spinner" /></div>

  return (
    <div className="page">
      <div className="page-header">
        <div>
          <h1 className="page-title">Occupancy <small>Daily weighted average by month</small></h1>
          <p className="page-sub">
            Rate = average of daily occupancy over all days in the month (a tenant leaving on the 29th only reduces
            the last 2 days), not the month-end reading.
          </p>
        </div>
      </div>

      {months.length === 0 ? (
        <div className="card"><div className="empty"><PieChart size={32} className="mx-auto mb-3 text-ink-faint" />
          <p>Occupancy history starts in September 2026.</p>
        </div></div>
      ) : (
        <>
          {months.map(m => <MonthCard key={m.ym} month={m} beds={beds} tenants={tenants} />)}
          <p className="text-[12px] text-ink-faint">
            Uses today's bed setup (sellable beds exclude removed and out-of-order beds) for every month, and includes
            tenants who have since moved out. Revenue is the sum of each present tenant's monthly rate per day.
          </p>
        </>
      )}
      {ToastEl}
    </div>
  )
}
