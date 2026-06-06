import { useState, useEffect, useMemo } from 'react'
import {
  fetchCutoffs, fetchUtilityBill, fetchTenants,
  fetchInterimReadings, addInterimReading, deleteInterimReading,
  fetchSplits, setRoomSplit, fetchAddons, saveAddon, deleteAddon, fetchAreaReadings,
} from '../lib/supabase'
import { computeBilling } from '../lib/billing'
import { useToast } from '../components/Toast'
import { Link } from 'react-router-dom'

const peso = n => '₱' + Number(n || 0).toLocaleString('en-PH', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
const m3   = n => Number(n || 0).toLocaleString('en-PH', { maximumFractionDigits: 2 })

export default function Billing() {
  const [cutoffs,  setCutoffs]  = useState([])
  const [cutoffId, setCutoffId] = useState(null)
  const [bill,     setBill]     = useState([])
  const [interims, setInterims] = useState([])
  const [tenants,  setTenants]  = useState([])
  const [loading,  setLoading]  = useState(true)
  const [view,     setView]     = useState('tenants')   // tenants | rooms
  const [showRec,  setShowRec]  = useState(false)
  const [splits,   setSplits]   = useState([])
  const [splitRoom, setSplitRoom] = useState(null)      // room object for split editor
  const [addons,   setAddons]   = useState([])
  const [areas,    setAreas]    = useState([])
  const [addonTenant, setAddonTenant] = useState(null)  // tenant row for add-on editor
  const { show, ToastEl } = useToast()

  const cutoff = cutoffs.find(c => c.id === cutoffId)

  useEffect(() => {
    fetchCutoffs().then(cs => {
      setCutoffs(cs)
      const active = cs.find(c => c.is_active) || cs[0]
      if (active) setCutoffId(active.id); else setLoading(false)
    }).catch(e => { show(e.message, 'error'); setLoading(false) })
  }, [])

  async function load() {
    if (!cutoffId) return
    setLoading(true)
    try {
      const [b, ir, t, sp, ad, ar] = await Promise.all([
        fetchUtilityBill(cutoffId), fetchInterimReadings(cutoffId), fetchTenants(),
        fetchSplits(cutoffId), fetchAddons(cutoffId), fetchAreaReadings(cutoffId),
      ])
      setBill(b); setInterims(ir); setTenants(t); setSplits(sp); setAddons(ad); setAreas(ar)
    } catch (e) { show(e.message, 'error') }
    setLoading(false)
  }
  useEffect(() => { load() }, [cutoffId])

  const { perRoom, perTenant } = useMemo(() => {
    if (!cutoff || !bill.length) return { perRoom: [], perTenant: [] }
    return computeBilling(cutoff, bill, interims, tenants, splits, addons, areas)
  }, [cutoff, bill, interims, tenants, splits, addons, areas])

  // Which (room|utility) have a custom split, for the badge
  const splitFlags = useMemo(() => {
    const s = new Set(); splits.forEach(x => s.add(`${x.room_id}|${x.utility}`)); return s
  }, [splits])

  const totals = useMemo(() => perTenant.reduce((s, t) => ({
    rent: s.rent + t.rent, water: s.water + t.water, elec: s.elec + t.elec,
    addons: s.addons + (t.addonRentWater || 0) + (t.addonElectric || 0), total: s.total + t.total,
  }), { rent: 0, water: 0, elec: 0, addons: 0, total: 0 }), [perTenant])

  if (loading && !cutoffs.length) return (
    <div className="loading-screen"><div className="spinner" />
      <span style={{ color: '#1B3A8C', fontWeight: 600 }}>Loading…</span></div>
  )
  if (!cutoffs.length) return (
    <div className="page"><div className="page-title">Billing</div>
      <div className="card"><div className="empty"><div className="empty-icon">🧾</div>
        <p>No cutoffs yet. Open one in the Utilities tab first.</p></div></div></div>
  )

  return (
    <div className="page" style={{ maxWidth: 1200 }}>
      <div className="page-title">Billing <small>Per-tenant rent &amp; utilities</small></div>

      <div className="toolbar">
        <select value={cutoffId || ''} onChange={e => setCutoffId(Number(e.target.value))}>
          {cutoffs.map(c => <option key={c.id} value={c.id}>{c.name}{c.is_active ? ' (active)' : ''}</option>)}
        </select>
        <div style={{ display: 'flex', border: '1px solid var(--border)', borderRadius: 7, overflow: 'hidden' }}>
          {[['tenants', 'Per Tenant'], ['rooms', 'Per Room (reconcile)'], ['report', 'Report']].map(([v, label]) => (
            <button key={v} onClick={() => setView(v)} style={{
              padding: '8px 16px', border: 'none', fontSize: 13, fontWeight: 700,
              background: view === v ? '#1B3A8C' : '#fff', color: view === v ? '#fff' : '#64748B',
            }}>{label}</button>
          ))}
        </div>
        <button className="btn secondary" style={{ marginLeft: 'auto' }} onClick={() => setShowRec(true)}>
          + Record Move-out Reading
        </button>
        {cutoffId && (
          <Link className="btn primary" to={`/print/rent-water?cutoff=${cutoffId}`}>
            🖨 Rent + Water
          </Link>
        )}
        {cutoffId && (
          <Link className="btn amber" to={`/print/electricity?cutoff=${cutoffId}`}>
            🖨 Electricity
          </Link>
        )}
      </div>

      {cutoff && (
        <div style={{ fontSize: 12, color: '#64748B', marginBottom: 12 }}>
          💧 Water: {cutoff.water_start} → {cutoff.water_end} &nbsp;·&nbsp;
          ⚡ Electric: {cutoff.electric_start} → {cutoff.electric_end}
          {interims.length > 0 && <> &nbsp;·&nbsp; {interims.length} move-out reading(s)</>}
          {splitFlags.size > 0 && <> &nbsp;·&nbsp; <span style={{ color: '#1B3A8C' }}>⚙ custom split</span> on {splitFlags.size} room-utility(ies)</>}
        </div>
      )}

      {loading ? (
        <div className="loading-screen" style={{ height: 180 }}><div className="spinner" /></div>
      ) : view === 'tenants' ? (
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Tenant</th><th>Room</th><th>Bed</th>
                <th style={{ textAlign: 'right' }}>Rent</th>
                <th style={{ textAlign: 'right' }}>Water (m³)</th>
                <th style={{ textAlign: 'right' }}>Water ₱</th>
                <th style={{ textAlign: 'right' }}>Elec (kWh)</th>
                <th style={{ textAlign: 'right' }}>Elec ₱</th>
                <th style={{ textAlign: 'right' }}>Add-ons</th>
                <th style={{ textAlign: 'right' }}>Total</th>
              </tr>
            </thead>
            <tbody>
              {perTenant.map(t => (
                <tr key={t.id}>
                  <td className="td-name">{t.name}{t.settled && <span className="badge oor" style={{ marginLeft: 6 }}>moved out</span>}</td>
                  <td>{t.room_no}</td>
                  <td><strong>{t.bed}</strong></td>
                  <td style={{ textAlign: 'right' }}>{t.rent ? peso(t.rent) : '—'}</td>
                  <td style={{ textAlign: 'right', color: '#64748B' }}>{m3(t.waterCons)}</td>
                  <td style={{ textAlign: 'right' }}>
                    {peso(t.water)}
                    {splitFlags.has(`${t.room_id}|WATER`) && <span title="custom split" style={{ marginLeft: 4, color: '#2563EB' }}>⚙</span>}
                  </td>
                  <td style={{ textAlign: 'right', color: '#64748B' }}>{m3(t.elecCons)}</td>
                  <td style={{ textAlign: 'right' }}>
                    {peso(t.elec)}
                    {splitFlags.has(`${t.room_id}|ELECTRIC`) && <span title="custom split" style={{ marginLeft: 4, color: '#D97706' }}>⚙</span>}
                  </td>
                  <td style={{ textAlign: 'right', whiteSpace: 'nowrap' }}>
                    {((t.addonRentWater || 0) + (t.addonElectric || 0)) > 0
                      ? <span title={(t.addons || []).map(a => `${a.label}: ${peso(a.amount)} [${a.bill_on === 'ELECTRIC' ? 'Elec' : 'Rent+Water'}${a.recurring ? '' : ', one-time'}]`).join('\n')}>
                          {peso((t.addonRentWater || 0) + (t.addonElectric || 0))}
                        </span>
                      : <span style={{ color: '#CBD5E1' }}>—</span>}
                    <button className="btn-xs blue" style={{ marginLeft: 6 }} onClick={() => setAddonTenant(t)}>⊕</button>
                  </td>
                  <td className="td-rate" style={{ textAlign: 'right' }}>{peso(t.total)}</td>
                </tr>
              ))}
            </tbody>
            <tfoot>
              <tr style={{ background: '#F8FAFC', borderTop: '2px solid #1B3A8C' }}>
                <td colSpan={3} style={{ fontWeight: 800, color: '#475569', textTransform: 'uppercase', fontSize: 11 }}>Totals</td>
                <td style={{ textAlign: 'right', fontWeight: 800 }}>{peso(totals.rent)}</td>
                <td></td>
                <td style={{ textAlign: 'right', fontWeight: 800 }}>{peso(totals.water)}</td>
                <td></td>
                <td style={{ textAlign: 'right', fontWeight: 800 }}>{peso(totals.elec)}</td>
                <td style={{ textAlign: 'right', fontWeight: 800 }}>{peso(totals.addons)}</td>
                <td style={{ textAlign: 'right', fontWeight: 800, color: '#1B3A8C' }}>{peso(totals.total)}</td>
              </tr>
            </tfoot>
          </table>
        </div>
      ) : view === 'rooms' ? (
        <div className="rooms-grid" style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(320px, 1fr))' }}>
          {perRoom.map(r => (
            <div key={r.room_id} className="card" style={{ padding: '12px 14px' }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
                <div style={{ fontWeight: 800, fontSize: 14 }}>Room {r.room_no}
                  <span style={{ fontSize: 11, fontWeight: 400, color: '#94A3B8' }}> · {r.room_type}</span></div>
                <button className="btn-xs blue" onClick={() => setSplitRoom(r)}>⚙ Split</button>
              </div>
              {[['💧 Water', r.water, 'WATER'], ['⚡ Electric', r.electric, 'ELECTRIC']].map(([label, u, util]) => (
                <div key={label} style={{ marginBottom: 8, fontSize: 12 }}>
                  <div style={{ fontWeight: 700, color: '#475569' }}>{label}
                    <span style={{ fontWeight: 400, color: '#94A3B8' }}> · {u.segments} segment(s)</span>
                    {splitFlags.has(`${r.room_id}|${util}`) && <span className="badge leased" style={{ marginLeft: 6 }}>custom split</span>}
                  </div>
                  <div style={{ display: 'flex', justifyContent: 'space-between', color: '#64748B' }}>
                    <span>Room: {m3(u.roomCons)} → {peso(u.roomAmt)}</span>
                    <span>Tenants: {peso(u.sum)}{u.unbilled > 0.01 ? ` (+${peso(u.unbilled)} vacant)` : ''}</span>
                  </div>
                  <div style={{ fontWeight: 700, color: u.ok ? '#16a34a' : '#DC2626' }}>
                    {u.ok ? '✓ reconciled' : '✗ mismatch — check readings'}
                  </div>
                </div>
              ))}
            </div>
          ))}
        </div>
      ) : (
        <ReportView totals={totals} perTenant={perTenant} cutoffName={cutoff?.name} />
      )}

      {showRec && (
        <RecordReadingModal
          cutoffId={cutoffId} rooms={bill} tenants={tenants}
          onClose={() => setShowRec(false)}
          onDone={async () => { setShowRec(false); await load(); show('Move-out reading recorded.', 'success') }}
          show={show}
        />
      )}

      {splitRoom && (
        <SplitModal
          cutoffId={cutoffId} room={splitRoom} tenants={tenants} splits={splits}
          onClose={() => setSplitRoom(null)}
          onDone={async () => { setSplitRoom(null); await load(); show('Split saved.', 'success') }}
          show={show}
        />
      )}

      {addonTenant && (
        <AddonModal
          cutoffId={cutoffId} cutoffName={cutoff?.name} tenant={addonTenant} addons={addons}
          onClose={() => setAddonTenant(null)}
          onDone={async () => { setAddonTenant(null); await load(); show('Add-ons updated.', 'success') }}
          show={show}
        />
      )}

      {/* Existing interim readings (deletable) */}
      {interims.length > 0 && (
        <div className="card" style={{ marginTop: 16, padding: '12px 16px' }}>
          <div className="card-header" style={{ padding: 0, border: 'none', marginBottom: 8 }}>Move-out readings this cutoff</div>
          {interims.map(ir => {
            const room = bill.find(b => b.room_id === ir.room_id)
            return (
              <div key={ir.id} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', fontSize: 13, padding: '5px 0', borderBottom: '1px solid #F1F5F9' }}>
                <span>Room {room?.room_no || ir.room_id} · {ir.utility} · {ir.reading_date} · reading <strong>{ir.reading_value}</strong></span>
                <button className="btn-xs red" onClick={async () => { await deleteInterimReading(ir.id); await load() }}>Delete</button>
              </div>
            )
          })}
        </div>
      )}

      {ToastEl}
    </div>
  )
}

// ── Record Move-out Reading modal ─────────────────────────────────────────────
function RecordReadingModal({ cutoffId, rooms, tenants, onClose, onDone, show }) {
  const today = new Date().toISOString().slice(0, 10)
  const [f, setF] = useState({ room_id: '', utility: 'WATER', reading_date: today, reading_value: '', moving_out_tenant_id: '' })
  const [busy, setBusy] = useState(false)
  const set = (k, v) => setF(s => ({ ...s, [k]: v }))

  const roomTenants = tenants.filter(t => String(t.beds?.room_id) === String(f.room_id))

  async function submit(e) {
    e.preventDefault()
    if (!f.room_id || !f.reading_date || f.reading_value === '') {
      show('Room, date, and reading value are required.', 'error'); return
    }
    setBusy(true)
    try {
      await addInterimReading({
        cutoff_id: cutoffId,
        room_id: Number(f.room_id),
        utility: f.utility,
        reading_date: f.reading_date,
        reading_value: Number(f.reading_value),
        moving_out_tenant_id: f.moving_out_tenant_id ? Number(f.moving_out_tenant_id) : null,
      })
      onDone()
    } catch (e) { show(e.message, 'error'); setBusy(false) }
  }

  return (
    <div className="overlay" onClick={e => e.target === e.currentTarget && onClose()}>
      <div className="modal modal-sm">
        <div className="modal-head"><h3>📏 Record Move-out Reading</h3>
          <button className="btn-close" onClick={onClose}>✕</button></div>
        <form onSubmit={submit}>
          <div className="modal-body">
            <div className="form-grid">
              <div className="fg full"><label>Room *</label>
                <select value={f.room_id} onChange={e => set('room_id', e.target.value)} required>
                  <option value="">Select room…</option>
                  {rooms.map(r => <option key={r.room_id} value={r.room_id}>Room {r.room_no} — {r.room_type}</option>)}
                </select>
              </div>
              <div className="fg"><label>Utility *</label>
                <select value={f.utility} onChange={e => set('utility', e.target.value)}>
                  <option value="WATER">💧 Water</option>
                  <option value="ELECTRIC">⚡ Electric</option>
                </select>
              </div>
              <div className="fg"><label>Move-out Date *</label>
                <input type="date" value={f.reading_date} onChange={e => set('reading_date', e.target.value)} required /></div>
              <div className="fg"><label>Room Meter Reading *</label>
                <input type="number" step="0.01" value={f.reading_value} onChange={e => set('reading_value', e.target.value)} required /></div>
              <div className="fg"><label>Moving-out Tenant</label>
                <select value={f.moving_out_tenant_id} onChange={e => set('moving_out_tenant_id', e.target.value)}>
                  <option value="">(optional)</option>
                  {roomTenants.map(t => <option key={t.id} value={t.id}>{t.name} ({t.beds?.bed_letter})</option>)}
                </select>
              </div>
            </div>
            <p style={{ fontSize: 11, color: '#94A3B8', marginTop: 12 }}>
              Record the room meter reading on the move-out date. The cutoff is sliced into
              segments and each tenant is billed for the days they were actually present.
            </p>
          </div>
          <div className="modal-foot">
            <button type="button" className="btn secondary" onClick={onClose}>Cancel</button>
            <button type="submit" className="btn primary" disabled={busy}>{busy ? 'Saving…' : '✓ Record'}</button>
          </div>
        </form>
      </div>
    </div>
  )
}

// ── Custom split editor (per room, per utility) ───────────────────────────────
function SplitModal({ cutoffId, room, tenants, splits, onClose, onDone, show }) {
  const roomTenants = tenants.filter(t => t.beds?.room_id === room.room_id && t.is_active)
  const [util, setUtil] = useState('WATER')
  const eq = Math.round(10000 / Math.max(roomTenants.length, 1)) / 100
  const initFor = (u) => {
    const ex = splits.filter(s => s.room_id === room.room_id && s.utility === u)
    const m = {}
    roomTenants.forEach(t => {
      const e = ex.find(s => s.tenant_id === t.id)
      m[t.id] = e ? Number(e.weight_pct) : eq
    })
    return m
  }
  const [w, setW] = useState({ WATER: initFor('WATER'), ELECTRIC: initFor('ELECTRIC') })
  const [busy, setBusy] = useState(false)
  const cur = w[util]
  const sum = roomTenants.reduce((s, t) => s + (Number(cur[t.id]) || 0), 0)
  const ok = Math.abs(sum - 100) < 0.1
  const accent = util === 'WATER' ? '#2563EB' : '#D97706'

  const setVal = (tid, v) => setW(s => ({ ...s, [util]: { ...s[util], [tid]: v } }))
  const resetEqual = () => setW(s => ({ ...s, [util]: Object.fromEntries(roomTenants.map(t => [t.id, eq])) }))

  async function save(clear) {
    if (!clear && !ok) { show('Weights must total 100%.', 'error'); return }
    setBusy(true)
    try {
      await setRoomSplit(cutoffId, room.room_id, util,
        clear ? [] : roomTenants.map(t => ({ tenant_id: t.id, weight_pct: Number(cur[t.id]) || 0 })))
      onDone()
    } catch (e) { show(e.message, 'error'); setBusy(false) }
  }

  return (
    <div className="overlay" onClick={e => e.target === e.currentTarget && onClose()}>
      <div className="modal modal-sm">
        <div className="modal-head"><h3>⚙ Custom Split — Room {room.room_no}</h3>
          <button className="btn-close" onClick={onClose}>✕</button></div>
        <div className="modal-body">
          <div style={{ display: 'flex', border: '1px solid var(--border)', borderRadius: 9, overflow: 'hidden', marginBottom: 14 }}>
            {['WATER', 'ELECTRIC'].map(u => (
              <button key={u} onClick={() => setUtil(u)} style={{
                flex: 1, padding: '8px', border: 'none', fontSize: 13, fontWeight: 700,
                background: util === u ? (u === 'WATER' ? '#2563EB' : '#D97706') : '#fff',
                color: util === u ? '#fff' : '#64748B',
              }}>{u === 'WATER' ? '💧 Water' : '⚡ Electric'}</button>
            ))}
          </div>

          {roomTenants.length === 0 ? (
            <div className="empty"><p>No active tenants in this room.</p></div>
          ) : (
            <>
              {roomTenants.map(t => (
                <div key={t.id} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '6px 0' }}>
                  <div style={{ flex: 1, fontSize: 13 }}>{t.name} <span style={{ color: '#94A3B8' }}>· Bed {t.beds?.bed_letter}</span></div>
                  <input type="number" step="0.1" value={cur[t.id] ?? 0}
                    onChange={e => setVal(t.id, e.target.value)}
                    style={{ width: 80, padding: '6px 8px', border: '1px solid var(--border)', borderRadius: 7, fontSize: 13, textAlign: 'right' }} />
                  <span style={{ width: 14, color: '#64748B' }}>%</span>
                </div>
              ))}
              <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: 8, fontWeight: 800, color: ok ? '#16a34a' : '#DC2626' }}>
                <span>Total</span><span>{sum.toFixed(1)}% {ok ? '✓' : '(must be 100%)'}</span>
              </div>
              <button className="btn-xs gray" style={{ marginTop: 10 }} onClick={resetEqual}>Reset to equal</button>
              <p style={{ fontSize: 11, color: '#94A3B8', marginTop: 10 }}>
                Applies to <strong>{util === 'WATER' ? 'water' : 'electric'}</strong> only for this cutoff. Switch tabs to set the other. "Use default" reverts to the per-day split.
              </p>
            </>
          )}
        </div>
        <div className="modal-foot">
          <button className="btn secondary" onClick={onClose}>Cancel</button>
          <button className="btn secondary" disabled={busy} onClick={() => save(true)}>Use default</button>
          <button className="btn primary" disabled={busy || !roomTenants.length || !ok} onClick={() => save(false)} style={{ background: accent }}>
            {busy ? 'Saving…' : ok ? 'Save split' : `Total ${sum.toFixed(1)}%`}
          </button>
        </div>
      </div>
    </div>
  )
}

