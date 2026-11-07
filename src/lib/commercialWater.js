/**
 * src/lib/commercialWater.js
 * --------------------------
 * Commercial water checks (Billing / Utilities warnings) and the common-area reading carry-forward on Utilities.
 */

const cents = (v) => Math.round((Number(v) || 0) * 100)

/** COMMERCIAL perTenant rows with no water consumption (zero or negative): their Rent + Water bill has P0 water. */
export function commercialWaterIssues(perTenant) {
  return (perTenant || [])
    .filter(t => t.category === 'COMMERCIAL' && !(Number(t.waterCons) > 0.0001))
    .map(t => ({ id: t.id, name: t.name, kind: 'ZERO' }))
}

const priorRow = (priorRows, areaName, utility) =>
  (priorRows || []).find(x => x.area_name === areaName && x.utility === utility)

/**
 * A common-area reading for the cutoff being shown. A saved row is kept as is; with no row yet, both fields start at the
 * prior cutoff's actual reading (consumption 0 until staff enter the new reading, so nothing goes negative); else 0/0.
 */
export function carriedAreaReading(found, priorRows, areaName, utility) {
  if (found) return { previous_reading: found.previous_reading ?? 0, current_reading: found.current_reading ?? 0 }
  const prior = priorRow(priorRows, areaName, utility)
  if (prior) {
    const v = Number(prior.current_reading) || 0
    return { previous_reading: v, current_reading: v }
  }
  return { previous_reading: 0, current_reading: 0 }
}

/** True when a saved row's Previous does not continue from the prior cutoff's actual reading (compared in cents). */
export function areaPrevMismatch(found, priorRows, areaName, utility) {
  if (!found) return false
  const prior = priorRow(priorRows, areaName, utility)
  if (!prior) return false
  return cents(found.previous_reading) !== cents(prior.current_reading)
}
