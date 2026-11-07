/**
 * src/lib/advanceCredit.js
 * ------------------------
 * Freezes the second-to-last-bill advance part when a cutoff is closed (the next one is opened): the advance
 * window (rent carried to the final bill, rent_carryovers) and, for the legacy table, any advance credit. Once stored,
 * a later change of the tenant's move-out date can no longer change the closed statement or what the final bill
 * bills. Admin session only (insert policies). Any failure throws, so the caller does not open the cutoff.
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
  const creditRows = creditsToStore({ tenants, cutoff, perTenant, deposits, stored, finalBills })
  await saveRentCarryovers(carryRows, actorId)
  return saveAdvanceCredits(creditRows, actorId)
}