// ── Add-ons editor (per tenant) ───────────────────────────────────────────────
const PRESETS = {
  PARKING_CAR: { label: 'Car Parking',        amount: 3500, bill_on: 'RENT_WATER', aircon: false },
  PARKING_MC:  { label: 'Motorcycle Parking', amount: 1500, bill_on: 'RENT_WATER', aircon: false },
  AIRCON:      { label: 'Aircon Usage',       amount: 0,    bill_on: 'ELECTRIC',   aircon: true  },
  OTHER:       { label: '',                   amount: 0,    bill_on: 'RENT_WATER', aircon: false },
}

function AddonModal({ cutoffId, cutoffName, tenant, addons, onClose, onDone, show }) {
  const mine = addons.filter(a => a.tenant_id === tenant.id)
  const [f, setF] = useState({ category: 'PARKING_CAR', ...PRESETS.PARKING_CAR, hours: '', rate: '', recurring: false })
  const [busy, setBusy] = useState(false)
  const set = (k, v) => setF(s => ({ ...s, [k]: v }))
  const pickCat = (c) => setF(s => ({ ...s, category: c, ...PRESETS[c], hours: '', rate: '' }))
  const computedAmount = f.aircon ? (Number(f.hours) || 0) * (Number(f.rate) || 0) : (Number(f.amount) || 0)

  async function add() {
    if (!f.label.trim()) { show('Enter a label.', 'error'); return }
    if (computedAmount <= 0) { show('Amount must be greater than 0.', 'error'); return }
    setBusy(true)
    try {
      await saveAddon({
        tenant_id: tenant.id,
        cutoff_id: f.recurring ? null : cutoffId,
        label: f.label.trim(), category: f.category, bill_on: f.bill_on,
        amount: computedAmount,
        hours: f.aircon ? Number(f.hours) || 0 : null,
        rate: f.aircon ? Number(f.rate) || 0 : null,
        recurring: f.recurring,
      })
      onDone()
    } catch (e) { show(e.message, 'error'); setBusy(false) }
  }
  async function remove(id) { setBusy(true); try { await deleteAddon(id); onDone() } catch (e) { show(e.message, 'error'); setBusy(false) } }

  const peso = n => '₱' + Number(n || 0).toLocaleString('en-PH', { minimumFractionDigits: 2, maximumFractionDigits: 2 })

  return (
    <div className="overlay" onClick={e => e.target === e.currentTarget && onClose()}>
      <div className="modal">
        <div className="modal-head"><h3>⊕ Add-ons — {tenant.name}</h3>
          <button className="btn-close" onClick={onClose}>✕</button></div>
        <div className="modal-body">
          {/* Existing add-ons */}
          {mine.length > 0 && (
            <div style={{ marginBottom: 14 }}>
              {mine.map(a => (
                <div key={a.id} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '6px 0', borderBottom: '1px solid #F1F5F9', fontSize: 13 }}>
                  <div style={{ flex: 1 }}>
                    <strong>{a.label}</strong> · {peso(a.amount)}
                    <span className="badge" style={{ marginLeft: 6, background: a.bill_on === 'ELECTRIC' ? '#FFFBEB' : '#EFF6FF', color: a.bill_on === 'ELECTRIC' ? '#D97706' : '#2563EB' }}>
                      {a.bill_on === 'ELECTRIC' ? 'Electric bill' : 'Rent+Water bill'}
                    </span>
                    <span className="badge" style={{ marginLeft: 4, background: a.recurring ? '#ECFDF5' : '#F1F5F9', color: a.recurring ? '#16a34a' : '#64748B' }}>
                      {a.recurring ? 'recurring' : 'this cutoff only'}
                    </span>
                  </div>
                  <button className="btn-xs red" disabled={busy} onClick={() => remove(a.id)}>Delete</button>
                </div>
              ))}
            </div>
          )}

          {/* New add-on */}
          <div className="form-section" style={{ borderBottom: '1px solid var(--border)', paddingBottom: 4, marginBottom: 10 }}>Add a charge</div>
          <div className="form-grid">
            <div className="fg"><label>Type</label>
              <select value={f.category} onChange={e => pickCat(e.target.value)}>
                <option value="PARKING_CAR">Car Parking (₱3,500)</option>
                <option value="PARKING_MC">Motorcycle Parking (₱1,500)</option>
                <option value="AIRCON">Aircon (hours × rate)</option>
                <option value="OTHER">Other</option>
              </select>
            </div>
            <div className="fg"><label>Label</label>
              <input type="text" value={f.label} onChange={e => set('label', e.target.value)} placeholder="e.g. Car Parking" /></div>

            {f.aircon ? (
              <>
                <div className="fg"><label>Hours</label><input type="number" step="0.1" value={f.hours} onChange={e => set('hours', e.target.value)} /></div>
                <div className="fg"><label>Rate (₱/hr)</label><input type="number" step="0.01" value={f.rate} onChange={e => set('rate', e.target.value)} /></div>
              </>
            ) : (
              <div className="fg"><label>Amount (₱)</label><input type="number" step="0.01" value={f.amount} onChange={e => set('amount', e.target.value)} /></div>
            )}

            <div className="fg"><label>Bill on</label>
              <select value={f.bill_on} onChange={e => set('bill_on', e.target.value)}>
                <option value="RENT_WATER">Rent + Water bill</option>
                <option value="ELECTRIC">Electricity bill</option>
              </select>
            </div>
            <div className="fg" style={{ justifyContent: 'flex-end' }}>
              <label style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
                <input type="checkbox" checked={f.recurring} onChange={e => set('recurring', e.target.checked)} /> Recurring (every cutoff)
              </label>
            </div>
          </div>
          <div style={{ marginTop: 10, fontSize: 13, color: '#475569' }}>
            Amount: <strong style={{ color: '#1B3A8C' }}>{peso(computedAmount)}</strong>
            {!f.recurring && <span style={{ color: '#94A3B8' }}> · applies to {cutoffName} only</span>}
          </div>
        </div>
        <div className="modal-foot">
          <button className="btn secondary" onClick={onClose}>Close</button>
          <button className="btn primary" disabled={busy} onClick={add}>+ Add charge</button>
        </div>
      </div>
    </div>
  )
}

