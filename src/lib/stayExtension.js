/**
 * src/lib/stayExtension.js
 * ------------------------
 * Pure: the stay extension of a late move-out (requirements section 5 "Stay extension"). The nights after the contract (planned)
 * move-out date are charged per night instead of pro-rated rent; checkout is 12:00 PM, so a tenant who leaves after 12:00 PM on the
 * actual move-out day pays one more night. Money is integer cents.
 */
import { dayNum, isoOfDay } from './stay'

export const STAY_EXTENSION_NIGHTLY = 500
export const STAY_EXTENSION_WARN_NIGHTS = 7
export const NOON_CHOICE_MISSING = 'Choose whether the tenant vacated by 12:00 PM or after 12:00 PM on the move-out day: the nights after the contract move-out date are charged as a stay extension.'

const MON = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec']
const iso10 = (v) => (v ? String(v).slice(0, 10) : null)
const short = (iso) => { const [, m, d] = iso.split('-'); return `${d} ${MON[+m - 1]}` }
const pesoText = (n) => '₱' + Number(n || 0).toLocaleString('en-PH', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
const nightsText = (n) => `${n} night${n === 1 ? '' : 's'}`

/** Is the actual move-out after the contract date (a stay extension applies)? */
export function hasExtension({ contractISO, actualISO }) {
  const c = dayNum(iso10(contractISO)), a = dayNum(iso10(actualISO))
  return c != null && a != null && a > c
}

/** Nights = days after the contract date + 1 when vacated after 12:00 PM. 0 on or before the contract date. */
export function extensionNights({ contractISO, actualISO, afterNoon }) {
  if (!hasExtension({ contractISO, actualISO })) return 0
  return (dayNum(iso10(actualISO)) - dayNum(iso10(contractISO))) + (afterNoon === true ? 1 : 0)
}

/** The extension charge line (integer cents), or null when no extension applies or the 12:00 PM choice is not made yet. */
export function extensionLine({ contractISO, actualISO, afterNoon, rate = STAY_EXTENSION_NIGHTLY }) {
  if (!hasExtension({ contractISO, actualISO }) || (afterNoon !== true && afterNoon !== false)) return null
  const nights = extensionNights({ contractISO, actualISO, afterNoon })
  const cents = nights * Math.round(Number(rate) * 100)
  const from = isoOfDay(dayNum(iso10(contractISO)) + 1), to = iso10(actualISO)
  const range = from === to ? short(to) : `${short(from)} - ${short(to)}`
  return {
    label: `Stay extension (${nightsText(nights)} x ${pesoText(rate)}, ${range}, vacated ${afterNoon ? 'after' : 'by'} 12:00 PM)`,
    mid: nightsText(nights), rate: Number(rate), amount: cents / 100, kind: 'charge', source: 'EXTENSION', computed: cents / 100,
  }
}

/** The record kept in final_bills.details.extension. */
export function extensionDetails({ contractISO, actualISO, afterNoon, rate = STAY_EXTENSION_NIGHTLY }) {
  const line = extensionLine({ contractISO, actualISO, afterNoon, rate })
  if (!line) return null
  return {
    contract_date: iso10(contractISO), actual_date: iso10(actualISO), after_noon: afterNoon,
    nights: extensionNights({ contractISO, actualISO, afterNoon }), rate: Number(rate), amount: line.amount,
  }
}

const MON_LONG = (iso) => { const [y, m, d] = iso.split('-'); return `${+d}-${MON[+m - 1]}-${y}` }

/** Foot note of the printed final bill. */
export function extensionNote(ext) {
  if (!ext || !ext.nights) return null
  return `Stay extension: ${nightsText(ext.nights)} after the contract move-out date ${MON_LONG(ext.contract_date)} (moved out ${MON_LONG(ext.actual_date)}, `
    + `vacated ${ext.after_noon ? 'after' : 'by'} 12:00 PM) at ${pesoText(ext.rate)} per night = ${pesoText(ext.amount)}. Checkout is 12:00 PM; `
    + 'staying past 12:00 PM counts as another night. Rent is charged up to the contract move-out date.'
}

/** A soft warning for a long extension (no cap). */
export function nightsWarning(n) {
  if (!(n > STAY_EXTENSION_WARN_NIGHTS)) return null
  return `${nightsText(n)} of stay extension at ${pesoText(STAY_EXTENSION_NIGHTLY)} per night. If the tenant really extended the lease, edit the planned move-out date instead.`
}
