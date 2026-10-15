// Pure helpers for advance/deposit receipt lines and reservation payments. No imports on purpose:
// money here is integer cents and typed amounts are NEVER rounded (unlike toCents() in finalBill.js,
// which rounds and must not be used to validate input).

const MONEY_RE = /^\d{1,8}(\.\d{1,2})?$/
const GROUPED_RE = /^\d{1,3}(,\d{3})+(\.\d{1,2})?$/

// Typed text -> integer cents, or null when it is not an exact amount with at most 2 decimals.
export function parseMoney(input) {
  if (input == null) return null
  let s = String(input).trim()
  if (s === '') return null
  if (GROUPED_RE.test(s)) s = s.replace(/,/g, '')
  if (!MONEY_RE.test(s)) return null
  const [whole, frac = ''] = s.split('.')
  return Number(whole) * 100 + Number((frac + '00').slice(0, 2))
}

// Why parseMoney() refused a value, for an error message.
export function moneyProblem(input) {
  const s = input == null ? '' : String(input).trim()
  if (s === '') return 'enter an amount'
  if (/^-/.test(s)) return 'amount cannot be negative'
  if (/^\d[\d,]*\.\d{3,}$/.test(s)) return 'amount can have at most 2 decimals (it is never rounded)'
  return 'amount is not a valid number (digits and at most 2 decimals, e.g. 3000.00)'
}

// A value read from a numeric(…,2) database column -> cents. Only for DB values, never typed input.
export function dbToCents(n) {
  return Math.round(Number(n) * 100)
}

export function centsToNumber(cents) {
  return Number((cents / 100).toFixed(2))
}

export function centsToInput(cents) {
  const sign = cents < 0 ? '-' : ''
  const abs = Math.abs(cents)
  return `${sign}${Math.floor(abs / 100)}.${String(abs % 100).padStart(2, '0')}`
}

export function fmtCents(cents) {
  const sign = cents < 0 ? '-' : ''
  const abs = Math.abs(cents)
  const whole = String(Math.floor(abs / 100)).replace(/\B(?=(\d{3})+(?!\d))/g, ',')
  return `${sign}P${whole}.${String(abs % 100).padStart(2, '0')}`
}

export function sumCents(lines) {
  let total = 0
  for (const l of lines || []) {
    const c = parseMoney(l?.amount)
    if (c != null) total += c
  }
  return total
}

// R = HELD reservation total, due = deposit due. The reservation is always kept whole as the deposit.
export function planDeposit({ dueCents, reservationCents }) {
  const due = dueCents || 0
  const res = reservationCents || 0
  if (res <= 0) return { shortfallCents: due, overageCents: 0, state: 'NONE' }
  if (res === due) return { shortfallCents: 0, overageCents: 0, state: 'FULL' }
  if (res < due) return { shortfallCents: due - res, overageCents: 0, state: 'SHORT' }
  return { shortfallCents: 0, overageCents: res - due, state: 'OVER' }
}

// "TR# 121", "tr 121", "121" all compare equal; a combined "TR# 121 & TR# 133" yields both parts.
export function normalizeRef(ref) {
  return String(ref ?? '')
    .trim()
    .replace(/^t\.r\.?/i, 'tr')
    .replace(/^tr(?:\s*#\s*|\s+|(?=\d))/i, '')
    .replace(/^#\s*/, '')
    .replace(/\s+/g, ' ')
    .toLowerCase()
}

function refParts(ref) {
  return String(ref ?? '').split(/[&,]/).map(normalizeRef).filter(Boolean)
}

export function nameMatches(a, b) {
  const n = v => String(v ?? '').trim().replace(/\s+/g, ' ').toLowerCase()
  return n(a) === n(b)
}

export function blankLine({ amount = '', date = '' } = {}) {
  return { amount, mode: '', refNo: '', bankRef: '', date }
}

export function refsOf(lines) {
  return (lines || []).map(l => String(l?.refNo ?? '').trim()).filter(Boolean)
}

const KIND_WORD = { ADVANCE: 'Advance', DEPOSIT: 'Deposit', RESERVATION: 'Reservation payment' }

// lines: [{ amount, mode, refNo, bankRef, date }]. For ADVANCE/DEPOSIT the lines must sum to dueCents exactly
// (dueCents === 0 means no lines are needed). For RESERVATION pass dueCents = null: any amount, no sum check,
// a T.R# is REQUIRED on every line, and maxDate (YYYY-MM-DD, client only) rejects a future received date.
// reservationRefs = T.R# already taken by reservation payments on this bed (and, for ADVANCE/DEPOSIT, by the
// reservation lines typed at Move In).
export function validateLines({ kind, dueCents, lines, reservationRefs = [], maxDate = null }) {
  const word = KIND_WORD[kind] || 'Deposit'
  const isReservation = kind === 'RESERVATION'
  const errors = []
  const list = lines || []
  const taken = new Set((reservationRefs || []).flatMap(refParts))
  let amountsOk = true

  list.forEach((l, i) => {
    const n = i + 1
    const cents = parseMoney(l.amount)
    if (cents == null) {
      amountsOk = false
      errors.push(`${word} line ${n}: ${moneyProblem(l.amount)}.`)
    } else if (cents <= 0) {
      amountsOk = false
      errors.push(`${word} line ${n}: amount must be greater than 0.`)
    }
    if (l.mode !== 'BANK' && l.mode !== 'CASH') errors.push(`${word} line ${n}: choose BANK or CASH.`)
    if (!l.date) errors.push(`${word} line ${n}: date is required.`)
    else if (maxDate && l.date > maxDate) errors.push(`${word} line ${n}: date cannot be in the future.`)
    if (isReservation && !String(l.refNo ?? '').trim()) errors.push(`${word} line ${n}: T.R# is required.`)
    const clash = refParts(l.refNo).find(p => taken.has(p))
    if (clash) {
      errors.push(isReservation
        ? `${word} line ${n}: reference "${String(l.refNo).trim()}" is already recorded as a reservation payment on this bed. Enter each receipt once.`
        : `${word} line ${n}: reference "${String(l.refNo).trim()}" is already used by a reservation payment on this bed. That money is applied automatically; do not enter it again.`)
    }
  })

  const totalCents = sumCents(list)
  if (dueCents == null) return { errors, totalCents, diffCents: 0 }
  const diffCents = dueCents - totalCents
  if (amountsOk && diffCents !== 0) {
    const w = word.toLowerCase()
    errors.push(
      `${word} lines total ${fmtCents(totalCents)} but the ${w} due is ${fmtCents(dueCents)} ` +
      `(${diffCents > 0 ? 'short' : 'over'} ${fmtCents(Math.abs(diffCents))}).`,
    )
  }
  return { errors, totalCents, diffCents }
}
