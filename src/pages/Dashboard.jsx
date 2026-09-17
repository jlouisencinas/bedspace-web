import { useState, useEffect, useMemo } from 'react'
import { Link } from 'react-router-dom'
import {
  fetchBeds, fetchActivityLog, fetchCutoffs, fetchUtilityBill,
  fetchInterimReadings, fetchTenants, fetchAreaReadings,
  fetchMonthlyReports, fetchActivityLogByType, fetchSplits, fetchAddons,
  fetchPaymentsForCutoff,
} from '../lib/supabase'
import { computePnL } from '../lib/pnl'
import { computeBilling } from '../lib/billing'
import { getCachedBilling, cacheBilling } from '../lib/billingCache'
import { buildPaymentMonitoring, summarizeCollections } from '../lib/collectionsSummary'
import { useAuth } from '../lib/auth'
import RoomMaintenancePanel  from '../components/RoomMaintenancePanel'
import OccupancyYtdChart     from '../components/OccupancyYtdChart'
import {
  BedDouble, Users, PhilippinePeso, Clock,
  CheckCircle2, AlertTriangle, Zap, FileText, Droplets, History,
  TrendingUp, Wallet, LogIn, LogOut as LogOutIcon,
  CalendarClock, BarChart3, PieChart,
} from 'lucide-react'

// ── helpers ───────────────────────────────────────────────────────────────────

const MO = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec']
const SOURCES = ['REFERRAL','FACEBOOK','TIKTOK','INSTAGRAM','WALK_IN']
const SOURCE_LABELS = {
  REFERRAL:  'Referral',
  FACEBOOK:  'Facebook',
  TIKTOK:    'TikTok',
  INSTAGRAM: 'Instagram',
  WALK_IN:   'Walk-In',
}

function fmtDate(v) {
  if (!v) return '—'
  const s = String(v).slice(0,10); const [y,m,d] = s.split('-')
  if (!y||!m||!d) return s
  return `${MO[+m-1]} ${+d}, ${y}`
}
function fmt(n) { return new Intl.NumberFormat('en-PH').format(n) }
function fmtPeso(n) { return '₱' + Number(n || 0).toLocaleString('en-PH', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) }
function daysUntil(dateStr) {
  if (!dateStr) return null
  return Math.ceil((new Date(dateStr) - new Date()) / 86400000)
}
function startOfMonthISO() {
  const d = new Date()
  return new Date(d.getFullYear(), d.getMonth(), 1).toISOString()
}
function monthBounds() {
  const d = new Date()
  const start = new Date(d.getFullYear(), d.getMonth(), 1)
  const end   = new Date(d.getFullYear(), d.getMonth() + 1, 0)
  end.setHours(23, 59, 59, 999)
  return { start, end }
}
function inRange(dateStr, start, end) {
  if (!dateStr) return false
  const d = new Date(dateStr)
  return d >= start && d <= end
}

// ── sub-components ─────────────────────────────────────────────────────────────

function KpiCard({ label, value, sub, icon: Icon, color }) {
  const colors = {
    blue:   { ring: 'bg-info-bg',    icon: 'text-info-text',    bar: 'bg-blue-500'    },
    green:  { ring: 'bg-success-bg', icon: 'text-success-text', bar: 'bg-emerald-500' },
    amber:  { ring: 'bg-warning-bg',   icon: 'text-warning-text',   bar: 'bg-amber-500'   },
    navy:   { ring: 'bg-navy-100',   icon: 'text-navy-500',    bar: 'bg-navy-500'    },
  }
  const c = colors[color] || colors.navy
  return (
    <div className="card p-4 transition-all hover:-translate-y-0.5 hover:shadow-card-lg">
      <div className="flex items-start justify-between mb-3">
        <span className="text-[11px] font-semibold text-ink-faint uppercase tracking-wider">{label}</span>
        <div className={`p-1.5 rounded-lg ${c.ring}`}>
          <Icon size={15} className={c.icon} />
        </div>
      </div>
      <div className="text-[26px] font-bold text-ink leading-none">{value}</div>
      {sub && <div className="text-[11px] text-ink-faint mt-1.5">{sub}</div>}
    </div>
  )
}

