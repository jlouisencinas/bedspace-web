import { useState, useEffect, useMemo } from 'react'
import {
  fetchCutoffs, fetchUtilityBill, saveReadings, openCutoff, updateCutoff, deleteCutoff,
  fetchInterimReadings, fetchTenants, fetchAreaReadings, upsertAreaReadings,
} from '../lib/supabase'
import { computePnL } from '../lib/pnl'
import { buildAndSaveSnapshot } from '../lib/snapshot'
import { useToast } from '../components/Toast'

const peso = n => '₱' + Number(n || 0).toLocaleString('en-PH', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
const r4   = n => Number(n || 0).toLocaleString('en-PH', { maximumFractionDigits: 4 })

const MONTHS = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec']
function addMonths(iso, n = 1) {
  if (!iso) return ''
  let [y, m, d] = iso.split('-').map(Number)
  let mi = (m - 1) + n
  y += Math.floor(mi / 12); mi = ((mi % 12) + 12) % 12
  const dim = new Date(y, mi + 1, 0).getDate(); if (d > dim) d = dim
  return `${y}-${String(mi + 1).padStart(2, '0')}-${String(d).padStart(2, '0')}`
}
function periodName(iso) {
  if (!iso) return ''
  const [y, m] = iso.split('-').map(Number)
  return `${MONTHS[m - 1]} ${y}`
}

const AREAS = [
  ['Lobby', 'STANDARD'], ['Second Floor', 'STANDARD'],
  ['Roof Deck', 'STANDARD'], ['Commercial', 'BEDSPACE'],
]

export default function Utilities() {
  const [cutoffs, setCutoffs] = useState([])
  const [cutoffId, setCutoffId] = useState(null)
  const [bill, setBill] = useState([])
  const [interims, setInterims] = useState([])
  const [tenants, setTenants] = useState([])
  const [utility, setUtility] = useState('WATER')
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [edits, setEdits] = useState({})           // room_id → current_reading
  const [cfg, setCfg] = useState({})               // cutoff provider/markup/rate fields
  const [areas, setAreas] = useState({})           // `${name}|${utility}` → {previous_reading,current_reading}
  const [showOpen, setShowOpen] = useState(false)
  const { show, ToastEl } = useToast()

  const cutoff = cutoffs.find(c => c.id === cutoffId)
  const readOnly = !!cutoff && !cutoff.is_active

  useEffect(() => {
    fetchCutoffs().then(cs => {
      setCutoffs(cs)
      const active = cs.find(c => c.is_active) || cs[0]
      if (active) setCutoffId(active.id); else setLoading(false)
    }).catch(e => { show(e.message, 'error'); setLoading(false) })
  }, [])

  useEffect(() => {
    if (!cutoffId) return
    setLoading(true)
    Promise.all([
      fetchUtilityBill(cutoffId), fetchInterimReadings(cutoffId), fetchTenants(), fetchAreaReadings(cutoffId),
    ]).then(([b, ir, t, ar]) => {
      b.sort((a, c) => (parseInt(a.room_no) || 0) - (parseInt(c.room_no) || 0))
      setBill(b); setInterims(ir); setTenants(t); setEdits({})
      const c = cutoffs.find(x => x.id === cutoffId) || {}
      setCfg({ ...c })
      const am = {}
      AREAS.forEach(([name, rt]) => ['WATER', 'ELECTRIC'].forEach(u => {
        const found = ar.find(x => x.area_name === name && x.utility === u)
        am[`${name}|${u}`] = {
          previous_reading: found?.previous_reading ?? 0,
          current_reading:  found?.current_reading ?? 0,
          rate_type: rt,
        }
      }))
      setAreas(am)
      setLoading(false)
    }).catch(e => { show(e.message, 'error'); setLoading(false) })
  }, [cutoffId, cutoffs])

  // ── Rate math for a utility from cfg ────────────────────────────────────────
  const calc = (u) => {
    const amt = Number(cfg[`${u}_main_amount`]) || 0
    const cons = Number(cfg[`${u}_main_consumption`]) || 0
    const std = cons > 0 ? amt / cons : 0
    const mk = Number(cfg[`${u}_markup_pct`]) || 0
    const ov = cfg[`${u}_rate_override`]
    const bed = ov ? (Number(cfg[`${u}_bedspace_rate`]) || 0) : std * (1 + mk / 100)
    return { std, bed, mk, ov }
  }
  const uKey = utility === 'WATER' ? 'water' : 'electric'
  const unit = utility === 'WATER' ? 'm³' : 'kWh'
  const { std: stdRate, bed: bedRate, ov: override } = calc(uKey)
  const setF = (k, v) => setCfg(s => ({ ...s, [k]: v }))

  // ── Live cutoff (with unsaved rate edits) for P&L + billing ────────────────
  const liveCutoff = useMemo(() => {
    if (!cutoff) return null
    const w = calc('water'), e = calc('electric')
    return {
      ...cutoff, ...cfg,
      water_maynilad_rate: w.std, water_bedspace_rate: w.bed,
      electric_meralco_rate: e.std, electric_bedspace_rate: e.bed,
    }
  }, [cutoff, cfg])

  const areaArray = useMemo(() => Object.entries(areas).map(([k, v]) => {
    const [area_name, util] = k.split('|')
    return { area_name, utility: util, rate_type: v.rate_type,
             consumption: (Number(v.current_reading) || 0) - (Number(v.previous_reading) || 0) }
  }), [areas])

  const pnl = useMemo(() => {
    if (!liveCutoff || !bill.length) return null
    return computePnL(liveCutoff, bill, interims, tenants, areaArray)
  }, [liveCutoff, bill, interims, tenants, areaArray])

  // ── Room rows for the active utility ────────────────────────────────────────
  const rows = useMemo(() => bill.map(rr => {
    const prev = utility === 'WATER' ? rr.water_prev : rr.elec_prev
    const saved = utility === 'WATER' ? rr.water_curr : rr.elec_curr
    const curr = edits[rr.room_id] !== undefined ? edits[rr.room_id] : (saved ?? '')
    const cons = curr === '' ? null : (Number(curr) - (Number(prev) || 0))
    return { ...rr, prev: Number(prev) || 0, curr, cons, amount: cons == null ? null : cons * bedRate }
  }), [bill, edits, utility, bedRate])

  const totals = useMemo(() => rows.reduce((t, r) => ({
    cons: t.cons + (r.cons || 0), amount: t.amount + (r.amount || 0),
  }), { cons: 0, amount: 0 }), [rows])

  // ── Save ────────────────────────────────────────────────────────────────────
  async function handleSave() {
    setSaving(true)
    try {
      const w = calc('water'), e = calc('electric')
      await updateCutoff(cutoffId, {
        water_main_prev: numOrNull(cfg.water_main_prev), water_main_curr: numOrNull(cfg.water_main_curr),
        water_main_consumption: numOrNull(cfg.water_main_consumption), water_main_amount: numOrNull(cfg.water_main_amount),
        water_markup_pct: Number(cfg.water_markup_pct) || 0, water_rate_override: !!cfg.water_rate_override,
        water_maynilad_rate: w.std, water_bedspace_rate: w.bed,
        electric_main_prev: numOrNull(cfg.electric_main_prev), electric_main_curr: numOrNull(cfg.electric_main_curr),
        electric_main_consumption: numOrNull(cfg.electric_main_consumption), electric_main_amount: numOrNull(cfg.electric_main_amount),
        electric_markup_pct: Number(cfg.electric_markup_pct) || 0, electric_rate_override: !!cfg.electric_rate_override,
        electric_meralco_rate: e.std, electric_bedspace_rate: e.bed,
      })
      // room readings for the active utility (rate = bedspace)
      await saveReadings(rows.map(r => ({
        cutoff_id: cutoffId, room_id: r.room_id, utility,
        previous_reading: r.prev, current_reading: r.curr === '' ? r.prev : Number(r.curr), rate: bedRate,
      })))
      // common-area readings (both utilities)
      await upsertAreaReadings(Object.entries(areas).map(([k, v]) => {
        const [area_name, util] = k.split('|')
        return { cutoff_id: cutoffId, area_name, utility: util, rate_type: v.rate_type,
                 previous_reading: Number(v.previous_reading) || 0, current_reading: Number(v.current_reading) || 0 }
      }))
      show('Saved.', 'success')
      const cs = await fetchCutoffs(); setCutoffs(cs)
      const fresh = await fetchUtilityBill(cutoffId); fresh.sort((a, c) => (parseInt(a.room_no) || 0) - (parseInt(c.room_no) || 0))
      setBill(fresh); setEdits({})
    } catch (e) { show(e.message, 'error') }
    setSaving(false)
  }

  function numOrNull(v) { return v === '' || v == null ? null : Number(v) }

  async function handleDeleteCutoff() {
    if (!cutoff || cutoffs.length <= 1) { show('Cannot delete the only cutoff.', 'error'); return }
    if (!window.confirm(`Delete cutoff "${cutoff.name}"?\n\nThis permanently removes its meter readings, common-area readings, custom splits, and one-time add-ons. This cannot be undone.`)) return
    try {
      await deleteCutoff(cutoffId)
      const cs = await fetchCutoffs(); setCutoffs(cs)
      const active = cs.find(c => c.is_active) || cs[0]
      setCutoffId(active ? active.id : null)
      show('Cutoff deleted.', 'success')
    } catch (e) { show(e.message, 'error') }
  }

  if (loading && !cutoffs.length) return <Spin />
  if (!cutoffs.length) return (
    <div className="page"><div className="page-title">Utilities</div>
      <div className="card"><div className="empty"><div className="empty-icon">⚡</div>
        <p>No cutoffs yet.</p>
        <button className="btn primary" style={{ marginTop: 14 }} onClick={() => setShowOpen(true)}>+ Open New Cutoff</button>
      </div></div>
      {showOpen && <OpenCutoffModal cutoffs={cutoffs} onClose={() => setShowOpen(false)}
        onDone={async id => {
          const prior = cutoffs.find(c => c.is_active)
          if (prior && prior.id !== id) { try { await buildAndSaveSnapshot(prior) } catch (e) { console.error('snapshot failed', e) } }
          const cs = await fetchCutoffs(); setCutoffs(cs); setCutoffId(id); setShowOpen(false)
          show(prior ? 'Cutoff opened — prior month snapshotted.' : 'Cutoff opened.', 'success')
        }} show={show} />}
      {ToastEl}
    </div>
  )

  const win = cutoff ? (utility === 'WATER'
    ? `${cutoff.water_start} → ${cutoff.water_end}` : `${cutoff.electric_start} → ${cutoff.electric_end}`) : ''
  const accent = utility === 'WATER' ? '#2563EB' : '#D97706'

  return (
    <div className="page" style={{ maxWidth: 1180 }}>
      <div className="page-title">Utilities <small>Readings, rates &amp; P&amp;L</small></div>

      {/* Controls */}
      <div className="toolbar">
        <select value={cutoffId || ''} onChange={e => setCutoffId(Number(e.target.value))}>
          {cutoffs.map(c => <option key={c.id} value={c.id}>{c.name}{c.is_active ? ' (active)' : ''}</option>)}
        </select>
        <div style={{ display: 'flex', border: '1px solid var(--border)', borderRadius: 10, overflow: 'hidden' }}>
          {['WATER', 'ELECTRIC'].map(u => (
            <button key={u} onClick={() => setUtility(u)} style={{
              padding: '8px 18px', border: 'none', fontSize: 13, fontWeight: 700,
              background: utility === u ? (u === 'WATER' ? '#2563EB' : '#D97706') : '#fff',
              color: utility === u ? '#fff' : '#64748B',
            }}>{u === 'WATER' ? '💧 Water' : '⚡ Electric'}</button>
          ))}
        </div>
        <span className="pager-info">{win}</span>
        {readOnly && <span className="badge oor" style={{ alignSelf: 'center' }}>🔒 read-only</span>}
        <button className="btn secondary" style={{ marginLeft: 'auto' }} onClick={() => setShowOpen(true)}>+ Open New Cutoff</button>
        {cutoffs.length > 1 && <button className="btn danger" onClick={handleDeleteCutoff} title="Undo / delete this cutoff">🗑 Delete cutoff</button>}
        {!readOnly && <button className="btn primary" disabled={saving} onClick={handleSave}>{saving ? 'Saving…' : '💾 Save All'}</button>}
      </div>

      {/* Provider line & rate */}
      <div className="card" style={{ padding: 16, marginBottom: 14 }}>
        <div style={{ fontSize: 11, fontWeight: 800, color: '#64748B', textTransform: 'uppercase', letterSpacing: '.5px', marginBottom: 10 }}>
          {utility === 'WATER' ? 'Maynilad' : 'MERALCO'} Main Line &amp; Rate
        </div>
        <div style={{ display: 'flex', gap: 14, flexWrap: 'wrap', alignItems: 'flex-end' }}>
          {[['Prev', `${uKey}_main_prev`], ['Current', `${uKey}_main_curr`], ['Consumption', `${uKey}_main_consumption`], ['Bill Amount (₱)', `${uKey}_main_amount`]].map(([lbl, k]) => (
            <div className="fg" key={k} style={{ maxWidth: 130 }}>
              <label>{lbl}</label>
              <input type="number" step="0.01" value={cfg[k] ?? ''} disabled={readOnly}
                onChange={e => setF(k, e.target.value)} />
            </div>
          ))}
          <div style={{ padding: '0 6px 6px' }}>
            <div style={{ fontSize: 10, color: '#94A3B8', fontWeight: 700, textTransform: 'uppercase' }}>Standard rate</div>
            <div style={{ fontSize: 18, fontWeight: 800, color: '#0F172A' }}>₱{r4(stdRate)}<span style={{ fontSize: 11, color: '#94A3B8' }}>/{unit}</span></div>
          </div>
          <div className="fg" style={{ maxWidth: 90 }}>
            <label>Markup %</label>
            <input type="number" step="0.1" value={cfg[`${uKey}_markup_pct`] ?? ''} disabled={readOnly || override}
              onChange={e => setF(`${uKey}_markup_pct`, e.target.value)} />
          </div>
          <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12, color: '#475569', paddingBottom: 8 }}>
            <input type="checkbox" checked={!!override} disabled={readOnly}
              onChange={e => setF(`${uKey}_rate_override`, e.target.checked)} /> manual
          </label>
          <div className="fg" style={{ maxWidth: 130 }}>
            <label style={{ color: accent }}>Bedspace rate</label>
            <input type="number" step="0.0001" value={override ? (cfg[`${uKey}_bedspace_rate`] ?? '') : Number(bedRate.toFixed(4))}
              disabled={readOnly || !override}
              onChange={e => setF(`${uKey}_bedspace_rate`, e.target.value)} />
          </div>
        </div>
        <div style={{ fontSize: 11, color: '#94A3B8', marginTop: 8 }}>
          Standard = Bill ÷ Consumption · Bedspace = Standard × (1 + Markup%){override ? ' — manual override on' : ''}. The main line is the direct provider meter (≠ sum of room sub-meters).
        </div>
      </div>

      {/* Utility P&L */}
      {pnl && <PnLCard pnl={pnl[utility]} utility={utility} />}

      {/* Common areas */}
      <div className="card" style={{ padding: 16, marginBottom: 14 }}>
        <div style={{ fontSize: 11, fontWeight: 800, color: '#64748B', textTransform: 'uppercase', letterSpacing: '.5px', marginBottom: 10 }}>Common Areas — {utility === 'WATER' ? 'Water' : 'Electric'}</div>
        <div className="table-wrap">
          <table><thead><tr>
            <th>Area</th><th>Rate</th><th>Prev</th><th>Current</th>
            <th style={{ textAlign: 'right' }}>Consumption</th><th style={{ textAlign: 'right' }}>Amount</th>
          </tr></thead><tbody>
            {AREAS.map(([name, rt]) => {
              const key = `${name}|${utility}`; const a = areas[key] || {}
              const cons = (Number(a.current_reading) || 0) - (Number(a.previous_reading) || 0)
              const rate = rt === 'BEDSPACE' ? bedRate : stdRate
              const setA = (f, v) => setAreas(s => ({ ...s, [key]: { ...s[key], rate_type: rt, [f]: v } }))
              return (
                <tr key={name}>
                  <td><strong>{name}</strong></td>
                  <td><span className="badge" style={{ background: rt === 'BEDSPACE' ? '#EFF6FF' : '#F1F5F9', color: rt === 'BEDSPACE' ? accent : '#64748B' }}>{rt === 'BEDSPACE' ? 'Bedspace' : 'Standard'}</span></td>
                  <td><input type="number" step="0.01" value={a.previous_reading ?? 0} disabled={readOnly} onChange={e => setA('previous_reading', e.target.value)} style={inp} /></td>
                  <td><input type="number" step="0.01" value={a.current_reading ?? 0} disabled={readOnly} onChange={e => setA('current_reading', e.target.value)} style={inp} /></td>
                  <td style={{ textAlign: 'right' }}>{cons}</td>
                  <td className="td-rate" style={{ textAlign: 'right' }}>{peso(cons * rate)}</td>
                </tr>
              )
            })}
          </tbody></table>
        </div>
        <div style={{ fontSize: 11, color: '#94A3B8', marginTop: 6 }}>Lobby / 2nd Floor / Roof Deck = standard (overhead). Commercial = bedspace (separate billing, pending).</div>
      </div>

      {/* Room readings */}
      {loading ? <Spin h={160} /> : (
        <div className="table-wrap">
          <table><thead><tr>
            <th>Room</th><th>Type</th><th>Previous</th><th>Current</th><th>Consumption</th>
            <th style={{ textAlign: 'right' }}>Rate</th><th style={{ textAlign: 'right' }}>Amount</th>
          </tr></thead><tbody>
            {rows.map(r => (
              <tr key={r.room_id}>
                <td><strong>{r.room_no}</strong></td>
                <td style={{ fontSize: 11, color: '#64748B' }}>{r.room_type}</td>
                <td>{Math.round(r.prev)}</td>
                <td>{readOnly ? <span style={{ fontWeight: 600 }}>{r.curr === '' ? '—' : r.curr}</span>
                  : <input type="number" step="0.01" value={r.curr} onChange={e => setEdits(ed => ({ ...ed, [r.room_id]: e.target.value }))} style={inp} />}</td>
                <td style={{ fontWeight: 600, color: r.cons < 0 ? '#DC2626' : '#0F172A' }}>{r.cons == null ? '—' : r.cons}</td>
                <td style={{ fontSize: 12, color: '#64748B', textAlign: 'right' }}>{r4(bedRate)}</td>
                <td className="td-rate" style={{ textAlign: 'right' }}>{r.amount == null ? '—' : peso(r.amount)}</td>
              </tr>
            ))}
          </tbody><tfoot>
            <tr style={{ background: '#F8FAFC', borderTop: '2px solid #1B3A8C' }}>
              <td colSpan={4} style={{ fontWeight: 800, color: '#475569', textTransform: 'uppercase', fontSize: 11 }}>Room Totals</td>
              <td style={{ fontWeight: 800 }}>{totals.cons.toLocaleString('en-PH')}</td>
              <td></td>
              <td style={{ fontWeight: 800, color: '#1B3A8C', textAlign: 'right' }}>{peso(totals.amount)}</td>
            </tr>
          </tfoot></table>
        </div>
      )}

      {showOpen && <OpenCutoffModal cutoffs={cutoffs} onClose={() => setShowOpen(false)}
        onDone={async id => {
          const prior = cutoffs.find(c => c.is_active)
          if (prior && prior.id !== id) { try { await buildAndSaveSnapshot(prior) } catch (e) { console.error('snapshot failed', e) } }
          const cs = await fetchCutoffs(); setCutoffs(cs); setCutoffId(id); setShowOpen(false)
          show(prior ? 'Cutoff opened — prior month snapshotted.' : 'Cutoff opened.', 'success')
        }} show={show} />}
      {ToastEl}
    </div>
  )
}

