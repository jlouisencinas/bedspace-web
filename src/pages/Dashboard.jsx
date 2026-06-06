import { useState, useEffect } from 'react'
import { Link } from 'react-router-dom'
import {
  fetchBeds, fetchActivityLog, fetchCutoffs, fetchUtilityBill,
  fetchInterimReadings, fetchTenants, fetchAreaReadings,
} from '../lib/supabase'
import { computePnL } from '../lib/pnl'

function fmt(n) {
  return new Intl.NumberFormat('en-PH').format(n)
}

const MO = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec']
// Unambiguous date: "May 31, 2026"
function fmtDate(v) {
  if (!v) return '—'
  const s = String(v).slice(0, 10)
  const [y, m, d] = s.split('-')
  if (!y || !m || !d) return s
  return `${MO[+m - 1]} ${+d}, ${y}`
}

function daysUntil(dateStr) {
  if (!dateStr) return null
  const diff = new Date(dateStr) - new Date()
  return Math.ceil(diff / 86400000)
}

function PnLMini({ label, v }) {
  const c = v < 0 ? '#DC2626' : '#16a34a'
  return (
    <div>
      <div style={{ fontSize: 10, fontWeight: 700, color: '#94A3B8', textTransform: 'uppercase' }}>{label}</div>
      <div style={{ fontSize: 15, fontWeight: 800, color: c }}>
        {v < 0 ? '−' : '+'}₱{Math.abs(v).toLocaleString('en-PH', { maximumFractionDigits: 0 })}
      </div>
    </div>
  )
}

