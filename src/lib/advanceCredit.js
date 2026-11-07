/**
 * src/lib/advanceCredit.js
 * ------------------------
 * Freezes the second-to-last-bill advance when a cutoff is closed (the next one is opened): first the advance windows
 * (rent_carryovers), then the `Less: Advance` credits derived from them (advance_credits, guards G1-G3). Once stored, a
 * later change of the tenant's move-out date or rate can no longer change the closed statement or what the final bill
 * bills. Admin session only (insert policies). Any failure throws, so the caller does not open the cutoff; a retry skips
 * the rows already stored on both tables.
 */
import {
  fetchUtilityBill, fetchInterimReadings, fetchSplits, fetchAddons, fetchAreaReadings, fetchTenants,
  fetchAllTenantDeposits, fetchStoredAdvanceCredits, fetchRentCarryovers, fetchFinalBillsLite, fetchTransfersForCutoff,
  saveAdvanceCredits, saveRentCarryovers,
} from './supabase'
import { computeBilling } from './billing'
import { creditsToStore, carryToStore } from './finalBill'

export async function recordAdvanceCredits(cutoff, actorId = null) {
  if (!cutoff) return []
  const [bill, interims, splits, addons, areas, tenants, deposits, stored, carry, finalBills, transfers] = await Promise.all([
    fetchUtilityBill(cutoff.id), fetchInterimReadings(cutoff.id), fetchSplits(cutoff.id), fetchAddons(cutoff.id),
    fetchAreaReadings(cutoff.id), fetchTenants(), fetchAllTenantDeposits(), fetchStoredAdvanceCredits(),
    fetchRentCarryovers(), fetchFinalBillsLite(), fetchTransfersForCutoff(cutoff),
  ])
  if (!bill.length) return []
  const { perTenant } = computeBilling(cutoff, bill, interims, tenants, splits, addons, areas, transfers)
  const carryRows = carryToStore({ tenants, cutoff, perTenant, deposits, stored, carry, finalBills, transfers })
  await saveRentCarryovers(carryRows, actorId)
  const creditRows = creditsToStore({ tenants, cutoff, perTenant, deposits, stored, carry: [...carry, ...carryRows], finalBills })
  return saveAdvanceCredits(creditRows, actorId)
}