const inp = { width: 90, padding: '5px 8px', border: '1px solid var(--border)', borderRadius: 6, fontSize: 13 }
function Spin({ h }) { return <div className="loading-screen" style={h ? { height: h } : {}}><div className="spinner" /></div> }

// ── P&L card ──────────────────────────────────────────────────────────────────
function PnLCard({ pnl, utility }) {
  const losing = pnl.variance < 0
  const color = losing ? '#DC2626' : '#16a34a'
  const row = (label, val, c) => (
    <div style={{ display: 'flex', justifyContent: 'space-between', padding: '4px 0', fontSize: 13 }}>
      <span style={{ color: '#475569' }}>{label}</span><span style={{ fontWeight: 700, color: c || '#0F172A' }}>{val}</span>
    </div>
  )
  return (
    <div className="card" style={{ padding: 16, marginBottom: 14, borderTop: `3px solid ${color}` }}>
      <div style={{ fontSize: 11, fontWeight: 800, color: '#64748B', textTransform: 'uppercase', letterSpacing: '.5px', marginBottom: 8 }}>
        {utility === 'WATER' ? '💧 Water' : '⚡ Electric'} P&amp;L
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '0 28px' }}>
        <div>
          {row('Provider cost', peso(pnl.cost), '#DC2626')}
          {row('Room collections', peso(pnl.roomCollections), '#16a34a')}
        </div>
        <div>
          {row('Overhead (standard)', peso(pnl.overhead))}
          {row('Commercial (pending)', peso(pnl.commercial), '#94A3B8')}
        </div>
      </div>
      <div style={{ borderTop: '1px solid var(--border)', marginTop: 8, paddingTop: 8, display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <span style={{ fontWeight: 800, textTransform: 'uppercase', fontSize: 12, color: '#475569' }}>Variance</span>
        <span style={{ fontWeight: 800, fontSize: 18, color }}>{losing ? '−' : '+'}{peso(Math.abs(pnl.variance))} {losing ? '🔴 losing' : '🟢 earning'}</span>
      </div>
    </div>
  )
}

