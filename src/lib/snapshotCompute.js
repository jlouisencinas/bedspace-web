/**
 * src/lib/snapshotCompute.js
 * --------------------------
 * Pure: one monthly report snapshot row (Property Summary + Collections + P&L) for a cutoff. Saved by snapshot.js.
 * Collections use the same rent as the statements: a second-to-last leaver's rent is reduced by the advance window
 * (cutoffAdvance), so the carried part is counted once, on the final bill. Occupancy is unaffected.
 */
import { computeBilling } from './billing'
import { computePnL } from './pnl'
import { cutoffAdvance } from './finalBill'
import { computeOccupancySnapshot } from '../../supabase/functions/_shared/occupancy.ts'

// advData = fetchAdvanceCreditData() result ({ deposits, finalBills, stored, carry }); transfers only feed the advance rule.
export function computeSnapshot(cutoff, beds, bill, interims, tenants, areas, splits, addons, advData = null, transfers = []) {
  // Property summary (whole-room aware, day-weighted across the cutoff's window)
  const occ = computeOccupancySnapshot(cutoff.water_start, cutoff.water_end, beds, tenants)
  const totalRooms = new Set(beds.map(b => b.room_id)).size

  // Collections
  const raw = computeBilling(cutoff, bill, interims, tenants, splits, addons, areas).perTenant
  const { perTenant } = advData ? cutoffAdvance({ cutoff, perTenant: raw, tenants, advData, transfers }) : { perTenant: raw }
  const col = perTenant.reduce((s, t) => ({
    rent: s.rent + t.rent, water: s.water + t.water, elec: s.elec + t.elec,
    addons: s.addons + (t.addonRentWater || 0) + (t.addonElectric || 0), total: s.total + t.total,
  }), { rent: 0, water: 0, elec: 0, addons: 0, total: 0 })

  // Utility P&L
  const pnl = computePnL(cutoff, bill, interims, tenants, areas, splits)

  return {
    cutoff_id: cutoff.id, period_name: cutoff.name, period_date: cutoff.water_start,
    total_beds: occ.totalBeds, sellable: occ.sellableBeds,
    occupied_beds: occ.occupiedBedsAvg, active_tenants: occ.activeTenantsAvg,
    occupied_rooms: occ.occupiedRoomsAvg, total_rooms: totalRooms, occupancy_pct: occ.occupancyPct,
    col_rent: col.rent, col_water: col.water, col_electric: col.elec,
    col_addons: col.addons, col_total: col.total,
    water_cost: pnl.WATER.cost, water_collections: pnl.WATER.collections, water_variance: pnl.WATER.variance,
    electric_cost: pnl.ELECTRIC.cost, electric_collections: pnl.ELECTRIC.collections, electric_variance: pnl.ELECTRIC.variance,
    total_variance: pnl.totalVariance,
  }
}
