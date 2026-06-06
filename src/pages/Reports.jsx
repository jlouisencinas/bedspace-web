import { useState, useEffect, useMemo } from 'react'
import { fetchMonthlyReports, fetchCutoffs, saveManualReport, deleteMonthlyReport } from '../lib/supabase'
import { buildAndSaveSnapshot } from '../lib/snapshot'
import { useToast } from '../components/Toast'

const peso = n => '₱' + Number(n || 0).toLocaleString('en-PH', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
const MO = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec']

const ROWS = [
  { label: 'Occupancy %',       get: r => r.occupancy_pct != null ? `${r.occupancy_pct}%` : '—' },
  { label: 'Occupied beds',     get: r => r.occupied_beds ?? '—' },
  { label: 'Active tenants',    get: r => r.active_tenants ?? '—' },
  { section: 'Collections' },
  { label: 'Rent',              get: r => peso(r.col_rent),     sum: 'col_rent' },
  { label: 'Water',             get: r => peso(r.col_water),    sum: 'col_water' },
  { label: 'Electricity',       get: r => peso(r.col_electric), sum: 'col_electric' },
  { label: 'Add-ons',           get: r => peso(r.col_addons),   sum: 'col_addons' },
  { label: 'Total Collections', get: r => peso(r.col_total),    sum: 'col_total', bold: true },
  { section: 'Utility P&L (variance)' },
  { label: 'Water',             get: r => peso(r.water_variance),    sum: 'water_variance',    signed: true },
  { label: 'Electric',          get: r => peso(r.electric_variance), sum: 'electric_variance', signed: true },
  { label: 'Total variance',    get: r => peso(r.total_variance),    sum: 'total_variance',    signed: true, bold: true },
]

const qOf = (iso) => { const [y, m] = iso.slice(0,10).split('-'); return { y: +y, q: Math.ceil(+m / 3) } }

export default function Reports() {
  const [reports, setReports] = useState([])
  const [cutoffs, setCutoffs] = useState([])
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)
  const [quarter, setQuarter] = useState(null)
  const [editRow, setEditRow] = useState(undefined)   // undefined = closed, null = new, obj = edit
  const { show, ToastEl } = useToast()

  async function load() {
    setLoading(true)
    try {
      const [r, cs] = await Promise.all([fetchMonthlyReports(), fetchCutoffs()])
      setReports(r); setCutoffs(cs)
      if (r.length) {
        const last = qOf(r[r.length - 1].period_date)
        setQuarter(`${last.y}-Q${last.q}`)
      }
    } catch (e) { show(e.message, 'error') }
    setLoading(false)
  }
  useEffect(() => { load() }, [])

  const quarters = useMemo(() => {
    const set = new Set(reports.map(r => { const { y, q } = qOf(r.period_date); return `${y}-Q${q}` }))
    return [...set].sort()
  }, [reports])

  async function snapshotNow() {
    const active = cutoffs.find(c => c.is_active) || cutoffs[0]
    if (!active) { show('No cutoff to snapshot.', 'error'); return }
    setBusy(true)
    try { await buildAndSaveSnapshot(active); await load(); show(`Snapshot saved for ${active.name}.`, 'success') }
    catch (e) { show(e.message, 'error') }
    setBusy(false)
  }

  if (loading) return <div className="loading-screen"><div className="spinner" /></div>

  // Months of the selected quarter
  const [qy, qq] = quarter ? quarter.split('-Q').map(Number) : [null, null]
  const monthsIdx = qq ? [(qq - 1) * 3 + 1, (qq - 1) * 3 + 2, (qq - 1) * 3 + 3] : []
  const monthReports = monthsIdx.map(mi =>
    reports.find(r => { const { y } = qOf(r.period_date); return y === qy && +r.period_date.slice(5, 7) === mi }) || null)
  const present = monthReports.filter(Boolean)

  const qTotal = (field) => present.reduce((s, r) => s + Number(r[field] || 0), 0)
  const varColor = (v) => v < 0 ? '#DC2626' : '#16a34a'

  return (
    <div className="page" style={{ maxWidth: 1000 }}>
      <div className="page-title">Reports <small>Monthly snapshots → quarterly owner view</small></div>

      <div className="toolbar">
        <select value={quarter || ''} onChange={e => setQuarter(e.target.value)}>
          {quarters.length === 0 && <option value="">No snapshots yet</option>}
          {quarters.map(q => { const [y, n] = q.split('-Q'); return <option key={q} value={q}>{`Q${n} ${y}`}</option> })}
        </select>
        <span className="pager-info">{reports.length} month(s) saved</span>
        <button className="btn secondary" style={{ marginLeft: 'auto' }} onClick={() => setEditRow(null)}>+ Manual month</button>
        <button className="btn primary" disabled={busy} onClick={snapshotNow}>
          {busy ? 'Saving…' : '📸 Snapshot current month'}
        </button>
      </div>

      {reports.length === 0 ? (
        <div className="card"><div className="empty"><div className="empty-icon">📊</div>
          <p>No snapshots yet. Click "Snapshot current month", or they're saved automatically when you open a new cutoff.</p>
        </div></div>
      ) : (
        <div className="card" style={{ padding: 0, overflow: 'hidden' }}>
          <div className="card-header">{quarter ? `Q${qq} ${qy}` : ''} — Property, Collections &amp; P&amp;L</div>
          <div className="table-wrap" style={{ border: 'none', boxShadow: 'none', borderRadius: 0 }}>
            <table>
              <thead>
                <tr>
                  <th>Metric</th>
                  {monthsIdx.map((mi, i) => (
                    <th key={mi} style={{ textAlign: 'right' }}>
                      {MO[mi - 1]}{monthReports[i] ? '' : ' ·'}
                    </th>
                  ))}
                  <th style={{ textAlign: 'right', background: '#EEF2F7' }}>Quarter Total</th>
                </tr>
              </thead>
              <tbody>
                {ROWS.map((row, idx) => row.section ? (
                  <tr key={idx} style={{ background: '#F8FAFC' }}>
                    <td colSpan={5} style={{ fontWeight: 800, fontSize: 11, color: '#64748B', textTransform: 'uppercase', letterSpacing: '.5px' }}>{row.section}</td>
                  </tr>
                ) : (
                  <tr key={idx}>
                    <td style={{ fontWeight: row.bold ? 800 : 500 }}>{row.label}</td>
                    {monthReports.map((r, i) => (
                      <td key={i} style={{ textAlign: 'right', fontWeight: row.bold ? 800 : 400,
                        color: r && row.signed ? varColor(Number(r[row.sum])) : '#0f172a' }}>
                        {r ? row.get(r) : '—'}
                      </td>
                    ))}
                    <td style={{ textAlign: 'right', background: '#EEF2F7', fontWeight: 800,
                      color: row.signed ? varColor(qTotal(row.sum)) : '#1B3A8C' }}>
                      {row.sum ? peso(qTotal(row.sum)) : '—'}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* Manage snapshots (edit / delete / backfill) */}
      {reports.length > 0 && (
        <div className="card" style={{ marginTop: 16, padding: '12px 16px' }}>
          <div className="card-header" style={{ padding: 0, border: 'none', marginBottom: 8 }}>All saved months</div>
          {[...reports].sort((a, b) => a.period_date.localeCompare(b.period_date)).map(r => (
            <div key={r.id} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '6px 0', borderBottom: '1px solid #F1F5F9', fontSize: 13 }}>
              <div style={{ flex: 1 }}>
                <strong>{r.period_name || r.period_date?.slice(0, 7)}</strong>
                {r.manual && <span className="badge oor" style={{ marginLeft: 6 }}>manual</span>}
                <span style={{ color: '#94A3B8', marginLeft: 8 }}>Total {peso(r.col_total)} · Variance {peso(r.total_variance)}</span>
              </div>
              <button className="btn-xs blue" onClick={() => setEditRow(r)}>Edit</button>
              <button className="btn-xs red" onClick={async () => {
                if (!window.confirm(`Delete the ${r.period_name || 'snapshot'}?`)) return
                try { await deleteMonthlyReport(r.id); await load(); show('Deleted.', 'success') } catch (e) { show(e.message, 'error') }
              }}>Delete</button>
            </div>
          ))}
        </div>
      )}

      <p style={{ fontSize: 11, color: '#94A3B8', marginTop: 10 }}>
        Snapshots auto-save when you open the next cutoff (re-closing overrides). Use <strong>+ Manual month</strong> to backfill earlier months or <strong>Edit</strong> to override any figure. Quarter columns show the three actual months; money rows total the quarter.
      </p>

      {editRow !== undefined && (
        <ManualReportModal
          initial={editRow}
          onClose={() => setEditRow(undefined)}
          onDone={async () => { setEditRow(undefined); await load(); show('Saved.', 'success') }}
          show={show}
        />
      )}
      {ToastEl}
    </div>
  )
}

// ── Manual snapshot editor (create / backfill / override) ─────────────────────
function ManualReportModal({ initial, onClose, onDone, show }) {
  const [f, setF] = useState(() => ({
    id: initial?.id,
    period_name:   initial?.period_name || '',
    month:         initial?.period_date ? initial.period_date.slice(0, 7) : '',
    occupancy_pct: initial?.occupancy_pct ?? '',
    occupied_beds: initial?.occupied_beds ?? '',
    active_tenants: initial?.active_tenants ?? '',
    col_rent:      initial?.col_rent ?? '',
    col_water:     initial?.col_water ?? '',
    col_electric:  initial?.col_electric ?? '',
    col_addons:    initial?.col_addons ?? '',
    water_variance:    initial?.water_variance ?? '',
    electric_variance: initial?.electric_variance ?? '',
  }))
  const [busy, setBusy] = useState(false)
  const set = (k, v) => setF(s => ({ ...s, [k]: v }))
  const n = v => { const x = parseFloat(v); return isNaN(x) ? 0 : x }
  const colTotal = n(f.col_rent) + n(f.col_water) + n(f.col_electric) + n(f.col_addons)
  const totVar = n(f.water_variance) + n(f.electric_variance)

  async function save() {
    if (!f.period_name.trim() || !f.month) { show('Period name and month are required.', 'error'); return }
    setBusy(true)
    try {
      await saveManualReport({
        id: f.id,
        period_name: f.period_name.trim(), period_date: `${f.month}-01`,
        occupancy_pct: f.occupancy_pct === '' ? null : n(f.occupancy_pct),
        occupied_beds: f.occupied_beds === '' ? null : Math.round(n(f.occupied_beds)),
        active_tenants: f.active_tenants === '' ? null : Math.round(n(f.active_tenants)),
        col_rent: n(f.col_rent), col_water: n(f.col_water), col_electric: n(f.col_electric),
        col_addons: n(f.col_addons), col_total: colTotal,
        water_variance: n(f.water_variance), electric_variance: n(f.electric_variance), total_variance: totVar,
      })
      onDone()
    } catch (e) { show(e.message, 'error'); setBusy(false) }
  }

  const field = (label, k, type = 'number') => (
    <div className="fg"><label>{label}</label>
      <input type={type} step="0.01" value={f[k]} onChange={e => set(k, e.target.value)} /></div>
  )

  return (
    <div className="overlay" onClick={e => e.target === e.currentTarget && onClose()}>
      <div className="modal">
        <div className="modal-head"><h3>{f.id ? 'Edit' : 'Manual'} Monthly Snapshot</h3>
          <button className="btn-close" onClick={onClose}>✕</button></div>
        <div className="modal-body">
          <div className="form-grid">
            <div className="fg"><label>Period Name *</label>
              <input type="text" value={f.period_name} onChange={e => set('period_name', e.target.value)} placeholder="e.g. Mar 2026" /></div>
            <div className="fg"><label>Month *</label>
              <input type="month" value={f.month} onChange={e => set('month', e.target.value)} /></div>
            <div className="form-section">Property</div>
            {field('Occupancy %', 'occupancy_pct')}
            {field('Occupied beds', 'occupied_beds')}
            {field('Active tenants', 'active_tenants')}
            <div className="form-section">Collections</div>
            {field('Rent', 'col_rent')}
            {field('Water', 'col_water')}
            {field('Electricity', 'col_electric')}
            {field('Add-ons', 'col_addons')}
            <div className="form-section">Utility P&amp;L (variance, negative = loss)</div>
            {field('Water variance', 'water_variance')}
            {field('Electric variance', 'electric_variance')}
          </div>
          <div style={{ marginTop: 10, fontSize: 13, color: '#475569', display: 'flex', gap: 20 }}>
            <span>Total Collections: <strong style={{ color: '#1B3A8C' }}>{peso(colTotal)}</strong></span>
            <span>Total Variance: <strong style={{ color: totVar < 0 ? '#DC2626' : '#16a34a' }}>{peso(totVar)}</strong></span>
          </div>
        </div>
        <div className="modal-foot">
          <button className="btn secondary" onClick={onClose}>Cancel</button>
          <button className="btn primary" disabled={busy} onClick={save}>{busy ? 'Saving…' : 'Save snapshot'}</button>
        </div>
      </div>
    </div>
  )
}