// ── Open New Cutoff modal ───────────────────────────────────────────────────────
function OpenCutoffModal({ cutoffs, onClose, onDone, show }) {
  const last = cutoffs[0]
  const sW = last?.water_end || '', sE = last?.electric_end || ''
  const [f, setF] = useState({
    name: periodName(sW), water_start: sW, water_end: addMonths(sW, 1),
    electric_start: sE, electric_end: addMonths(sE, 1),
    water_bedspace_rate: last?.water_bedspace_rate ?? 0, electric_bedspace_rate: last?.electric_bedspace_rate ?? 0,
  })
  const [busy, setBusy] = useState(false)
  const set = (k, v) => setF(s => ({ ...s, [k]: v }))
  const onW = v => setF(s => ({ ...s, water_start: v, water_end: addMonths(v, 1), name: periodName(v) }))
  const onE = v => setF(s => ({ ...s, electric_start: v, electric_end: addMonths(v, 1) }))

  async function submit(e) {
    e.preventDefault()
    if (!f.name || !f.water_start || !f.electric_start) { show('Fill name + both start dates.', 'error'); return }
    setBusy(true)
    try {
      const id = await openCutoff({
        name: f.name, water_start: f.water_start, water_end: f.water_end,
        electric_start: f.electric_start, electric_end: f.electric_end,
        water_maynilad_rate: 0, water_bedspace_rate: Number(f.water_bedspace_rate),
        electric_meralco_rate: 0, electric_bedspace_rate: Number(f.electric_bedspace_rate),
      })
      onDone(id)
    } catch (e) { show(e.message, 'error'); setBusy(false) }
  }
  const ro = { fontSize: 9, color: '#94A3B8', fontWeight: 600 }
  return (
    <div className="overlay" onClick={e => e.target === e.currentTarget && onClose()}>
      <div className="modal modal-sm">
        <div className="modal-head"><h3>⚡ Open New Cutoff</h3><button className="btn-close" onClick={onClose}>✕</button></div>
        <form onSubmit={submit}>
          <div className="modal-body">
            <div className="form-grid">
              <div className="fg full"><label>Period Name *</label><input type="text" value={f.name} onChange={e => set('name', e.target.value)} required /></div>
              <div className="form-section">💧 Water window</div>
              <div className="fg"><label>Start *</label><input type="date" value={f.water_start} onChange={e => onW(e.target.value)} /></div>
              <div className="fg"><label>End <span style={ro}>(auto +1mo)</span></label><input type="date" value={f.water_end} disabled style={{ background: '#F8FAFC' }} /></div>
              <div className="form-section">⚡ Electric window</div>
              <div className="fg"><label>Start *</label><input type="date" value={f.electric_start} onChange={e => onE(e.target.value)} /></div>
              <div className="fg"><label>End <span style={ro}>(auto +1mo)</span></label><input type="date" value={f.electric_end} disabled style={{ background: '#F8FAFC' }} /></div>
            </div>
            <p style={{ fontSize: 11, color: '#94A3B8', marginTop: 12 }}>Previous readings carry forward. Enter the provider main line + markup after opening to set rates.</p>
          </div>
          <div className="modal-foot">
            <button type="button" className="btn secondary" onClick={onClose}>Cancel</button>
            <button type="submit" className="btn primary" disabled={busy}>{busy ? 'Opening…' : '✓ Open Cutoff'}</button>
          </div>
        </form>
      </div>
    </div>
  )
}
