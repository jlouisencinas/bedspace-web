/**
 * src/lib/snapshot.js
 * -------------------
 * Build a monthly report snapshot (Property Summary + Collections + P&L)
 * for a cutoff and save it. Auto-called when a new cutoff is opened (to close
 * the prior month) and available as a manual "Save snapshot" action.
 */
import {
  fetchBeds, fetchUtilityBill, fetchInterimReadings, fetchTenants,
  fetchAreaReadings, fetchSplits, fetchAddons, saveMonthlyReport,
} from './supabase'
import { computeBilling } from './billing'
import { computePnL } from './pnl'

const num = (v) => { const n = parseFloat(v); return isNaN(n) ? 0 : n }

export function computeSnapshot(cutoff, beds, bill, interims, tenants, areas, splits, addons) {
  // Property summary (whole-room aware)
  const leased   = beds.filter(b => b.status === 'LEASED').length
  const oor      = beds.filter(b => b.status === 'OUT OF ORDER').length
  const total    = beds.length
  const sellable = total - oor
  const tkeys = new Set(beds.filter(b => b.status === 'LEASED' && b.tenant_name)
    .map(b => `${b.room_id}|${String(b.tenant_name).trim().toUpperCase()}`))
  const totalRooms    = new Set(beds.map(b => b.room_id)).size
  const occupiedRooms = new Set(beds.filter(b => b.status === 'LEASED').map(b => b.room_id)).size
  const occPct = sellable > 0 ? Math.round((leased / sellable) * 1000) / 10 : 0

  // Collections
  const { perTenant } = computeBilling(cutoff, bill, interims, tenants, splits, addons, areas)
  const col = perTenant.reduce((s, t) => ({
    rent: s.rent + t.rent, water: s.water + t.water, elec: s.elec + t.elec,
    addons: s.addons + (t.addonRentWater || 0) + (t.addonElectric || 0), total: s.total + t.total,
  }), { rent: 0, water: 0, elec: 0, addons: 0, total: 0 })

  // Utility P&L
  const pnl = computePnL(cutoff, bill, interims, tenants, areas, splits)

  return {
    cutoff_id: cutoff.id, period_name: cutoff.name, period_date: cutoff.water_start,
    total_beds: total, sellable, occupied_beds: leased, active_tenants: tkeys.size,
    occupied_rooms: occupiedRooms, total_rooms: totalRooms, occupancy_pct: occPct,
    col_rent: col.rent, col_water: col.water, col_electric: col.elec,
    col_addons: col.addons, col_total: col.total,
    water_cost: pnl.WATER.cost, water_collections: pnl.WATER.roomCollections, water_variance: pnl.WATER.variance,
    electric_cost: pnl.ELECTRIC.cost, electric_collections: pnl.ELECTRIC.roomCollections, electric_variance: pnl.ELECTRIC.variance,
    total_variance: pnl.totalVariance,
  }
}

export async function buildAndSaveSnapshot(cutoff) {
  if (!cutoff) return null
  const [beds, bill, interims, tenants, areas, splits, addons] = await Promise.all([
    fetchBeds(), fetchUtilityBill(cutoff.id), fetchInterimReadings(cutoff.id),
    fetchTenants(), fetchAreaReadings(cutoff.id), fetchSplits(cutoff.id), fetchAddons(cutoff.id),
  ])
  const row = computeSnapshot(cutoff, beds, bill, interims, tenants, areas, splits, addons)
  await saveMonthlyReport(row)
  return row
}
