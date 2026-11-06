/**
 * src/lib/finalBill.js
 * --------------------
 * Pure (no React, no Supabase) builder for a tenant's move-out Final Bill, plus the automatic
 * second-to-last-bill advance credit. Money is computed at full precision and rounded to
 * 2 decimals only when a line is stored; every total is the sum of the stored (rounded) lines.
 *
 * A line is { label, mid, amount, kind, rate?, source?, deposit_ids?, original?, prior_cutoff? }
 *   kind 'charge'    rent / water / electricity (positive)
 *   kind 'unsettled' free line typed by staff (earlier unsettled amounts, adjustments)
 *   kind 'credit'    advance / deposit applied (NEGATIVE amount)
 *   kind 'forfeit'   advance / deposit forfeited (amount 0, `original` = the forfeited amount)
 *   kind 'payment'   payments already recorded on the covered cutoffs, netted (NEGATIVE amount, `payment_ids`)
 * Rent / stay extension / water / electricity lines carry `source` 'RENT' | 'EXTENSION' | 'WATER' | 'ELECTRIC' and `computed`
 * (the amount the system computed, so a staff edit can be flagged).
 */
import {
  dayNum, isoOfDay, addMonthsISO, classifyStay, appStart, computeCoverage, isCutoffClosed, cutoffForDate, finalCutoffForUtility, windowOf, pricingInfoForDay, snapToMonthEnd, stayRent, prorateCents, coveredEntries, parseCovered,
} from './stay'
import { resolveStartReading, splitUtility, resolveRate, checkReadingOrder } from './utilityPieces'
import { hasExtension, extensionLine, extensionDetails, nightsWarning, extensionNights, NOON_CHOICE_MISSING } from './stayExtension'

export { addMonthsISO, cutoffForDate }

const MONTH_NAMES = ['January','February','March','April','May','June','July','August','September','October','November','December']

export const toCents = (v) => {
  const n = Number(v)
  if (!Number.isFinite(n)) return 0
  return Math.sign(n) * Math.round(Math.abs(n) * 100) + 0
}
export const round2 = (v) => toCents(v) / 100

const iso10 = (v) => (v ? String(v).slice(0, 10) : null)

