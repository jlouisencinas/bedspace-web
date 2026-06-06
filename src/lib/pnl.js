/**
 * src/lib/pnl.js
 * --------------
 * Utility profit/loss per cutoff.
 *
 *   Provider cost     = master-line bill (Maynilad / MERALCO)
 *   Standard rate     = bill ÷ consumption
 *   Bedspace rate     = standard × (1 + markup%)   (or manual override)
 *   Room collections  = Σ billed room amounts (Method B) — ties to room billing
 *   Overhead          = unbilled rooms (e.g. 702 mgmt, 706) consumption × standard
 *                       + common areas (Lobby/2nd Floor/Roof Deck) × standard
 *   Commercial        = commercial area consumption × bedspace (billing TBD)
 *   Variance          = Room collections − Provider cost   (− = losing)
 */
import { computeBilling } from './billing'

const num = (v) => { const n = parseFloat(v); return isNaN(n) ? 0 : n }

export function computePnL(cutoff, billRows, interims, tenants, areaReadings, splits = []) {
  const { perRoom } = computeBilling(cutoff, billRows, interims, tenants, splits)

  const defs = {
    WATER:    { key: 'water',    amt: 'water_main_amount',    cons: 'water_main_consumption',    std: 'water_maynilad_rate',   bed: 'water_bedspace_rate' },
    ELECTRIC: { key: 'electric', amt: 'electric_main_amount', cons: 'electric_main_consumption', std: 'electric_meralco_rate', bed: 'electric_bedspace_rate' },
  }

  const out = {}
  for (const util of ['WATER', 'ELECTRIC']) {
    const d = defs[util]
    const cost      = num(cutoff[d.amt])
    const mainCons  = num(cutoff[d.cons])
    const standard  = mainCons > 0 ? cost / mainCons : num(cutoff[d.std])
    const bedspace  = num(cutoff[d.bed])

    // Room collections (billed rooms) + overhead (unbilled rooms × standard)
    let roomCollections = 0, roomOverhead = 0
    perRoom.forEach(r => {
      const u = r[d.key] || {}
      if ((u.sum || 0) > 0.01) roomCollections += u.sum            // billed
      else if ((u.roomCons || 0) > 0) roomOverhead += u.roomCons * standard  // mgmt/702/706
    })

    // Common areas
    let areaOverhead = 0, commercial = 0
    areaReadings.filter(a => a.utility === util).forEach(a => {
      const c = num(a.consumption)
      if (a.rate_type === 'BEDSPACE') commercial += c * bedspace
      else areaOverhead += c * standard
    })

    const overhead = roomOverhead + areaOverhead
    const variance = roomCollections - cost

    out[util] = { cost, standard, bedspace, mainCons, roomCollections, overhead, commercial, variance }
  }
  out.totalVariance = out.WATER.variance + out.ELECTRIC.variance
  return out
}
