/**
 * src/lib/collectionsSummary.js
 * ------------------------------
 * Shared billed-vs-paid calculation for a cutoff, used by BOTH the Dashboard's
 * projected-vs-actual summary widget and the full Tenant Payment Monitoring
 * page — the non-negotiable is that a tenant's balance must reconcile with no
 * drift between the two call sites, so this logic must live in exactly one place.
 */

const r2 = n => Math.round((Number(n) || 0) * 100) / 100

/**
 * cutoff:          the active/selected cutoff row (kept in the signature for
 *                   parity with computeBilling's call shape; not read directly
 *                   here — due-date labelling is out of scope for this module).
 * tenants:         from fetchTenants() — not read directly (computeBilling's
 *                   perTenant already carries everything needed per row), kept
 *                   in the signature to match the plan's call shape.
 * billingPerTenant: computeBilling(...).perTenant
 * cutoffPayments:   fetchPaymentsForCutoff(cutoffId)
 *
 * Billed is split into 3 comparable columns (Rent+Water / Electric / Add-ons)
 * so the Payment Monitoring table can show them separately — this differs from
 * Collections.jsx's 2-column billingMap (which folds add-ons into rent+water /
 * electric) only in that the add-on portion is broken out as its own column;
 * the underlying totals are identical.
 */
export function buildPaymentMonitoring(cutoff, tenants, billingPerTenant, cutoffPayments) {
  const paysByTenant = {}
  ;(cutoffPayments || []).forEach(p => {
    ;(paysByTenant[p.tenant_id] ||= []).push(p)
  })

  return (billingPerTenant || []).map(t => {
    const rentWater = r2((t.rent || 0) + (t.water || 0))
    const electric  = r2(t.elec || 0)
    const addons    = r2((t.addonRentWater || 0) + (t.addonElectric || 0))
    const billedTotal = r2(rentWater + electric + addons)

    const tPays = paysByTenant[t.id] || []
    const paidRentWater = r2(tPays.filter(p => p.category === 'RENT_WATER').reduce((s, p) => s + Number(p.amount || 0), 0))
    const paidElectric  = r2(tPays.filter(p => p.category === 'ELECTRICITY').reduce((s, p) => s + Number(p.amount || 0), 0))
    const paidOther     = r2(tPays.filter(p => p.category === 'OTHER' || !p.category).reduce((s, p) => s + Number(p.amount || 0), 0))
    const paidTotal     = r2(paidRentWater + paidElectric + paidOther)

    // Overpayment surfaces as a credit, not a negative outstanding balance.
    const diff = r2(billedTotal - paidTotal)
    const outstanding = diff > 0 ? diff : 0
    const credit       = diff < 0 ? r2(-diff) : 0

    const lastPaymentDate = tPays.filter(p => p.pay_type !== 'VOID').reduce((max, p) =>
      (!max || (p.payment_date && p.payment_date > max)) ? p.payment_date : max, null)

    return {
      id:         t.id,
      name:       t.name,
      room_no:    t.room_no,
      bed_letter: t.bed,
      wholeRoom:  !!t.wholeRoom,
      billed: { rentWater, electric, addons, total: billedTotal },
      paid:   { rentWater: paidRentWater, electric: paidElectric, other: paidOther, total: paidTotal },
      outstanding,
      credit,
      lastPaymentDate,
    }
  })
}

export function summarizeCollections(rows) {
  const list = rows || []
  const totalBilled      = r2(list.reduce((s, r) => s + r.billed.total, 0))
  const totalPaid        = r2(list.reduce((s, r) => s + r.paid.total, 0))
  const totalOutstanding = r2(list.reduce((s, r) => s + r.outstanding, 0))
  const pctCollected     = totalBilled > 0 ? Math.round((totalPaid / totalBilled) * 100) : 0
  const unpaidCount      = list.filter(r => r.outstanding > 0).length
  const tenantCount      = list.length
  return { totalBilled, totalPaid, totalOutstanding, pctCollected, unpaidCount, tenantCount }
}
