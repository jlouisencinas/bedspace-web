/**
 * src/lib/tenantStatements.js
 * ---------------------------
 * Pure helpers for the tenant profile's monthly statement history (Bills tab). Figures come straight from a
 * computeCutoffBilling result (src/lib/cutoffBilling.js): nothing here computes a charge.
 */
import { dbToCents } from './receiptLines'
import { dayNum, parseCovered } from './stay'

export const HISTORY_CAP = 12

const iso10 = (v) => (v ? String(v).slice(0, 10) : null)

// Windows are [start, end) day numbers; a null end is an open window. Stay end is the inclusive last day.
const overlaps = (stay, startIso, endIso) => {
  const s = dayNum(startIso)
  if (s == null) return false
  const e = dayNum(endIso) ?? Infinity
  return stay.s <= e - 1 && stay.e >= s
}

function stayDays(tenant) {
  const out = tenant.is_active ? null : (tenant.actual_move_out_date || tenant.move_out_date)
  return { s: dayNum(tenant.move_in_date) ?? -Infinity, e: out ? dayNum(out) : Infinity }
}

// The cutoffs to list for this tenant, in the given order (fetchCutoffs: newest first). finalBills are the tenant's own;
// only FINAL ones count (a voided bill covers nothing). A bill's cutoff_id counts as covering water and electric.
export function tenantCutoffs({ tenant, cutoffs, finalBills, payments }) {
  const stay = stayDays(tenant)
  const live = (finalBills || []).filter(b => b.status === 'FINAL')
  return (cutoffs || []).flatMap(cutoff => {
    const coveredWater = [], coveredElec = []
    for (const b of live) {
      let entries = parseCovered(b.covered_cutoffs)
      if (b.cutoff_id != null && !entries.some(e => e.id === b.cutoff_id)) entries = parseCovered([...entries, b.cutoff_id])
      const e = entries.find(x => x.id === cutoff.id)
      if (e?.water) coveredWater.push(b.id)
      if (e?.electric) coveredElec.push(b.id)
    }
    const inStay = overlaps(stay, cutoff.water_start, cutoff.water_end) || overlaps(stay, cutoff.electric_start, cutoff.electric_end)
    const hasPayments = (payments || []).some(p => p.cutoff_id === cutoff.id)
    if (!inStay && !coveredWater.length && !coveredElec.length && !hasPayments) return []
    return [{ cutoff, inStay, coveredWater, coveredElec, hasPayments }]
  })
}

// Integer cents of a payment set on one cutoff; voids are negative rows and net out.
export function paidByComponent(payments, cutoffId) {
  let rwCents = 0, elecCents = 0, otherCents = 0
  for (const p of payments || []) {
    if (p.cutoff_id !== cutoffId) continue
    const c = dbToCents(p.amount)
    if (p.category === 'RENT_WATER') rwCents += c
    else if (p.category === 'ELECTRICITY') elecCents += c
    else otherCents += c
  }
  return { rwCents, elecCents, otherCents }
}

// Integer cents of the 2-decimal value the screen shows for x, so "billed minus paid" uses the figure the user sees.
// Rounded by the same Intl formatter as the peso display: toFixed / Math.round(x * 100) differ from it on values like
// 4499.495 (shown as 4,499.50, toFixed gives 4499.49).
export function toCents2(x) {
  const n = Number(x) || 0
  const s = Math.abs(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2, useGrouping: false })
  const c = Number(s.replace('.', ''))
  return n < 0 && c !== 0 ? -c : c
}

// One tenant's statement on one cutoff, taken directly from the computeCutoffBilling result.
// kind: BILLED (own row) | WHOLE_ROOM (row on a same-name sibling bed) | STAY_BILLED (one-month stay) | NONE (no row)
export function statementForTenant(result, tenant, { siblingIds = [] } = {}) {
  const own = result.perTenant.find(r => r.id === tenant.id)
  const sib = own ? null : result.perTenant.find(r => r.wholeRoom && r.id !== tenant.id && siblingIds.includes(r.id))
  const row = own || sib || null
  const stayBilled = result.stayBilled.some(s => s.id === tenant.id)
  const kind = stayBilled ? 'STAY_BILLED' : own ? 'BILLED' : sib ? 'WHOLE_ROOM' : 'NONE'
  if (!row) return { kind, row: null, credit: null, rw: null, elec: null, roomCheck: null }
  const credit = result.credits.get(row.id) || null
  const rwTotal = (row.rent || 0) + (row.water || 0) + (row.addonRentWater || 0)
  const elecTotal = (row.elec || 0) + (row.addonElectric || 0)
  const room = result.perRoom.find(r => r.room_id === row.room_id)
  return {
    kind, row, credit,
    rw: {
      rent: row.rent, water: row.water, waterCons: row.waterCons,
      addons: (row.addons || []).filter(a => a.bill_on !== 'ELECTRIC'), addonTotal: row.addonRentWater || 0,
      total: rwTotal, net: credit ? rwTotal - credit.amount : rwTotal,
    },
    elec: {
      elec: row.elec, elecCons: row.elecCons,
      addons: (row.addons || []).filter(a => a.bill_on === 'ELECTRIC'), addonTotal: row.addonElectric || 0,
      total: elecTotal,
    },
    roomCheck: room ? { roomNo: room.room_no, waterOk: room.water.ok, elecOk: room.electric.ok } : null,
  }
}

// Room number the tenant held on dateIso, from their COMPLETED transfers (fetchTenantTransfers shape, any order):
// before a transfer's date they were in its from-room. currentRoomNo when no later transfer exists.
export function roomAsOf(transfers, dateIso, currentRoomNo) {
  const later = (transfers || [])
    .filter(x => iso10(x.transfer_date) > dateIso)
    .sort((a, b) => iso10(a.transfer_date).localeCompare(iso10(b.transfer_date)) || a.id - b.id)
  return later.length ? (later[0].from_room?.room_no ?? null) : currentRoomNo
}

// A transfer computeBilling applies on this cutoff (strictly inside the water window, as billing.js tests it).
export function hasTransferInWindow(transfers, cutoff) {
  const s = dayNum(cutoff.water_start), e = dayNum(cutoff.water_end) ?? Infinity
  return (transfers || []).some(x => { const d = dayNum(x.transfer_date); return d != null && d > s && d < e })
}