function PnLMini({ label, v }) {
  const positive = v >= 0
  return (
    <div>
      <div className="text-[10px] font-semibold text-ink-faint uppercase tracking-wider mb-1 flex items-center gap-1">{label}</div>
      <div className={`text-[15px] font-bold ${positive ? 'text-success-text' : 'text-danger-text'}`}>
        {positive ? '+' : '−'}₱{Math.abs(v).toLocaleString('en-PH', { maximumFractionDigits: 0 })}
      </div>
    </div>
  )
}

// ── main ──────────────────────────────────────────────────────────────────────

export default function Dashboard() {
  const { isAdmin, isUser } = useAuth()
  const canAct = isAdmin || isUser

  const [beds,    setBeds]    = useState([])
  const [logs,    setLogs]    = useState([])
  const [tenants, setTenants] = useState([])
  const [monthlyReports, setMonthlyReports] = useState([])
  const [moveOutChanges, setMoveOutChanges] = useState([])
  const [pnl,     setPnl]     = useState(null)
  const [pnlCut,  setPnlCut]  = useState(null)
  const [activeCutoff,     setActiveCutoff]     = useState(null)
  const [billingPerTenant, setBillingPerTenant] = useState([])
  const [cutoffPayments,   setCutoffPayments]   = useState([])
  const [loading, setLoading] = useState(true)

  async function load() {
    setLoading(true)
    const [b, l, allTenants, reports, moChanges] = await Promise.all([
      fetchBeds(),
      fetchActivityLog(),
      fetchTenants(),
      fetchMonthlyReports(),
      fetchActivityLogByType('Move-out Date Changed', startOfMonthISO()),
    ])
    setBeds(b); setLogs(l); setTenants(allTenants)
    setMonthlyReports(reports); setMoveOutChanges(moChanges)
    setLoading(false)
    try {
      const cutoffs = await fetchCutoffs()
      const active = cutoffs.find(c => c.is_active) || cutoffs[0]
      setActiveCutoff(active || null)
      if (active) {
        const [bill, interims, areas, splits, addons, cutoffPays] = await Promise.all([
          fetchUtilityBill(active.id), fetchInterimReadings(active.id), fetchAreaReadings(active.id),
          fetchSplits(active.id), fetchAddons(active.id), fetchPaymentsForCutoff(active.id),
        ])
        const areaArr = areas.map(a => ({ ...a, consumption: (Number(a.current_reading)||0) - (Number(a.previous_reading)||0) }))
        setPnl(computePnL(active, bill, interims, allTenants, areaArr))
        setPnlCut(active.name)
        setCutoffPayments(cutoffPays)
        if (bill.length) {
          const cached = getCachedBilling(active.id)
          if (cached) {
            setBillingPerTenant(cached)
          } else {
            const { perTenant } = computeBilling(active, bill, interims, allTenants, splits, addons, areaArr)
            cacheBilling(active.id, perTenant)
            setBillingPerTenant(perTenant)
          }
        }
      }
    } catch { /* best-effort */ }
  }

  useEffect(() => { load() }, [])

  const collectionsSummary = useMemo(() => {
    if (!activeCutoff || billingPerTenant.length === 0) return null
    const rows = buildPaymentMonitoring(activeCutoff, tenants, billingPerTenant, cutoffPayments)
    return summarizeCollections(rows)
  }, [activeCutoff, tenants, billingPerTenant, cutoffPayments])

  if (loading) return (
    <div className="loading-screen">
      <div className="spinner" />
      <span className="text-navy-500 font-semibold text-sm">Loading…</span>
    </div>
  )

  const leased   = beds.filter(b => b.status === 'LEASED').length
  const vacant   = beds.filter(b => b.status === 'VACANT').length
  const reserved = beds.filter(b => b.status === 'RESERVED').length
  const oor      = beds.filter(b => b.status === 'OUT OF ORDER').length
  const total    = beds.length
  const sellable = total - oor
  const revenue  = beds.filter(b => b.status === 'LEASED').reduce((s, b) => s + (parseFloat(b.rate||b.default_rate)||0), 0)
  const occPct   = sellable > 0 ? Math.round((leased / sellable) * 100) : 0
  const seg      = n => sellable > 0 ? (n / sellable) * 100 : 0

  const tenantKeys = new Set(
    beds.filter(b => b.status === 'LEASED' && b.tenant_name)
        .map(b => `${b.room_id}|${String(b.tenant_name).trim().toUpperCase()}`)
  )
  const activeTenants = tenantKeys.size
  const roomIds       = new Set(beds.map(b => b.room_id))
  const occupiedRooms = new Set(beds.filter(b => b.status === 'LEASED').map(b => b.room_id)).size
  const totalRooms    = roomIds.size

  const typeMap = {}
  beds.forEach(b => {
    const t = b.room_type || 'Other'
    const e = (typeMap[t] ||= { type: t, total: 0, leased: 0, revenue: 0, tnames: new Set() })
    e.total++
    if (b.status === 'LEASED') {
      e.leased++; e.revenue += parseFloat(b.rate||b.default_rate)||0
      if (b.tenant_name) e.tnames.add(`${b.room_id}|${String(b.tenant_name).trim().toUpperCase()}`)
    }
  })
  const byType = Object.values(typeMap)
    .map(e => ({ ...e, tenants: e.tnames.size, pct: e.total ? Math.round((e.leased/e.total)*100) : 0 }))
    .sort((a, b) => a.type.localeCompare(b.type))

  const upcoming = beds
    .filter(b => b.status === 'LEASED' && b.move_out_date)
    .map(b => ({ ...b, days: daysUntil(b.move_out_date) }))
    .filter(b => b.days !== null && b.days >= 0 && b.days <= 30)
    .sort((a, b) => a.days - b.days)

  const recent = logs.slice(0, 8)

  // ── New monthly metrics (§9/§10) ──────────────────────────────────────────
  const { start: moStart, end: moEnd } = monthBounds()
  const today = new Date(); today.setHours(0, 0, 0, 0)

  const movingOutThisMonth = beds.filter(b =>
    b.status === 'LEASED' && inRange(b.move_out_date, moStart, moEnd)
  ).length

  const moveInsThisMonth = tenants.filter(t => inRange(t.move_in_date, moStart, moEnd)).length

  const mtdProjectedMoveOuts = beds.filter(b =>
    b.status === 'LEASED' && b.move_out_date && new Date(b.move_out_date) >= today && new Date(b.move_out_date) <= moEnd
  ).length

  // Only later-pushing edits count as "extensions" (§9 default assumption).
  const leaseExtensions = moveOutChanges.filter(e => {
    const meta = e.metadata || {}
    return meta.new_move_out_date && meta.old_move_out_date && meta.new_move_out_date > meta.old_move_out_date
  }).length

  // Move-in source breakdown (all tenants, not just currently active — source
  // is assigned at move-in and doesn't change).
  const sourceCounts = SOURCES.map(s => ({
    source: s,
    label:  SOURCE_LABELS[s],
    count:  tenants.filter(t => t.source === s).length,
  }))
  const maxSourceCount = Math.max(1, ...sourceCounts.map(s => s.count))

  // Occupancy YTD — gaps for months with no snapshot, not zero-value bars.
  const currentYear = new Date().getFullYear()
  const occYtdData = monthlyReports
    .filter(r => r.period_date && new Date(r.period_date).getFullYear() === currentYear && r.occupancy_pct != null)
    .sort((a, b) => a.period_date.localeCompare(b.period_date))
    .map(r => ({ month: MO[new Date(r.period_date).getMonth()], occupancy_pct: Number(r.occupancy_pct) }))

  return (
    <div className="page">
      {/* ── Header ── */}
      <div className="mb-6">
        <h1 className="page-title">Dashboard</h1>
        <p className="page-sub">Your Property at a Glance</p>
      </div>

      {/* ── KPI Cards ── */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4 mb-5">
        <KpiCard label="Occupied Beds"   value={leased}              sub={`of ${sellable} sellable`}      icon={BedDouble}   color="blue"  />
        <KpiCard label="Vacant"          value={vacant}              sub="available now"                  icon={CheckCircle2} color="green" />
        <KpiCard label="Reserved"        value={reserved}            sub="pending move-in"                icon={Clock}       color="amber" />
        <KpiCard label="Monthly Revenue" value={`₱${fmt(revenue)}`} sub={`${occPct}% occupancy`}         icon={PhilippinePeso}  color="navy"  />
      </div>

      {/* ── Monthly metrics (§9/§10) ── */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4 mb-5">
        <KpiCard label="Moving Out This Month"    value={movingOutThisMonth}    sub="active tenants"          icon={LogOutIcon}    color="amber" />
        <KpiCard label="Move-ins This Month"      value={moveInsThisMonth}      sub="all move-ins"            icon={LogIn}         color="blue"  />
        <KpiCard label="Lease Extensions"         value={leaseExtensions}       sub="this month"              icon={CalendarClock} color="green" />
        <KpiCard label="MTD Projected Move-outs"  value={mtdProjectedMoveOuts}  sub="remainder of month"      icon={AlertTriangle} color="navy"  />
      </div>

      {/* ── Occupancy Bar ── */}
      <div className="card p-5 mb-5">
        <div className="flex items-center justify-between mb-3">
          <div>
            <div className="text-[13px] font-semibold text-ink-secondary">Bed Occupancy</div>
            <div className="text-[11px] text-ink-faint mt-0.5">{activeTenants} active tenants · {occupiedRooms}/{totalRooms} rooms occupied</div>
          </div>
          <div className="text-right">
            <div className="text-[24px] font-bold text-navy-500">{occPct}%</div>
          </div>
        </div>
        {/* Segmented bar */}
        <div className="flex h-2.5 rounded-full overflow-hidden bg-surface-3">
          <div className="bg-blue-500 transition-all duration-700" style={{ width: `${seg(leased)}%` }} title={`Leased: ${leased}`} />
          <div className="bg-amber-400 transition-all duration-700" style={{ width: `${seg(reserved)}%` }} title={`Reserved: ${reserved}`} />
          <div className="bg-emerald-400 transition-all duration-700" style={{ width: `${seg(vacant)}%` }} title={`Vacant: ${vacant}`} />
        </div>
        <div className="flex gap-5 mt-2.5">
          {[
            { color: 'bg-blue-500',    label: 'Leased',   n: leased   },
            { color: 'bg-amber-400',   label: 'Reserved', n: reserved },
            { color: 'bg-emerald-400', label: 'Vacant',   n: vacant   },
            ...(oor > 0 ? [{ color: 'bg-slate-300', label: 'Out of Order', n: oor }] : []),
          ].map(({ color, label, n }) => (
            <div key={label} className="flex items-center gap-1.5 text-[11px] font-medium text-ink-muted">
              <span className={`w-2 h-2 rounded-full ${color}`} />
              {label} ({n})
            </div>
          ))}
        </div>
      </div>

      {/* ── Occupancy YTD + Move-in Source ── */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4 mb-5">
        <div className="card p-5">
          <div className="text-[11px] font-bold text-ink-faint uppercase tracking-widest mb-3 flex items-center gap-2">
            <BarChart3 size={12} /> Occupancy Rate YTD
          </div>
          <OccupancyYtdChart data={occYtdData} />
        </div>

        <div className="card p-5">
          <div className="text-[11px] font-bold text-ink-faint uppercase tracking-widest mb-3 flex items-center gap-2">
            <PieChart size={12} /> Move-in Source Breakdown
          </div>
          <div className="space-y-3">
            {sourceCounts.map(s => (
              <div key={s.source} className="flex items-center gap-3">
                <div className="w-20 text-[12px] font-medium text-ink-secondary truncate">{s.label}</div>
                <div className="flex-1 h-1.5 bg-surface-3 rounded-full overflow-hidden">
                  <div className="h-full bg-navy-500 rounded-full transition-all duration-500" style={{ width: `${(s.count / maxSourceCount) * 100}%` }} />
                </div>
                <div className="text-[12px] font-semibold text-ink-muted w-8 text-right">{s.count}</div>
              </div>
            ))}
          </div>
        </div>
      </div>

      {/* ── Property summary ── */}
      <div className="card mb-5">
        <div className="px-5 py-3.5 border-b border-line-subtle flex items-center justify-between">
          <span className="text-[11px] font-bold text-ink-faint uppercase tracking-widest">Property Summary</span>
        </div>
        <div className="p-5">
          <div className="grid grid-cols-4 sm:grid-cols-8 gap-3 mb-5">
            {[
              ['Total Beds',    total,                            'text-navy-500'],
              ['Sellable',      sellable,                         'text-info-text'],
              ['Occupied',      leased,                           'text-info-text'],
              ['Available',     vacant,                           'text-success-text'],
              ['Reserved',      reserved,                         'text-warning-text'],
              ['Out of Order',  oor,                              'text-ink-faint'],
              ['Tenants',       activeTenants,                    'text-navy-500'],
              ['Rooms',         `${occupiedRooms}/${totalRooms}`, 'text-ink-secondary'],
            ].map(([label, val, cls]) => (
              <div key={label} className="text-center">
                <div className={`text-[20px] font-bold ${cls}`}>{val}</div>
                <div className="text-[10px] font-semibold text-ink-faint uppercase tracking-wider mt-0.5 leading-tight">{label}</div>
              </div>
            ))}
          </div>

          {byType.length > 0 && (
            <>
              <div className="text-[10px] font-bold text-ink-faint uppercase tracking-widest mb-3">By Room Type</div>
              <div className="space-y-3">
                {byType.map(t => (
                  <div key={t.type} className="flex items-center gap-3">
                    <div className="w-36 text-[12px] font-medium text-ink-secondary truncate">{t.type}</div>
                    <div className="flex-1 h-1.5 bg-surface-3 rounded-full overflow-hidden">
                      <div className="h-full bg-navy-500 rounded-full transition-all duration-500" style={{ width: `${t.pct}%` }} />
                    </div>
                    <div className="text-[11px] text-ink-faint w-20 text-right">{t.leased}/{t.total} beds</div>
                    <div className="text-[11px] font-semibold text-ink-muted w-20 text-right">{t.tenants}t</div>
                    <div className="text-[12px] font-bold text-navy-500 w-24 text-right">₱{fmt(t.revenue)}</div>
                  </div>
                ))}
              </div>
            </>
          )}
        </div>
      </div>

      {/* ── Utility P&L ── */}
      {pnl && (
        <Link
          to="/utilities"
          className={`card block p-5 mb-5 hover:shadow-card-lg transition-shadow border-t-[3px] ${pnl.totalVariance < 0 ? 'border-t-red-600' : 'border-t-emerald-600'}`}
        >
          <div className="text-[10px] font-bold text-ink-faint uppercase tracking-widest mb-3 flex items-center gap-2">
            <Zap size={12} /> Utilities P&amp;L · {pnlCut}
          </div>
          <div className="flex justify-between items-center flex-wrap gap-4">
            <div className="flex gap-8">
              <PnLMini label={<span className="flex items-center gap-1"><Droplets size={11} /> Water</span>}    v={pnl.WATER.variance}    />
              <PnLMini label={<span className="flex items-center gap-1"><Zap size={11} /> Electric</span>}     v={pnl.ELECTRIC.variance} />
            </div>
            <div className="text-right">
              <div className="text-[10px] font-semibold text-ink-faint uppercase tracking-wider">Combined Variance</div>
              <div className={`text-[22px] font-bold mt-0.5 ${pnl.totalVariance < 0 ? 'text-danger-text' : 'text-success-text'}`}>
                {pnl.totalVariance < 0 ? '−' : '+'}₱{Math.abs(pnl.totalVariance).toLocaleString('en-PH', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
              </div>
            </div>
          </div>
        </Link>
      )}

      {/* ── Projected vs. Actual Collections ── */}
      <Link
        to="/payment-monitoring"
        className="card block p-5 mb-5 hover:shadow-card-lg transition-shadow border-t-[3px] border-t-navy-500"
      >
        <div className="text-[10px] font-bold text-ink-faint uppercase tracking-widest mb-3 flex items-center gap-2">
          <TrendingUp size={12} /> Projected vs. Actual Collections {activeCutoff ? `· ${activeCutoff.name}` : ''}
        </div>
        {!activeCutoff ? (
          <div className="empty py-4">
            <Wallet size={28} className="mx-auto mb-2 text-ink-faint" />
            <p>No active cutoff. Open one in Utilities first.</p>
          </div>
        ) : !collectionsSummary ? (
          <p className="text-[13px] text-ink-faint">No billing data yet for this cutoff.</p>
        ) : (
          <div className="flex justify-between items-center flex-wrap gap-4">
            <div className="flex gap-8">
              <div>
                <div className="text-[10px] font-semibold text-ink-faint uppercase tracking-wider mb-1">Billed</div>
                <div className="text-[15px] font-bold text-ink">{fmtPeso(collectionsSummary.totalBilled)}</div>
              </div>
              <div>
                <div className="text-[10px] font-semibold text-ink-faint uppercase tracking-wider mb-1">Paid</div>
                <div className="text-[15px] font-bold text-success-text">{fmtPeso(collectionsSummary.totalPaid)}</div>
              </div>
              <div>
                <div className="text-[10px] font-semibold text-ink-faint uppercase tracking-wider mb-1">Outstanding</div>
                <div className="text-[15px] font-bold text-danger-text">{fmtPeso(collectionsSummary.totalOutstanding)}</div>
              </div>
            </div>
            <div className="text-right">
              <div className="text-[10px] font-semibold text-ink-faint uppercase tracking-wider">Collected</div>
              <div className="text-[22px] font-bold mt-0.5 text-navy-600">{collectionsSummary.pctCollected}%</div>
              <div className="text-[11px] text-ink-faint">{collectionsSummary.unpaidCount}/{collectionsSummary.tenantCount} unpaid</div>
            </div>
          </div>
        )}
      </Link>

      {/* ── Room Maintenance ── */}
      {canAct && (
        <div className="mb-5">
          <RoomMaintenancePanel />
        </div>
      )}

      {/* ── Two-column: Upcoming + Recent ── */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        {/* Upcoming move-outs */}
        <div className="card">
          <div className="px-5 py-3.5 border-b border-line-subtle flex items-center gap-2">
            <AlertTriangle size={13} className="text-amber-500" />
            <span className="text-[11px] font-bold text-ink-faint uppercase tracking-widest">Upcoming Move-outs</span>
            <span className="ml-auto text-[10px] font-semibold text-ink-faint">next 30 days</span>
          </div>
          <div>
            {upcoming.length === 0 ? (
              <div className="empty"><CheckCircle2 size={32} className="mx-auto mb-3 text-emerald-400 opacity-70" /><p>No upcoming move-outs</p></div>
            ) : upcoming.map((b, i) => (
              <div key={i} className="upcoming-item">
                <div className="upcoming-info">
                  <div className="upcoming-name">{b.tenant_name}</div>
                  <div className="upcoming-room">Room {b.room_no} · Bed {b.bed_letter}</div>
                </div>
                <div className="upcoming-date">
                  {b.days === 0 ? (
                    <span className="text-danger-text">TODAY</span>
                  ) : (
                    `in ${b.days}d`
                  )}
                  <div className="text-ink-faint font-normal mt-0.5">{fmtDate(b.move_out_date)}</div>
                </div>
              </div>
            ))}
          </div>
        </div>

        {/* Recent activity */}
        <div className="card">
          <div className="px-5 py-3.5 border-b border-line-subtle flex items-center gap-2">
            <History size={13} className="text-ink-faint" />
            <span className="text-[11px] font-bold text-ink-faint uppercase tracking-widest">Recent Activity</span>
          </div>
          <div>
            {recent.length === 0 ? (
              <div className="empty"><FileText size={32} className="mx-auto mb-3 text-ink-faint" /><p>No activity yet</p></div>
            ) : recent.map((r, i) => (
              <div key={i} className="activity-item">
                <div className={`activity-dot ${r.activity_type === 'Move In' ? 'movein' : 'moveout'} mt-1.5`} />
                <div className="activity-text">
                  <div className="text-[13px] font-semibold text-ink">{r.tenant_name}</div>
                  <div className="activity-sub">
                    Room {r.room_no} · Bed {r.bed_letter}
                    {r.rate ? ` · ₱${fmt(r.rate)}/mo` : ''}
                  </div>
                </div>
                <div className="activity-right">
                  <span className={`badge ${r.activity_type === 'Move In' ? 'movein' : 'moveout'}`}>
                    {r.activity_type}
                  </span>
                  <div className="activity-date">{fmtDate(r.recorded_at)}</div>
                </div>
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  )
}
