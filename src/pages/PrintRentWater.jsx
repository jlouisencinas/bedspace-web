import { useState, useEffect, useMemo } from 'react'
import { useSearchParams, useNavigate, Link } from 'react-router-dom'
import { fetchCutoffs } from '../lib/supabase'
import { loadCutoffBillingInputs, computeCutoffBilling, NO_ADVANCE_DATA } from '../lib/cutoffBilling'
import { rentWaterRows, rentWaterProps, rentWaterDefaultBillingDate, REPRINT_BANNER, pickStatements, parseIdList } from '../lib/monthlyStatement'
import { monthlyBillNo } from '../lib/billNumber'
import Statement from '../components/Statement'

const todayIso = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Manila', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date())

const EMPTY_INPUTS = { bill: [], interims: [], tenants: [], splits: [], addons: [], areas: [], transfers: [], advData: NO_ADVANCE_DATA }

export default function PrintRentWater() {
  const [params] = useSearchParams()
  const navigate = useNavigate()
  const cutoffId = Number(params.get('cutoff'))
  // ?tenant=<id>: reprint of one tenant's statement (from the tenant profile)
  const tenantId = params.get('tenant') ? Number(params.get('tenant')) : null
  // ?only=<ids> / ?skip=<ids>: a selection from Billing (held tenants print later).
  const onlyKey = params.get('only') || '', skipKey = params.get('skip') || ''
  const only = useMemo(() => parseIdList(onlyKey), [onlyKey])
  const skip = useMemo(() => parseIdList(skipKey), [skipKey])
  const selection = tenantId == null && (only.length > 0 || skip.length > 0)

  const [cutoff, setCutoff] = useState(null)
  const [inputs, setInputs] = useState(EMPTY_INPUTS)
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState('')

  const [billingDate, setBillingDate] = useState('')
  const [preparedBy, setPreparedBy]   = useState('')
  const [showReprint, setShowReprint] = useState(true)

  useEffect(() => {
    (async () => {
      try {
        const cs = await fetchCutoffs()
        const c = cs.find(x => x.id === cutoffId)
        setCutoff(c)
        if (c) {
          setInputs(await loadCutoffBillingInputs(c))
          setBillingDate(rentWaterDefaultBillingDate(c))
        }
      } catch (e) { console.error(e); setLoadError(e?.message || String(e)) }
      setLoading(false)
    })()
  }, [cutoffId])

  const { perTenant, credits } = useMemo(() => computeCutoffBilling(cutoff, inputs), [cutoff, inputs])

  const roomMap = useMemo(() => {
    const m = {}; inputs.bill.forEach(b => { m[b.room_id] = b }); return m
  }, [inputs.bill])

  const allStatements = useMemo(() => rentWaterRows(perTenant), [perTenant])
  const statements = useMemo(() => pickStatements(allStatements, { tenant: tenantId, only, skip }), [allStatements, tenantId, only, skip])
  const skippedNames = useMemo(() => {
    const shown = new Set(statements.map(x => x.t.id))
    return allStatements.filter(t => !shown.has(t.id)).map(t => t.name)
  }, [allStatements, statements])

  if (loading) return <div className="loading-screen"><div className="spinner" /></div>
  if (!cutoff) return <div className="page"><p>{loadError ? `Could not load this cutoff: ${loadError}` : 'Cutoff not found.'} <Link to="/billing">Back</Link></p></div>

  const advData = inputs.advData
  const banner = tenantId != null && showReprint ? REPRINT_BANNER(todayIso()) : undefined

  const propsFor = (t, billNo, copyLabel) => rentWaterProps({
    t, cutoff, roomRow: roomMap[t.room_id], splits: inputs.splits, credit: credits.get(t.id),
    billNo, copyLabel, billingDate, preparedBy, banner,
  })

  return (
    <div style={{ background: '#F0F4F8', minHeight: '100vh', padding: '16px 0' }}>
      <div className="no-print" style={{ maxWidth: 760, margin: '0 auto 16px', display: 'flex', gap: 12, flexWrap: 'wrap', alignItems: 'flex-end', background: '#fff', padding: 14, borderRadius: 10, border: '1px solid #e2e8f0' }}>
        {tenantId != null
          ? <button type="button" className="btn secondary" onClick={() => navigate(-1)}>← Back</button>
          : <Link to="/billing" className="btn secondary">← Back</Link>}
        <div className="fg" style={{ maxWidth: 150 }}><label>Billing Date</label>
          <input type="date" value={billingDate} onChange={e => setBillingDate(e.target.value)} /></div>
        <div className="fg" style={{ maxWidth: 180 }}><label>Prepared by</label>
          <input type="text" value={preparedBy} onChange={e => setPreparedBy(e.target.value)} placeholder="Name" /></div>
        {tenantId != null && (
          <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12, color: '#334155' }}>
            <input type="checkbox" checked={showReprint} onChange={e => setShowReprint(e.target.checked)} /> Show reprint notice
          </label>
        )}
        <div style={{ marginLeft: 'auto', display: 'flex', gap: 8, alignItems: 'center' }}>
          <span style={{ fontSize: 12, color: '#64748B' }}>
            {selection ? `${statements.length} of ${allStatements.length} bills` : `${statements.length} bill(s)`} · Rent + Water{tenantId != null ? ' · reprint' : ''}
            {selection && only.length === 0 && skippedNames.length > 0 && <> · skipped: {skippedNames.join(', ')}</>}
          </span>
          <button className="btn primary" onClick={() => window.print()}>🖨 Print / Save PDF</button>
        </div>
      </div>

      {advData.error && (
        <div className="no-print" style={{ maxWidth: 760, margin: '0 auto 16px', background: '#fff7ed', border: '1px solid #fdba74', color: '#9a3412', padding: 12, borderRadius: 10, fontSize: 13 }}>
          Advance data could not be loaded ({advData.error}). Do not print 2nd-to-last bills until this is fixed: they would show the full rent instead of the rent up to the advance month.
        </div>
      )}

      {loadError && (
        <div className="no-print" style={{ maxWidth: 760, margin: '0 auto 16px', background: '#fef2f2', border: '1px solid #fca5a5', color: '#991b1b', padding: 12, borderRadius: 10, fontSize: 13 }}>
          Could not load this cutoff: {loadError}. No statements are shown; reload the page before printing.
        </div>
      )}

      {!loadError && tenantId != null && statements.length === 0 && (
        <div className="no-print" style={{ maxWidth: 760, margin: '0 auto 16px', background: '#fff', border: '1px solid #e2e8f0', color: '#334155', padding: 12, borderRadius: 10, fontSize: 13 }}>
          No Rent + Water statement for this tenant on {cutoff.name} (see the tenant profile).
        </div>
      )}

      {statements.map(({ t }) => {
        const billNo = monthlyBillNo(t.room_no, cutoff) ?? ''
        return (
          <div className="a4page" key={t.id}>
            <Statement {...propsFor(t, billNo, "Tenant's Copy")} />
            <div className="cutline" />
            <Statement {...propsFor(t, billNo, "Owner's Copy")} />
          </div>
        )
      })}
    </div>
  )
}
