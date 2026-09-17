import { useState, useEffect, useMemo } from 'react'
import {
  fetchCutoffs, fetchTenants,
  fetchPaymentsForCutoff, fetchUtilityBill, fetchInterimReadings,
  fetchSplits, fetchAddons, fetchAreaReadings,
} from '../lib/supabase'
import { computeBilling } from '../lib/billing'
import { getCachedBilling, cacheBilling } from '../lib/billingCache'
import { buildPaymentMonitoring } from '../lib/collectionsSummary'
import { useToast } from '../components/Toast'
import SearchInput from '../components/SearchInput'
import { TrendingUp, AlertTriangle, Wallet } from 'lucide-react'

function fmt(n) {
  return '₱' + Number(n || 0).toLocaleString('en-PH', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
}
function fmtDate(d) {
  if (!d) return '—'
  return new Date(d).toLocaleDateString('en-PH', { month: 'short', day: 'numeric', year: 'numeric' })
}

export default function PaymentMonitoring() {
  const [cutoffs,   setCutoffs]   = useState([])
  const [cutoffId,  setCutoffId]  = useState(null)
  const [tenants,   setTenants]   = useState([])
  const [billingPerTenant, setBillingPerTenant] = useState([])
  const [cutoffPayments,   setCutoffPayments]   = useState([])
  const [loading,   setLoading]   = useState(true)
  const [search,    setSearch]    = useState('')
  const [unpaidOnly,setUnpaidOnly]= useState(false)
  const [sortKey,   setSortKey]   = useState('outstanding')
  const [sortDir,   setSortDir]   = useState('desc')
  const { show, ToastEl } = useToast()

  useEffect(() => { loadCutoffs() }, [])
  useEffect(() => { if (cutoffId) loadBilling(cutoffId) }, [cutoffId])

  async function loadCutoffs() {
    setLoading(true)
    try {
      const cuts = await fetchCutoffs()
      setCutoffs(cuts)
      const active = cuts.find(c => c.is_active) || cuts[0] || null
      setCutoffId(active?.id ?? null)
      if (!active) setLoading(false)
    } catch(e) { show(e.message, 'error'); setLoading(false) }
  }

  async function loadBilling(id) {
    setLoading(true)
    try {
      const cutoff = cutoffs.find(c => c.id === id)
      const allTenants = await fetchTenants()
      setTenants(allTenants)

      const cutoffPays = await fetchPaymentsForCutoff(id)
      setCutoffPayments(cutoffPays)

      const cached = getCachedBilling(id)
      if (cached) {
        setBillingPerTenant(cached)
      } else {
        const [bill, ir, sp, ad, ar] = await Promise.all([
          fetchUtilityBill(id),
          fetchInterimReadings(id),
          fetchSplits(id),
          fetchAddons(id),
          fetchAreaReadings(id),
        ])
        if (bill.length) {
          const { perTenant } = computeBilling(cutoff, bill, ir, allTenants, sp, ad, ar)
          cacheBilling(id, perTenant)
          setBillingPerTenant(perTenant)
        } else {
          setBillingPerTenant([])
        }
      }
    } catch(e) { show(e.message, 'error') }
    setLoading(false)
  }

  const activeCutoff   = cutoffs.find(c => c.is_active) || null
  const selectedCutoff = cutoffs.find(c => c.id === cutoffId) || null
  const isHistorical   = selectedCutoff && !selectedCutoff.is_active

  const rows = useMemo(() =>
    buildPaymentMonitoring(selectedCutoff, tenants, billingPerTenant, cutoffPayments)
  , [selectedCutoff, tenants, billingPerTenant, cutoffPayments])

  const filtered = useMemo(() => {
    const q = search.toLowerCase()
    return rows.filter(r => {
      if (unpaidOnly && r.outstanding <= 0) return false
      if (q && !(r.name || '').toLowerCase().includes(q) && !String(r.room_no || '').toLowerCase().includes(q)) return false
      return true
    })
  }, [rows, search, unpaidOnly])

  const sorted = useMemo(() => {
    const val = (r, key) => {
      switch (key) {
        case 'name':        return (r.name || '').toLowerCase()
        case 'room':        return parseInt(r.room_no) || 0
        case 'rentWater':   return r.billed.rentWater
        case 'electric':    return r.billed.electric
        case 'addons':      return r.billed.addons
        case 'billedTotal': return r.billed.total
        case 'paid':        return r.paid.total
        case 'outstanding': return r.outstanding
        case 'lastPayment': return r.lastPaymentDate || ''
        default:            return 0
      }
    }
    return [...filtered].sort((a, b) => {
      const av = val(a, sortKey), bv = val(b, sortKey)
      const c = av < bv ? -1 : av > bv ? 1 : 0
      return sortDir === 'asc' ? c : -c
    })
  }, [filtered, sortKey, sortDir])

  function handleSort(key) {
    if (key === sortKey) setSortDir(d => d === 'asc' ? 'desc' : 'asc')
    else { setSortKey(key); setSortDir(key === 'name' || key === 'room' ? 'asc' : 'desc') }
  }
  const arrow = key => key === sortKey ? (sortDir === 'asc' ? ' ▲' : ' ▼') : ''

  if (loading && !cutoffs.length) return (
    <div className="loading-screen"><div className="spinner" /></div>
  )

  return (
    <div className="page">
      {/* ── Header ── */}
      <div className="page-header">
        <div>
          <h1 className="page-title flex items-center gap-2"><TrendingUp size={18} className="text-navy-500" /> Payment Monitoring</h1>
          <p className="page-sub">Billed vs. actual collections, per tenant, for a billing period</p>
        </div>
        {cutoffs.length > 0 && (
          <select
            value={cutoffId ?? ''}
            onChange={e => { setLoading(true); setCutoffId(Number(e.target.value)) }}
            className="px-3 py-2 border border-line rounded-lg text-[13px] bg-surface focus:outline-none focus:ring-2 focus:ring-navy-700/25 focus:border-navy-600 transition-colors"
          >
            {cutoffs.map(c => (
              <option key={c.id} value={c.id}>{c.name}{c.is_active ? ' (active)' : ''}</option>
            ))}
          </select>
        )}
      </div>

      {!selectedCutoff ? (
        <div className="card mt-4">
          <div className="empty">
            <Wallet size={32} className="mx-auto mb-3 text-ink-faint" />
            <p>No active cutoff. Open one in Utilities first.</p>
          </div>
        </div>
      ) : (
        <>
          {isHistorical && (
            <div className="mt-4 px-4 py-3 bg-warning-bg border border-warning-border rounded-xl text-[13px] text-warning-text flex items-start gap-2">
              <AlertTriangle size={15} className="shrink-0 mt-0.5 text-amber-500" />
              Historical cutoffs may not reflect tenants who have since moved out — see Reports for the saved period-end figures.
            </div>
          )}

          {/* ── Toolbar ── */}
          <div className="toolbar mt-4">
            <SearchInput
              placeholder="Search name, room…"
              value={search} onChange={e => setSearch(e.target.value)}
              className="w-60"
            />
            <label className="flex items-center gap-1.5 text-[13px] text-ink-secondary cursor-pointer select-none">
              <input type="checkbox" checked={unpaidOnly} onChange={e => setUnpaidOnly(e.target.checked)} />
              Unpaid only
            </label>
          </div>

          {loading ? (
            <div className="loading-screen"><div className="spinner" /></div>
          ) : (
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th onClick={() => handleSort('name')}        className="cursor-pointer select-none">Tenant{arrow('name')}</th>
                    <th onClick={() => handleSort('room')}        className="cursor-pointer select-none">Room / Bed{arrow('room')}</th>
                    <th onClick={() => handleSort('rentWater')}   className="cursor-pointer select-none">Rent + Water{arrow('rentWater')}</th>
                    <th onClick={() => handleSort('electric')}    className="cursor-pointer select-none">Electric{arrow('electric')}</th>
                    <th onClick={() => handleSort('addons')}      className="cursor-pointer select-none">Add-ons{arrow('addons')}</th>
                    <th onClick={() => handleSort('billedTotal')} className="cursor-pointer select-none">Billed Total{arrow('billedTotal')}</th>
                    <th onClick={() => handleSort('paid')}        className="cursor-pointer select-none">Paid{arrow('paid')}</th>
                    <th onClick={() => handleSort('outstanding')} className="cursor-pointer select-none">Outstanding{arrow('outstanding')}</th>
                    <th onClick={() => handleSort('lastPayment')} className="cursor-pointer select-none">Last Payment{arrow('lastPayment')}</th>
                  </tr>
                </thead>
                <tbody>
                  {sorted.length === 0 ? (
                    <tr><td colSpan={9}><div className="empty"><p>No matching tenants.</p></div></td></tr>
                  ) : sorted.map(r => (
                    <tr key={r.id}>
                      <td className="td-name">{r.name}{r.wholeRoom && <span className="ml-1.5 text-[10px] font-bold text-navy-600 bg-navy-50 border border-navy-100 px-1.5 py-0.5 rounded">Whole Room</span>}</td>
                      <td className="text-[12px] text-ink-muted">Rm {r.room_no || '—'}{r.bed_letter ? ` · ${r.bed_letter}` : ''}</td>
                      <td>{fmt(r.billed.rentWater)}</td>
                      <td>{fmt(r.billed.electric)}</td>
                      <td>{fmt(r.billed.addons)}</td>
                      <td className="font-semibold text-ink">{fmt(r.billed.total)}</td>
                      <td className="text-success-text font-medium">{fmt(r.paid.total)}</td>
                      <td>
                        {r.outstanding > 0
                          ? <span className="font-semibold text-danger-text">{fmt(r.outstanding)}</span>
                          : r.credit > 0
                            ? <span className="font-semibold text-info-text">+{fmt(r.credit)} credit</span>
                            : <span className="text-success-text font-medium">Paid</span>
                        }
                      </td>
                      <td className="text-[12px] text-ink-muted">{fmtDate(r.lastPaymentDate)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </>
      )}

      {ToastEl}
    </div>
  )
}
