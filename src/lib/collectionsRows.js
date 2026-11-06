/**
 * src/lib/collectionsRows.js
 * --------------------------
 * Pure row building for the Collections page (§12): billed vs. paid per tenant for one cutoff, the cutoff's
 * outstanding total for the past-due banner, and which closed cutoffs the banner checks.
 * Billed amounts come from computeCutoffBilling (cutoffBilling.js) so they match Billing and Payment Monitoring.
 */

const cents = n => Math.round((Number(n) || 0) * 100)

/**
 * One Collections cell (Rent+Water or Electricity) from billed vs. net paid, compared in integer cents.
 * state: 'none' (nothing billed, nothing paid) | 'unpaid' (net paid <= 0) | 'partial' (0 < paid < billed)
 *        | 'paid' (paid == billed) | 'over' (paid > billed, incl. an advance paid before any bill).
 */
export function cellStatus({ billed, paid }) {
  const bC = cents(billed), pC = cents(paid)
  let state
  if (pC <= 0) state = bC > 0 ? 'unpaid' : 'none'
  else if (pC < bC) state = 'partial'
  else if (pC === bC) state = 'paid'
  else state = 'over'
  return {
    state,
    billed: bC / 100,
    paid: pC / 100,
    remaining: Math.max(bC - pC, 0) / 100,
    over: (pC > 0 ? Math.max(pC - bC, 0) : 0) / 100,
  }
}

/** Cells of one component ('rw' | 'elec') that are fully paid (paid or overpaid); partial payers are not counted. */
export function countFullyPaid(rows, comp) {
  return (rows || []).filter(r => {
    const st = r.status?.[comp]?.state ?? cellStatus({ billed: r.billed?.[comp], paid: r.paid?.[comp] }).state
    return st === 'paid' || st === 'over'
  }).length
}

/**
 * perTenant:       computeCutoffBilling(...).perTenant
 * tenants:         fetchTenants() rows (display fields: name, beds.rooms.room_no, beds.bed_letter, beds.bed_location)
 * payments:        fetchPaymentsForCutoff(cutoffId), VOID rows included (negative amounts lower paid)
 * adjustments:     Map(tenantId -> amount) second-to-last-bill advance credit; lowers billed.rw, never counted as paid
 * includeInactive: false (active cutoff) = every active tenant, as before, billed 0 when there is no bill row;
 *                  true (closed cutoff) = exactly the tenants with a bill row, moved-out ones included.
 */
export function buildCollectionRows({ perTenant = [], tenants = [], payments = [], adjustments = new Map(), includeInactive = false }) {
  const billById = new Map((perTenant || []).map(t => [t.id, t]))
  const tenantById = new Map((tenants || []).map(t => [t.id, t]))
  const paysByTenant = new Map()
  for (const p of payments || []) {
    if (!paysByTenant.has(p.tenant_id)) paysByTenant.set(p.tenant_id, [])
    paysByTenant.get(p.tenant_id).push(p)
  }

  const ids = includeInactive
    ? (perTenant || []).map(t => t.id)
    : (tenants || []).filter(t => t.is_active).map(t => t.id)

  return ids.map(id => {
    const t = tenantById.get(id)
    const b = billById.get(id)
    const tPays = paysByTenant.get(id) || []
    const rwPays = tPays.filter(p => p.category === 'RENT_WATER')
    const elecPays = tPays.filter(p => p.category === 'ELECTRICITY')

    const billedRwC = b ? cents(b.rent) + cents(b.water) + cents(b.addonRentWater) - cents(adjustments?.get(id)) : 0
    const billedElC = b ? cents(b.elec) + cents(b.addonElectric) : 0
    const paidRwC = rwPays.reduce((s, p) => s + cents(p.amount), 0)
    const paidElC = elecPays.reduce((s, p) => s + cents(p.amount), 0)

    return {
      id,
      name: t?.name ?? b?.name ?? '',
      room_no: t?.beds?.rooms?.room_no ?? b?.room_no ?? '',
      bed_letter: t?.beds?.bed_letter ?? b?.bed ?? '',
      bed_location: t?.beds?.bed_location ?? '',
      rwPays,
      elecPays,
      billed: { rw: billedRwC / 100, elec: billedElC / 100 },
      paid: { rw: paidRwC / 100, elec: paidElC / 100 },
      remaining: { rw: Math.max(billedRwC - paidRwC, 0) / 100, elec: Math.max(billedElC - paidElC, 0) / 100 },
      status: {
        rw: cellStatus({ billed: billedRwC / 100, paid: paidRwC / 100 }),
        elec: cellStatus({ billed: billedElC / 100, paid: paidElC / 100 }),
      },
    }
  })
}

// Overpayment by one tenant is never netted against another tenant's balance.
export function cutoffOutstanding(rows) {
  let rwC = 0, elC = 0, unpaidCount = 0
  for (const r of rows || []) {
    const a = cents(r.remaining.rw), e = cents(r.remaining.elec)
    rwC += a; elC += e
    if (a + e > 0) unpaidCount++
  }
  return { rw: rwC / 100, elec: elC / 100, total: (rwC + elC) / 100, unpaidCount }
}

// The most recent closed cutoffs with a billing window, newest first; the active cutoff is never a candidate.
export function pickPastDueCandidates(cutoffs, lookback = 3) {
  return (cutoffs || [])
    .filter(c => !c.is_active && c.water_start)
    .sort((a, b) => (a.water_start < b.water_start ? 1 : a.water_start > b.water_start ? -1 : 0))
    .slice(0, lookback)
}

const byWaterStartDesc = (a, b) => (a.water_start ?? '') < (b.water_start ?? '') ? 1 : (a.water_start ?? '') > (b.water_start ?? '') ? -1 : b.id - a.id

/** The cutoff Collections opens: the ?cutoff= id when it is a known cutoff, else the active one, else the newest by water_start. */
export function resolveCutoffId(cutoffs, param) {
  const list = cutoffs || []
  if (list.length === 0) return null
  const s = param == null ? '' : String(param).trim()
  const id = /^\d+$/.test(s) ? Number(s) : NaN
  const known = list.find(c => c.id === id)
  if (known) return known.id
  const active = list.find(c => c.is_active)
  if (active) return active.id
  return [...list].sort(byWaterStartDesc)[0].id
}

/** The neighbouring cutoff by water_start ('older' | 'newer'), or null at either end / for an unknown id. */
export function adjacentCutoffId(cutoffs, id, direction) {
  const sorted = [...(cutoffs || [])].sort(byWaterStartDesc)
  const i = sorted.findIndex(c => c.id === id)
  if (i < 0) return null
  const j = direction === 'older' ? i + 1 : direction === 'newer' ? i - 1 : -1
  return j >= 0 && j < sorted.length ? sorted[j].id : null
}

/**
 * Past-due banner refresh state, independent of the viewed cutoff. A refresh stays wanted until one run finishes
 * successfully, so a page load that is superseded (StrictMode double effect, a quick cutoff switch) cannot lose it.
 * start() -> token; finish(token, ok) -> true when that run is the latest one (no newer start/request) and its result may be shown.
 */
export function createPastDueRefresh() {
  let wanted = true
  let seq = 0
  return {
    // Invalidates a run already in flight: it read data from before the change that asked for this refresh.
    request() { wanted = true; seq++ },
    shouldRun() { return wanted },
    start() { return ++seq },
    finish(token, ok) {
      if (token !== seq) return false
      if (ok) wanted = false
      return true
    },
  }
}
