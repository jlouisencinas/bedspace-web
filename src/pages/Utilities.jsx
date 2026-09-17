import { useState, useEffect, useMemo } from 'react'
import {
  fetchCutoffs, fetchUtilityBill, saveReadings, openCutoff, updateCutoff, deleteCutoff,
  fetchInterimReadings, fetchTenants, fetchAreaReadings, upsertAreaReadings,
} from '../lib/supabase'
import { computePnL } from '../lib/pnl'
import { buildAndSaveSnapshot } from '../lib/snapshot'
import { useToast } from '../components/Toast'
import { Save, Trash2, Lock, Droplets, Zap, X } from 'lucide-react'

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
      <div className="card"><div className="empty"><Zap size={32} className="mx-auto mb-3 text-ink-faint" />
        <p>No cutoffs yet.</p>
        <button className="btn primary mt-4" onClick={() => setShowOpen(true)}>+ Open New Cutoff</button>
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
  const accent = utility === 'WATER' ? 'var(--blue)' : 'var(--amber)'

  return (
    <div className="page">
      <div className="page-header">
        <div>
          <h1 className="page-title">Utilities <small>Readings, rates &amp; P&amp;L</small></h1>
          {win && <p className="page-sub">{win}{readOnly && <span className="badge oor ml-2 inline-flex items-center gap-1"><Lock size={10} />read-only</span>}</p>}
        </div>
        <div className="flex gap-2 flex-wrap">
          {!readOnly && <button className="btn primary" disabled={saving} onClick={handleSave}>{saving ? 'Saving…' : <><Save size={14} /> Save All</>}</button>}
          {cutoffs.length > 1 && <button className="btn danger" onClick={handleDeleteCutoff}><Trash2 size={14} /> Delete</button>}
          <button className="btn secondary" onClick={() => setShowOpen(true)}>+ Open Cutoff</button>
        </div>
      </div>

      {/* Controls */}
      <div className="toolbar">
        <select value={cutoffId || ''} onChange={e => setCutoffId(Number(e.target.value))}>
          {cutoffs.map(c => <option key={c.id} value={c.id}>{c.name}{c.is_active ? ' (active)' : ''}</option>)}
        </select>
        <div className="flex gap-1 p-1 bg-surface-3 rounded-lg">
          {['WATER', 'ELECTRIC'].map(u => (
            <button key={u} onClick={() => setUtility(u)}
              className={`px-4 py-1.5 rounded-md text-[12px] font-semibold transition-all inline-flex items-center gap-1 ${
                utility === u
                  ? u === 'WATER' ? 'bg-blue-600 text-white shadow-sm' : 'bg-amber-500 text-white shadow-sm'
                  : 'text-ink-muted hover:text-ink-secondary'
              }`}>
              {u === 'WATER' ? <><Droplets size={13} /> Water</> : <><Zap size={13} /> Electric</>}
            </button>
          ))}
        </div>
      </div>

      {/* Provider line & rate */}
      <div className="card p-4 mb-4">
        <div className="text-[10px] font-extrabold text-ink-faint uppercase tracking-widest mb-3">
          {utility === 'WATER' ? 'Maynilad' : 'MERALCO'} Main Line &amp; Rate
        </div>
        <div className="flex gap-4 flex-wrap items-end">
          {[['Prev Reading', `${uKey}_main_prev`], ['Actual Reading', `${uKey}_main_curr`], ['Consumption', `${uKey}_main_consumption`], ['Bill Amount (₱)', `${uKey}_main_amount`]].map(([lbl, k]) => (
            <div className="fg max-w-[130px]" key={k}>
              <label>{lbl}</label>
              <input type="number" step="0.01" value={cfg[k] ?? ''} disabled={readOnly}
                onChange={e => setF(k, e.target.value)} />
            </div>
          ))}
          <div className="pb-1.5 px-1">
            <div className="text-[10px] text-ink-faint font-bold uppercase tracking-wide mb-0.5">Standard rate</div>
            <div className="text-[18px] font-extrabold text-ink">
              ₱{r4(stdRate)}<span className="text-[11px] text-ink-faint">/{unit}</span>
            </div>
          </div>
          <div className="fg max-w-[90px]">
            <label>Markup %</label>
            <input type="number" step="0.1" value={cfg[`${uKey}_markup_pct`] ?? ''} disabled={readOnly || override}
              onChange={e => setF(`${uKey}_markup_pct`, e.target.value)} />
          </div>
          <label className="flex items-center gap-1.5 text-[12px] text-ink-secondary pb-2 cursor-pointer">
            <input type="checkbox" checked={!!override} disabled={readOnly}
              onChange={e => setF(`${uKey}_rate_override`, e.target.checked)} className="w-4 h-4 accent-navy-700" /> manual
          </label>
          <div className="fg max-w-[130px]">
            <label className={utility === 'WATER' ? 'text-info-text' : 'text-warning-text'}>Bedspace rate</label>
            <input type="number" step="0.0001" value={override ? (cfg[`${uKey}_bedspace_rate`] ?? '') : Number(bedRate.toFixed(4))}
              disabled={readOnly || !override}
              onChange={e => setF(`${uKey}_bedspace_rate`, e.target.value)} />
          </div>
        </div>
        <p className="text-[11px] text-ink-faint mt-2 leading-relaxed">
          Standard = Bill ÷ Consumption · Bedspace = Standard × (1 + Markup%){override ? ' — manual override on' : ''}. The main line is the direct provider meter (≠ sum of room sub-meters).
        </p>
      </div>

      {/* Utility P&L */}
      {pnl && <PnLCard pnl={pnl[utility]} utility={utility} />}

      {/* Common areas */}
      <div className="card p-4 mb-4">
        <div className="text-[10px] font-extrabold text-ink-faint uppercase tracking-widest mb-3">
          Common Areas — {utility === 'WATER' ? 'Water' : 'Electric'}
        </div>
        <div className="table-wrap">
          <table><thead><tr>
            <th>Area</th><th>Rate</th><th>Prev Reading</th><th>Actual Reading</th>
            <th className="text-right">Consumption</th><th className="text-right">Amount</th>
          </tr></thead><tbody>
            {AREAS.map(([name, rt]) => {
              const key = `${name}|${utility}`; const a = areas[key] || {}
              const cons = (Number(a.current_reading) || 0) - (Number(a.previous_reading) || 0)
              const rate = rt === 'BEDSPACE' ? bedRate : stdRate
              const setA = (f, v) => setAreas(s => ({ ...s, [key]: { ...s[key], rate_type: rt, [f]: v } }))
              return (
                <tr key={name}>
                  <td><strong>{name}</strong></td>
                  <td>
                    <span className={`badge ${rt === 'BEDSPACE' ? 'bg-info-bg text-info-text' : 'bg-surface-3 text-ink-muted'}`}>
                      {rt === 'BEDSPACE' ? 'Bedspace' : 'Standard'}
                    </span>
                  </td>
                  <td><input type="number" step="0.01" value={a.previous_reading ?? 0} disabled={readOnly} onChange={e => setA('previous_reading', e.target.value)} className="w-24 px-2 py-1 border border-line rounded-md text-[13px] focus:outline-none focus:ring-1 focus:ring-navy-700/25" /></td>
                  <td><input type="number" step="0.01" value={a.current_reading ?? 0} disabled={readOnly} onChange={e => setA('current_reading', e.target.value)} className="w-24 px-2 py-1 border border-line rounded-md text-[13px] focus:outline-none focus:ring-1 focus:ring-navy-700/25" /></td>
                  <td className="text-right">{cons}</td>
                  <td className="td-rate text-right">{peso(cons * rate)}</td>
                </tr>
              )
            })}
          </tbody></table>
        </div>
        <p className="text-[11px] text-ink-faint mt-2">Lobby / 2nd Floor / Roof Deck = standard (overhead). Commercial = bedspace (separate billing, pending).</p>
      </div>

      {/* Room readings */}
      {loading ? <Spin h={160} /> : (
        <div className="table-wrap">
          <table><thead><tr>
            <th>Room</th><th>Type</th><th>Prev Reading</th><th>Actual Reading</th><th>Consumption</th>
            <th className="text-right">Rate</th><th className="text-right">Amount</th>
          </tr></thead><tbody>
            {rows.map(r => (
              <tr key={r.room_id}>
                <td className="font-bold text-ink">{r.room_no}</td>
                <td className="text-[11px] text-ink-faint">{r.room_type}</td>
                <td>{Math.round(r.prev)}</td>
                <td>{readOnly
                  ? <span className="font-semibold">{r.curr === '' ? '—' : r.curr}</span>
                  : <input type="number" step="0.01" value={r.curr} onChange={e => setEdits(ed => ({ ...ed, [r.room_id]: e.target.value }))}
                      className="w-24 px-2 py-1 border border-line rounded-md text-[13px] focus:outline-none focus:ring-1 focus:ring-navy-700/25" />}
                </td>
                <td className={`font-semibold ${r.cons < 0 ? 'text-danger-text' : 'text-ink'}`}>{r.cons == null ? '—' : r.cons}</td>
                <td className="text-[12px] text-ink-faint text-right">{r4(bedRate)}</td>
                <td className="td-rate text-right">{r.amount == null ? '—' : peso(r.amount)}</td>
              </tr>
            ))}
          </tbody><tfoot>
            <tr className="bg-surface-2 border-t-2 border-navy-700">
              <td colSpan={4} className="text-[11px] font-extrabold text-ink-muted uppercase tracking-wide">Room Totals</td>
              <td className="font-extrabold">{totals.cons.toLocaleString('en-PH')}</td>
              <td></td>
              <td className="font-extrabold text-navy-500 text-right">{peso(totals.amount)}</td>
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

function Spin({ h }) { return <div className="loading-screen" style={h ? { height: h } : {}}><div className="spinner" /></div> }

// ── P&L card ──────────────────────────────────────────────────────────────────
function PnLCard({ pnl, utility }) {
  const isShortfall = pnl.variance < 0
  const Row = ({ label, val, cls }) => (
    <div className="flex justify-between py-1 text-[13px]">
      <span className="text-ink-muted">{label}</span>
      <span className={`font-semibold ${cls || 'text-ink'}`}>{val}</span>
    </div>
  )
  return (
    <div className={`card p-4 mb-4 border-t-[3px] ${isShortfall ? 'border-t-red-600' : 'border-t-emerald-600'}`}>
      <div className="text-[10px] font-extrabold text-ink-faint uppercase tracking-widest mb-3 flex items-center gap-1">
        {utility === 'WATER' ? <><Droplets size={12} /> Water</> : <><Zap size={12} /> Electric</>} P&amp;L
      </div>
      <div className="grid grid-cols-2 gap-x-7">
        <div>
          <Row label="Provider cost" val={peso(pnl.cost)} cls="text-danger-text" />
          <Row label="Room collections" val={peso(pnl.roomCollections)} cls="text-success-text" />
        </div>
        <div>
          <Row label="Overhead (standard)" val={peso(pnl.overhead)} />
          <Row label="Commercial (pending)" val={peso(pnl.commercial)} cls="text-ink-faint" />
        </div>
      </div>
      <div className="border-t border-line-subtle mt-3 pt-3 flex justify-between items-center">
        <span className="text-[12px] font-extrabold text-ink-muted uppercase tracking-wide">Variance</span>
        <span className={`text-[18px] font-extrabold ${isShortfall ? 'text-danger-text' : 'text-success-text'}`}>
          {isShortfall ? '−' : '+'}{peso(Math.abs(pnl.variance))} {isShortfall ? 'Shortfall' : 'Surplus'}
        </span>
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
  return (
    <div className="overlay" onClick={e => e.stopPropagation()}>
      <div className="modal modal-sm">
        <div className="modal-head">
          <h3><span className="inline-flex items-center gap-1.5"><Zap size={16} /> Open New Cutoff</span></h3>
          <button className="btn-close" onClick={onClose}><X size={16} /></button>
        </div>
        <form onSubmit={submit}>
          <div className="modal-body">
            <div className="form-grid">
              <div className="fg full"><label>Period Name *</label><input type="text" value={f.name} onChange={e => set('name', e.target.value)} required /></div>
              <div className="form-section flex items-center gap-1"><Droplets size={12} /> Water window</div>
              <div className="fg"><label>Start *</label><input type="date" value={f.water_start} onChange={e => onW(e.target.value)} /></div>
              <div className="fg">
                <label>End <span className="text-[9px] text-ink-faint font-semibold">(auto +1mo)</span></label>
                <input type="date" value={f.water_end} disabled className="bg-surface-2" />
              </div>
              <div className="form-section flex items-center gap-1"><Zap size={12} /> Electric window</div>
              <div className="fg"><label>Start *</label><input type="date" value={f.electric_start} onChange={e => onE(e.target.value)} /></div>
              <div className="fg">
                <label>End <span className="text-[9px] text-ink-faint font-semibold">(auto +1mo)</span></label>
                <input type="date" value={f.electric_end} disabled className="bg-surface-2" />
              </div>
            </div>
            <p className="text-[11px] text-ink-faint mt-3 leading-relaxed">
              Previous readings carry forward. Enter the provider main line + markup after opening to set rates.
            </p>
          </div>
          <div className="modal-foot">
            <button type="button" className="btn secondary" onClick={onClose}>Cancel</button>
            <button type="submit" className="btn primary" disabled={busy}>{busy ? 'Opening…' : 'Open Cutoff'}</button>
          </div>
        </form>
      </div>
    </div>
  )
}
