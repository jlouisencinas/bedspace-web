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
 */
import { computeBilling, dayNum } from './billing'

const MS_DAY = 86400000
const MONTH_NAMES = ['January','February','March','April','May','June','July','August','September','October','November','December']

export const toCents = (v) => {
  const n = Number(v)
  if (!Number.isFinite(n)) return 0
  return Math.sign(n) * Math.round(Math.abs(n) * 100) + 0
}
export const round2 = (v) => toCents(v) / 100

const isoOfDay = (n) => new Date(n * MS_DAY).toISOString().slice(0, 10)
const iso10 = (v) => (v ? String(v).slice(0, 10) : null)

// Same month arithmetic as Utilities.jsx addMonths().
export function addMonthsISO(iso, n = 1) {
  if (!iso) return ''
  let [y, m, d] = iso.slice(0, 10).split('-').map(Number)
  let mi = (m - 1) + n
  y += Math.floor(mi / 12); mi = ((mi % 12) + 12) % 12
  const dim = new Date(y, mi + 1, 0).getDate(); if (d > dim) d = dim
  return `${y}-${String(mi + 1).padStart(2, '0')}-${String(d).padStart(2, '0')}`
}

const pesoText = (n) => '₱' + Number(n || 0).toLocaleString('en-PH', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
const qtyText = (n) => Number(n || 0).toLocaleString('en-PH', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
const dayMonth = (iso) => { const [, m, d] = iso.slice(0, 10).split('-'); return `${d} ${MONTH_NAMES[+m - 1]}` }

/**
 * Where does this tenant's bill for `cutoff` sit relative to their move-out date?
 * Uses the rent/water window (water_end is exclusive, as in billing.js).
 *   FINAL          move-out date inside this window
 *   SECOND_TO_LAST move-out date inside the NEXT window (water_end .. addMonths(water_end, 1))
 *                  and the tenant moved in before this window (a stay of only one or two billing
 *                  periods has no second-to-last bill: the advance is credited on the final bill)
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
    const moveIn = iso10(tenant.move_in_date)
    if (moveIn && dayNum(moveIn) >= s) return 'STANDARD'
    return 'SECOND_TO_LAST'
  }
  return 'STANDARD'
}

/** Which of the given cutoffs' rent/water windows contains the date? */
export function cutoffForDate(cutoffs, dateISO) {
  const d = dayNum(dateISO)
  if (d == null) return null
  return (cutoffs || []).find(c => c.water_start && c.water_end && d >= dayNum(c.water_start) && d < dayNum(c.water_end)) || null
}

const REF_PREFIX = { ADVANCE: 'S.I#', DEPOSIT: 'TR#' }
const REF_ALREADY = { ADVANCE: /^\s*S\.?\s?I\s*#/i, DEPOSIT: /^\s*T\.?\s?R\s*#/i }

export function refText(kind, receipts) {
  const refs = [...new Set(receipts.map(p => (p.ref_no ?? p.ref ?? '').trim()).filter(Boolean))]
  return refs.map(r => (REF_ALREADY[kind].test(r) ? r : `${REF_PREFIX[kind]} ${r}`)).join(' & ')
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
 * Second-to-last-bill advance credit for the tenants billed in `cutoff`.
 * Credit = min(advance on file, that period's rent): an adjustment, never cash.
 *  - A stored `advance_credits` row for (tenant, cutoff) always wins and is immutable.
 *  - A CLOSED cutoff with no stored row has no credit.
 *  - The ACTIVE cutoff (or `live: true`) is detected live from the move-out date, but a tenant whose
 *    advance was already credited in another cutoff (stored row) gets nothing: the advance is consumed.
 * Whole-room tenancies sum the advance of every same-name bed against the combined rent.
 * Returns Map(tenantId -> { amount, ref, allocations: [{ deposit_id, amount }] }).
 */
export function advanceCredits({ tenants, cutoff, perTenant, deposits, stored = [], live = null }) {
  const out = new Map()
  const byId = new Map(tenants.map(t => [t.id, t]))
  const isLive = live ?? cutoff.is_active === true
  for (const row of perTenant || []) {
    if (row.special) continue
    const t = byId.get(row.id)
    if (!t) continue
    const mine = stored.find(s => s.tenant_id === t.id && s.cutoff_id === cutoff.id)
    if (mine) { out.set(t.id, { amount: Number(mine.amount), ref: mine.ref_text || '', allocations: mine.allocations || [] }); continue }
    if (!isLive || billPosition(t, cutoff) !== 'SECOND_TO_LAST') continue
    const group = row.wholeRoom ? wholeRoomGroup(t, tenants) : [t]
    const receipts = advanceReceipts(deposits || [], new Set(group.map(g => g.id)), ['HELD', 'APPLIED'])
    const receiptIds = new Set(receipts.map(r => r.id))
    if (stored.some(s => s.tenant_id === t.id || (s.allocations || []).some(a => receiptIds.has(a.deposit_id)))) continue
    const alloc = allocate(receipts, Math.min(receipts.reduce((s, r) => s + toCents(r.amount), 0), toCents(row.rent)))
    const cents = alloc.reduce((s, a) => s + a.cents, 0)
    if (cents > 0) {
      out.set(t.id, {
        amount: cents / 100,
        ref: refText('ADVANCE', receipts.filter(r => alloc.some(a => a.id === r.id))),
        allocations: alloc.map(a => ({ deposit_id: a.id, amount: a.cents / 100 })),
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

/** Rows to insert into advance_credits when `cutoff` is closed: live detection, minus what is already stored. */
export function creditsToStore({ tenants, cutoff, perTenant, deposits, stored = [] }) {
  const credits = advanceCredits({ tenants, cutoff, perTenant, deposits, stored, live: true })
  return [...credits]
    .filter(([id]) => !stored.some(s => s.tenant_id === id && s.cutoff_id === cutoff.id))
    .map(([id, c]) => ({ tenant_id: id, cutoff_id: cutoff.id, amount: c.amount, ref_text: c.ref || null, allocations: c.allocations }))
}

/**
 * How much of this tenant's HELD advance was already credited on a second-to-last statement.
 * Stored rows are authoritative (by receipt, so a whole-room sibling's receipts count and a lease
 * extension cannot credit twice). Only if nothing is stored and the cutoff right before the final one is
 * still the active one (the credit not recorded yet) is it estimated live.
 * Returns { name, creditedById: Map(receiptId -> cents) } or null.
 */
export function priorCredits({ tenant, moveOut, deposits, storedCredits = [], cutoffs = [], cutoff = null }) {
  const pool = (deposits || []).filter(d => d.kind === 'ADVANCE' && d.status === 'HELD')
  const mine = new Set(pool.map(d => d.id))
  const creditedById = new Map()
  let name = null
  for (const s of storedCredits) {
    for (const a of s.allocations || []) {
      if (!mine.has(a.deposit_id)) continue
      creditedById.set(a.deposit_id, (creditedById.get(a.deposit_id) || 0) + toCents(a.amount))
      name ||= cutoffs.find(c => c.id === s.cutoff_id)?.name || `cutoff #${s.cutoff_id}`
    }
  }
  if (creditedById.size) return { name, creditedById }
  if (!cutoff || storedCredits.some(s => s.tenant_id === tenant.id)) return null
  const prev = (cutoffs || []).find(c => c.id !== cutoff.id && c.is_active === true && c.water_end && dayNum(c.water_end) === dayNum(cutoff.water_start))
  if (!prev || billPosition({ ...tenant, actual_move_out_date: moveOut }, prev) !== 'SECOND_TO_LAST') return null
  const alloc = allocate(pool, Math.min(pool.reduce((s, d) => s + toCents(d.amount), 0), toCents(tenant.rate)))
  if (!alloc.length) return null
  return { name: prev.name, creditedById: new Map(alloc.map(a => [a.id, a.cents])) }
}

const CLAWBACK_LABEL = 'Advance credited on second-to-last bill (forfeited)'

/**
 * Credit / forfeit lines for the final bill from the tenant's HELD receipts.
 * `prior` ({ name, creditedById }) = part of the advance already credited on a second-to-last statement:
 *  - credited normally: only the balance is credited here (a 0 line is kept as the record);
 *  - forfeited: the forfeit line is shown AND an editable charge line takes the earlier credit back,
 *    so the forfeiture really costs the tenant that amount.
 */
export function buildCreditLines(deposits, { earlyTermination = false, waived = false, prior = null } = {}) {
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
    // Never credit more than a receipt is worth now (an admin may have edited a HELD receipt down after the credit was stored).
    const priorSum = kind === 'ADVANCE' && prior ? pool.reduce((s, p) => s + (prior.creditedById.get(p.id) || 0), 0) : 0
    const credited = kind === 'ADVANCE' && prior ? pool.reduce((s, p) => s + Math.min(prior.creditedById.get(p.id) || 0, toCents(p.amount)), 0) : 0
    if (credited < priorSum) notes.push(`The advance receipt was edited after the second-to-last credit: the earlier credit of ${pesoText(priorSum / 100)} is limited to ${pesoText(credited / 100)} here.`)
    if (forfeit) {
      lines.push({ ...base, label: kind === 'ADVANCE' ? 'Advance forfeited' : 'Deposit forfeited', mid: ref, amount: 0, kind: 'forfeit', original: cents / 100 })
      if (credited > 0) {
        lines.push({ label: CLAWBACK_LABEL, mid: prior.name, amount: credited / 100, kind: 'charge', source: 'ADVANCE_CLAWBACK' })
        notes.push(`Advance ${pesoText(credited / 100)} was already credited on the second-to-last bill (${prior.name}); because it is forfeited it is charged back.`)
      }
    } else if (credited > 0) {
      const balance = cents - credited
      lines.push({
        ...base, label: 'Less: Advanced Payment', kind: 'credit', amount: round2(-balance / 100), prior_cutoff: prior.name,
        mid: [ref, `${pesoText(credited / 100)} credited on the second-to-last bill (${prior.name})`].filter(Boolean).join(' · '),
      })
      notes.push(`Advance ${pesoText(cents / 100)} was credited up to ${pesoText(credited / 100)} on the second-to-last bill (${prior.name}); only the balance ${pesoText(balance / 100)} is credited here.`)
    } else {
      lines.push({ ...base, label: kind === 'ADVANCE' ? 'Less: Advanced Payment' : 'Less: Deposit Payment', mid: ref, amount: -cents / 100, kind: 'credit' })
    }
  }
  return { lines, notes }
}

/** Replace the credit/forfeit lines (e.g. after the waiver toggle) and keep everything else. */
export function rebuildCreditLines(lines, deposits, opts) {
  const { lines: credit, notes } = buildCreditLines(deposits, opts)
  return { lines: [...lines.filter(l => l.kind !== 'credit' && l.kind !== 'forfeit' && l.source !== 'ADVANCE_CLAWBACK'), ...credit], notes }
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
    if (l.kind === 'credit') credits += -c
    else if (l.kind !== 'forfeit') charges += c
  }
  return { total_charges: charges / 100, total_credits: credits / 100, net_amount: net / 100 }
}

/**
 * Apply-time check of a final bill carried in an approval request. Nothing in the payload is trusted for
 * money that comes from the DB: the cutoff is derived from the move-out date, early termination from the
 * tenant's planned move_out_date, and the credit/forfeit lines (amounts + receipt ids) from the tenant's
 * own HELD receipts. Staff-edited labels/mid text, charge and unsettled lines, details and prepared_by are
 * kept. `errors` must block the apply; `diffs` are what changes versus the request, to show the admin.
 * tenant = DB row (rate, move_out_date); deposits = that tenant's receipts.
 */
export function reconcileBill({ bill, moveOut, tenant, deposits, cutoffs, storedCredits = [], waived = false }) {
  const errors = [], diffs = []
  const cutoff = cutoffForDate(cutoffs, moveOut)
  const cutoffId = cutoff?.id ?? null
  if ((bill.cutoff_id ?? null) !== cutoffId) diffs.push(`Billing period: requested ${bill.cutoff_id ?? 'none'}, will use ${cutoff ? cutoff.name : 'none (no cutoff covers the date)'}.`)
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

  const prior = priorCredits({ tenant, moveOut, deposits, storedCredits, cutoffs, cutoff })
  const expected = buildCreditLines(deposits, { earlyTermination: early, waived: w, prior })
  const oldCredit = lines.filter(l => l.kind === 'credit' || l.kind === 'forfeit')
  const oldClaw = lines.find(l => l.source === 'ADVANCE_CLAWBACK')
  const clawback = expected.lines.find(l => l.source === 'ADVANCE_CLAWBACK')
  const creditExpected = expected.lines.filter(l => l.source !== 'ADVANCE_CLAWBACK')
  const rebuilt = []
  for (const e of creditExpected) {
    const p = oldCredit.find(l => l.source === e.source)
    if (!p) diffs.push(`${e.label}: not in the request, will be added (${pesoText(e.kind === 'forfeit' ? e.original : -e.amount)}).`)
    else if (p.kind !== e.kind || toCents(p.amount) !== toCents(e.amount)) {
      diffs.push(`${e.source === 'ADVANCE' ? 'Advance' : 'Deposit'}: requested ${p.kind === 'forfeit' ? 'forfeited' : `credit ${pesoText(-p.amount)}`}, will apply ${e.kind === 'forfeit' ? 'forfeited' : `credit ${pesoText(-e.amount)}`}.`)
    }
    rebuilt.push(p && p.kind === e.kind ? { ...e, label: p.label, mid: p.mid } : e)
  }
  for (const p of oldCredit) if (!creditExpected.some(e => e.source === p.source)) diffs.push(`${p.label}: removed (no HELD ${p.source} receipt on file).`)
  if (clawback && !oldClaw) diffs.push(`${CLAWBACK_LABEL}: will be added (${pesoText(clawback.amount)}).`)
  if (!clawback && oldClaw) diffs.push(`${CLAWBACK_LABEL}: removed (not applicable).`)

  const kept = lines.filter(l => l.kind !== 'credit' && l.kind !== 'forfeit' && l.source !== 'ADVANCE_CLAWBACK')
  const out = [...kept, ...(clawback ? [oldClaw || clawback] : []), ...rebuilt]
  return {
    lines: out, cutoff_id: cutoffId, early_termination: early, forfeit_waived: w,
    errors, diffs, totals: computeTotals(normalizeLines(out)),
  }
}

const nonEmpty = (v) => v !== '' && v != null

/**
 * Auto-draft of a final bill. Utilities reuse computeBilling with the tenant treated as present
 * through the move-out date and the move-out readings applied as hypothetical interim readings
 * (nothing is written): the leaving tenant gets the per-day share of the segment up to the move-out
 * reading, everyone else keeps the shares they get today. With no `cutoff` (admin override when no
 * period covers the date) rent and utilities are left at 0 for staff to key in.
 */
export function buildFinalBillDraft({
  tenant, cutoff = null, cutoffs = [], billRows = [], interims = [], tenants = [], splits = [], deposits = [],
  storedCredits = [], moveOutDate, readings: rawReadings = {}, plannedMoveOut = null, waived = false,
}) {
  const warnings = []
  const moveOut = iso10(moveOutDate)
  const moveNum = dayNum(moveOut)
  const readings = {
    water: nonEmpty(rawReadings.water) ? round2(rawReadings.water) : rawReadings.water,
    electric: nonEmpty(rawReadings.electric) ? round2(rawReadings.electric) : rawReadings.electric,
  }
  const details = { asOf: moveOut, water: null, electric: null }
  const rate = Number(tenant.rate) || 0
  const lines = []
  let acc = null, room = null

  if (!cutoff) {
    warnings.push('No billing period (cutoff) covers this move-out date. The move-out meter readings will NOT be saved (meter readings belong to a cutoff), so the other tenants in the room are not adjusted for them. Rent and the tenant\'s water and electricity lines are left at 0: key them in manually.')
    lines.push({ label: 'Rent Period', mid: '', amount: 0, kind: 'charge' })
    lines.push({ label: 'Add: Water (cu. m)', mid: '', amount: 0, kind: 'charge' })
    lines.push({ label: 'Add: Electricity (per kWh)', mid: '', amount: 0, kind: 'charge' })
  } else {
    const sNum = dayNum(cutoff.water_start), eNum = dayNum(cutoff.water_end)
    const periodDays = eNum - sNum

    // ── Rent: per day from max(period start, move-in) through the move-out date inclusive ──
    const moveInNum = dayNum(iso10(tenant.move_in_date))
    const fromNum = Math.max(sNum, moveInNum ?? sNum)
    let days = moveNum - fromNum + 1
    if (moveNum < sNum || moveNum >= eNum) {
      warnings.push(`The move-out date is outside the billing period ${cutoff.water_start} to ${cutoff.water_end}; check the rent line.`)
    }
    days = Math.max(0, Math.min(days, periodDays))
    const lastDayNum = Math.min(Math.max(moveNum, fromNum), eNum - 1)
    lines.push({
      label: days < periodDays ? `Rent Period (${days} of ${periodDays} days)` : 'Rent Period',
      mid: `${dayMonth(isoOfDay(fromNum))} - ${dayMonth(isoOfDay(lastDayNum))}`,
      amount: round2(rate * days / periodDays), kind: 'charge',
    })

    // ── Utilities ──
    const roomId = tenant.beds?.room_id ?? tenant.room_id ?? null
    const br = roomId != null ? billRows.find(b => b.room_id === roomId) : null
    const sources = [
      { key: 'water',    util: 'WATER',    label: 'Add: Water (cu. m)',         start: cutoff.water_start,    end: cutoff.water_end,    prev: br?.water_prev, rate: br?.water_rate },
      { key: 'electric', util: 'ELECTRIC', label: 'Add: Electricity (per kWh)', start: cutoff.electric_start, end: cutoff.electric_end, prev: br?.elec_prev,  rate: br?.elec_rate },
    ]
    const usable = {}
    const hypothetical = []
    if (roomId == null || !br) {
      warnings.push(roomId == null
        ? 'This tenant has no room, so utilities were not computed. Add them as lines if needed.'
        : 'No meter-reading row exists for this room in the billing period, so utilities were not computed.')
    } else {
      for (const u of sources) {
        const reading = readings[u.key]
        const s = dayNum(u.start), e = dayNum(u.end)
        if (!nonEmpty(reading)) { warnings.push(`No ${u.key} reading entered; the ${u.key} line is 0.`); continue }
        if (!(moveNum > s && moveNum < e)) {
          warnings.push(moveNum === s
            ? `The move-out date is the first day of the ${u.key} window (${u.start}); its share cannot be derived automatically. Enter the ${u.key} line manually.`
            : `The move-out date is outside the ${u.key} window ${u.start} to ${u.end}; the ${u.key} line is 0. Enter it manually if it applies.`)
          continue
        }
        usable[u.key] = true
        hypothetical.push({ room_id: roomId, utility: u.util, reading_date: moveOut, reading_value: Number(reading) })
      }
    }

    if (hypothetical.length) {
      const baseT = tenants.find(t => t.id === tenant.id) || tenant
      const hypo = { ...baseT, is_active: true, actual_move_out_date: moveOut }
      const list = tenants.some(t => t.id === tenant.id) ? tenants.map(t => (t.id === tenant.id ? hypo : t)) : [...tenants, hypo]
      const res = computeBilling(cutoff, billRows, [...interims, ...hypothetical], list, splits)
      acc = res.perTenant.find(p => p.id === tenant.id) || null
      room = res.perRoom.find(r => r.room_id === roomId) || null
      if (splits.some(sp => sp.room_id === roomId)) warnings.push('This room has a custom utility split; the leaving tenant\'s share follows that split.')
      if (!acc) warnings.push('The tenant was not part of the utility split for this period; utility lines are 0.')
    }
    if (roomId != null && tenants.some(t => t.id !== tenant.id && t.is_active && t.beds?.room_id === roomId && sameName(t, tenant))) {
      warnings.push('Whole-room tenancy: another bed in this room is rented by the same name. Each bed row is billed separately here, and the second-to-last advance credit was computed on the combined rent of all beds. Check the utility and credit lines.')
    }
    if (tenant.transfer_date && dayNum(iso10(tenant.transfer_date)) > sNum && dayNum(iso10(tenant.transfer_date)) < eNum) {
      warnings.push('This tenant was transferred during this period; rent and utilities from the earlier room are not included. Add them manually.')
    }

    if (roomId != null && br) {
      for (const u of sources) {
        const personalAmt = usable[u.key] && acc ? (u.key === 'water' ? acc.water : acc.elec) : 0
        const personalCons = usable[u.key] && acc ? (u.key === 'water' ? acc.waterCons : acc.elecCons) : 0
        lines.push({
          label: u.label, mid: qtyText(personalCons), rate: Number(u.rate) || 0,
          amount: round2(personalAmt), kind: 'charge',
        })
        const reading = nonEmpty(readings[u.key]) ? Number(readings[u.key]) : null
        details[u.key] = {
          prev: u.prev != null ? Number(u.prev) : null,
          curr: usable[u.key] ? reading : null,
          roomCons: usable[u.key] && u.prev != null ? round2(reading - Number(u.prev)) : null,
          personalCons: round2(personalCons),
        }
      }
    }
  }

  // ── Credits / forfeiture ──
  const planned = iso10(plannedMoveOut)
  const earlyTermination = !!(planned && moveOut && moveOut < planned)
  const prior = priorCredits({ tenant, moveOut, deposits, storedCredits, cutoffs, cutoff })
  const credit = buildCreditLines(deposits, { earlyTermination, waived, prior })
  lines.push(...credit.lines)

  const stored = normalizeLines(lines)
  return {
    lines: stored, details, period: cutoff ? { start: cutoff.water_start, end: cutoff.water_end } : null,
    earlyTermination, totals: computeTotals(stored), warnings, notes: credit.notes, room,
    prior: prior ? { name: prior.name, creditedById: prior.creditedById } : null,
  }
}
