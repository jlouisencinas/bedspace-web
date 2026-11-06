/**
 * src/lib/reservation.js
 * ----------------------
 * Pure rules for a reservation's target move-in date (beds.reserved_move_in_date) and the Move In defaults it drives.
 * Dates are 'YYYY-MM-DD' strings; "today" is always passed in so the rules are testable.
 */
import { dayNum, isoOfDay } from './stay'

const MON = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec']

// Date.parse rolls '2026-11-31' over to Dec 1, so a real date must survive the round trip unchanged.
export function isValidISODate(v) {
  if (typeof v !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(v)) return false
  const n = dayNum(v)
  return Number.isFinite(n) && isoOfDay(n) === v
}

export function fmtTargetDate(iso) {
  if (!isValidISODate(iso)) return ''
  const [y, m, d] = iso.split('-').map(Number)
  return `${MON[m - 1]} ${d}, ${y}`
}

const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`

/** Reserve / edit rule: required, a real date, today or later. Returns a message or null. */
export function targetDateProblem(dateISO, todayISO) {
  const v = typeof dateISO === 'string' ? dateISO.trim() : ''
  if (!v) return 'Enter the target move-in date.'
  if (!isValidISODate(v)) return 'The target move-in date is not a valid date.'
  if (isValidISODate(todayISO) && v < todayISO) return 'The target move-in date cannot be before today.'
  return null
}

/** Display state of a target date relative to today; days is negative when overdue. */
export function targetDateState(dateISO, todayISO) {
  if (!isValidISODate(dateISO) || !isValidISODate(todayISO)) return { state: 'NONE', days: null }
  const days = dayNum(dateISO) - dayNum(todayISO)
  return { state: days === 0 ? 'TODAY' : days > 0 ? 'UPCOMING' : 'OVERDUE', days }
}

/** Move In prefill for a bed: a RESERVED bed's name and target date (today when it has none). */
export function moveInDefaults(bed, todayISO) {
  const reserved = bed?.status === 'RESERVED'
  const targetDate = reserved && isValidISODate(bed.reserved_move_in_date) ? bed.reserved_move_in_date : null
  return {
    name:       reserved ? (bed.reserved_name || '') : '',
    moveInDate: targetDate || todayISO,
    targetDate,
  }
}

/** Non-blocking notice under Move In Date (rent is prorated from it). Returns text or null. */
export function moveInDateNotice(moveInISO, targetISO, todayISO) {
  if (!isValidISODate(moveInISO) || !isValidISODate(todayISO)) return null
  const parts = []
  const days = dayNum(moveInISO) - dayNum(todayISO)
  if (days > 0) parts.push(`Move-in date is ${plural(days, 'day')} after today: rent starts on this date.`)
  if (days < 0) parts.push(`Move-in date is ${plural(-days, 'day')} before today: rent starts on this date.`)
  if (isValidISODate(targetISO) && targetISO !== moveInISO) {
    parts.push(`It differs from the reservation's target move-in date (${fmtTargetDate(targetISO)}).`)
  }
  return parts.length ? parts.join(' ') : null
}
