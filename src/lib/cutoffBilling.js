/**
 * src/lib/cutoffBilling.js
 * ------------------------
 * The one way to compute a cutoff's monthly statements: used by the Billing page, the Rent + Water and Electricity print
 * pages and the tenant profile's statement history, so they always show the same figures.
 */
import {
  fetchUtilityBill, fetchInterimReadings, fetchTenants, fetchSplits, fetchAddons, fetchAreaReadings,
  fetchTransfersForCutoff, fetchAdvanceCreditData,
} from './supabase'
import { computeBilling } from './billing'
import { advanceCredits } from './finalBill'

export const NO_ADVANCE_DATA = { deposits: [], finalBills: [], stored: [], error: null }

// Throws on any read error except the advance-credit data, which reports it in advData.error (as fetchAdvanceCreditData does).
// shared.tenants / shared.advData skip those fetches when the caller already holds them.
export async function loadCutoffBillingInputs(cutoff, shared = {}) {
  const [bill, interims, tenants, splits, addons, areas, transfers, advData] = await Promise.all([
    fetchUtilityBill(cutoff.id), fetchInterimReadings(cutoff.id), shared.tenants ?? fetchTenants(),
    fetchSplits(cutoff.id), fetchAddons(cutoff.id), fetchAreaReadings(cutoff.id),
    cutoff.water_start ? fetchTransfersForCutoff(cutoff) : Promise.resolve([]),
    shared.advData ?? fetchAdvanceCreditData(),
  ])
  return { bill, interims, tenants, splits, addons, areas, transfers, advData }
}

// Pure. Never caches (the Billing page keeps its own cacheBilling call).
export function computeCutoffBilling(cutoff, inputs) {
  const { bill, interims, tenants, splits, addons, areas, transfers, advData } = inputs
  if (!cutoff || !bill?.length) return { perRoom: [], perTenant: [], stayBilled: [], credits: new Map() }
  const result = computeBilling(cutoff, bill, interims, tenants, splits, addons, areas, transfers)
  const credits = result.perTenant.length
    ? advanceCredits({ tenants, cutoff, perTenant: result.perTenant, deposits: advData.deposits, stored: advData.stored })
    : new Map()
  return { ...result, credits }
}