export default function Dashboard() {
  const [beds,     setBeds]     = useState([])
  const [logs,     setLogs]     = useState([])
  const [pnl,      setPnl]      = useState(null)
  const [pnlCut,   setPnlCut]   = useState(null)
  const [loading,  setLoading]  = useState(true)

  async function load() {
    setLoading(true)
    const [b, l] = await Promise.all([fetchBeds(), fetchActivityLog()])
    setBeds(b);  setLogs(l)
    setLoading(false)
    // Utility P&L for the active cutoff (best-effort; won't block the dashboard)
    try {
      const cutoffs = await fetchCutoffs()
      const active = cutoffs.find(c => c.is_active) || cutoffs[0]
      if (active) {
        const [bill, interims, tenants, areas] = await Promise.all([
          fetchUtilityBill(active.id), fetchInterimReadings(active.id), fetchTenants(), fetchAreaReadings(active.id),
        ])
        const areaArr = areas.map(a => ({ ...a, consumption: (Number(a.current_reading) || 0) - (Number(a.previous_reading) || 0) }))
        setPnl(computePnL(active, bill, interims, tenants, areaArr))
        setPnlCut(active.name)
      }
    } catch { /* ignore */ }
  }

  useEffect(() => { load() }, [])

  if (loading) return (
    <div className="loading-screen">
      <div className="spinner" />
      <span style={{ color: '#1B3A8C', fontWeight: 600 }}>Loading…</span>
    </div>
  )

  const leased   = beds.filter(b => b.status === 'LEASED').length
  const vacant   = beds.filter(b => b.status === 'VACANT').length
  const reserved = beds.filter(b => b.status === 'RESERVED').length
  const oor      = beds.filter(b => b.status === 'OUT OF ORDER').length
  const total    = beds.length
  const sellable = total - oor
  const revenue  = beds.filter(b => b.status === 'LEASED')
                       .reduce((s, b) => s + (parseFloat(b.rate || b.default_rate) || 0), 0)
  const occPct   = sellable > 0 ? Math.round((leased / sellable) * 100) : 0

  // ── Property summary (whole-room aware) ─────────────────────────────────────
  // Active tenants = distinct (room + name) among leased beds, so one person
  // holding a whole multi-bed room counts as 1 tenant, while a couple counts as 2.
  const tenantKeys = new Set(
    beds.filter(b => b.status === 'LEASED' && b.tenant_name)
        .map(b => `${b.room_id}|${String(b.tenant_name).trim().toUpperCase()}`)
  )
  const activeTenants = tenantKeys.size

  // Rooms
  const roomIds       = new Set(beds.map(b => b.room_id))
  const occupiedRooms = new Set(
    beds.filter(b => b.status === 'LEASED').map(b => b.room_id)
  ).size
  const totalRooms    = roomIds.size

  // Per room-type breakdown
  const typeMap = {}
  beds.forEach(b => {
    const t = b.room_type || 'Other'
    const e = (typeMap[t] ||= { type: t, total: 0, leased: 0, revenue: 0, tnames: new Set() })
    e.total++
    if (b.status === 'LEASED') {
      e.leased++
      e.revenue += parseFloat(b.rate || b.default_rate) || 0
      if (b.tenant_name) e.tnames.add(`${b.room_id}|${String(b.tenant_name).trim().toUpperCase()}`)
    }
  })
  const byType = Object.values(typeMap)
    .map(e => ({ ...e, tenants: e.tnames.size, pct: e.total ? Math.round((e.leased / e.total) * 100) : 0 }))
    .sort((a, b) => a.type.localeCompare(b.type))

  // Segmented occupancy bar widths (% of sellable)
  const seg = (n) => sellable > 0 ? (n / sellable) * 100 : 0

  // Upcoming move-outs (within 30 days)
  const upcoming = beds
    .filter(b => b.status === 'LEASED' && b.move_out_date)
    .map(b => ({ ...b, days: daysUntil(b.move_out_date) }))
    .filter(b => b.days !== null && b.days >= 0 && b.days <= 30)
    .sort((a, b) => a.days - b.days)

  const recent = logs.slice(0, 8)

  return (
    <div className="page">
      <div className="page-title">Dashboard</div>

      {/* Stats */}
      <div className="stats-grid">
        <div className="stat-card blue">
          <div className="stat-label">Leased / Occupied</div>
          <div className="stat-value">{leased}</div>
          <div className="stat-sub">of {sellable} sellable beds</div>
        </div>
        <div className="stat-card green">
          <div className="stat-label">Vacant</div>
          <div className="stat-value">{vacant}</div>
          <div className="stat-sub">available now</div>
        </div>
        <div className="stat-card amber">
          <div className="stat-label">Reserved</div>
          <div className="stat-value">{reserved}</div>
          <div className="stat-sub">pending move-in</div>
        </div>
        <div className="stat-card">
          <div className="stat-label">Monthly Revenue</div>
          <div className="stat-value" style={{ fontSize: 20 }}>₱{fmt(revenue)}</div>
          <div className="stat-sub">{occPct}% occupancy</div>
        </div>
      </div>

      {/* Occupancy bar */}
      <div className="occ-wrap">
        <div className="occ-header">
          <span>Occupancy Rate</span>
          <span className="occ-pct">{occPct}%</span>
        </div>
        <div className="occ-bg">
          <div className="occ-fill" style={{ width: `${occPct}%` }} />
        </div>
        <div className="occ-legend">
          <span style={{ color: '#2563EB' }}>● Leased ({leased})</span>
          <span style={{ color: '#059669' }}>● Vacant ({vacant})</span>
          <span style={{ color: '#D97706' }}>● Reserved ({reserved})</span>
          {oor > 0 && <span style={{ color: '#94A3B8' }}>● Out of Order ({oor})</span>}
        </div>
      </div>

      {/* Property Summary */}
      <div className="card" style={{ marginBottom: 20 }}>
        <div className="card-header">🏢 Property Summary</div>
        <div style={{ padding: 16 }}>
          {/* KPI tiles */}
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(112px, 1fr))', gap: 10, marginBottom: 18 }}>
            {[
              ['Total Beds',     total,                         '#1B3A8C'],
              ['Sellable',       sellable,                      '#2563EB'],
              ['Occupied Beds',  leased,                        '#2563EB'],
              ['Available',      vacant,                        '#059669'],
              ['Reserved',       reserved,                      '#D97706'],
              ['Out of Order',   oor,                           '#94A3B8'],
              ['Active Tenants', activeTenants,                 '#7C3AED'],
              ['Occupied Rooms', `${occupiedRooms}/${totalRooms}`, '#0F766E'],
            ].map(([label, val, color]) => (
              <div key={label} style={{ border: '1px solid var(--border)', borderTop: `3px solid ${color}`, borderRadius: 10, padding: '10px 12px' }}>
                <div style={{ fontSize: 9, fontWeight: 700, letterSpacing: '.6px', color: '#94A3B8', textTransform: 'uppercase' }}>{label}</div>
                <div style={{ fontSize: 20, fontWeight: 800, color: '#0F172A', lineHeight: 1.1 }}>{val}</div>
              </div>
            ))}
          </div>

          {/* Segmented occupancy bar */}
          <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 12, marginBottom: 6 }}>
            <span style={{ fontWeight: 700, color: '#475569' }}>Bed Occupancy</span>
            <span style={{ fontWeight: 800, color: '#1B3A8C' }}>{occPct}%</span>
          </div>
          <div style={{ display: 'flex', height: 10, borderRadius: 5, overflow: 'hidden', background: '#E2E8F0' }}>
            <div style={{ width: `${seg(leased)}%`,   background: '#2563EB' }} />
            <div style={{ width: `${seg(reserved)}%`, background: '#D97706' }} />
            <div style={{ width: `${seg(vacant)}%`,   background: '#059669' }} />
          </div>

          {/* Per room type */}
          <div style={{ marginTop: 18, marginBottom: 8, fontSize: 11, fontWeight: 800, color: '#64748B', textTransform: 'uppercase', letterSpacing: '.5px' }}>By Room Type</div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 9 }}>
            {byType.map(t => (
              <div key={t.type} style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
                <div style={{ width: 150, fontSize: 12, fontWeight: 600, color: '#0F172A' }}>{t.type}</div>
                <div style={{ flex: 1, minWidth: 80, height: 8, borderRadius: 4, background: '#E2E8F0', overflow: 'hidden' }}>
                  <div style={{ width: `${t.pct}%`, height: '100%', background: '#1B3A8C' }} />
                </div>
                <div style={{ width: 80, textAlign: 'right', fontSize: 12, color: '#475569' }}>{t.leased}/{t.total} beds</div>
                <div style={{ width: 64, textAlign: 'right', fontSize: 11, color: '#64748B' }}>{t.tenants} tenant{t.tenants === 1 ? '' : 's'}</div>
                <div style={{ width: 92, textAlign: 'right', fontSize: 12, fontWeight: 700, color: '#1B3A8C' }}>₱{fmt(t.revenue)}</div>
              </div>
            ))}
          </div>
        </div>
      </div>

      {/* Utility P&L tile */}
      {pnl && (
        <Link to="/utilities" className="card" style={{ display: 'block', padding: 16, marginBottom: 20, textDecoration: 'none', color: 'inherit', borderTop: `3px solid ${pnl.totalVariance < 0 ? '#DC2626' : '#16a34a'}` }}>
          <div style={{ fontSize: 11, fontWeight: 800, color: '#64748B', textTransform: 'uppercase', letterSpacing: '.5px', marginBottom: 8 }}>⚡ Utilities P&amp;L · {pnlCut}</div>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 12 }}>
            <div style={{ display: 'flex', gap: 28, flexWrap: 'wrap' }}>
              <PnLMini label="💧 Water" v={pnl.WATER.variance} />
              <PnLMini label="⚡ Electric" v={pnl.ELECTRIC.variance} />
            </div>
            <div style={{ textAlign: 'right' }}>
              <div style={{ fontSize: 10, fontWeight: 700, color: '#94A3B8', textTransform: 'uppercase' }}>Combined Variance</div>
              <div style={{ fontSize: 22, fontWeight: 800, color: pnl.totalVariance < 0 ? '#DC2626' : '#16a34a' }}>
                {pnl.totalVariance < 0 ? '−' : '+'}₱{Math.abs(pnl.totalVariance).toLocaleString('en-PH', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} {pnl.totalVariance < 0 ? '🔴' : '🟢'}
              </div>
            </div>
          </div>
        </Link>
      )}

      <div className="dash-2col">
        {/* Upcoming move-outs */}
        <div className="card">
          <div className="card-header">⏰ Upcoming Move-outs (30 days)</div>
          <div className="activity-list">
            {upcoming.length === 0
              ? <div className="empty"><div className="empty-icon">✅</div><p>No upcoming move-outs</p></div>
              : upcoming.map((b, i) => (
                <div key={i} className="upcoming-item">
                  <div className="upcoming-info">
                    <div className="upcoming-name">{b.tenant_name}</div>
                    <div className="upcoming-room">Room {b.room_no} · Bed {b.bed_letter}</div>
                  </div>
                  <div className="upcoming-date">
                    {b.days === 0 ? 'TODAY' : `in ${b.days}d`}
                    <div style={{ fontWeight: 400, color: '#94A3B8' }}>{fmtDate(b.move_out_date)}</div>
                  </div>
                </div>
              ))}
          </div>
        </div>

        {/* Recent activity */}
        <div className="card">
          <div className="card-header">📋 Recent Activity</div>
          <div className="activity-list">
            {recent.length === 0
              ? <div className="empty"><div className="empty-icon">📋</div><p>No activity yet</p></div>
              : recent.map((r, i) => (
                <div key={i} className="activity-item">
                  <div className={`activity-dot ${r.activity_type === 'Move In' ? 'movein' : 'moveout'}`} />
                  <div className="activity-text">
                    <strong>{r.tenant_name}</strong>
                    <div className="activity-sub">
                      Room {r.room_no} · Bed {r.bed_letter}
                      {r.rate ? ` · ₱${fmt(r.rate)}/mo` : ''}
                    </div>
                  </div>
                  <div className="activity-right">
                    <span className={`badge ${r.activity_type === 'Move In' ? 'movein' : 'moveout'}`}>
                      {r.activity_type}
                    </span>
                    <div className="activity-date">
                      {fmtDate(r.recorded_at)}
                    </div>
                  </div>
                </div>
              ))}
          </div>
        </div>
      </div>
    </div>
  )
}
