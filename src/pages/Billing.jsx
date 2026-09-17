import { useState, useEffect, useMemo } from 'react'
import {
  fetchCutoffs, fetchUtilityBill, fetchTenants,
  fetchInterimReadings, deleteInterimReading,
  fetchSplits, setRoomSplit, fetchAddons, saveAddon, deleteAddon, fetchAreaReadings,
  fetchTransfersForCutoff,
} from '../lib/supabase'
import { computeBilling } from '../lib/billing'
import { cacheBilling } from '../lib/billingCache'
import { useToast } from '../components/Toast'
import { useAuth } from '../lib/auth'
import { requestApproval } from '../lib/approvals'
import { Link } from 'react-router-dom'
import { Printer, Droplets, Zap, Settings2, PlusCircle, Receipt, X, AlertTriangle, Clock, Trash2 } from 'lucide-react'

const peso = n => '₱' + Number(n || 0).toLocaleString('en-PH', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
const m3   = n => Number(n || 0).toLocaleString('en-PH', { maximumFractionDigits: 2 })

export default function Billing() {
  const [cutoffs,     setCutoffs]     = useState([])
  const [cutoffId,    setCutoffId]    = useState(null)
  const [bill,        setBill]        = useState([])
  const [interims,    setInterims]    = useState([])
  const [tenants,     setTenants]     = useState([])
  const [loading,     setLoading]     = useState(true)
  const [view,        setView]        = useState('tenants')
  const [billCat,     setBillCat]     = useState('RENT_WATER')

  const [splits,      setSplits]      = useState([])
  const [splitRoom,   setSplitRoom]   = useState(null)
  const [addons,      setAddons]      = useState([])
  const [areas,       setAreas]       = useState([])
  const [transfers,   setTransfers]   = useState([])
  const [addonTenant, setAddonTenant] = useState(null)
  const [confirmDelete, setConfirmDelete] = useState(null)
  const { show, ToastEl } = useToast()

  const cutoff = cutoffs.find(c => c.id === cutoffId)

  useEffect(() => {
    fetchCutoffs().then(cs => {
      setCutoffs(cs)
      const active = cs.find(c => c.is_active) || cs[0]
      // Pass the active cutoff ID AND the fresh list into load() so there is no
      // stale-closure window between setCutoffs and the [cutoffId] effect firing.
      if (active) { setCutoffId(active.id); load(active.id) }
      else setLoading(false)
    }).catch(e => { show(e.message, 'error'); setLoading(false) })
  }, [])

  async function load(overrideCutoffId) {
    const id = overrideCutoffId ?? cutoffId
    if (!id) return
    setLoading(true)
    try {
      // Re-fetch cutoff directly to avoid stale closure over `cutoffs` state
      const freshCutoffs = await fetchCutoffs()
      const cutoffObj = freshCutoffs.find(c => c.id === id)
      const [b, ir, t, sp, ad, ar, xf] = await Promise.all([
        fetchUtilityBill(id), fetchInterimReadings(id), fetchTenants(),
        fetchSplits(id), fetchAddons(id), fetchAreaReadings(id),
        cutoffObj ? fetchTransfersForCutoff(cutoffObj) : Promise.resolve([]),
      ])
      setCutoffs(freshCutoffs)
      setBill(b); setInterims(ir); setTenants(t); setSplits(sp); setAddons(ad); setAreas(ar); setTransfers(xf)
    } catch (e) { show(e.message, 'error') }
    setLoading(false)
  }
  useEffect(() => { load() }, [cutoffId])

  const { perRoom, perTenant } = useMemo(() => {
    if (!cutoff || !bill.length) return { perRoom: [], perTenant: [] }
    const result = computeBilling(cutoff, bill, interims, tenants, splits, addons, areas, transfers)
    cacheBilling(cutoff.id, result.perTenant)
    return result
  }, [cutoff, bill, interims, tenants, splits, addons, areas, transfers])

  const splitFlags = useMemo(() => {
    const s = new Set(); splits.forEach(x => s.add(`${x.room_id}|${x.utility}`)); return s
  }, [splits])

  const totals = useMemo(() => perTenant.reduce((s, t) => ({
    rent: s.rent + t.rent, water: s.water + t.water, elec: s.elec + t.elec,
    addons: s.addons + (t.addonRentWater || 0) + (t.addonElectric || 0), total: s.total + t.total,
  }), { rent: 0, water: 0, elec: 0, addons: 0, total: 0 }), [perTenant])

  if (loading && !cutoffs.length) return (
    <div className="loading-screen"><div className="spinner" /></div>
  )
  if (!cutoffs.length) return (
    <div className="page">
      <div className="page-title">Billing</div>
      <div className="card"><div className="empty"><Receipt size={32} className="mx-auto mb-3 text-ink-faint" />
        <p>No cutoffs yet. Open one in the Utilities tab first.</p>
      </div></div>
    </div>
  )

  return (
    <div className="page">
      <div className="page-header">
        <div>
          <h1 className="page-title">Billing <small>Per-tenant rent &amp; utilities</small></h1>
          {cutoff && (
            <p className="page-sub text-[11px] flex items-center gap-1.5 flex-wrap">
              <Droplets size={11} className="text-blue-500 shrink-0" /> Water: {cutoff.water_start} → {cutoff.water_end} &nbsp;·&nbsp;
              <Zap size={11} className="text-amber-500 shrink-0" /> Electric: {cutoff.electric_start} → {cutoff.electric_end}
              {interims.length > 0 && <> &nbsp;·&nbsp; {interims.length} move-out reading(s)</>}
              {splitFlags.size > 0 && <> &nbsp;·&nbsp; <span className="text-navy-500 font-semibold">⚙ custom split</span> on {splitFlags.size} room-utility(ies)</>}
            </p>
          )}
        </div>
        <div className="flex gap-2 flex-wrap items-center">
          {cutoffId && (
            <Link className="btn secondary" to={`/print/rent-water?cutoff=${cutoffId}`}>
              <Printer size={13} /> Rent + Water
            </Link>
          )}
          {cutoffId && (
            <Link className="btn amber" to={`/print/electricity?cutoff=${cutoffId}`}>
              <Printer size={13} /> Electricity
            </Link>
          )}
        </div>
      </div>

      {/* ── Toolbar ── */}
      <div className="toolbar">
        <select value={cutoffId || ''} onChange={e => setCutoffId(Number(e.target.value))}>
          {cutoffs.map(c => <option key={c.id} value={c.id}>{c.name}{c.is_active ? ' (active)' : ''}</option>)}
        </select>

        {/* View switcher tabs */}
        <div className="flex gap-1 p-1 bg-surface-3 rounded-lg">
          {[['tenants', 'Per Tenant'], ['rooms', 'Per Room'], ['report', 'Report']].map(([v, label]) => (
            <button key={v} onClick={() => setView(v)}
              className={`px-3 py-1.5 rounded-md text-[12px] font-semibold transition-all ${
                view === v ? 'bg-surface text-ink shadow-sm' : 'text-ink-muted hover:text-ink-secondary'
              }`}>
              {label}
            </button>
          ))}
        </div>

        {/* Category toggle — only in Per Tenant view */}
        {view === 'tenants' && (
          <div className="flex gap-1 p-1 bg-surface-3 rounded-lg">
            {[['RENT_WATER', 'Rent + Water'], ['ELECTRICITY', 'Electricity']].map(([cat, label]) => (
              <button key={cat} onClick={() => setBillCat(cat)}
                className={`px-3 py-1.5 rounded-md text-[12px] font-semibold transition-all inline-flex items-center gap-1.5 ${
                  billCat === cat
                    ? cat === 'RENT_WATER' ? 'bg-blue-600 text-white shadow-sm' : 'bg-amber-500 text-white shadow-sm'
                    : 'text-ink-muted hover:text-ink-secondary'
                }`}>
                {cat === 'RENT_WATER' ? <><Droplets size={13} /> Rent + Water</> : <><Zap size={13} /> Electricity</>}
              </button>
            ))}
          </div>
        )}

      </div>

      {/* ── Content ── */}
      {loading ? (
        <div className="loading-screen min-h-[200px]"><div className="spinner" /></div>
      ) : view === 'tenants' ? (
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Tenant</th><th>Room</th><th>Bed</th>
                {billCat === 'RENT_WATER' ? (
                  <>
                    <th className="text-right">Rent</th>
                    <th className="text-right text-ink-faint">W. Prev Rdg</th>
                    <th className="text-right text-ink-faint">W. Actual</th>
                    <th className="text-right">Water (m³)</th>
                    <th className="text-right">Water ₱</th>
                    <th className="text-right">Add-ons</th>
                    <th className="text-right">RW Total</th>
                  </>
                ) : (
                  <>
                    <th className="text-right text-ink-faint">E. Prev Rdg</th>
                    <th className="text-right text-ink-faint">E. Actual</th>
                    <th className="text-right">Elec (kWh)</th>
                    <th className="text-right">Elec ₱</th>
                    <th className="text-right">Add-ons</th>
                    <th className="text-right">Elec Total</th>
                  </>
                )}
              </tr>
            </thead>
            <tbody>
              {perTenant.map(t => {
                const rwTotal   = (t.rent || 0) + (t.water || 0) + (t.addonRentWater || 0)
                const elecTotal = (t.elec  || 0) + (t.addonElectric || 0)
                return (
                  <tr key={t.id}>
                    <td className="td-name">
                      {t.name}
                      {t.settled     && <span className="badge oor ml-1.5">moved out</span>}
                      {t.transferred && <span className="badge leased ml-1.5" title="Mid-period room transfer — readings show old room (period start → transfer date); amounts include both rooms">XFER</span>}
                      {t.wholeRoom   && <span className="badge ml-1.5 bg-info-bg text-info-text" style={{border:'1px solid var(--info-border)'}} title="Single tenant renting the entire room — all bed rates combined, full room utilities">ROOM</span>}
                    </td>
                    <td>{t.transferred && t.fromRoomNo ? `${t.fromRoomNo}→${t.room_no}` : t.room_no}</td>
                    <td><strong>{t.bed}</strong></td>
                    {billCat === 'RENT_WATER' ? (
                      <>
                        <td className="text-right">{t.rent ? peso(t.rent) : '—'}</td>
                        <td className="text-right text-ink-faint tabular-nums" title={t.transferred ? 'Old room period-start reading' : 'Period start reading'}>{t.waterPrev != null ? m3(t.waterPrev) : '—'}</td>
                        <td className="text-right text-ink-faint tabular-nums" title={t.transferred ? 'Transfer reading (as entered)' : 'Period end reading'}>{t.waterCurr != null ? m3(t.waterCurr) : '—'}</td>
                        <td className="text-right text-ink-faint">
                          {m3(t.waterCons)}
                          {t.transferred && t.oldWaterCons > 0 && (
                            <div className="text-[10px] text-ink-faint leading-[1.3] mt-0.5 tabular-nums">
                              R{t.fromRoomNo}:{m3(t.oldWaterCons)}<br />R{t.room_no}:{m3(t.waterCons - t.oldWaterCons)}
                            </div>
                          )}
                        </td>
                        <td className="text-right">
                          {peso(t.water)}
                          {t.transferred && t.oldWater > 0 && (
                            <div className="text-[10px] text-ink-faint leading-[1.3] mt-0.5 tabular-nums">
                              R{t.fromRoomNo}:{peso(t.oldWater)}<br />R{t.room_no}:{peso(t.water - t.oldWater)}
                            </div>
                          )}
                          {splitFlags.has(`${t.room_id}|WATER`) && <Settings2 size={11} title="custom split" className="inline ml-1 text-info-text" />}
                        </td>
                        <td className="text-right whitespace-nowrap">
                          {(t.addonRentWater || 0) > 0
                            ? <span title={(t.addons || []).filter(a => a.bill_on !== 'ELECTRIC').map(a => `${a.label}: ${peso(a.amount)}${a.recurring ? '' : ' (one-time)'}`).join('\n')}>
                                {peso(t.addonRentWater)}
                              </span>
                            : <span className="text-ink-faint">—</span>}
                          <button className="btn-xs blue ml-1.5" onClick={() => setAddonTenant(t)}><PlusCircle size={10} /></button>
                        </td>
                        <td className="td-rate text-right">{peso(rwTotal)}</td>
                      </>
                    ) : (
                      <>
                        <td className="text-right text-ink-faint tabular-nums" title={t.transferred ? 'Old room period-start reading' : 'Period start reading'}>{t.elecPrev != null ? m3(t.elecPrev) : '—'}</td>
                        <td className="text-right text-ink-faint tabular-nums" title={t.transferred ? 'Transfer reading (as entered)' : 'Period end reading'}>{t.elecCurr != null ? m3(t.elecCurr) : '—'}</td>
                        <td className="text-right text-ink-faint">
                          {m3(t.elecCons)}
                          {t.transferred && t.oldElecCons > 0 && (
                            <div className="text-[10px] text-ink-faint leading-[1.3] mt-0.5 tabular-nums">
                              R{t.fromRoomNo}:{m3(t.oldElecCons)}<br />R{t.room_no}:{m3(t.elecCons - t.oldElecCons)}
                            </div>
                          )}
                        </td>
                        <td className="text-right">
                          {peso(t.elec)}
                          {t.transferred && t.oldElec > 0 && (
                            <div className="text-[10px] text-ink-faint leading-[1.3] mt-0.5 tabular-nums">
                              R{t.fromRoomNo}:{peso(t.oldElec)}<br />R{t.room_no}:{peso(t.elec - t.oldElec)}
                            </div>
                          )}
                          {splitFlags.has(`${t.room_id}|ELECTRIC`) && <Settings2 size={11} title="custom split" className="inline ml-1 text-amber-500" />}
                        </td>
                        <td className="text-right whitespace-nowrap">
                          {(t.addonElectric || 0) > 0
                            ? <span title={(t.addons || []).filter(a => a.bill_on === 'ELECTRIC').map(a => `${a.label}: ${peso(a.amount)}${a.recurring ? '' : ' (one-time)'}`).join('\n')}>
                                {peso(t.addonElectric)}
                              </span>
                            : <span className="text-ink-faint">—</span>}
                          <button className="btn-xs blue ml-1.5" onClick={() => setAddonTenant(t)}><PlusCircle size={10} /></button>
                        </td>
                        <td className="td-rate text-right">{peso(elecTotal)}</td>
                      </>
                    )}
                  </tr>
                )
              })}
            </tbody>
            <tfoot>
              {billCat === 'RENT_WATER' ? (
                <tr className="bg-surface-2 border-t-2 border-navy-700">
                  <td colSpan={3} className="text-[11px] font-extrabold text-ink-muted uppercase tracking-wide">Totals</td>
                  <td className="text-right font-extrabold">{peso(totals.rent)}</td>
                  <td colSpan={2}></td>
                  <td></td>
                  <td className="text-right font-extrabold">{peso(totals.water)}</td>
                  <td className="text-right font-extrabold">{peso(perTenant.reduce((s,t) => s + (t.addonRentWater||0), 0))}</td>
                  <td className="text-right font-extrabold text-navy-500">{peso(perTenant.reduce((s,t) => s + (t.rent||0) + (t.water||0) + (t.addonRentWater||0), 0))}</td>
                </tr>
              ) : (
                <tr className="bg-surface-2 border-t-2 border-amber-500">
                  <td colSpan={3} className="text-[11px] font-extrabold text-ink-muted uppercase tracking-wide">Totals</td>
                  <td colSpan={2}></td>
                  <td></td>
                  <td className="text-right font-extrabold">{peso(totals.elec)}</td>
                  <td className="text-right font-extrabold">{peso(perTenant.reduce((s,t) => s + (t.addonElectric||0), 0))}</td>
                  <td className="text-right font-extrabold text-warning-text">{peso(perTenant.reduce((s,t) => s + (t.elec||0) + (t.addonElectric||0), 0))}</td>
                </tr>
              )}
            </tfoot>
          </table>
        </div>
      ) : view === 'rooms' ? (
        <div className="grid gap-3" style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(320px, 1fr))' }}>
          {perRoom.map(r => (
            <div key={r.room_id} className="card p-4">
              <div className="flex justify-between items-center mb-3">
                <div className="text-[14px] font-bold text-ink">
                  Room {r.room_no}
                  <span className="text-[11px] font-normal text-ink-faint ml-1">· {r.room_type}</span>
                </div>
                <button className="btn-xs blue" onClick={() => setSplitRoom(r)}><Settings2 size={10} /> Split</button>
              </div>
              {[['Water', r.water, 'WATER', <Droplets key="w" size={12} />], ['Electric', r.electric, 'ELECTRIC', <Zap key="e" size={12} />]].map(([label, u, util, icon]) => (
                <div key={label} className="mb-3 text-[12px]">
                  <div className="font-semibold text-ink-secondary mb-1 flex items-center gap-1.5">
                    {icon}{label}
                    <span className="font-normal text-ink-faint"> · {u.segments} segment(s)</span>
                    {splitFlags.has(`${r.room_id}|${util}`) && <span className="badge leased ml-1.5">custom split</span>}
                  </div>
                  <div className="flex justify-between text-ink-muted mb-0.5">
                    <span>Room: {m3(u.roomCons)} → {peso(u.roomAmt)}</span>
                    <span>Tenants: {peso(u.sum)}{u.unbilled > 0.01 ? ` (+${peso(u.unbilled)} vacant)` : ''}</span>
                  </div>
                  <div className={`font-semibold ${u.ok ? 'text-success-text' : 'text-danger-text'}`}>
                    {u.ok ? 'Reconciled' : 'Mismatch — check readings'}
                  </div>
                </div>
              ))}
            </div>
          ))}
        </div>
      ) : (
        <ReportView totals={totals} perTenant={perTenant} cutoffName={cutoff?.name} />
      )}

      {/* Existing interim readings */}
      {interims.length > 0 && (
        <div className="card mt-4 p-4">
          <div className="text-[10px] font-bold text-ink-faint uppercase tracking-widest mb-3">Move-out readings this cutoff</div>
          {interims.map(ir => {
            const room = bill.find(b => b.room_id === ir.room_id)
            return (
              <div key={ir.id} className="flex justify-between items-center text-[13px] py-2 border-b border-line-subtle last:border-0">
                <span className="text-ink-secondary">
                  Room {room?.room_no || ir.room_id} · {ir.utility} · {ir.reading_date} · reading <strong>{ir.reading_value}</strong>
                </span>
                <button className="btn-xs red" onClick={() => setConfirmDelete(ir)}>Delete</button>
              </div>
            )
          })}
        </div>
      )}

      {confirmDelete && (
        <ConfirmDeleteInterimModal
          reading={confirmDelete}
          room={bill.find(b => b.room_id === confirmDelete.room_id)}
          onClose={() => setConfirmDelete(null)}
          onDeleted={async () => { setConfirmDelete(null); await load(); show('Interim reading deleted.', 'success') }}
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

      {ToastEl}
    </div>
  )
}


// ── Confirm / approve interim reading delete ──────────────────────────────────
function ConfirmDeleteInterimModal({ reading, room, onClose, onDeleted, show }) {
  const { isAdmin } = useAuth()
  const [reason, setReason]   = useState('')
  const [busy, setBusy]       = useState(false)
  const [submitted, setSubmitted] = useState(false)
  const [error, setError]     = useState('')

  const roomNo = room?.room_no || reading.room_id

  async function confirmDelete() {
    setBusy(true)
    try {
      await deleteInterimReading(reading.id)
      onDeleted()
    } catch (e) { show(e.message, 'error'); setBusy(false) }
  }

  async function submitForApproval() {
    if (!reason.trim()) { setError('Please provide a reason.'); return }
    setError('')
    setBusy(true)
    try {
      await requestApproval({
        entityType: 'INTERIM_READING',
        entityId:   String(reading.id),
        fieldName:  'interim_reading_delete',
        oldValue: {
          room_id: reading.room_id, room_no: roomNo, utility: reading.utility,
          reading_date: reading.reading_date, reading_value: reading.reading_value,
        },
        newValue: {
          _action: 'delete_interim_reading', _reading_id: reading.id, _room_no: roomNo,
          utility: reading.utility, reading_date: reading.reading_date, reading_value: reading.reading_value,
        },
        reason: reason.trim(),
      })
      setSubmitted(true)
    } catch (e) { setError(e.message) }
    setBusy(false)
  }

  if (submitted) {
    return (
      <div className="overlay" onClick={e => e.stopPropagation()}>
        <div className="modal modal-sm">
          <div className="modal-head">
            <h3><span className="inline-flex items-center gap-1.5"><Trash2 size={16} /> Delete Interim Reading</span></h3>
            <button className="btn-close" onClick={onClose}><X size={16} /></button>
          </div>
          <div className="modal-body text-center py-8">
            <Clock size={36} className="mx-auto mb-3 text-amber-400" />
            <h4 className="text-[15px] font-semibold text-ink mb-2">Sent for Approval</h4>
            <p className="text-[13px] text-ink-muted leading-relaxed">
              The deletion request has been submitted to an admin for review.
              The reading remains active and still feeds billing until approved.
            </p>
          </div>
          <div className="modal-foot">
            <button className="btn primary" onClick={onClose}>Close</button>
          </div>
        </div>
      </div>
    )
  }

  return (
    <div className="overlay" onClick={e => e.stopPropagation()}>
      <div className="modal modal-sm">
        <div className="modal-head">
          <h3><span className="inline-flex items-center gap-1.5"><Trash2 size={16} /> Delete Interim Reading</span></h3>
          <button className="btn-close" onClick={onClose}><X size={16} /></button>
        </div>
        <div className="modal-body space-y-4">
          <div className="bg-danger-bg border border-danger-border rounded-xl px-4 py-3 text-[13px]">
            <div className="font-semibold text-ink">Room {roomNo} · {reading.utility}</div>
            <div className="text-ink-muted mt-0.5">Reading date: {reading.reading_date} · Value: {reading.reading_value}</div>
          </div>
          <p className="text-[13px] text-ink-secondary">Are you sure you want to delete this interim reading?</p>

          {!isAdmin && (
            <div className="space-y-3">
              <div className="bg-warning-bg border border-warning-border rounded-xl px-3 py-2.5 text-[12px] text-warning-text">
                <AlertTriangle size={13} className="shrink-0 mt-px inline mr-1" /> Deleting an interim reading requires admin approval.
              </div>
              <div className="fg">
                <label>Reason for deletion <span className="text-danger-text">*</span></label>
                <textarea
                  rows={2}
                  value={reason}
                  onChange={e => { setError(''); setReason(e.target.value) }}
                  placeholder="State the reason for deleting this reading…"
                />
              </div>
            </div>
          )}

          {error && (
            <div className="p-3 bg-danger-bg text-danger-text text-[13px] rounded-xl border border-danger-border">{error}</div>
          )}
        </div>
        <div className="modal-foot">
          <button className="btn secondary" onClick={onClose}>Cancel</button>
          {isAdmin ? (
            <button className="btn danger" disabled={busy} onClick={confirmDelete}>
              {busy ? 'Deleting…' : 'Confirm Delete'}
            </button>
          ) : (
            <button className="btn danger" disabled={busy} onClick={submitForApproval}>
              {busy ? 'Submitting…' : 'Submit for Approval'}
            </button>
          )}
        </div>
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
    <div className="overlay" onClick={e => e.stopPropagation()}>
      <div className="modal modal-sm">
        <div className="modal-head">
          <h3 className="flex items-center gap-2"><Settings2 size={15} className="text-ink-faint" /> Custom Split — Room {room.room_no}</h3>
          <button className="btn-close" onClick={onClose}><X size={16} /></button>
        </div>
        <div className="modal-body space-y-4">
          {/* Utility tabs */}
          <div className="flex gap-1 p-1 bg-surface-3 rounded-lg">
            {['WATER', 'ELECTRIC'].map(u => (
              <button key={u} onClick={() => setUtil(u)}
                className={`flex-1 py-2 rounded-md text-[12px] font-semibold transition-all flex items-center justify-center gap-1.5 ${
                  util === u
                    ? u === 'WATER' ? 'bg-blue-600 text-white shadow-sm' : 'bg-amber-500 text-white shadow-sm'
                    : 'text-ink-muted hover:text-ink-secondary'
                }`}>
                {u === 'WATER' ? <><Droplets size={13} /> Water</> : <><Zap size={13} /> Electric</>}
              </button>
            ))}
          </div>

          {roomTenants.length === 0 ? (
            <div className="empty"><p>No active tenants in this room.</p></div>
          ) : (
            <div className="space-y-1">
              {roomTenants.map(t => (
                <div key={t.id} className="flex items-center gap-3 py-2 border-b border-line-subtle last:border-0">
                  <div className="flex-1 text-[13px] text-ink">
                    {t.name} <span className="text-ink-faint">· Bed {t.beds?.bed_letter}</span>
                  </div>
                  <input
                    type="number" step="0.1" value={cur[t.id] ?? 0}
                    onChange={e => setVal(t.id, e.target.value)}
                    className="w-20 px-2 py-1.5 border border-line rounded-lg text-[13px] text-right
                               focus:outline-none focus:ring-2 focus:ring-navy-700/25 focus:border-navy-600"
                  />
                  <span className="text-[13px] text-ink-muted w-4">%</span>
                </div>
              ))}
              <div className={`flex justify-between pt-2 font-bold text-[13px] ${ok ? 'text-success-text' : 'text-danger-text'}`}>
                <span>Total</span>
                <span>{sum.toFixed(1)}% {ok ? '✓' : '(must be 100%)'}</span>
              </div>
              <button className="btn-xs gray mt-2" onClick={resetEqual}>Reset to equal</button>
              <p className="text-[11px] text-ink-faint mt-2 leading-relaxed">
                Applies to <strong>{util === 'WATER' ? 'water' : 'electric'}</strong> only for this cutoff. Switch tabs to set the other. "Use default" reverts to the per-day split.
              </p>
            </div>
          )}
        </div>
        <div className="modal-foot">
          <button className="btn secondary" onClick={onClose}>Cancel</button>
          <button className="btn secondary" disabled={busy} onClick={() => save(true)}>Use default</button>
          <button
            className={`btn ${ok ? 'primary' : 'secondary'}`}
            disabled={busy || !roomTenants.length || !ok}
            onClick={() => save(false)}
          >
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

  return (
    <div className="overlay" onClick={e => e.stopPropagation()}>
      <div className="modal">
        <div className="modal-head">
          <h3 className="flex items-center gap-2"><PlusCircle size={15} className="text-ink-faint" /> Add-ons — {tenant.name}</h3>
          <button className="btn-close" onClick={onClose}><X size={16} /></button>
        </div>
        <div className="modal-body space-y-4">
          {/* Existing add-ons */}
          {mine.length > 0 && (
            <div>
              {mine.map(a => (
                <div key={a.id} className="flex items-center gap-2 py-2.5 border-b border-line-subtle last:border-0 text-[13px]">
                  <div className="flex-1">
                    <span className="font-semibold text-ink">{a.label}</span>
                    <span className="text-ink-muted ml-1.5">· {peso(a.amount)}</span>
                    <span className={`badge ml-1.5 ${a.bill_on === 'ELECTRIC' ? 'bg-warning-bg text-warning-text' : 'bg-info-bg text-info-text'}`}>
                      {a.bill_on === 'ELECTRIC' ? 'Electric' : 'Rent+Water'}
                    </span>
                    <span className={`badge ml-1 ${a.recurring ? 'bg-success-bg text-success-text' : 'bg-surface-3 text-ink-muted'}`}>
                      {a.recurring ? 'recurring' : 'this cutoff'}
                    </span>
                  </div>
                  <button className="btn-xs red" disabled={busy} onClick={() => remove(a.id)}>Delete</button>
                </div>
              ))}
            </div>
          )}

          {/* New add-on form */}
          <div className="form-section border-b border-line-subtle pb-2">Add a charge</div>
          <div className="form-grid">
            <div className="fg">
              <label>Type</label>
              <select value={f.category} onChange={e => pickCat(e.target.value)}>
                <option value="PARKING_CAR">Car Parking (₱3,500)</option>
                <option value="PARKING_MC">Motorcycle Parking (₱1,500)</option>
                <option value="AIRCON">Aircon (hours × rate)</option>
                <option value="OTHER">Other</option>
              </select>
            </div>
            <div className="fg">
              <label>Label</label>
              <input type="text" value={f.label} onChange={e => set('label', e.target.value)} placeholder="e.g. Car Parking" />
            </div>

            {f.aircon ? (
              <>
                <div className="fg"><label>Hours</label><input type="number" step="0.1" value={f.hours} onChange={e => set('hours', e.target.value)} /></div>
                <div className="fg"><label>Rate (₱/hr)</label><input type="number" step="0.01" value={f.rate} onChange={e => set('rate', e.target.value)} /></div>
              </>
            ) : (
              <div className="fg"><label>Amount (₱)</label><input type="number" step="0.01" value={f.amount} onChange={e => set('amount', e.target.value)} /></div>
            )}

            <div className="fg">
              <label>Bill on</label>
              <select value={f.bill_on} onChange={e => set('bill_on', e.target.value)}>
                <option value="RENT_WATER">Rent + Water bill</option>
                <option value="ELECTRIC">Electricity bill</option>
              </select>
            </div>
            <div className="fg justify-end">
              <label className="flex gap-2 items-center cursor-pointer">
                <input type="checkbox" checked={f.recurring} onChange={e => set('recurring', e.target.checked)} className="w-4 h-4 rounded accent-navy-700" />
                <span>Recurring (every cutoff)</span>
              </label>
            </div>
          </div>

          <div className="text-[13px] text-ink-secondary bg-surface-2 rounded-lg px-3 py-2">
            Amount: <strong className="text-navy-500">{peso(computedAmount)}</strong>
            {!f.recurring && <span className="text-ink-faint ml-2">· applies to {cutoffName} only</span>}
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
  const counts = perTenant.reduce((c, t) => {
    if (t.special) c.special++; else c.bed++
    return c
  }, { bed: 0, special: 0 })

  const tiles = [
    { label: 'Rent',        value: peso(totals.rent),   color: 'var(--navy)' },
    { label: 'Water',       value: peso(totals.water),  color: 'var(--blue)' },
    { label: 'Electricity', value: peso(totals.elec),   color: 'var(--amber)' },
    { label: 'Add-ons',     value: peso(totals.addons), color: 'var(--navy)' },
    { label: 'Grand Total', value: peso(totals.total),  color: 'var(--green)' },
  ]

  return (
    <div>
      <p className="text-[12px] text-ink-faint mb-4">
        Collections summary · {cutoffName} · {counts.bed} bed tenant(s) + {counts.special} special/commercial
      </p>
      <div className="stats-grid">
        {tiles.map(t => (
          <div key={t.label} className="stat-card" style={{ borderTopColor: t.color }}>
            <div className="stat-label">{t.label}</div>
            <div className="stat-value text-[20px]">{t.value}</div>
          </div>
        ))}
      </div>
      <div className="card p-4 mt-2">
        {[
          ['Rent collections',    peso(totals.rent),   false],
          ['Water charging',      peso(totals.water),  false],
          ['Electricity charging',peso(totals.elec),   false],
          ['Add-ons',             peso(totals.addons), false],
        ].map(([label, val]) => (
          <div key={label} className="flex justify-between text-[14px] py-1.5 border-b border-line-subtle last:border-0">
            <span className="text-ink-secondary">{label}</span>
            <strong className="text-ink">{val}</strong>
          </div>
        ))}
        <div className="flex justify-between text-[16px] pt-3 mt-2 border-t-2 border-navy-500 font-extrabold text-navy-500">
          <span>TOTAL BILLED</span>
          <span>{peso(totals.total)}</span>
        </div>
      </div>
    </div>
  )
}
