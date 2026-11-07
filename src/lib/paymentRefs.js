/**
 * src/lib/paymentRefs.js
 * ----------------------
 * S.I# (service invoice) / T.R# (temporary receipt) numbers on Collections payments (§12). Pure, no Supabase.
 * Stored bare (no prefix) in payments.si_no / payments.tr_no; optional; edited after saving only through the
 * set_payment_receipt_refs RPC (staff fill an empty number, admin changes or clears one).
 * Amount corrections (void + re-record through the correct_payment_amount RPC) are validated here too.
 */
import { normalizeReceiptRef } from './finalBill'
import { parseMoney, moneyProblem } from './receiptLines'

const KIND = { SI: 'ADVANCE', TR: 'DEPOSIT' }
const LABEL = { SI: 'S.I#', TR: 'T.R#' }
const CROSS = {
  SI: 'That looks like a T.R#; this field takes the S.I#.',
  TR: 'That looks like an S.I#; this field takes the T.R#.',
}
const CONTROL = /[\u0000-\u001f\u007f-\u009f]/
const CATEGORY_LABEL = { RENT_WATER: 'Rent + Water', ELECTRICITY: 'Electricity', OTHER: 'Other' }

const cents = n => Math.round((Number(n) || 0) * 100)
const isVoidRow = p => p?.voids_payment_id != null || p?.pay_type === 'VOID'

/** kind 'SI' | 'TR', raw typed text -> { value, error }. Blank is allowed (value null). */
export function normalizePaymentRef(kind, raw) {
  const s = String(raw ?? '').trim()
  if (!s) return { value: null, error: null }
  // normalizeReceiptRef collapses inner whitespace first, which would turn a pasted "12\n3" into "12 3".
  if (CONTROL.test(s)) return { value: null, error: `The ${LABEL[kind]} number cannot contain '·' or control characters.` }
  const n = normalizeReceiptRef(KIND[kind], s)
  if (n.error && n.error.startsWith('That looks like')) return { value: null, error: CROSS[kind] }
  return n
}

/** { si_no, tr_no } -> "S.I# 123 · T.R# 456" / "S.I# 123" / "T.R# 456" / "". */
export function formatPaymentRefs({ si_no, tr_no } = {}) {
  const si = String(si_no ?? '').trim()
  const tr = String(tr_no ?? '').trim()
  return [si && `S.I# ${si}`, tr && `T.R# ${tr}`].filter(Boolean).join(' · ')
}

/** The payments still in force (not a void row, not voided, amount > 0), newest first, for the Paid list. */
export function effectivePaymentLines(pays) {
  const list = pays || []
  const voided = new Set(list.filter(p => p.voids_payment_id != null).map(p => p.voids_payment_id))
  return list
    .filter(p => !isVoidRow(p) && !voided.has(p.id) && cents(p.amount) > 0)
    .map(p => ({
      id: p.id, amount: Number(p.amount), payment_date: p.payment_date ?? null, si_no: p.si_no ?? null, tr_no: p.tr_no ?? null,
      notes: p.notes ?? null, category: p.category ?? null, pay_type: p.pay_type ?? null,
    }))
    .sort((a, b) => (a.payment_date === b.payment_date ? b.id - a.id : (a.payment_date ?? '') < (b.payment_date ?? '') ? 1 : -1))
}

/**
 * Who may edit a saved payment's numbers (the RPC enforces the same rule). field 'si' | 'tr' narrows it to one number:
 * canFill = that number is empty and the caller is admin/user; canChange = it is set and the caller is admin.
 * Without field: canFill = some number is empty, canChange = some number is set (admin).
 */
export function canEditPaymentRef({ role, payment, field = null, voided = false }) {
  const none = { canFill: false, canChange: false }
  if (role !== 'admin' && role !== 'user') return none
  if (!payment || voided || isVoidRow(payment) || cents(payment.amount) <= 0) return none
  const set = f => String(payment[`${f}_no`] ?? '').trim() !== ''
  const fields = field ? [field] : ['si', 'tr']
  return {
    canFill: fields.some(f => !set(f)),
    canChange: role === 'admin' && fields.some(f => set(f)),
  }
}

const CORRECTABLE = new Set(['RENT_WATER', 'ELECTRICITY'])
const MAX_AMOUNT_CENTS = 9999999999
const MAX_REASON = 200

/** Who may correct a saved payment's amount (the correct_payment_amount RPC enforces the same rule): admin or staff,
 *  on an in-force positive Rent + Water / Electricity payment. */
export function canCorrectPaymentAmount({ role, payment, voided = false }) {
  if (role !== 'admin' && role !== 'user') return false
  if (!payment || voided || isVoidRow(payment) || cents(payment.amount) <= 0) return false
  return CORRECTABLE.has(payment.category)
}

/**
 * Typed corrected amount + reason for one payment, in integer cents (typed text is never rounded).
 * -> { ok, error, noChange, voidsLine, oldCents, newCents, deltaCents, newAmount, reason }. ok is true only when a write should
 * happen; an unchanged amount gives ok false, noChange true, error null. 0 is allowed and voids the whole line (voidsLine).
 */
export function validateAmountCorrection({ payment, newAmount, reason }) {
  const fail = error => ({ ok: false, error, noChange: false, voidsLine: false, oldCents: null, newCents: null, deltaCents: null, newAmount: null, reason: null })
  if (!payment) return fail('Payment not found. Reload the page and try again.')
  const oldCents = cents(payment.amount)
  const raw = String(newAmount ?? '').replace(/[₱\s]/g, '')
  if (raw === '') return fail('Enter the corrected amount.')
  const newCents = parseMoney(raw)
  if (newCents == null) return fail(`The corrected ${moneyProblem(raw)}.`)
  if (newCents > MAX_AMOUNT_CENTS) return fail('The corrected amount is too large.')
  const base = { voidsLine: newCents === 0, oldCents, newCents, deltaCents: newCents - oldCents, newAmount: newCents / 100 }
  if (newCents === oldCents) return { ok: false, error: null, noChange: true, ...base, reason: null }
  const why = String(reason ?? '').trim()
  if (!why) return { ...fail('Enter the reason for the correction.'), ...base }
  if (why.length > MAX_REASON) return { ...fail(`The reason is too long (max ${MAX_REASON} characters).`), ...base }
  return { ok: true, error: null, noChange: false, ...base, reason: why }
}

/** staged: [{ key, siNo, trNo, tenant: { name }, category }] -> [{ key, field: 'si'|'tr', message }] for every invalid number. */
export function validateStagedRefs(staged) {
  const out = []
  for (const s of staged || []) {
    for (const [field, kind, raw] of [['si', 'SI', s.siNo], ['tr', 'TR', s.trNo]]) {
      const n = normalizePaymentRef(kind, raw)
      if (n.error) {
        out.push({ key: s.key, field, message: `${s.tenant?.name ?? 'Tenant'} · ${CATEGORY_LABEL[s.category] || s.category} · ${LABEL[kind]}: ${n.error}` })
      }
    }
  }
  return out
}
