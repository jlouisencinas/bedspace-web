/**
 * src/lib/advanceCredit.js
 * ------------------------
 * Records the second-to-last-bill advance credit when a cutoff is closed (the next one is opened), so
 * the credit becomes immutable: a later change of the tenant's move-out date can neither drop it nor
 * credit the advance a second time. Admin session only (advance_credits insert policy).
 */
import {
  fetchUtilityBill, fetchInterimReadings, fetchSplits, fetchAddons, fetchAreaReadings, fetchTenants,
  fetchAllTenantDeposits, fetchStoredAdvanceCredits, saveAdvanceCredits,
} from './supabase'
import { computeBilling } from './billing'
import { creditsToStore } from './finalBill'

export async function recordAdvanceCredits(cutoff, actorId = null) {
  if (!cutoff) return []
  const [bill, interims, splits, addons, areas, tenants, deposits, stored] = await Promise.all([
    fetchUtilityBill(cutoff.id), fetchInterimReadings(cutoff.id), fetchSplits(cutoff.id), fetchAddons(cutoff.id),
    fetchAreaReadings(cutoff.id), fetchTenants(), fetchAllTenantDeposits(), fetchStoredAdvanceCredits(),
  ])
  if (!bill.length) return []
  const { perTenant } = computeBilling(cutoff, bill, interims, tenants, splits, addons, areas)
  return saveAdvanceCredits(creditsToStore({ tenants, cutoff, perTenant, deposits, stored }), actorId)
}