const pesoText = (n) => '₱' + Number(n || 0).toLocaleString('en-PH', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
const qtyText = (n) => Number(n || 0).toLocaleString('en-PH', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
const dayMonth = (iso) => { const [, m, d] = iso.slice(0, 10).split('-'); return `${d} ${MONTH_NAMES[+m - 1]}` }

/**
 * Where does this tenant's bill for `cutoff` sit relative to their move-out date?
 * Uses the rent/water window (water_end is exclusive, as in billing.js).
 *   FINAL          move-out date inside this window
 *   SECOND_TO_LAST move-out date inside the NEXT window (water_end .. addMonths(water_end, 1))
 *                  and the tenant moved in before this window (a stay of only one or two billing
 *                  periods has no second-to-last bill: the advance is credited on the final bill).
 *                  A move-out on the LAST day of that next window (a calendar month end) has none either:
 *                  the final bill is then a full month, so the advance goes on the final bill only.
 *   STANDARD       anything else
 * The date is actual_move_out_date || move_out_date, so the position follows the date if it changes.
 */
export function billPosition(tenant, cutoff) {
  const moveOut = iso10(tenant?.actual_move_out_date || tenant?.move_out_date)
  if (!moveOut || !cutoff?.water_start || !cutoff?.water_end) return 'STANDARD'
  const d = dayNum(moveOut), s = dayNum(cutoff.water_start), e = dayNum(cutoff.water_end)
  if (d >= s && d < e) return 'FINAL'
  const nextEnd = dayNum(addMonthsISO(cutoff.water_end, 1))
  if (d >= e && d < nextEnd) {
    if (d === nextEnd - 1) return 'STANDARD'
    const moveIn = iso10(tenant.move_in_date)
    if (moveIn && dayNum(moveIn) >= s) return 'STANDARD'
    return 'SECOND_TO_LAST'
  }
  return 'STANDARD'
}

const REF_PREFIX = { ADVANCE: 'S.I#', DEPOSIT: 'TR#' }
const REF_ALREADY = { ADVANCE: /^\s*S\.?\s?I\s*#/i, DEPOSIT: /^\s*T\.?\s?R\s*#/i }

export function refText(kind, receipts) {
  const refs = [...new Set(receipts.map(p => (p.ref_no ?? p.ref ?? '').trim()).filter(Boolean))]
  return refs.map(r => (REF_ALREADY[kind].test(r) ? r : `${REF_PREFIX[kind]} ${r}`)).join(' & ')
}

const REF_PART = /^\s*(S\.?\s?I|T\.?\s?R)\s*#/i
const REF_LABEL = { ADVANCE: 'S.I#', DEPOSIT: 'T.R#' }
const REF_MAX = 30
// Own-field prefix: S.I# / SI / SI# / S.I. / S.I. No. (T.R likewise), then an optional ':' '.' '-'. Never eats letters of the number.
const prefixRe = (a, b) => new RegExp(`^${a}\\s*\\.?\\s*${b}(?:\\s*\\.?\\s*(?:#|no\\.?(?![a-z])))?(?![a-z])\\s*\\.?\\s*[:.\\-]?\\s*`, 'i')
const REF_OWN = { ADVANCE: prefixRe('S', 'I'), DEPOSIT: prefixRe('T', 'R') }
// Mirrors the correct_receipt_ref RPC: a value still starting with '#' or S.I#/T.R#/SI No is refused there.
const REF_DB_REFUSED = /^(#|(s\s*\.?\s*i|t\s*\.?\s*r)\s*\.?\s*(#|no\b))/i
const REF_CONTROL = /[\u0000-\u001f\u007f-\u009f]/

/**
 * A typed S.I# (advance) / T.R# (deposit) number -> { value, error }. The value is the bare number (no prefix) that is stored in
 * tenant_deposits.ref_no; refText() adds the prefix when it is printed. '&' and an inner '#' are allowed ("121 & TR# 133").
 */
export function normalizeReceiptRef(kind, raw) {
  const label = REF_LABEL[kind] || 'receipt'
  const fail = (error) => ({ value: null, error })
  let v = String(raw ?? '').replace(/\s+/g, ' ').trim()
  const other = kind === 'ADVANCE' ? 'DEPOSIT' : 'ADVANCE'
  if (REF_OWN[other] && REF_OWN[other].test(v) && !REF_OWN[kind].test(v)) {
    return fail(kind === 'ADVANCE'
      ? 'That looks like a T.R#; the advance is documented by an S.I#.'
      : 'That looks like an S.I#; the deposit is documented by a T.R#.')
  }
  if (REF_OWN[kind]) v = v.replace(REF_OWN[kind], '')
  v = v.replace(/^#\s*/, '').trim()
  if (!v) return fail(`Enter the ${label} number.`)
  if (REF_CONTROL.test(v) || v.includes('·')) return fail(`The ${label} number cannot contain '·' or control characters.`)
  if (v.length > REF_MAX) return fail(`The ${label} number is too long (max ${REF_MAX} characters).`)
  if (!/[0-9]/.test(v)) return fail(`The ${label} number must contain at least one digit.`)
  if (REF_DB_REFUSED.test(v)) return fail(`Enter the ${label} number only, without a prefix.`)
  return { value: v, error: null }
}

/** Duplicate-compare key of a receipt number. */
export const refKey = (v) => String(v ?? '').toLowerCase().replace(/\s+/g, '')

const isRefLine = (l) => (l?.kind === 'credit' || l?.kind === 'forfeit') && (l?.source === 'ADVANCE' || l?.source === 'DEPOSIT')
const isLockedRef = (d) => d?.reservation_payment_id != null && String(d?.ref_no ?? '').trim() !== ''
const validRef = (kind, refs, id) => {
  if (!refs || !Object.prototype.hasOwnProperty.call(refs, id)) return undefined
  const n = normalizeReceiptRef(kind, refs[id])
  return n.error ? undefined : n.value
}

/**
 * The receipts this bill credits or forfeits, one entry per receipt id: { deposit_id, kind, amount, received_date, payment_mode,
 * fromReservation, locked, current, required }. locked = a reservation-carried T.R# (read-only); required = amount > 0 and not locked.
 */
export function receiptRefsNeeded(lines, deposits) {
  const byId = new Map((deposits || []).map(d => [d.id, d]))
  const out = []
  const seen = new Set()
  for (const l of lines || []) {
    if (!isRefLine(l)) continue
    for (const id of l.deposit_ids || []) {
      const d = byId.get(id)
      if (!d || seen.has(id)) continue
      seen.add(id)
      const locked = isLockedRef(d)
      out.push({
        deposit_id: id, kind: d.kind, amount: Number(d.amount), received_date: d.received_date ?? null, payment_mode: d.payment_mode ?? null,
        fromReservation: d.reservation_payment_id != null, locked, current: d.ref_no ?? '', required: toCents(d.amount) > 0 && !locked,
      })
    }
  }
  return out
}

/** One message per required receipt whose number (refs[id] when typed, else the one on file) is not a valid S.I#/T.R#. */
export function missingReceiptRefs(lines, deposits, refs = {}) {
  const out = []
  for (const r of receiptRefsNeeded(lines, deposits)) {
    if (!r.required) continue
    const raw = Object.prototype.hasOwnProperty.call(refs || {}, r.deposit_id) ? refs[r.deposit_id] : r.current
    const n = normalizeReceiptRef(r.kind, raw)
    if (n.error) out.push(`${REF_LABEL[r.kind]} of the ${r.kind === 'ADVANCE' ? 'advance' : 'deposit'} receipt #${r.deposit_id} (${pesoText(r.amount)}): ${n.error}`)
  }
  return out
}

/** Puts `ref` as the first ' · ' segment of a line's details, replacing any S.I#/T.R# segment and keeping the rest. */
export function spliceRefSegment(mid, ref) {
  const rest = String(mid ?? '').split(' · ').map(x => x.trim()).filter(x => x && !REF_PART.test(x))
  return [ref, ...rest].filter(Boolean).join(' · ')
}

/**
 * Text only: the details (`mid`) of every advance/deposit credit or forfeit line carry the receipt numbers, from `refs` (typed, valid
 * ones) or else the receipt's ref_no. `only` restricts it to the lines holding that receipt id. Amounts, ids and kinds are untouched.
 */
export function applyReceiptRefs(lines, deposits, refs = {}, { only = null } = {}) {
  const byId = new Map((deposits || []).map(d => [d.id, d]))
  return (lines || []).map(l => {
    if (!isRefLine(l)) return l
    const ids = l.deposit_ids || []
    if (only != null && !ids.includes(only)) return l
    const receipts = ids.map(id => {
      const d = byId.get(id)
      const typed = isLockedRef(d) ? undefined : validRef(l.source, refs, id)
      return { ref_no: typed ?? d?.ref_no ?? '' }
    })
    return { ...l, mid: spliceRefSegment(l.mid, refText(l.source, receipts)) }
  })
}

/**
 * Text only: the Advance check with the typed receipt numbers. receipts[].ref is rebuilt for receipts that have a valid typed number
 * (others keep theirs), and the "Advance <numbers> ₱…" prefix of the text follows. Every figure stays as it is.
 */
export function applyCheckRefs(check, deposits, refs = {}) {
  if (!check || !Array.isArray(check.receipts)) return check
  const byId = new Map((deposits || []).map(d => [d.id, d]))
  const receipts = check.receipts.map(r => {
    const typed = isLockedRef(byId.get(r.deposit_id)) ? undefined : validRef('ADVANCE', refs, r.deposit_id)
    return typed === undefined ? r : { ...r, ref: refText('ADVANCE', [{ ref_no: typed }]) }
  })
  // The old prefix as advanceCheck() wrote it: refText de-duplicates the raw ref_no (so "1234" and "S.I# 1234" both print), else the
  // receipts' own refs. Only a whole "Advance <refs> ₱" prefix is replaced, never part of a longer list.
  const candidates = uniq([
    refText('ADVANCE', check.receipts.map(r => byId.get(r.deposit_id) ?? { ref: r.ref })),
    uniq(check.receipts.map(r => r.ref)).join(' & '),
  ].map(x => `Advance ${x} `))
  const newP = `Advance ${uniq(receipts.map(r => r.ref)).join(' & ')} `
  const t = typeof check.text === 'string' ? check.text : ''
  const oldP = candidates.find(p => t.startsWith(p) && t.slice(p.length).startsWith('₱'))
  const changed = check.receipts.some(r => {
    const typed = isLockedRef(byId.get(r.deposit_id)) ? undefined : validRef('ADVANCE', refs, r.deposit_id)
    return typed !== undefined && typed !== String(byId.get(r.deposit_id)?.ref_no ?? '').trim()
  })
  const text = changed && oldP ? newP + t.slice(oldP.length) : check.text
  return { ...check, receipts, text }
}

const sameName = (a, b) => (a.name || '').trim().toLowerCase() === (b.name || '').trim().toLowerCase()

// Beds billed as one whole-room tenancy (billing.js collapses >= 2 active same-name beds in a room).
export function wholeRoomGroup(t, tenants) {
  const room = t.beds?.room_id
  if (room == null) return [t]
  const group = tenants.filter(x => x.is_active && x.beds?.room_id === room && sameName(x, t))
  return group.length ? group : [t]
}

// Spread `totalCents` over receipts in id order. Returns [{ id, cents }] (only receipts that get a share).
function allocate(receipts, totalCents) {
  let remaining = totalCents
  const out = []
  for (const r of [...receipts].sort((a, b) => a.id - b.id)) {
    const use = Math.min(toCents(r.amount), remaining)
    if (use <= 0) continue
    out.push({ id: r.id, cents: use })
    remaining -= use
  }
  return out
}

const advanceReceipts = (deposits, tenantIds, statuses) =>
  deposits.filter(d => tenantIds.has(d.tenant_id) && d.kind === 'ADVANCE' && statuses.includes(d.status))

/**
 * Pro-rated second-to-last-bill advance credit, integer cents.
 * windowDays W = days of the second-to-last window (water_end exclusive); days D = days of the stay in the next window
 * up to and including the move-out day (capped at W). credit = min(half-up advance x D / W, rent); the rest of the
 * advance (advanceCents - creditCents, exact) is left for the final bill.
 */
export function proratedAdvanceCents({ advanceCents, rentCents, waterStart, waterEnd, moveOut }) {
  const windowDays = dayNum(iso10(waterEnd)) - dayNum(iso10(waterStart))
  const days = Math.min(Math.max(dayNum(iso10(moveOut)) - dayNum(iso10(waterEnd)) + 1, 0), Math.max(windowDays, 0))
  const prorated = windowDays > 0 && days > 0 && advanceCents > 0 ? prorateCents(advanceCents, days, windowDays) : 0
  const creditCents = rentCents == null ? prorated : Math.max(Math.min(prorated, rentCents), 0)
  return { creditCents, days, windowDays }
}

/**
 * Second-to-last-bill advance credit for the tenants billed in `cutoff`.
 * Credit = min(advance on file x D / W, that period's rent) (proratedAdvanceCents): an adjustment, never cash.
 *  - A stored `advance_credits` row for (tenant, cutoff) always wins and is immutable.
 *  - A CLOSED cutoff with no stored row has no credit.
 *  - The ACTIVE cutoff (or `live: true`) is detected live from the move-out date, but a tenant whose
 *    advance was already credited in another cutoff (stored row) gets nothing: the advance is consumed.
 * Whole-room tenancies sum the advance of every same-name bed against the combined rent.
 * Returns Map(tenantId -> { amount, ref, allocations, onFile, remaining, days?, windowDays? }) where onFile is the advance
 * on file (receipts the credit drew on plus the tenant's other advance receipts) and remaining = onFile - amount, the
 * part that is left for the final bill. days / windowDays (the pro-ration) are set on live credits only.
 */
export function advanceCredits({ tenants, cutoff, perTenant, deposits, stored = [], live = null, receiptStatuses = ['HELD', 'APPLIED'] }) {
  const out = new Map()
  const byId = new Map(tenants.map(t => [t.id, t]))
  const isLive = live ?? cutoff.is_active === true
  for (const row of perTenant || []) {
    if (row.special) continue
    const t = byId.get(row.id)
    if (!t) continue
    const mine = stored.find(s => s.tenant_id === t.id && s.cutoff_id === cutoff.id)
    if (mine) {
      const group = row.wholeRoom ? wholeRoomGroup(t, tenants) : [t]
      const allocIds = new Set((mine.allocations || []).map(a => a.deposit_id))
      const onFileC = (deposits || [])
        .filter(d => d.kind === 'ADVANCE' && (allocIds.has(d.id) || (group.some(g => g.id === d.tenant_id) && receiptStatuses.includes(d.status))))
        .reduce((s, d) => s + toCents(d.amount), 0)
      const amountC = toCents(mine.amount)
      // The day count is printed only while the current date still reproduces the frozen amount (never for pre-pro-rating rows).
      const pro = billPosition(t, cutoff) === 'SECOND_TO_LAST' ? proratedAdvanceCents({
        advanceCents: onFileC, rentCents: toCents(row.rent),
        waterStart: cutoff.water_start, waterEnd: cutoff.water_end, moveOut: t.actual_move_out_date || t.move_out_date,
      }) : null
      out.set(t.id, {
        amount: amountC / 100, ref: mine.ref_text || '', allocations: mine.allocations || [],
        onFile: Math.max(onFileC, amountC) / 100, remaining: Math.max(onFileC - amountC, 0) / 100,
        ...(pro && pro.creditCents === amountC ? { days: pro.days, windowDays: pro.windowDays } : {}),
      })
      continue
    }
    if (!isLive || billPosition(t, cutoff) !== 'SECOND_TO_LAST') continue
    const group = row.wholeRoom ? wholeRoomGroup(t, tenants) : [t]
    const receipts = advanceReceipts(deposits || [], new Set(group.map(g => g.id)), receiptStatuses)
    const receiptIds = new Set(receipts.map(r => r.id))
    if (stored.some(s => s.tenant_id === t.id || (s.allocations || []).some(a => receiptIds.has(a.deposit_id)))) continue
    const totalC = receipts.reduce((s, r) => s + toCents(r.amount), 0)
    const pro = proratedAdvanceCents({
      advanceCents: totalC, rentCents: toCents(row.rent),
      waterStart: cutoff.water_start, waterEnd: cutoff.water_end, moveOut: t.actual_move_out_date || t.move_out_date,
    })
    const alloc = allocate(receipts, pro.creditCents)
    const cents = alloc.reduce((s, a) => s + a.cents, 0)
    if (cents > 0) {
      out.set(t.id, {
        amount: cents / 100,
        ref: refText('ADVANCE', receipts.filter(r => alloc.some(a => a.id === r.id))),
        allocations: alloc.map(a => ({ deposit_id: a.id, amount: a.cents / 100 })),
        onFile: totalC / 100, remaining: (totalC - cents) / 100,
        days: pro.days, windowDays: pro.windowDays,
      })
    }
  }
  return out
}

/** Tenants on their second-to-last bill (live) whose advance was already credited in another cutoff. */
export function advanceConsumed({ tenants, cutoff, perTenant, stored = [], cutoffs = [] }) {
  const out = new Map()
  if (cutoff.is_active !== true) return out
  const byId = new Map(tenants.map(t => [t.id, t]))
  for (const row of perTenant || []) {
    const t = byId.get(row.id)
    if (!t || row.special || billPosition(t, cutoff) !== 'SECOND_TO_LAST') continue
    if (stored.some(s => s.tenant_id === t.id && s.cutoff_id === cutoff.id)) continue
    const other = stored.find(s => s.tenant_id === t.id)
    if (other) out.set(t.id, cutoffs.find(c => c.id === other.cutoff_id)?.name || `cutoff #${other.cutoff_id}`)
  }
  return out
}

/** advanceCredits() as Map(tenantId -> amount), the shape buildPaymentMonitoring() takes as adjustments. */
export function advanceAdjustments(args) {
  return new Map([...advanceCredits(args)].map(([id, c]) => [id, c.amount]))
}

/**
 * Rows to insert into advance_credits when `cutoff` is closed: live detection, minus what is already stored.
 * Only HELD receipts are credited, a tenant who already has a FINAL bill is skipped (the advance went to the
 * final bill), and a row whose allocations do not add up to its amount throws (G1 would reject it anyway).
 */
export function creditsToStore({ tenants, cutoff, perTenant, deposits, stored = [], finalBills = [] }) {
  const finalIds = new Set((finalBills || []).filter(f => f.status === 'FINAL').map(f => f.tenant_id))
  const credits = advanceCredits({ tenants, cutoff, perTenant, deposits, stored, live: true, receiptStatuses: ['HELD'] })
  const rows = []
  for (const [id, c] of credits) {
    if (finalIds.has(id) || stored.some(s => s.tenant_id === id && s.cutoff_id === cutoff.id)) continue
    const cents = toCents(c.amount)
    if (cents <= 0) continue
    rows.push({ tenant_id: id, cutoff_id: cutoff.id, amount: cents / 100, ref_text: c.ref || null, allocations: c.allocations })
  }
  assertCreditRows(rows)
  return rows
}

/** Throws unless every advance_credits row's receipt allocations add up exactly to its amount (integer cents). */
export function assertCreditRows(rows) {
  for (const r of rows || []) {
    const cents = toCents(r.amount)
    const allocCents = (r.allocations || []).reduce((s, a) => s + toCents(a.amount), 0)
    if (allocCents !== cents) throw new Error(`Advance credit for tenant #${r.tenant_id}: the receipt allocations (${pesoText(allocCents / 100)}) do not add up to the credit (${pesoText(cents / 100)}). Nothing was recorded.`)
  }
}

const joinNames = (names) => [...new Set(names.filter(Boolean))].join(' & ')

/**
 * How much of this tenant's HELD advance was already credited on a statement before the final bill.
 *  R1 A stored row counts only if its cutoff window ENDS on or before the move-out date (the tenant was really
 *     billed on that statement). A row for the final bill's own cutoff or a later one is an "orphan": the final
 *     bill replaces that statement, so it is ignored (listed in `ignored`) and nothing is charged back for it.
 *  R2 Fail closed: a (non-orphan) row of this tenant that overlaps none of the tenant's HELD ADVANCE receipts is
 *     only accepted when its receipts belong to a same-name same-room sibling bed (`siblingIds`, looked up by
 *     the caller); otherwise `problem` is set and the caller must not produce credit lines.
 * Stored rows are matched by receipt, so a whole-room sibling's row and a lease extension both work. There is no
 * live estimate any more: the cutoff right before the final one is always already closed (and stored) by then.
 * Returns { name, creditedById: Map(receiptId -> cents), byCutoff, ignored, problem? }.
 */
export function priorCredits({ tenant, moveOut, deposits, storedCredits = [], cutoffs = [], siblingIds = null }) {
  const pool = (deposits || []).filter(d => d.kind === 'ADVANCE' && d.status === 'HELD')
  const mine = new Set(pool.map(d => d.id))
  const sibling = siblingIds instanceof Set ? siblingIds : new Set(siblingIds || [])
  const moveNum = dayNum(iso10(moveOut))
  const creditedById = new Map()
  const byCutoff = []
  const ignored = []
  let problem = null
  const ordered = [...(storedCredits || [])].sort((a, b) => (a.cutoff_id - b.cutoff_id) || ((a.id ?? 0) - (b.id ?? 0)))
  for (const s of ordered) {
    const allocs = s.allocations || []
    const overlaps = allocs.some(a => mine.has(a.deposit_id))
    if (s.tenant_id !== tenant.id && !overlaps) continue
    const c = cutoffs.find(x => x.id === s.cutoff_id)
    const name = c?.name || `cutoff #${s.cutoff_id}`
    if (c?.water_end && moveNum != null && dayNum(c.water_end) > moveNum) {
      ignored.push({ cutoff_id: s.cutoff_id, name, cents: toCents(s.amount) })
      continue
    }
    if (!overlaps) {
      if (toCents(s.amount) > 0 && !(allocs.length && allocs.every(a => sibling.has(a.deposit_id)))) {
        problem ||= {
          code: 'ADVANCE_CREDIT_UNMATCHED',
          message: `A stored advance credit of ${pesoText(toCents(s.amount) / 100)} for ${name} does not match this tenant's advance receipts. Resolve it before moving out.`,
        }
      }
      continue
    }
    for (const a of allocs) {
      if (!mine.has(a.deposit_id)) continue
      const cents = toCents(a.amount)
      if (cents <= 0) continue
      creditedById.set(a.deposit_id, (creditedById.get(a.deposit_id) || 0) + cents)
      byCutoff.push({ cutoff_id: s.cutoff_id, name, deposit_id: a.deposit_id, cents })
    }
  }
  return { name: joinNames(byCutoff.map(b => b.name)) || null, creditedById, byCutoff, ignored, ...(problem ? { problem } : {}) }
}

const CLAWBACK_LABEL = 'Advance credited on second-to-last bill (forfeited)'

const fmtStamp = (d) => {
  const p = (n) => String(n).padStart(2, '0')
  return `${p(d.getDate())} ${MONTH_NAMES[d.getMonth()].slice(0, 3)} ${d.getFullYear()} ${p(d.getHours())}:${p(d.getMinutes())}`
}

/** Lines the system builds from the receipts and the stored credits; staff may edit label/mid only. */
/**
 * The "vacated" confirmation of a move-out (admin path): the tenant has vacated the room and access has been returned. Throws
 * (nothing is written) unless v.confirmed === true; returns the record stored in final_bills.details.vacated.
 */
export function vacatedRecord(v, fallbackBy = null, now = new Date()) {
  if (!v || v.confirmed !== true) {
    throw new Error('Confirm that the tenant has vacated the room and access has been returned before moving them out. Nothing was changed.')
  }
  return { confirmed: true, by: v.by || fallbackBy || null, at: v.at || now.toISOString() }
}

const STALE_SHAPE_TAIL = 'The app in this browser is out of date: reload the page and issue the bill again. Nothing was changed.'
const isObj = (v) => !!v && typeof v === 'object' && !Array.isArray(v)

/**
 * Mirror of database trigger G4 (database/migrations/final_bill_shape_guard.sql): the problem with a NEW FINAL bill that has the
 * shape an outdated client wrote (bills 7 and 26), else null. `cutoffs` = the fresh cutoff list; a null cutoff_id is refused only
 * when finalCutoffForUtility gives a water cutoff for the move-out date (a date in a window gap or before every window keeps none).
 * covered_cutoffs is not checked: a stay that began after the latest window legitimately stores [] with a cutoff_id.
 * isReissue: a re-issue may replace a bill that never had `vacated`.
 */
export function finalBillShapeProblem(bill, { cutoffs = [], isReissue = false } = {}) {
  if (bill?.cutoff_id == null && finalCutoffForUtility(cutoffs, 'WATER', bill?.move_out_date).cutoff) {
    return `final bill: no cutoff is set on this bill. ${STALE_SHAPE_TAIL}`
  }
  if (!isObj(bill?.details?.advance_check)) return `final bill: the advance check is missing. ${STALE_SHAPE_TAIL}`
  if (!isReissue && !isObj(bill?.details?.vacated)) return `final bill: the vacated confirmation is missing. ${STALE_SHAPE_TAIL}`
  return null
}

export const isSystemLine = (l) =>
  l?.source === 'ADVANCE_CLAWBACK' || l?.source === 'PAYMENT'
  || ((l?.kind === 'credit' || l?.kind === 'forfeit') && (l?.source === 'ADVANCE' || l?.source === 'DEPOSIT'))

/** Rent / stay extension / water / electricity lines computed by the system (the amount stays editable; the line cannot be deleted). */
export const isComputedLine = (l) => l?.source === 'RENT' || l?.source === 'EXTENSION' || l?.source === 'WATER' || l?.source === 'ELECTRIC'

/**
 * The "Advance check": what the database says about the tenant's advance at this moment.
 *   status NO_ADVANCE | NOT_CREDITED_BEFORE | PARTLY_CREDITED_BEFORE | FULLY_CREDITED_BEFORE | FORFEITED | ORPHAN_IGNORED | BLOCKED
 * Amounts are numbers in pesos computed from integer cents. `lines` (the credit/forfeit lines in force) give
 * credited_here / forfeited; without them they are derived from the same rules buildCreditLines uses.
 */
export function advanceCheck({ deposits, prior = null, lines = null, early = false, waived = false, now = new Date() }) {
  const pool = (deposits || []).filter(d => d.kind === 'ADVANCE' && d.status === 'HELD')
  const totalC = pool.reduce((s, d) => s + toCents(d.amount), 0)
  const creditedById = prior?.creditedById || new Map()
  const forfeit = early && !waived
  const receipts = pool.map(d => {
    const amountC = toCents(d.amount)
    const beforeC = Math.min(creditedById.get(d.id) || 0, amountC)
    return { deposit_id: d.id, ref: refText('ADVANCE', [d]), amount: amountC / 100, credited_before: beforeC / 100, credited_here: forfeit ? 0 : (amountC - beforeC) / 100, beforeC }
  })
  const beforeC = receipts.reduce((s, r) => s + r.beforeC, 0)
  const advLines = (lines || []).filter(l => l.source === 'ADVANCE' && (l.kind === 'credit' || l.kind === 'forfeit'))
  const hereC = advLines.length
    ? advLines.reduce((s, l) => s + (l.kind === 'credit' ? -toCents(l.amount) : 0), 0)
    : (forfeit ? 0 : totalC - beforeC)
  const forfeitedC = advLines.length
    ? advLines.reduce((s, l) => s + (l.kind === 'forfeit' ? toCents(l.original) : 0), 0)
    : (forfeit ? totalC : 0)
  const byCut = new Map()
  for (const b of prior?.byCutoff || []) {
    const cur = byCut.get(b.cutoff_id) || { cutoff_id: b.cutoff_id, name: b.name, cents: 0 }
    cur.cents += b.cents
    byCut.set(b.cutoff_id, cur)
  }
  const priorList = [...byCut.values()].map(p => ({ cutoff_id: p.cutoff_id, name: p.name, amount: p.cents / 100 }))
  const ignored = (prior?.ignored || []).map(i => ({ cutoff_id: i.cutoff_id, name: i.name, amount: i.cents / 100 }))
  const refs = refText('ADVANCE', pool)
  const priorNames = joinNames((prior?.byCutoff || []).map(b => b.name))

  let status, text
  if (prior?.problem) {
    status = 'BLOCKED'; text = prior.problem.message
  } else if (totalC <= 0) {
    status = 'NO_ADVANCE'; text = 'No advance receipt on file.'
  } else if (forfeit) {
    status = 'FORFEITED'
    text = `Advance ${refs} ${pesoText(totalC / 100)} forfeited (early termination)`
      + (beforeC > 0 ? `; ${pesoText(beforeC / 100)} already credited on ${priorNames} is charged back.` : '.')
  } else if (beforeC <= 0) {
    status = 'NOT_CREDITED_BEFORE'
    text = `No earlier advance credit on record (checked ${fmtStamp(now)}); full advance ${pesoText(totalC / 100)} credited on this bill.`
  } else if (beforeC >= totalC) {
    status = 'FULLY_CREDITED_BEFORE'
    text = `Advance ${refs} ${pesoText(totalC / 100)}: already credited ${pesoText(beforeC / 100)} on the ${priorNames} bill; remaining ${pesoText(0)}.`
  } else {
    status = 'PARTLY_CREDITED_BEFORE'
    text = `Advance ${refs} ${pesoText(totalC / 100)}: already credited ${pesoText(beforeC / 100)} on the ${priorNames} bill; remaining ${pesoText((totalC - beforeC) / 100)} credited on this bill.`
  }
  if (!prior?.problem && ignored.length) {
    if (status !== 'FORFEITED') status = 'ORPHAN_IGNORED'
    text += ' ' + ignored.map(i => `A credit of ${pesoText(i.amount)} was recorded for ${i.name}, but this final bill replaces that statement; it is not counted.`).join(' ')
  }
  return {
    version: 1, checked_at: now.toISOString(), status,
    advance_total: totalC / 100, credited_before: beforeC / 100, credited_here: hereC / 100, forfeited: forfeitedC / 100,
    remaining_before: (totalC - beforeC) / 100,
    receipts: receipts.map(({ beforeC: _b, ...r }) => r),
    prior: priorList, ignored, text,
  }
}

/**
 * Credit / forfeit lines for the final bill from the tenant's HELD receipts.
 * `prior` (from priorCredits) = part of the advance already credited on an earlier statement, per receipt:
 *  - credited normally: only the remainder of every receipt is credited here (a 0 line is kept as the record);
 *  - forfeited: the forfeit line shows the full advance AND a charge line takes the earlier credit back, so the
 *    forfeiture really costs the tenant that amount (a waiver removes both the forfeit and the charge-back).
 * With prior.problem no lines are produced at all (the caller must block). Also returns the advance `check`.
 */
export function buildCreditLines(deposits, { earlyTermination = false, waived = false, prior = null, now = new Date() } = {}) {
  if (prior?.problem) {
    return { lines: [], notes: [prior.problem.message], problem: prior.problem, check: advanceCheck({ deposits, prior, lines: [], early: earlyTermination, waived, now }) }
  }
  const pools = { ADVANCE: [], DEPOSIT: [] }
  for (const d of deposits || []) {
    if (d.status === 'HELD') pools[d.kind]?.push(d)
  }
  const lines = []
  const notes = []
  const forfeit = earlyTermination && !waived
  for (const kind of ['ADVANCE', 'DEPOSIT']) {
    const pool = pools[kind]
    const cents = pool.reduce((s, p) => s + toCents(p.amount), 0)
    if (cents <= 0) continue
    const ref = refText(kind, pool)
    const base = { source: kind, deposit_ids: pool.map(p => p.id) }
    // Per receipt: never credit more than a receipt is worth now (a receipt edited down after the credit was stored).
    const priorSum = kind === 'ADVANCE' && prior ? pool.reduce((s, p) => s + (prior.creditedById.get(p.id) || 0), 0) : 0
    const credited = kind === 'ADVANCE' && prior ? pool.reduce((s, p) => s + Math.min(prior.creditedById.get(p.id) || 0, toCents(p.amount)), 0) : 0
    if (credited < priorSum) notes.push(`The advance receipt was edited after the earlier credit: the earlier credit of ${pesoText(priorSum / 100)} is limited to ${pesoText(credited / 100)} here.`)
    if (forfeit) {
      lines.push({ ...base, label: kind === 'ADVANCE' ? 'Advance forfeited' : 'Deposit forfeited', mid: ref, amount: 0, kind: 'forfeit', original: cents / 100 })
      if (credited > 0) {
        lines.push({ label: CLAWBACK_LABEL, mid: prior.name, amount: credited / 100, kind: 'charge', source: 'ADVANCE_CLAWBACK' })
        notes.push(`Advance ${pesoText(credited / 100)} was already credited on the ${prior.name} bill; because it is forfeited it is charged back.`)
      }
    } else if (kind === 'ADVANCE') {
      const balance = cents - credited
      lines.push({
        ...base, label: 'Less: Advanced Payment', kind: 'credit', amount: round2(-balance / 100),
        ...(credited > 0 ? { prior_cutoff: prior.name } : {}),
        mid: [ref, credited > 0
          ? `already credited ${pesoText(credited / 100)} on ${prior.name} · remaining ${pesoText(balance / 100)} (credited here)`
          : 'no earlier credit on record'].filter(Boolean).join(' · '),
      })
      if (credited > 0) notes.push(`Advance ${pesoText(cents / 100)}: ${pesoText(credited / 100)} was already credited on the ${prior.name} bill; only the remaining ${pesoText(balance / 100)} is credited here.`)
    } else {
      lines.push({ ...base, label: 'Less: Deposit Payment', mid: ref, amount: -cents / 100, kind: 'credit' })
    }
  }
  if (prior?.ignored?.length) {
    for (const i of prior.ignored) notes.push(`A credit of ${pesoText(i.cents / 100)} is recorded for ${i.name}, but this final bill replaces that statement, so it is not counted and nothing is charged back for it.`)
  }
  return { lines, notes, check: advanceCheck({ deposits, prior, lines, early: earlyTermination, waived, now }) }
}

/** Replace the credit/forfeit lines (e.g. after the waiver toggle) and keep everything else. */
export function rebuildCreditLines(lines, deposits, opts) {
  const { lines: credit, notes, check, problem } = buildCreditLines(deposits, opts)
  const rest = lines.filter(l => l.kind !== 'credit' && l.kind !== 'forfeit' && l.source !== 'ADVANCE_CLAWBACK')
  return { lines: [...rest.filter(l => l.kind !== 'payment'), ...credit, ...rest.filter(l => l.kind === 'payment')], notes, check, problem }
}

export function normalizeLines(lines) {
  return lines.map(l => ({ ...l, amount: round2(l.amount) }))
}

/** Totals are exact sums of the stored (2-decimal) line amounts. */
export function computeTotals(lines) {
  let charges = 0, credits = 0, net = 0
  for (const l of lines) {
    const c = toCents(l.amount)
    net += c
    if (l.kind === 'credit' || l.kind === 'payment') credits += -c
    else if (l.kind !== 'forfeit') charges += c
  }
  return { total_charges: charges / 100, total_credits: credits / 100, net_amount: net / 100 }
}

const CAT_LABEL = { RENT_WATER: 'Rent + Water', ELECTRICITY: 'Electricity' }

/**
 * The payments this bill nets: only the component the bill really bills for each covered cutoff. RENT_WATER payments count on
 * cutoffs whose rent/water this bill bills, ELECTRICITY payments on cutoffs whose electricity it bills; a payment for a
 * component the bill does not bill belongs to the statement that was already issued. A payment of any other category (OTHER,
 * empty, unknown) is not tied to a statement component and is netted on ANY covered cutoff. Voids (negative rows carrying
 * their original's category and cutoff) are honoured; payments with no cutoff (the move-out "Final payment", recorded after
 * the bill) and payments on uncovered cutoffs are never netted.
 * `covered` = the stored covered_cutoffs entries (a plain id = both components).
 */
export function nettablePayments(payments, covered) {
  const comp = new Map(parseCovered(covered).map(c => [c.id, c]))
  return (payments || []).filter(p => {
    const c = p.cutoff_id == null ? null : comp.get(p.cutoff_id)
    if (!c) return false
    if (p.category === 'RENT_WATER') return c.water
    if (p.category === 'ELECTRICITY') return c.electric
    return c.water || c.electric
  })
}

/** One locked line netting those payments. Returns [] when nothing is left to net. */
export function paymentLines(payments, covered, cutoffs = []) {
  const rows = nettablePayments(payments, covered)
  const net = rows.reduce((s, p) => s + toCents(p.amount), 0)
  if (net <= 0) return []
  const names = [...new Set(rows.map(p => (cutoffs || []).find(c => c.id === p.cutoff_id)?.name).filter(Boolean))]
  const cats = [...new Set(rows.map(p => CAT_LABEL[p.category] || 'Other'))]
  return [{
    label: 'Less: payment received', mid: [names.join(' & '), cats.join(' + ')].filter(Boolean).join(' · '),
    amount: -net / 100, kind: 'payment', source: 'PAYMENT', payment_ids: rows.map(p => p.id).sort((a, b) => a - b),
  }]
}

const norm = (v) => String(v || '').trim().toLowerCase()
const roomOf = (t) => t?.beds?.room_id ?? t?.room_id ?? null
const bedOf = (t) => t?.beds?.bed_letter ?? t?.bed_letter ?? ''

/**
 * Beds that leave together: active tenants with the same trimmed case-insensitive name, in the same room, with the same
 * non-null planned move-out date. Sorted by bed letter then id. A tenant without a planned date is never grouped.
 */
export function siblingGroup(tenant, tenants) {
  const room = roomOf(tenant), date = iso10(tenant.move_out_date)
  if (room == null || !date) return [tenant]
  const g = (tenants || []).filter(x => x.is_active && roomOf(x) === room && norm(x.name) === norm(tenant.name) && iso10(x.move_out_date) === date)
  if (!g.some(x => x.id === tenant.id)) g.push(tenant)
  return g.sort((a, b) => String(bedOf(a)).localeCompare(String(bedOf(b))) || a.id - b.id)
}

/** Same-name active tenants in the room that are NOT grouped with this one because the planned date differs (or is empty). */
export function siblingMismatch(tenant, tenants) {
  const room = roomOf(tenant), date = iso10(tenant.move_out_date)
  if (room == null) return []
  return (tenants || []).filter(x => x.is_active && x.id !== tenant.id && roomOf(x) === room && norm(x.name) === norm(tenant.name) && iso10(x.move_out_date) !== date)
}

/**
 * Apply-time check of a final bill carried in an approval request. Nothing in the payload is trusted for
 * money that comes from the DB: the covered cutoffs (and the billing cutoff) are derived from the stay and the move-out
 * date, early termination from the tenant's planned move_out_date, the credit/forfeit lines (amounts, receipt ids and
 * the advance text) plus the charge-back amount from the tenant's own HELD receipts and the stored advance credits, and
 * the payment line from the tenant's payments on the covered cutoffs. Staff-edited labels, rent/utility/charge and
 * unsettled lines, details and prepared_by are kept. `errors` must block the apply; `diffs` are what changes versus the
 * request, to show the admin; `warnings` are soft (a staff-edited computed amount). `check` is the Advance check from
 * the DB data and `ignored` the orphan credits that were not counted.
 * tenant = DB row (rate, move_in_date, move_out_date); deposits = that tenant's receipts; payments = all of that
 * tenant's payment rows (null = do not check payment lines); siblingIds = receipt ids of same-name same-room sibling
 * beds (only needed to accept a stored credit that sits on a sibling's receipt).
 */
export function reconcileBill({ bill, moveOut, tenant, deposits, cutoffs, storedCredits = [], waived = false, siblingIds = null, payments = null, now = new Date() }) {
  const errors = [], diffs = [], warnings = []
  const cls = classifyStay({ moveIn: iso10(tenant.move_in_date), planned: iso10(tenant.move_out_date), actual: iso10(moveOut), appStartISO: appStart(cutoffs) })
  const cov = computeCoverage({ cutoffs, moveInISO: iso10(tenant.move_in_date), moveOutISO: iso10(moveOut), kind: cls.kind })
  const cutoffId = cov.primaryCutoffId
  const coveredNow = coveredEntries(cov)
  const nameOf = (id) => (cutoffs || []).find(c => c.id === id)?.name || `#${id}`
  if ((bill.cutoff_id ?? null) !== cutoffId) diffs.push(`Billing period: requested ${bill.cutoff_id ?? 'none'}, will use ${cutoffId != null ? nameOf(cutoffId) : 'none (no cutoff covers the date)'}.`)
  if (Array.isArray(bill.covered_cutoffs)) {
    const a = parseCovered(bill.covered_cutoffs), b = parseCovered(coveredNow)
    const say = (list) => list.map(c => nameOf(c.id) + (c.water && c.electric ? '' : c.water ? ' (water and rent only)' : ' (electricity only)')).join(', ') || 'none'
    if (JSON.stringify(a) !== JSON.stringify(b)) diffs.push(`Covered periods: requested [${say(a)}], will use [${say(b)}].`)
  }
  const planned = iso10(tenant.move_out_date)
  const early = !!(planned && moveOut < planned)
  if (!!bill.early_termination !== early) diffs.push(`Early termination: requested ${bill.early_termination ? 'yes' : 'no'}, the tenant's lease end (${planned || 'not set'}) makes it ${early ? 'yes' : 'no'}.`)
  const w = early && !!waived

  const lines = bill.lines || []
  const held = new Map((deposits || []).filter(d => d.status === 'HELD').map(d => [d.id, d]))
  for (const l of lines) {
    if (l.kind !== 'credit' && l.kind !== 'forfeit') continue
    const ids = l.deposit_ids || []
    const foreign = ids.filter(id => !held.has(id) || held.get(id).kind !== l.source)
    if (foreign.length) { errors.push(`"${l.label}" references receipt(s) ${foreign.join(', ')} that are not this tenant's HELD ${l.source} receipts.`); continue }
    const sum = ids.reduce((s, id) => s + toCents(held.get(id).amount), 0)
    const claimed = l.kind === 'credit' ? -toCents(l.amount) : toCents(l.original)
    if (claimed > sum || (l.kind === 'credit' && toCents(l.amount) > 0)) errors.push(`"${l.label}" is ${pesoText(claimed / 100)} but those receipts total ${pesoText(sum / 100)}.`)
  }
  const t = computeTotals(normalizeLines(lines))
  for (const [k, v] of Object.entries({ total_charges: bill.total_charges, total_credits: bill.total_credits, net_amount: bill.net_amount })) {
    if (v != null && toCents(v) !== toCents(t[k])) errors.push(`The request's ${k} (${pesoText(v)}) does not match its lines (${pesoText(t[k])}).`)
  }

  if (bill.details?.stay) {
    const has = (src) => lines.some(l => l.source === src)
    if (!has('RENT')) errors.push('The bill has no rent line.')
    if (cov.water.covered.length && !has('WATER')) errors.push('The bill has no water line although a water period is covered.')
    if (cov.electric.covered.length && !has('ELECTRIC')) errors.push('The bill has no electricity line although an electricity period is covered.')
  }
  for (const l of lines) {
    if (!isComputedLine(l) || l.computed == null) continue
    if (Math.abs(Number(l.amount) - Number(l.computed)) > 0.005) warnings.push(`"${l.label}" was changed by staff: computed ${pesoText(l.computed)}, on the bill ${pesoText(l.amount)}.`)
  }

  const prior = priorCredits({ tenant, moveOut, deposits, storedCredits, cutoffs, siblingIds })
  const expected = buildCreditLines(deposits, { earlyTermination: early, waived: w, prior, now })
  const ignored = prior.ignored.map(i => ({ cutoff_id: i.cutoff_id, name: i.name, amount: i.cents / 100 }))

  // Payment line: recomputed from the tenant's own payments on the covered cutoffs.
  const checkPayments = Array.isArray(payments)
  const oldPay = checkPayments ? lines.filter(l => l.kind === 'payment' || l.source === 'PAYMENT') : []
  let payOut = []
  if (checkPayments) {
    const allowed = new Set(nettablePayments(payments, coveredNow).map(p => p.id))
    for (const l of oldPay) {
      if (toCents(l.amount) > 0) errors.push(`"${l.label}" has a positive amount; a payment line can only reduce the bill.`)
      const foreign = (l.payment_ids || []).filter(id => !allowed.has(id))
      if (foreign.length || !(l.payment_ids || []).length) errors.push(`"${l.label}" references payment(s) ${foreign.join(', ') || '(none)'} that are not this tenant's payments on the covered periods.`)
    }
    const exp = paymentLines(payments, coveredNow, cutoffs)[0] || null
    const old = oldPay[0] || null
    const sameIds = (x = [], y = []) => x.length === y.length && [...x].sort((p, q) => p - q).every((v, i) => v === [...y].sort((p, q) => p - q)[i])
    if (exp && !old) { diffs.push(`Payment received: will be added (${pesoText(-exp.amount)} already paid on the covered periods).`); payOut = [exp] }
    else if (exp && old) {
      if (toCents(old.amount) !== toCents(exp.amount) || !sameIds(old.payment_ids, exp.payment_ids)) {
        diffs.push(`Payment received: requested ${pesoText(-old.amount)}, will apply ${pesoText(-exp.amount)}.`)
      }
      payOut = [{ ...exp, label: old.label || exp.label, mid: old.mid ?? exp.mid }]
    } else if (!exp && old) diffs.push('Payment received: removed (no payment on the covered periods).')
    for (const extra of oldPay.slice(1)) diffs.push(`"${extra.label}": removed (only one payment line is allowed).`)
  }

  if (prior.problem) {
    errors.push(prior.problem.message)
    return {
      lines, cutoff_id: cutoffId, covered_cutoffs: coveredNow, stay: cls, early_termination: early, forfeit_waived: w,
      errors, diffs, warnings, totals: computeTotals(normalizeLines(lines)), check: expected.check, ignored, problem: prior.problem,
    }
  }
  const oldCredit = lines.filter(l => l.kind === 'credit' || l.kind === 'forfeit')
  const oldClaw = lines.find(l => l.source === 'ADVANCE_CLAWBACK')
  const clawback = expected.lines.find(l => l.source === 'ADVANCE_CLAWBACK')
  const creditExpected = expected.lines.filter(l => l.source !== 'ADVANCE_CLAWBACK')
  const sameIds = (a = [], b = []) => a.length === b.length && [...a].sort((x, y) => x - y).every((x, i) => x === [...b].sort((x2, y2) => x2 - y2)[i])
  const rebuilt = []
  for (const e of creditExpected) {
    const p = oldCredit.find(l => l.source === e.source)
    if (!p) diffs.push(`${e.label}: not in the request, will be added (${pesoText(e.kind === 'forfeit' ? e.original : -e.amount)}).`)
    else {
      const amountDiff = p.kind !== e.kind || toCents(p.amount) !== toCents(e.amount) || (e.kind === 'forfeit' && toCents(p.original) !== toCents(e.original))
      if (amountDiff || !sameIds(p.deposit_ids, e.deposit_ids)) {
        const say = (x) => (x.kind === 'forfeit' ? `forfeited ${pesoText(x.original)}` : `credit ${pesoText(-x.amount)}`)
        diffs.push(`${e.source === 'ADVANCE' ? 'Advance' : 'Deposit'}: requested ${say(p)}, will apply ${say(e)}${amountDiff ? '' : ' (the receipts it uses changed)'}.`)
      }
    }
    rebuilt.push(p && p.kind === e.kind ? { ...e, label: p.label } : e)
  }
  for (const p of oldCredit) if (!creditExpected.some(e => e.source === p.source)) diffs.push(`${p.label}: removed (no HELD ${p.source} receipt on file).`)
  let clawOut = null
  if (clawback && !oldClaw) { diffs.push(`${CLAWBACK_LABEL}: will be added (${pesoText(clawback.amount)}).`); clawOut = clawback }
  if (!clawback && oldClaw) diffs.push(`${CLAWBACK_LABEL}: removed (not applicable).`)
  if (clawback && oldClaw) {
    if (toCents(oldClaw.amount) !== toCents(clawback.amount)) diffs.push(`${CLAWBACK_LABEL}: requested ${pesoText(oldClaw.amount)}, will apply ${pesoText(clawback.amount)}.`)
    clawOut = { ...clawback, label: oldClaw.label || clawback.label, mid: oldClaw.mid ?? clawback.mid }
  }

  const kept = lines.filter(l => l.kind !== 'credit' && l.kind !== 'forfeit' && l.source !== 'ADVANCE_CLAWBACK' && !(checkPayments && (l.kind === 'payment' || l.source === 'PAYMENT')))
  const out = [...kept, ...(clawOut ? [clawOut] : []), ...rebuilt, ...payOut]
  return {
    lines: out, cutoff_id: cutoffId, covered_cutoffs: coveredNow, stay: cls, early_termination: early, forfeit_waived: w,
    errors, diffs, warnings, totals: computeTotals(normalizeLines(out)), check: expected.check, ignored,
  }
}

/**
 * Strict re-verification of a bill against fresh database data (direct admin path, right before it is saved).
 * It is reconcileBill plus a verdict: `ok` only when there are no errors and nothing differs, i.e. the credit,
 * forfeit and charge-back lines, the payment line, the covered periods and the early-termination flag are exactly what
 * the database says now. `stale` lists what changed (shown to staff when the bill is rebuilt); `lines` are the corrected
 * lines. tenant = fresh DB row (rate, move_in_date, move_out_date); payments = all of the tenant's payment rows.
 */
export function verifyBillAgainstDb({ bill, moveOut, tenant, deposits, storedCredits = [], cutoffs, waived = false, siblingIds = null, payments = null, now = new Date() }) {
  const r = reconcileBill({ bill, moveOut, tenant, deposits, cutoffs, storedCredits, waived, siblingIds, payments, now })
  return {
    ok: r.errors.length === 0 && r.diffs.length === 0, stale: r.diffs, errors: r.errors, warnings: r.warnings, check: r.check, lines: r.lines,
    ignored: r.ignored, problem: r.problem || null, cutoff_id: r.cutoff_id, covered_cutoffs: r.covered_cutoffs,
  }
}

const nonEmpty = (v) => v !== '' && v != null

// The computed source of a request line; lines from an old modal carry no `source`, so they are recognised by their label.
export const computedSourceOf = (l) => {
  if (l.source === 'RENT' || l.source === 'EXTENSION' || l.source === 'WATER' || l.source === 'ELECTRIC') return l.source
  if (l.source || l.kind !== 'charge') return null
  if (/^Rent\b/i.test(l.label || '')) return 'RENT'
  if (/^Add: Water/i.test(l.label || '')) return 'WATER'
  if (/^Add: Electric/i.test(l.label || '')) return 'ELECTRIC'
  return null
}
const SOURCE_TEXT = { RENT: 'Rent', EXTENSION: 'Stay extension', WATER: 'Water', ELECTRIC: 'Electricity' }

/**
 * A stay extension typed by staff before the computed EXTENSION line existed: a rent line relabelled "...extension..." (bill #26) or a
 * typed "Unsettled" line mentioning an extension. Where the computed line is present it replaces these, so the nights are never charged twice.
 */
export const isTypedExtension = (l) => !!l && l.source !== 'EXTENSION' && /extension/i.test(l.label || '')
  && ((l.kind === 'charge' && computedSourceOf(l) === 'RENT') || l.kind === 'unsettled')

/**
 * Approval review / apply: the rent, water and electricity lines of a request were computed at SUBMIT time, each request
 * assuming the other leavers of the room are still present. `fresh` is the draft rebuilt from the database NOW (same date, readings,
 * start-reading overrides and 12:00 PM choice; beds already applied are ghosts). Per source (RENT, EXTENSION, WATER, ELECTRIC):
 *  - UNEDITED lines (amount equals the line's own `computed`, or no `computed` marker exists: old requests) are replaced by the fresh
 *    lines, and any difference is listed in `diffs`;
 *  - lines STAFF EDITED (amount differs from their own `computed`) are kept as requested, with a warning.
 * Typed (unsettled) lines and the locked system lines are not touched here. Returns { lines, details, diffs, warnings, replaced }.
 */
export function mergeRecomputedLines({ lines, details = null, fresh }) {
  const diffs = [], warnings = []
  let out = [...lines]
  const nd = { ...(details || {}) }
  let replaced = false
  // A hand-typed extension gives way to the computed EXTENSION line (else the nights would be charged twice).
  const typedExtensions = fresh.lines.some(l => l.source === 'EXTENSION') ? out.filter(isTypedExtension) : []
  if (typedExtensions.length) {
    out = out.filter(l => !typedExtensions.includes(l))
    for (const l of typedExtensions) diffs.push(`"${String(l.label).trim()}" (${pesoText(round2(l.amount))}, typed by staff) is replaced by the computed stay extension.`)
  }
  for (const S of ['RENT', 'EXTENSION', 'WATER', 'ELECTRIC']) {
    const idxs = out.map((l, i) => (computedSourceOf(l) === S ? i : -1)).filter(i => i >= 0)
    const req = idxs.map(i => out[i])
    const F = fresh.lines.filter(l => l.source === S)
    const reqC = req.map(l => toCents(l.amount)), freshC = F.map(l => toCents(l.amount))
    const sum = (a) => a.reduce((x, y) => x + y, 0)
    const edited = req.some(l => l.computed != null && Math.abs(Number(l.amount) - Number(l.computed)) > 0.005)
    if (edited) {
      if (sum(reqC) !== sum(freshC)) warnings.push(`${SOURCE_TEXT[S]} was edited by staff and is kept at ${pesoText(sum(reqC) / 100)}; the database now computes ${pesoText(sum(freshC) / 100)}.`)
      continue
    }
    if (reqC.length !== freshC.length || reqC.some((c, i) => c !== freshC[i])) {
      diffs.push(`${SOURCE_TEXT[S]}: requested ${pesoText(sum(reqC) / 100)}, will apply ${pesoText(sum(freshC) / 100)} (recomputed from the database now).`)
    }
    const without = out.filter((_, i) => !idxs.includes(i))
    const afterRent = S === 'EXTENSION' ? without.map(l => computedSourceOf(l) === 'RENT').lastIndexOf(true) : -1
    let at = idxs.length ? idxs[0] : afterRent >= 0 ? afterRent + 1 : without.findIndex(l => l.kind === 'unsettled' || l.kind === 'credit' || l.kind === 'forfeit' || l.kind === 'payment' || l.source === 'ADVANCE_CLAWBACK')
    if (at < 0) at = without.length
    out = [...without.slice(0, at), ...F, ...without.slice(at)]
    replaced = true
    if (S === 'WATER') nd.water = fresh.details.water
    if (S === 'ELECTRIC') nd.electric = fresh.details.electric
    if (S === 'EXTENSION') {
      if (fresh.details.extension) nd.extension = fresh.details.extension
      else delete nd.extension
    }
  }
  if (replaced) nd.stay = fresh.details.stay
  return { lines: out, details: nd, diffs, warnings, replaced, replacedTyped: typedExtensions.map(l => ({ label: String(l.label).trim(), amount: round2(l.amount) })) }
}

const uniq = (list) => [...new Set(list.filter(Boolean))]
const refMid = (lines) => {
  const parts = lines.flatMap(l => String(l.mid || '').split(' · ').map(x => x.trim()).filter(Boolean))
  return [uniq(parts.filter(x => REF_PART.test(x))).join(' & '), ...uniq(parts.filter(x => !REF_PART.test(x)))].filter(Boolean).join(' · ')
}
const qtyOf = (l) => { const n = Number(String(l.mid ?? '').replace(/,/g, '')); return Number.isFinite(n) && String(l.mid ?? '').trim() !== '' ? toCents(n) : null }

/**
 * Display only: one summed statement for one tenant's several beds (the database keeps one final_bills row per bed). Amounts are summed in
 * integer cents per line type: one rent line, water and electricity per rate, advance and deposit credits, forfeits, the charge-back and the
 * payment line; typed lines are listed individually with their bed. items = [{ bed, bill: { lines, details, net_amount? } }] in bed order.
 * Returns { lines, details, net_amount, total_charges, total_credits, perBed, bedNote, billIds }; the net is the exact sum of the beds' nets.
 */
export function combineBillsForPrint(items) {
  const rows = items.flatMap(it => normalizeLines(it.bill.lines || []).map(l => ({ l, bed: it.bed })))
  const lines = []
  const sum = (ls) => ls.reduce((s, l) => s + toCents(l.amount), 0) / 100
  const same = (vals) => (new Set(vals).size === 1 ? vals[0] : null)
  const take = (pred) => rows.filter(r => pred(r.l)).map(r => r.l)
  const rent = take(l => computedSourceOf(l) === 'RENT')
  if (rent.length) lines.push({ label: same(rent.map(l => l.label)) ?? 'Rent', mid: same(rent.map(l => l.mid)) ?? '', amount: sum(rent), kind: 'charge', source: 'RENT' })
  const ext = take(l => computedSourceOf(l) === 'EXTENSION')
  if (ext.length) {
    const nights = ext.map(l => parseInt(String(l.mid ?? ''), 10))
    const rate = same(ext.map(l => String(l.rate ?? '')))
    lines.push({
      label: same(ext.map(l => l.label)) ?? 'Stay extension',
      mid: nights.every(Number.isFinite) ? `${nights.reduce((a, b) => a + b, 0)} nights` : '',
      ...(rate != null && rate !== '' ? { rate: Number(rate) } : {}), amount: sum(ext), kind: 'charge', source: 'EXTENSION',
    })
  }
  for (const S of ['WATER', 'ELECTRIC']) {
    const all = take(l => computedSourceOf(l) === S)
    for (const r of uniq(all.map(l => String(l.rate ?? '')))) {
      const ls = all.filter(l => String(l.rate ?? '') === r)
      const q = ls.map(qtyOf)
      lines.push({
        label: same(ls.map(l => l.label)) ?? (S === 'WATER' ? 'Add: Water (cu. m)' : 'Add: Electricity (per kWh)'),
        mid: q.every(v => v != null) ? qtyText(q.reduce((a, b) => a + b, 0) / 100) : '',
        ...(r !== '' ? { rate: Number(r) } : {}), amount: sum(ls), kind: 'charge', source: S,
        ...(uniq(ls.map(l => l.rate_note)).length ? { rate_note: uniq(ls.map(l => l.rate_note)).join('; ') } : {}),
        ...(uniq(ls.map(l => l.gap_note)).length ? { gap_note: uniq(ls.map(l => l.gap_note)).join('; ') } : {}),
      })
    }
  }
  const isGrouped = (l) => computedSourceOf(l) || l.kind === 'credit' || l.kind === 'forfeit' || l.kind === 'payment' || l.source === 'ADVANCE_CLAWBACK'
  for (const r of rows) if (!isGrouped(r.l)) lines.push({ ...r.l, label: `${r.l.label} (Bed ${r.bed})` })
  const claw = take(l => l.source === 'ADVANCE_CLAWBACK')
  if (claw.length) lines.push({ label: claw[0].label, mid: uniq(claw.map(l => l.mid)).join(' & '), amount: sum(claw), kind: claw[0].kind, source: 'ADVANCE_CLAWBACK' })
  for (const src of ['ADVANCE', 'DEPOSIT']) {
    for (const kind of ['credit', 'forfeit']) {
      const ls = take(l => l.kind === kind && l.source === src)
      if (!ls.length) continue
      lines.push({
        label: ls[0].label, mid: refMid(ls), amount: sum(ls), kind, source: src, deposit_ids: ls.flatMap(l => l.deposit_ids || []),
        ...(kind === 'forfeit' ? { original: ls.reduce((s, l) => s + toCents(l.original), 0) / 100 } : {}),
      })
    }
  }
  const others = take(l => (l.kind === 'credit' || l.kind === 'forfeit') && l.source !== 'ADVANCE' && l.source !== 'DEPOSIT')
  for (const l of others) lines.push(l)
  const pay = take(l => l.kind === 'payment')
  if (pay.length) lines.push({ label: pay[0].label, mid: uniq(pay.map(l => l.mid)).join(' & '), amount: sum(pay), kind: 'payment', source: 'PAYMENT', payment_ids: pay.flatMap(l => l.payment_ids || []) })

  const netOf = (it) => toCents(it.bill.net_amount ?? computeTotals(normalizeLines(it.bill.lines || [])).net_amount)
  const netC = items.reduce((s, it) => s + netOf(it), 0)
  const detail = (k) => {
    const ds = items.map(it => it.bill.details?.[k]).filter(Boolean)
    if (!ds.length) return null
    return { ...ds[0], personalCons: ds.reduce((s, d) => s + toCents(d.personalCons), 0) / 100 }
  }
  const perBed = items.map(it => {
    const ls = normalizeLines(it.bill.lines || [])
    const of = (S) => ls.filter(l => computedSourceOf(l) === S).reduce((s, l) => s + toCents(l.amount), 0) / 100
    return { bed: it.bed, rent: of('RENT'), extension: of('EXTENSION'), water: of('WATER'), electric: of('ELECTRIC'), net: netOf(it) / 100 }
  })
  const bedNote = perBed.map(b => `Bed ${b.bed}: rent ${pesoText(b.rent)}${b.extension ? `, stay extension ${pesoText(b.extension)}` : ''}, water ${pesoText(b.water)}, electricity ${pesoText(b.electric)}, ${b.net < 0 ? `to return ${pesoText(-b.net)}` : `due ${pesoText(b.net)}`}`).join(' · ')
  const totals = computeTotals(lines)
  return {
    lines, details: { asOf: items[0]?.bill.details?.asOf ?? null, water: detail('water'), electric: detail('electric'), stay: items[0]?.bill.details?.stay ?? null },
    net_amount: netC / 100, total_charges: totals.total_charges, total_credits: totals.total_credits, perBed, bedNote,
    billIds: items.map(it => it.bill.id).filter(id => id != null),
  }
}

/**
 * Splits print items [{ name, room, bed, bill }] into statements: non-void bills with the same trimmed case-insensitive name, room and
 * move-out date form ONE summed statement; anything else stays on its own. Returns [{ items, combined: boolean }] in first-seen order.
 */
export function groupBillsForPrint(items) {
  const groups = new Map()
  items.forEach((it, i) => {
    const key = it.bill.status === 'VOID' ? `void|${i}` : `${norm(it.name)}|${it.room}|${iso10(it.bill.move_out_date)}`
    if (!groups.has(key)) groups.set(key, [])
    groups.get(key).push(it)
  })
  return [...groups.values()].map(list => ({
    items: [...list].sort((a, b) => String(a.bed).localeCompare(String(b.bed)) || a.bill.id - b.bill.id),
    combined: list.length > 1,
  }))
}

/** Was this bed's final bill issued by THIS approval request (its details.approval_request_id)? v = verifyMoveOutApplied() result. */
export const appliedByRequest = (v, requestId) => !!v && v.ok === true && v.requestId != null && String(v.requestId) === String(requestId)

/**
 * A request bed in the approval review / apply:
 *  ACTIVE         still in the room: reconcile it and apply it
 *  APPLIED_HERE   already out through THIS request's own final bill (a resume after a partial failure): nothing to reconcile, nothing to
 *                 apply, its receipts are settled so a reconcile would only report stale errors
 *  OUT_ELSEWHERE  out through some other bill (or none): the request cannot be applied for this bed
 */
export function bedRequestState({ tenantActive, applied, requestId }) {
  if (tenantActive) return 'ACTIVE'
  return appliedByRequest(applied, requestId) ? 'APPLIED_HERE' : 'OUT_ELSEWHERE'
}

/** Other ACTIVE tenants of the room whose planned move-out is earlier than this request's date (they should be approved first). */
export function earlierLeavers({ tenants, groupIds, roomId, date }) {
  const ids = new Set((groupIds || []).map(Number))
  return (tenants || []).filter(x => x.is_active && !ids.has(Number(x.id)) && roomOf(x) === roomId && iso10(x.move_out_date) && iso10(x.move_out_date) < iso10(date))
}
export const earlierLeaverWarning = (x) =>
  `${x.name} leaves earlier (${iso10(x.move_out_date)}) and is not processed yet; approve move-outs in move-out date order so the room's utilities reconcile.`

/** Review vs apply race: the net the admin saw must still be the net that would be applied (same cents). null = fine. */
export function figuresChangedMessage({ label, shown, now }) {
  if (shown == null || toCents(now) === toCents(shown)) return null
  const sp = (v) => (Number(v) < 0 ? '-' : '') + pesoText(Math.abs(Number(v)))
  return `The figures changed since you opened this review (${label}: shown ${sp(shown)}, now ${sp(now)}). Reopen the review and approve again. Nothing was changed.`
}

/**
 * Pending move-out approval requests that already cover any of these tenant ids (the request's tenant, its entity id or one of its
 * sibling beds). `requests` = approval_requests rows. Used to stop a second request for the same tenant.
 */
export function pendingMoveOutFor(requests, tenantIds) {
  const want = new Set((tenantIds || []).map(Number))
  return (requests || []).filter(r => {
    if (r.status && r.status !== 'PENDING') return false
    if (r.field_name !== 'move_out' && r.new_value?._action !== 'process_move_out') return false
    const ids = [r.entity_id, r.new_value?._tenant_id, ...(r.new_value?._siblings || []).map(s => s._tenant_id)].filter(v => v != null).map(Number)
    return ids.some(id => want.has(id))
  })
}

/** Rent billed on a CLOSED cutoff's statement for a tenant who moved in at `moveInNum` (the billing.js rule), in cents. */
function statementRentCents(rateC, moveInNum, wStart, wEnd) {
  if (moveInNum >= wEnd) return 0
  return moveInNum > wStart ? prorateCents(rateC, wEnd - moveInNum, wEnd - wStart) : rateC
}

function buildRentLines({ tenant, cls, cov, cutoffs, moveInISO, moveOutISO }) {
  const rateC = toCents(Number(tenant.rate) || 0)
  const mi = dayNum(moveInISO), mo = dayNum(moveOutISO)
  const warnings = []
  const range = `${dayMonth(moveInISO)} - ${dayMonth(moveOutISO)}`
  const info = { rule: cls.rentRule, months: cls.months }
  const mk = (label, mid, cents) => ({ label, mid, amount: cents / 100, kind: 'charge', source: 'RENT', computed: cents / 100 })

  if (cls.kind === 'STAY_BILLED' && cls.rentRule === 'FLAT_ONE_MONTH') {
    return { lines: [mk('Rent (1 month, flat)', range, rateC)], warnings, info }
  }
  if (cls.kind === 'WHOLE_MONTHS') {
    const final = cov.water.final
    const limit = final ? dayNum(final.water_start) : mo
    let closedC = 0
    for (const c of cutoffs) {
      const w = windowOf(c, 'WATER')
      if (!w || !(w.s <= mo && w.e > mi) || !isCutoffClosed(c, cutoffs) || w.e > limit) continue
      const cents = statementRentCents(rateC, mi, w.s, w.e)
      closedC += cents
      // A tenant created after the next cutoff was opened (back-dated move-in) was never really billed on this closed statement.
      const next = cutoffs.filter(x => (dayNum(x.water_start) ?? 0) >= w.e).sort((a, b) => dayNum(a.water_start) - dayNum(b.water_start))[0]
      if (cents > 0 && next?.created_at && tenant.created_at && Date.parse(tenant.created_at) > Date.parse(next.created_at)) {
        warnings.push(`${tenant.name || 'The tenant'} was added after the ${c.name} statement closed; the closed-period rent deducted (${pesoText(cents / 100)}) assumes it was billed.`)
      }
    }
    const sr = stayRent(rateC, moveInISO, moveOutISO)
    if (!sr) {
      warnings.push('The stay dates are not usable, so the rent could not be computed. The rent line is 0: key it in manually.')
      return { lines: [mk('Rent', range, 0)], warnings, info }
    }
    const totalC = sr.totalCents
    if (totalC < closedC) warnings.push(`The rent already billed on closed statements (${pesoText(closedC / 100)}) is more than the rent of the stay (${pesoText(totalC / 100)}); the rent line is 0.`)
    const amountC = Math.max(0, totalC - closedC)
    info.closed_cents = closedC
    info.months = sr.months
    info.total_cents = totalC
    const plural = (n, w) => `${n} ${w}${n === 1 ? '' : 's'}`
    const parts = []
    if (sr.months > 0) parts.push(sr.exact ? `${plural(sr.months, 'month')} x ${pesoText(rateC / 100)}` : plural(sr.months, 'month'))
    if (!sr.exact) {
      parts.push(sr.segments.map(x => `${x.days} of ${x.monthDays} days`).join(' + '))
    }
    info.summary = parts.join(' + ')
    const label = `Rent (${parts.join(' + ')} = ${pesoText(totalC / 100)}`
      + (closedC > 0 ? `, less ${pesoText(closedC / 100)} billed on closed statements)` : ')')
    return { lines: [mk(label, range, amountC)], warnings, info }
  }

  const wins = cov.water.covered
  if (!wins.length && !cov.water.beyondWindow) {
    warnings.push('No billing period (cutoff) holds the move-out date, so the rent could not be prorated. The rent line is 0: key it in manually.')
    return { lines: [mk('Rent Period', '', 0)], warnings, info }
  }
  const lines = []
  for (const c of wins) {
    const w = windowOf(c, 'WATER')
    const periodDays = w.e - w.s
    const fromNum = Math.max(w.s, mi ?? w.s)
    const lastNum = Math.min(Math.max(mo, fromNum), w.e - 1)
    const days = Math.max(0, Math.min(mo, w.e - 1) - fromNum + 1)
    if (days === 0 && (wins.length > 1 || cov.water.beyondWindow)) continue
    lines.push(mk(
      days < periodDays ? `Rent Period (${days} of ${periodDays} days)` : 'Rent Period',
      days > 0 ? `${dayMonth(isoOfDay(fromNum))} - ${dayMonth(isoOfDay(lastNum))}` : '',
      prorateCents(rateC, days, periodDays),
    ))
  }
  // After the latest window there is no cutoff to prorate against: the rest of the stay uses the real calendar months.
  if (cov.water.beyondWindow) {
    let from = Math.max(windowOf(cov.water.final, 'WATER').e, mi ?? -Infinity)
    while (from <= mo) {
      const monthEnd = snapToMonthEnd(isoOfDay(from))
      const to = Math.min(mo, dayNum(monthEnd))
      const days = to - from + 1, monthDays = Number(monthEnd.slice(8, 10))
      lines.push(mk(days < monthDays ? `Rent Period (${days} of ${monthDays} days)` : 'Rent Period', `${dayMonth(isoOfDay(from))} - ${dayMonth(isoOfDay(to))}`, prorateCents(rateC, days, monthDays)))
      from = to + 1
    }
  }
  if (!lines.length) lines.push(mk('Rent Period', '', 0))
  return { lines, warnings, info }
}

const UTIL_LABEL = { WATER: 'Add: Water (cu. m)', ELECTRIC: 'Add: Electricity (per kWh)' }
const UTIL_KEY = { WATER: 'water', ELECTRIC: 'electric' }
const ROUNDING_RULE = 'Each reading-to-reading piece is rounded to the cent; the cents are shared by day-weights, any odd cent goes to the larger fractional share, ties to the lower tenant id (first bed).'

/**
 * Auto-draft of the final bills of one move-out (one tenant, or sibling beds leaving together).
 *
 *   group      tenant rows (id, name, rate, move_in_date, move_out_date, beds{room_id, bed_letter} ...), in bed order
 *   tenants    every tenant (fetchTenants): the room's other occupants share the utility pieces
 *   readings   { water, electric } room meter readings at move-out
 *   bundle     { rowsByCutoff: Map('WATER'|'ELECTRIC' -> Map(cutoffId -> { prev, curr, rate })) for the room,
 *                interimsAll: every interim reading of the room (all cutoffs), splitFlags: Set('cutoffId|UTILITY'),
 *                addonFlags: add-on rows of the group }
 *   deposits / payments / plannedMoveOut / waived / siblingIds   Map(tenantId -> ...); storedCredits: array
 *   startOverrides { WATER, ELECTRIC }  start readings typed by staff (apply to the stay-billed tenants)
 *   isAdmin    admin may proceed without a cutoff holding the date (that utility's lines are 0, its reading is not saved)
 *
 * Rent, covered cutoffs and the utility pieces: see requirements section 5. Money is integer cents; every line is stored
 * rounded to 2 decimals and the totals are the exact sum of the stored lines.
 * Returns { drafts: Map(tenantId -> draft), warnings, startReadings }. A draft is { lines, details, period, earlyTermination,
 * totals, warnings, errors, notes, prior, check, blocking, cutoff_id, covered_cutoffs, stay, readingPlan }. `blocking` stops
 * the flow at step 1 (missing cutoff for a non-admin, unmatched stored advance credit); `errors` are reading problems the
 * staff fix in the bill editor (they disable the confirm step).
 */
export function buildFinalBillDrafts({
  group, cutoffs = [], tenants = [], moveOutDate, readings: rawReadings = {}, bundle = {}, deposits = new Map(), storedCredits = [],
  payments = new Map(), plannedMoveOut = new Map(), waived = new Map(), siblingIds = new Map(), startOverrides = {}, isAdmin = false, now = new Date(),
  vacatedAfterNoon = null,
}) {
  const moveOut = iso10(moveOutDate)
  const moveNum = dayNum(moveOut)
  const readings = {
    WATER: nonEmpty(rawReadings.water) ? round2(rawReadings.water) : null,
    ELECTRIC: nonEmpty(rawReadings.electric) ? round2(rawReadings.electric) : null,
  }
  const roomId = roomOf(group[0])
  const rowsBy = bundle.rowsByCutoff || new Map()
  const rowsFor = (u) => rowsBy.get(u) || new Map()
  const interimsAll = bundle.interimsAll || []
  const groupIds = group.map(g => g.id)
  const appS = appStart(cutoffs)
  const getMap = (m, id, d) => (m instanceof Map && m.has(id) ? m.get(id) : d)
  const startReadings = { WATER: null, ELECTRIC: null }

  const ctxs = group.map(t => {
    const moveInISO = iso10(t.move_in_date)
    const planned = iso10(getMap(plannedMoveOut, t.id, t.move_out_date))
    const cls = classifyStay({ moveIn: moveInISO, planned, actual: moveOut, appStartISO: appS })
    const cov = computeCoverage({ cutoffs, moveInISO, moveOutISO: moveOut, kind: cls.kind })
    // Late move-out: rent runs to the contract date (its own rent rule); coverage and utilities keep the actual date.
    const late = hasExtension({ contractISO: planned, actualISO: moveOut })
    const toContract = late ? classifyStay({ moveIn: moveInISO, planned, actual: planned, appStartISO: appS }) : null
    const rentCls = toContract && toContract.kind === cls.kind ? toContract : cls
    const rentEnd = late ? planned : moveOut
    const afterNoon = vacatedAfterNoon instanceof Map ? (vacatedAfterNoon.has(t.id) ? vacatedAfterNoon.get(t.id) : null) : vacatedAfterNoon
    return {
      t, moveInISO, planned, cls, cov, late, rentCls, rentEnd, afterNoon: afterNoon === true || afterNoon === false ? afterNoon : null,
      warnings: [], errors: [], blocking: [], util: { WATER: null, ELECTRIC: null }, utilLines: { WATER: [], ELECTRIC: [] }, details: {}, notesRate: [],
    }
  })
  const pushAll = (list, msg, key = 'warnings') => { for (const c of list) if (!c[key].includes(msg)) c[key].push(msg) }

  for (const u of ['WATER', 'ELECTRIC']) {
    const missing = ctxs[0].cov[UTIL_KEY[u]].missing
    if (!missing) continue
    const low = UTIL_KEY[u]
    if (isAdmin) {
      pushAll(ctxs, `No cutoff has a ${low} window holding ${missing.date} (the ${missing.name} cutoff is not open). The ${low} lines are 0 and the ${low} move-out reading will NOT be saved: key the lines in by hand${u === 'WATER' ? ' (rent that depends on a window is 0 too)' : ''}.`)
    } else {
      pushAll(ctxs, `Open the ${missing.name} cutoff first: no cutoff has a ${low} window holding ${missing.date}. Ask an admin to open it, or to process this move-out.`, 'blocking')
    }
  }

  // Mirrors billing.js: active tenants of the room, the tenants moving out now, and inactive tenants that are ghosts (final-billed with
  // that component covered) for a cutoff being priced. Every other inactive row, even with an actual date, is ignored.
  const ignoredRows = new Set()
  const usedGhosts = []  // ghosts (earlier final bills of this room) that overlap the span
  const participantsFor = (spanStart, spanEnd, util, pricingIds) => {
    const out = []
    const seen = new Set()
    const isGhostHere = (x) => {
      if (!x._finalBilled) return false
      const ids = (util === 'WATER' ? x._finalBilledWater : x._finalBilledElectric) ?? x._finalBilledCutoffs ?? []
      return ids.some(id => pricingIds.has(id))
    }
    const consider = (x) => {
      const leaver = ctxs.find(c => c.t.id === x.id)
      const miN = dayNum(iso10(x.move_in_date))
      const moN = leaver ? moveNum : dayNum(iso10(x.actual_move_out_date || x.move_out_date))
      if ((miN != null && miN > spanEnd) || (moN != null && moN < spanStart)) return
      if (!leaver && x.transfer_date) {
        const tn = dayNum(iso10(x.transfer_date))
        if (tn != null && tn >= spanStart && tn <= spanEnd) {
          pushAll(ctxs, `${x.name} was transferred during this stay and is left out of the utility split; check the utility lines.`)
          return
        }
      }
      if (seen.has(x.id)) return
      seen.add(x.id)
      out.push({ id: x.id, moveInNum: miN, moveOutNum: moN })
    }
    for (const x of tenants) {
      if (roomOf(x) !== roomId) continue
      if (x.is_active || ctxs.some(c => c.t.id === x.id) || isGhostHere(x)) {
        consider(x)
        if (!x.is_active && !ctxs.some(c => c.t.id === x.id) && out.some(o => o.id === x.id)) usedGhosts.push(x)
        continue
      }
      const miN = dayNum(iso10(x.move_in_date)), moN = dayNum(iso10(x.actual_move_out_date || x.move_out_date))
      if (!((miN != null && miN > spanEnd) || (moN != null && moN < spanStart))) ignoredRows.add(x.id)
    }
    for (const c of ctxs) consider(c.t)
    return out
  }

  const pricingIdsOf = (u, from, to) => {
    const ids = new Set()
    for (let d = from; d <= to; d++) { const c = pricingInfoForDay(cutoffs, u, d).cutoff; if (c) ids.add(c.id) }
    return ids
  }
  const classes = [
    ['STAY', ctxs.filter(c => c.cls.kind === 'STAY_BILLED')],
    ['REG', ctxs.filter(c => c.cls.kind !== 'STAY_BILLED')],
  ]
  const todayISO = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`
  if (moveNum > dayNum(todayISO) + 31) pushAll(ctxs, `The move-out date (${moveOut}) is more than 31 days from today; check the date.`)
  for (const u of ['WATER', 'ELECTRIC']) {
    const key = UTIL_KEY[u]
    const final = ctxs[0].cov[key].final
    if (!final) continue
    if (ctxs[0].cov[key].beyondWindow && moveNum - (windowOf(final, u).e - 1) > 31) {
      pushAll(ctxs, `The move-out date (${moveOut}) is more than 31 days past the last ${key} window (${final.name}); check the date.`)
    }
    if (readings[u] == null) { pushAll(ctxs, `No ${key} reading entered; the ${key} line is 0.`); continue }
    if (roomId == null) { pushAll(ctxs, 'This tenant has no room, so utilities were not computed. Add them as lines if needed.'); continue }
    const order = checkReadingOrder({ utility: u, roomId, moveOutISO: moveOut, value: readings[u], finalCutoffId: final.id, interimsAll, groupIds })
    for (const msg of order.errors) pushAll(ctxs, msg, 'blocking')
    for (const msg of order.warnings) pushAll(ctxs, msg)
    const rows = rowsFor(u)
    const beyondWindow = ctxs[0].cov[key].beyondWindow
    const finalRow = rows.get(final.id)
    if (beyondWindow && finalRow && Number(finalRow.curr) > 0 && readings[u] < Number(finalRow.curr)) {
      pushAll(ctxs, `The ${key} move-out reading (${readings[u]}) is dated after the ${final.name} window but is lower than that cutoff's current reading (${Number(finalRow.curr)}): one of the two readings is wrong. Check them.`)
    }
    for (const [cname, members] of classes) {
      if (!members.length) continue
      let start
      if (cname === 'STAY') {
        const anchor = [...members].sort((a, b) => (a.moveInISO < b.moveInISO ? -1 : a.moveInISO > b.moveInISO ? 1 : 0))[0]
        const r = resolveStartReading({ utility: u, roomId, tenant: anchor.t, moveInISO: anchor.moveInISO, cutoffs, rowsByCutoff: rows, interimsAll, groupIds, override: startOverrides?.[u] })
        if (r.error) { pushAll(members, r.error, 'errors'); continue }
        start = r
        for (const m of members) for (const wmsg of r.warnings) if (!m.warnings.includes(wmsg)) m.warnings.push(wmsg)
      } else {
        const first = members.map(m => m.cov[key].covered[0]).filter(Boolean).sort((a, b) => windowOf(a, u).s - windowOf(b, u).s)[0]
        if (!first && ctxs[0].cov[key].beyondWindow) {
          // The stay began after the latest window: the meter starts where the room stood before move-in, not at that window's opening.
          const anchor = [...members].sort((a, b) => (a.moveInISO < b.moveInISO ? -1 : a.moveInISO > b.moveInISO ? 1 : 0))[0]
          const r = resolveStartReading({ utility: u, roomId, tenant: anchor.t, moveInISO: anchor.moveInISO, cutoffs, rowsByCutoff: rows, interimsAll, groupIds, override: startOverrides?.[u] })
          if (r.error) { pushAll(members, r.error, 'errors'); continue }
          start = r
          for (const msg of r.warnings) pushAll(members, msg)
        } else {
          const row = first ? rows.get(first.id) : null
          if (!first || !row || row.prev == null) { pushAll(members, `No ${key} meter-reading row exists for this room in the billing period, so the ${key} line is 0.`); continue }
          const w = windowOf(first, u)
          start = { value: Number(row.prev), pos: w.s - 1, source: 'CUTOFF_PREV', date: isoOfDay(w.s - 1), label: `${first.name} opening reading`, cutoff_id: first.id }
        }
      }
      if (cname === 'STAY' || !startReadings[u]) {
        startReadings[u] = { value: start.value, source: start.source, date: start.date, label: start.label, pos: start.pos, cutoff_id: start.cutoff_id ?? null }
      }
      const known = interimsAll
        .filter(r => r.room_id === roomId && r.utility === u && !groupIds.includes(r.moving_out_tenant_id))
        .map(r => ({ pos: dayNum(r.reading_date), value: Number(r.reading_value), label: `interim reading of ${iso10(r.reading_date)}` }))
      const res = splitUtility({
        utility: u,
        startReading: { value: start.value, pos: start.pos, label: start.label },
        endReading: { value: readings[u], pos: moveNum, label: 'move-out reading' },
        knownReadings: known, cutoffs, rowsByCutoff: rows, participants: participantsFor(start.pos + 1, moveNum, u, pricingIdsOf(u, start.pos + 1, moveNum)),
      })
      for (const msg of res.warnings) pushAll(members, msg)
      if (res.errors.length) { for (const msg of res.errors) pushAll(members, msg, 'errors'); continue }
      for (const m of members) {
        const bt = res.byTenant.get(m.t.id)
        if (!bt) continue
        const ordered = [...bt.lines].sort((a, b) => (windowOf(cutoffs.find(c => c.id === a.cutoff_id), u)?.s ?? 0) - (windowOf(cutoffs.find(c => c.id === b.cutoff_id), u)?.s ?? 0))
        const multi = ordered.length > 1
        m.utilLines[u] = ordered.map(l => {
          const c = cutoffs.find(x => x.id === l.cutoff_id)
          return {
            label: multi ? `${UTIL_LABEL[u]} - ${c.name}` : UTIL_LABEL[u], mid: qtyText(l.cons), rate: l.rate, amount: l.cents / 100, kind: 'charge',
            source: u, cutoff_id: c.id, period: c.name, computed: l.cents / 100,
            ...(l.rateNote ? { rate_note: l.rateNote } : {}), ...(l.gapNote ? { gap_note: l.gapNote } : {}),
          }
        })
        m.util[u] = { prev: start.value, curr: readings[u], roomCons: round2(res.roomCons), personalCons: round2(bt.cons), cents: bt.cents }
        for (const l of ordered) {
          if (l.rateNote) m.notesRate.push(`${UTIL_LABEL[u].replace('Add: ', '')}: ${l.rateNote}`)
          if (l.gapNote) m.notesRate.push(`${UTIL_LABEL[u].replace('Add: ', '')}: ${l.gapNote}`)
        }
      }
      const row = rows.get(final.id)
      if (!beyondWindow && row && Number(row.curr) > 0 && Number(row.curr) >= Number(row.prev ?? 0) && readings[u] > Number(row.curr)) {
        pushAll(members, `The ${key} move-out reading (${readings[u]}) is higher than the ${final.name} current reading on file (${row.curr}); the cutoff statement for that period shows a negative last segment until its readings are updated.`)
      }
    }
  }

  if (ignoredRows.size) {
    const one = ignoredRows.size === 1
    pushAll(ctxs, `${ignoredRows.size} earlier tenant row${one ? '' : 's'} of this room ${one ? 'was' : 'were'} ignored: ${one ? 'it is' : 'they are'} not billed in the cutoff statements.`)
  }
  // A tenant added (back-dated move-in) AFTER roommates were already final-billed shares days those bills already absorbed.
  for (const c of ctxs) {
    if (!c.t.created_at) continue
    const earlier = usedGhosts.some(x => x._finalBilledAt && Date.parse(x._finalBilledAt) < Date.parse(c.t.created_at))
    if (earlier) pushAll([c], "Earlier final bills for this room already billed part of this period; the room's utilities for the overlapping days may be billed more than the meter shows. Review the utility lines.")
  }
  const drafts = new Map()
  const roomWarnings = []
  const sameNameOthers = (t) => roomId != null && tenants.some(x => x.is_active && x.id !== t.id && !groupIds.includes(x.id) && roomOf(x) === roomId && norm(x.name) === norm(t.name))
  for (const c of ctxs) {
    const { t, cls, cov } = c
    const rentRes = buildRentLines({ tenant: t, cls: c.rentCls, cov, cutoffs, moveInISO: c.moveInISO, moveOutISO: c.rentEnd })
    for (const msg of rentRes.warnings) pushAll([c], msg)
    const lines = [...rentRes.lines]
    let extension = null
    if (c.late) {
      const ext = { contractISO: c.planned, actualISO: moveOut, afterNoon: c.afterNoon }
      const line = extensionLine(ext)
      if (line) { lines.push(line); extension = extensionDetails(ext) } else pushAll([c], NOON_CHOICE_MISSING, 'blocking')
      const warn = nightsWarning(extensionNights({ ...ext, afterNoon: c.afterNoon === true }))
      if (warn) pushAll([c], warn)
    }
    for (const u of ['WATER', 'ELECTRIC']) {
      const key = UTIL_KEY[u]
      if (c.utilLines[u].length) { lines.push(...c.utilLines[u]); continue }
      const fin = cov[key].final
      const rr = fin ? resolveRate(cutoffs, fin, u).rate : 0
      lines.push({ label: UTIL_LABEL[u], mid: qtyText(0), rate: rr, amount: 0, kind: 'charge', source: u, cutoff_id: fin?.id ?? null, period: fin?.name ?? null, computed: 0 })
    }

    if (cls.kind === 'STAY_BILLED' && c.rentCls.rentRule === 'PRORATE_ALL_TOUCHED') pushAll([c], 'The stay is not exactly one month (early or late move-out): the rent is prorated by days over every period the stay touched.')
    if (cls.kind === 'ODD' && c.moveInISO && appS && c.moveInISO < appS) pushAll([c], 'This stay began before the first cutoff of the app, so the rent is prorated by days over the covered periods instead of whole months.')
    if (sameNameOthers(t)) pushAll([c], 'Whole-room tenancy: another bed in this room is rented by the same name and is not leaving with this one. Each bed row is billed separately here; check the utility and credit lines.')
    if (t.transfer_date) {
      const tn = dayNum(iso10(t.transfer_date))
      if (tn != null && tn >= dayNum(c.moveInISO) && tn <= moveNum) pushAll([c], 'This tenant was transferred during the stay; rent and utilities from the earlier room are not included. Add them manually.')
    }
    for (const u of ['WATER', 'ELECTRIC']) {
      for (const cc of cov[UTIL_KEY[u]].covered) {
        if (!rowsFor(u).get(cc.id)) pushAll([c], `The ${UTIL_KEY[u]} readings of ${cc.name} have no row for this room.`)
        if (bundle.splitFlags?.has(`${cc.id}|${u}`)) pushAll([c], `${cc.name} has a custom ${UTIL_KEY[u]} split for this room; the final bill ignores custom splits and splits the stay by days.`)
      }
    }
    const adds = (bundle.addonFlags || []).filter(a => a.tenant_id === t.id && (a.recurring || (a.cutoff_id != null && cov.coveredIds.includes(a.cutoff_id))))
    if (adds.length) pushAll([c], `Add-ons (${adds.map(a => a.label).join(', ')}) are not part of the final bill. Add a typed line for any that still apply.`)

    const planned = c.planned
    const earlyTermination = !!(planned && moveOut && moveOut < planned)
    const prior = priorCredits({ tenant: t, moveOut, deposits: getMap(deposits, t.id, []), storedCredits, cutoffs, siblingIds: getMap(siblingIds, t.id, null) })
    const credit = buildCreditLines(getMap(deposits, t.id, []), { earlyTermination, waived: !!getMap(waived, t.id, false), prior, now })
    lines.push(...credit.lines)
    lines.push(...paymentLines(getMap(payments, t.id, []), coveredEntries(cov), cutoffs))

    const stored = normalizeLines(lines)
    const names = (list) => list.map(x => x.name)
    const details = {
      asOf: moveOut, water: c.util.WATER && { prev: c.util.WATER.prev, curr: c.util.WATER.curr, roomCons: c.util.WATER.roomCons, personalCons: c.util.WATER.personalCons },
      electric: c.util.ELECTRIC && { prev: c.util.ELECTRIC.prev, curr: c.util.ELECTRIC.curr, roomCons: c.util.ELECTRIC.roomCons, personalCons: c.util.ELECTRIC.personalCons },
      ...(extension ? { extension } : {}),
      stay: {
        kind: cls.kind, months: rentRes.info.months ?? c.rentCls.months, rent_rule: c.rentCls.rentRule,
        ...(c.rentEnd !== moveOut ? { rent_end: c.rentEnd } : {}),
        ...(rentRes.info.summary ? { rent_summary: rentRes.info.summary } : {}),
        start_readings: {
          water: startReadings.WATER && c.util.WATER ? { source: startReadings.WATER.source, date: startReadings.WATER.date, label: startReadings.WATER.label } : null,
          electric: startReadings.ELECTRIC && c.util.ELECTRIC ? { source: startReadings.ELECTRIC.source, date: startReadings.ELECTRIC.date, label: startReadings.ELECTRIC.label } : null,
        },
        coverage: {
          water: { final: cov.water.final?.name ?? null, covered: names(cov.water.covered) },
          electric: { final: cov.electric.final?.name ?? null, covered: names(cov.electric.covered) },
        },
        rounding_rule: ROUNDING_RULE, rate_notes: [...new Set(c.notesRate)], group: { tenant_ids: groupIds },
        ...(rentRes.info.closed_cents != null ? { closed_rent: rentRes.info.closed_cents / 100 } : {}),
      },
    }
    const fw = cov.water.final
    drafts.set(t.id, {
      lines: stored, details, period: fw ? { start: fw.water_start, end: fw.water_end } : null,
      earlyTermination, totals: computeTotals(stored), warnings: c.warnings, errors: c.errors, notes: credit.notes,
      prior, check: credit.check, blocking: [...c.blocking, ...(credit.problem ? [credit.problem.message] : [])],
      cutoff_id: cov.primaryCutoffId, covered_cutoffs: coveredEntries(cov),
      stay: { kind: cls.kind, months: c.rentCls.months, rentRule: c.rentCls.rentRule }, extension,
      readingPlan: { water: { cutoff_id: cov.water.final?.id ?? null }, electric: { cutoff_id: cov.electric.final?.id ?? null } },
    })
  }
  return { drafts, warnings: roomWarnings, startReadings }
}

/** Single-tenant wrapper around buildFinalBillDrafts. */
export function buildFinalBillDraft({ tenant, ...rest }) {
  return buildFinalBillDrafts({ group: [tenant], ...rest }).drafts.get(tenant.id)
}

// ── Void & re-issue of a final bill ───────────────────────────────────────────

/** Why this bill cannot be re-issued (shown on the disabled button), or null. bill = final_bills row, tenant = its tenant row. */
export function reissueBlocker({ bill, tenant, isAdmin }) {
  if (!isAdmin) return 'Only an admin can void and re-issue a final bill.'
  if (bill?.status !== 'FINAL') return 'Only a FINAL bill can be re-issued.'
  if (bill.refund_status === 'PAID') return 'The refund of this bill is already paid: it cannot be re-issued.'
  if (tenant?.is_active) return 'The tenant is active again: a final bill can only be re-issued for a tenant who has moved out.'
  if ((bill.details?.stay?.group?.tenant_ids || []).length > 1) return 'Bills of several beds: re-issue is per bed and not supported yet.'
  return null
}

/** The tenant's receipts with the ones the bill being re-issued settled (settled_note "Final bill #<id>: ...") treated as HELD again. */
export function asHeldForReissue(deposits, billId) {
  const prefix = `Final bill #${billId}:`
  return (deposits || []).map(d => ((d.status === 'APPLIED' || d.status === 'FORFEITED') && String(d.settled_note || '').startsWith(prefix) ? { ...d, status: 'HELD' } : d))
}

/** The move-out readings of the bill: the saved move-out interim reading of that tenant and date, else the bill's own details. */
export function reissueReadings({ bill, interims = [] }) {
  const day = iso10(bill.move_out_date)
  const pick = (u, k) => {
    const row = (interims || []).filter(r => r.moving_out_tenant_id === bill.tenant_id && r.utility === u && iso10(r.reading_date) === day)
      .sort((a, b) => (b.id ?? 0) - (a.id ?? 0))[0]
    if (row) return { value: Number(row.reading_value), source: 'INTERIM' }
    const v = bill.details?.[k]?.curr
    return v != null ? { value: Number(v), source: 'BILL' } : { value: '', source: null }
  }
  const w = pick('WATER', 'water'), e = pick('ELECTRIC', 'electric')
  return { water: w.value, electric: e.value, sources: { water: w.source, electric: e.source } }
}

/** The contract (planned) move-out date of a moved-out tenant: the bill's extension record, else the move-out request, else the tenant row. */
export function reissuePlannedDate({ bill, request = null, tenant = null }) {
  return iso10(bill?.details?.extension?.contract_date ?? request?.old_value?.move_out_date ?? tenant?.move_out_date) || null
}

/** Union of two covered_cutoffs lists, per component, in the stored form (plain id = water and electric). */
export function mergeCoveredEntries(a, b) {
  return parseCovered([...(Array.isArray(a) ? a : []), ...(Array.isArray(b) ? b : [])])
    .map(e => (e.water && e.electric ? e.id : { id: e.id, water: e.water, electric: e.electric }))
}


/**
 * Lines of the re-issued bill: rent, stay extension, water and electricity recomputed (`fresh` = the new draft's lines, so the bill matches
 * the ghost share the room's statements use); keepUtilities keeps the old bill's water / electricity instead; typed lines carried over, typed extensions (isTypedExtension) dropped when the computed one exists, and the credit / forfeit /
 * charge-back / payment lines from the fresh draft. Returns { lines, kept: { WATER, ELECTRIC }, dropped }.
 */
export function reissueLines({ oldLines, freshLines, keepUtilities = false }) {
  const old = oldLines || [], fresh = freshLines || []
  const dropped = fresh.some(l => l.source === 'EXTENSION') ? old.filter(isTypedExtension) : []
  const of = (list, S) => list.filter(l => computedSourceOf(l) === S && !dropped.includes(l))
  const kept = { WATER: false, ELECTRIC: false }
  const util = (S) => {
    const o = of(old, S)
    if (keepUtilities && o.length) { kept[S] = true; return o }
    return of(fresh, S)
  }
  const typed = old.filter(l => !dropped.includes(l) && !computedSourceOf(l) && !isSystemLine(l) && l.kind !== 'credit' && l.kind !== 'forfeit' && l.kind !== 'payment')
  const tail = fresh.filter(l => l.source === 'ADVANCE_CLAWBACK' || l.kind === 'credit' || l.kind === 'forfeit')
  const pay = fresh.filter(l => l.kind === 'payment')
  const lines = [...of(fresh, 'RENT'), ...of(fresh, 'EXTENSION'), ...util('WATER'), ...util('ELECTRIC'), ...typed, ...tail, ...pay]
  return { lines, kept, dropped }
}

const DIFF_KEYS = ['RENT', 'EXTENSION', 'WATER', 'ELECTRIC', 'OTHER', 'ADVANCE_CLAWBACK', 'ADVANCE', 'DEPOSIT', 'PAYMENT']
const DIFF_LABEL = {
  RENT: 'Rent', EXTENSION: 'Stay extension', WATER: 'Water', ELECTRIC: 'Electricity', OTHER: 'Other lines',
  ADVANCE_CLAWBACK: 'Advance charged back', ADVANCE: 'Advance', DEPOSIT: 'Deposit', PAYMENT: 'Payments received',
}
const diffKeyOf = (l) => {
  if (isTypedExtension(l)) return 'EXTENSION'
  const cs = computedSourceOf(l)
  if (cs) return cs
  if (l.source === 'ADVANCE_CLAWBACK') return 'ADVANCE_CLAWBACK'
  if ((l.kind === 'credit' || l.kind === 'forfeit') && (l.source === 'ADVANCE' || l.source === 'DEPOSIT')) return l.source
  if (l.kind === 'payment') return 'PAYMENT'
  return 'OTHER'
}

/**
 * The review table of a re-issue: per line type the old bill's amount, the new bill's amount and the change (integer cents), plus the
 * recomputed water / electricity from the database when `recomputed` (the fresh draft's lines) is given. `replaced` lists the old bill's
 * typed extension lines that the computed EXTENSION line replaces. net = { old, new, change }.
 */
export function reissueDiff(oldBill, newBill, { recomputed = null } = {}) {
  const sums = (lines) => {
    const m = new Map()
    for (const l of normalizeLines(lines || [])) m.set(diffKeyOf(l), (m.get(diffKeyOf(l)) || 0) + toCents(l.amount))
    return m
  }
  const a = sums(oldBill?.lines), b = sums(newBill?.lines), r = recomputed ? sums(recomputed) : null
  const rows = DIFF_KEYS.filter(k => a.has(k) || b.has(k)).map(k => {
    const o = a.get(k) || 0, n = b.get(k) || 0
    return {
      key: k, label: DIFF_LABEL[k], old: o / 100, new: n / 100, change: (n - o) / 100,
      ...(r && (k === 'WATER' || k === 'ELECTRIC') ? { recomputed: (r.get(k) || 0) / 100 } : {}),
    }
  })
  const oNet = toCents(computeTotals(normalizeLines(oldBill?.lines || [])).net_amount)
  const nNet = toCents(computeTotals(normalizeLines(newBill?.lines || [])).net_amount)
  return {
    rows, net: { old: oNet / 100, new: nNet / 100, change: (nNet - oNet) / 100 },
    replaced: (oldBill?.lines || []).filter(isTypedExtension).map(l => ({ label: l.label, amount: round2(l.amount) })),
  }
}
