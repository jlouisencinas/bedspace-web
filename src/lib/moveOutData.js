/**
 * src/lib/moveOutData.js
 * ----------------------
 * Loads everything buildFinalBillDrafts() needs for one move-out (one tenant or sibling beds leaving together) from the
 * database. Shared by MoveOutModal and the Approvals review so both rebuild from the same fresh data.
 */
import {
  supabase, fetchCutoffs, fetchTenants, fetchUtilityBill, fetchTenantDeposits, fetchStoredAdvanceCredits, fetchRentCarryovers,
  fetchAdvanceSiblingIds, fetchPayments, fetchRoomInterimReadings, fetchSplits, fetchMoveOutRequestForBill,
} from './supabase'
import { classifyStay, computeCoverage, appStart, dayNum } from './stay'
import { buildFinalBillDrafts, asHeldForReissue, reissueReadings, reissuePlannedDate } from './finalBill'

const iso10 = (v) => (v ? String(v).slice(0, 10) : null)

/**
 * Rebuilds the drafts of a move-out REQUEST from the database as it is now (the same date, readings and start-reading overrides
 * the request used), for the beds that are still active. Beds already applied (inactive, final-billed) are ghosts in the split.
 * beds = [{ id, bill }] in bed order; vacatedAfterNoon = the 12:00 PM choice of a late move-out (null = not made: the draft blocks).
 * Returns { drafts: Map(tenantId -> draft), tenants } (tenants = every tenant, fresh).
 */
export async function buildRequestFreshDrafts({ beds, moveOutDate, readings, vacatedAfterNoon = null }) {
  if (!beds.length) return { drafts: new Map(), tenants: [] }
  const b = await loadMoveOutBundle({ groupIds: beds.map(x => x.id), moveOutDate })
  const manual = (k) => {
    for (const x of beds) {
      const sr = x.bill?.details?.stay?.start_readings?.[k]
      if (sr?.source === 'MANUAL' && x.bill.details[k]?.prev != null) return x.bill.details[k].prev
    }
    return undefined
  }
  const res = buildFinalBillDrafts({
    group: b.group, cutoffs: b.cutoffs, tenants: b.tenants, moveOutDate, readings, bundle: b.bundle,
    deposits: b.deposits, storedCredits: b.storedCredits, storedCarry: b.storedCarry, payments: b.payments, plannedMoveOut: b.plannedMoveOut,
    siblingIds: b.siblingIds, startOverrides: { WATER: manual('water'), ELECTRIC: manual('electric') }, isAdmin: true, vacatedAfterNoon,
  })
  return { drafts: res.drafts, tenants: b.tenants }
}

const manualStart = (bill, k) => {
  const sr = bill?.details?.stay?.start_readings?.[k]
  return sr?.source === 'MANUAL' && bill.details[k]?.prev != null ? bill.details[k].prev : undefined
}

/**
 * Inputs of the re-issue draft of a FINAL bill of a moved-out tenant: the bill's tenant only (inactive), the stamps without this bill (the
 * tenant is not their own ghost), the receipts this bill settled treated as HELD, the contract date (reissuePlannedDate), the saved move-out
 * readings (else the bill's own) and the bill's manual start readings. Returns loadMoveOutBundle()'s shape plus
 * { tenant, readings, readingSources, planned, request, startOverrides }.
 */
export async function loadReissueBundle({ bill }) {
  const b = await loadMoveOutBundle({ groupIds: [bill.tenant_id], moveOutDate: bill.move_out_date, excludeFinalBillId: bill.id })
  const tenant = b.group[0]
  let request = null
  try { request = await fetchMoveOutRequestForBill(bill) } catch (e) { console.warn('move-out request lookup skipped:', e.message) }
  const planned = reissuePlannedDate({ bill, request, tenant })
  const r = reissueReadings({ bill, interims: b.bundle.interimsAll })
  return {
    ...b, tenant, request, planned,
    deposits: new Map([[tenant.id, asHeldForReissue(b.deposits.get(tenant.id), bill.id)]]),
    plannedMoveOut: new Map([[tenant.id, planned]]),
    readings: { water: r.water, electric: r.electric }, readingSources: r.sources,
    startOverrides: { WATER: manualStart(bill, 'water'), ELECTRIC: manualStart(bill, 'electric') },
  }
}

const withRoom = (t) => ({
  ...t,
  room_no: t.beds?.rooms?.room_no ?? '', room_id: t.beds?.room_id ?? null, bed_letter: t.beds?.bed_letter ?? '',
})