// ── Report (grand totals) ─────────────────────────────────────────────────────
function ReportView({ totals, perTenant, cutoffName }) {
  const peso = n => '₱' + Number(n || 0).toLocaleString('en-PH', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
  const counts = perTenant.reduce((c, t) => {
    if (t.special) c.special++; else c.bed++
    return c
  }, { bed: 0, special: 0 })
  const tile = (label, val, color) => (
    <div className="stat-card" style={{ borderTopColor: color }}>
      <div className="stat-label">{label}</div>
      <div className="stat-value" style={{ fontSize: 20 }}>{val}</div>
    </div>
  )
  return (
    <div>
      <div style={{ fontSize: 12, color: '#64748B', marginBottom: 12 }}>Collections summary · {cutoffName} · {counts.bed} bed tenants + {counts.special} special/commercial</div>
      <div className="stats-grid">
        {tile('Rent',        peso(totals.rent),   '#1B3A8C')}
        {tile('Water',       peso(totals.water),  '#2563EB')}
        {tile('Electricity', peso(totals.elec),   '#D97706')}
        {tile('Add-ons',     peso(totals.addons), '#7C3AED')}
        {tile('Grand Total', peso(totals.total),  '#16a34a')}
      </div>
      <div className="card" style={{ padding: 16, marginTop: 4 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 14, padding: '4px 0' }}><span>Rent collections</span><strong>{peso(totals.rent)}</strong></div>
        <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 14, padding: '4px 0' }}><span>Water charging</span><strong>{peso(totals.water)}</strong></div>
        <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 14, padding: '4px 0' }}><span>Electricity charging</span><strong>{peso(totals.elec)}</strong></div>
        <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 14, padding: '4px 0' }}><span>Add-ons</span><strong>{peso(totals.addons)}</strong></div>
        <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 16, padding: '8px 0 0', marginTop: 6, borderTop: '2px solid #1B3A8C', fontWeight: 800, color: '#1B3A8C' }}><span>TOTAL BILLED</span><span>{peso(totals.total)}</span></div>
      </div>
    </div>
  )
}
