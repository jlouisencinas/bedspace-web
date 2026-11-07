/**
 * src/lib/snapshot.js
 * -------------------
 * Build a monthly report snapshot (Property Summary + Collections + P&L)
 * for a cutoff and save it. Auto-called when a new cutoff is opened (to close
 * the prior month) and available as a manual "Save snapshot" action.
 * The row itself is computed by the pure snapshotCompute.js.
 */
import {
  fetchBeds, fetchUtilityBill, fetchInterimReadings, fetchTenants,
  fetchAreaReadings, fetchSplits, fetchAddons, saveMonthlyReport,
  fetchAdvanceCreditData, fetchTransfersForCutoff,
} from './supabase'
import { computeSnapshot } from './snapshotCompute'

export { computeSnapshot }

// actorId: the user opening the cutoff (Utilities.jsx) or clicking "Snapshot
// now" (Reports.jsx) — passed through so saveMonthlyReport can attribute the
// activity_log diff to them.
export async function buildAndSaveSnapshot(cutoff, actorId = null) {
  if (!cutoff) return null
  const [beds, bill, interims, tenants, areas, splits, addons, advData, transfers] = await Promise.all([
    fetchBeds(), fetchUtilityBill(cutoff.id), fetchInterimReadings(cutoff.id),
    fetchTenants(), fetchAreaReadings(cutoff.id), fetchSplits(cutoff.id), fetchAddons(cutoff.id),
    fetchAdvanceCreditData(), cutoff.water_start ? fetchTransfersForCutoff(cutoff) : Promise.resolve([]),
  ])
  // Without the advance data the rent of second-to-last leavers would be counted in full: save nothing rather than a wrong figure.
  if (advData.error) throw new Error(`Snapshot not saved: the advance data could not be loaded (${advData.error}).`)
  const row = computeSnapshot(cutoff, beds, bill, interims, tenants, areas, splits, addons, advData, transfers)
  await saveMonthlyReport(row, actorId)
  return row
}