/**
 * Returns { cutoffs, tenants, group, roomId, plannedMoveOut, deposits, storedCredits, storedCarry, siblingIds, payments, bundle }
 * where `bundle` = { rowsByCutoff, interimsAll, splitFlags, addonFlags } as expected by buildFinalBillDrafts. `group` keeps
 * the order of `groupIds` (callers pass bed order).
 */
export async function loadMoveOutBundle({ groupIds, moveOutDate, excludeFinalBillId = null }) {
  const [cutoffs, allTenants] = await Promise.all([fetchCutoffs(), fetchTenants({ excludeFinalBillId })])
  const tenants = allTenants.map(withRoom)
  const group = groupIds.map(id => tenants.find(t => t.id === id)).filter(Boolean)
  if (group.length !== groupIds.length) throw new Error('A tenant of this move-out could not be found. Reload the page and try again.')
  const roomId = group[0].room_id
  const moveOut = iso10(moveOutDate)

  const [deposits, payments, storedCredits, allCarry] = await Promise.all([
    Promise.all(group.map(t => fetchTenantDeposits(t.id))),
    Promise.all(group.map(t => fetchPayments(t.id))),
    fetchStoredAdvanceCredits(),
    fetchRentCarryovers(),
  ])
  const storedCarry = allCarry.filter(r => groupIds.includes(r.tenant_id))
  const depMap = new Map(group.map((t, i) => [t.id, deposits[i]]))
  const payMap = new Map(group.map((t, i) => [t.id, payments[i]]))
  const sibMap = new Map()
  for (const t of group) sibMap.set(t.id, await fetchAdvanceSiblingIds(t, depMap.get(t.id), storedCredits))
  const plannedMoveOut = new Map(group.map(t => [t.id, iso10(t.move_out_date)]))

  const empty = { cutoffs, tenants, group, roomId, plannedMoveOut, deposits: depMap, storedCredits, storedCarry, siblingIds: sibMap, payments: payMap }
  if (roomId == null || !moveOut) {
    return { ...empty, bundle: { rowsByCutoff: new Map([['WATER', new Map()], ['ELECTRIC', new Map()]]), interimsAll: [], splitFlags: new Set(), addonFlags: [] } }
  }

  const appS = appStart(cutoffs)
  const covered = new Set()
  let minIn = dayNum(moveOut)
  for (const t of group) {
    const mi = iso10(t.move_in_date)
    if (mi) minIn = Math.min(minIn, dayNum(mi))
    const cls = classifyStay({ moveIn: mi, planned: iso10(t.move_out_date), actual: moveOut, appStartISO: appS })
    computeCoverage({ cutoffs, moveInISO: mi, moveOutISO: moveOut, kind: cls.kind }).coveredIds.forEach(id => covered.add(id))
  }
  // Rows for every cutoff near the stay: covered ones, the ones that price its days and the ones holding the start reading.
  const moveNum = dayNum(moveOut)
  const near = cutoffs.filter(c => {
    const ws = dayNum(c.water_start), we = dayNum(c.water_end) ?? Infinity
    const es = dayNum(c.electric_start), ee = dayNum(c.electric_end) ?? Infinity
    const lo = minIn - 75, hi = moveNum + 45
    return covered.has(c.id) || (ws != null && ws <= hi && we >= lo) || (es != null && es <= hi && ee >= lo)
  })

  const [billSets, interimsAll, splitSets, addonRes] = await Promise.all([
    Promise.all(near.map(c => fetchUtilityBill(c.id))),
    fetchRoomInterimReadings(roomId),
    Promise.all([...covered].map(id => fetchSplits(id))),
    supabase.from('addons').select('*').in('tenant_id', groupIds),
  ])
  if (addonRes.error) throw addonRes.error

  const water = new Map(), electric = new Map()
  near.forEach((c, i) => {
    const row = (billSets[i] || []).find(b => b.room_id === roomId)
    if (!row) return
    if (row.water_prev != null || row.water_curr != null) water.set(c.id, { prev: row.water_prev, curr: row.water_curr, rate: row.water_rate })
    if (row.elec_prev != null || row.elec_curr != null) electric.set(c.id, { prev: row.elec_prev, curr: row.elec_curr, rate: row.elec_rate })
  })
  const splitFlags = new Set()
  ;[...covered].forEach((id, i) => {
    for (const s of splitSets[i] || []) if (s.room_id === roomId) splitFlags.add(`${id}|${s.utility}`)
  })

  return {
    ...empty,
    bundle: {
      rowsByCutoff: new Map([['WATER', water], ['ELECTRIC', electric]]),
      interimsAll, splitFlags, addonFlags: addonRes.data || [],
    },
  }
}
