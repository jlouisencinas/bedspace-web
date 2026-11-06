/**
 * src/lib/monthlyStatement.js
 * ---------------------------
 * Pure props for one printed monthly Statement of Account (Rent + Water or Electricity), from a computeCutoffBilling
 * perTenant row. Shared by the print pages and the tenant profile's statement preview, so a reprint is identical.
 */
import { prorateCents } from './stay'

export const COMPANY = {
  address:    'JP Rizal ext., Cor Lapu-Lapu street, Brgy. West Rembo, Taguig City',
  bankName:   'NJL Corp.',
  bankAcct:   '00 138 802 7530',
  bankBranch: 'BDO Valero-Salcedo Branch',
}

export const peso = n => '₱' + Number(n || 0).toLocaleString('en-PH', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
export const cu   = n => Number(n || 0).toLocaleString('en-PH', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
export const kwh  = n => Number(n || 0).toLocaleString('en-PH', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
export const reading = n => String(Math.round(Number(n) || 0))   // meter readings: integer, no comma

const MO = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec']
export const fmt = (iso) => { if (!iso) return ''; const [y,m,d] = iso.slice(0,10).split('-'); return `${+d}-${MO[+m-1]}-${y}` }
export const addDays = (iso, n) => new Date(Date.parse(iso.slice(0,10)+'T00:00:00Z') + n*86400000).toISOString().slice(0,10)
export const periodLabel = (start, endExcl) => {
  const last = addDays(endExcl, -1)
  const [, sm, sd] = start.slice(0,10).split('-'); const [, em, ed] = last.split('-')
  return `${+sd} ${MO[+sm-1]} - ${+ed} ${MO[+em-1]}`
}
// Electricity period is 10th → 10th (end date is the reading date, inclusive)
export const periodLabelIncl = (start, end) => {
  const [, sm, sd] = start.slice(0,10).split('-'); const [, em, ed] = end.slice(0,10).split('-')
  return `${+sd} ${MO[+sm-1]} - ${+ed} ${MO[+em-1]}`
}

// The rows that get a printed statement, in print order (the print pages number bills by this position).
export const rentWaterRows   = (perTenant) => perTenant.filter(t => (t.rent + t.water + (t.addonRentWater || 0)) > 0.01)
export const electricityRows = (perTenant) => perTenant.filter(t => (t.elec + (t.addonElectric || 0)) > 0.01)

/** "3,5,x,5" -> [3, 5]: positive integer ids, each once; anything else is ignored. */
export function parseIdList(v) {
  const out = []
  for (const part of String(v ?? '').split(',')) {
    const s = part.trim()
    if (!/^\d+$/.test(s)) continue
    const n = Number(s)
    if (n > 0 && !out.includes(n)) out.push(n)
  }
  return out
}

/**
 * The statements to print, each with its position in the FULL list (the Billing No. itself comes from billNumber.js):
 * `tenant` (one reprint) wins, else `only`, else every row minus `skip`. Unknown ids are ignored. Returns [{ t, pos }].
 */
export function pickStatements(rows, { only = null, skip = null, tenant = null } = {}) {
  const numbered = (rows || []).map((t, pos) => ({ t, pos }))
  if (tenant != null) return numbered.filter(x => x.t.id === tenant)
  if (only && only.length) return numbered.filter(x => only.includes(x.t.id))
  if (skip && skip.length) return numbered.filter(x => !skip.includes(x.t.id))
  return numbered
}

export const rentWaterDefaultBillingDate   = (cutoff) => addDays(cutoff.water_end, -1)
export const electricityDefaultBillingDate = (cutoff) => cutoff.electric_end   // reading is taken ON the 10th

// Two lines for Statement.reprintNote.
export const REPRINT_BANNER = (dateIso) =>
  [`REPRINT - recalculated ${fmt(dateIso)} from current data;`, 'may differ from the statement originally issued']

const cents = (v) => Math.round((Number(v) || 0) * 100)

// " (pro-rated D of W days)" only when advance x D / W reproduces the credit; a credit capped at the rent says " (pro-rated)";
// a credit without a day count (stored before pro-rating, or its move-out date moved since) gets no note.
export function proratedNote(credit) {
  const { days, windowDays } = credit || {}
  if (!(days > 0 && windowDays > 0)) return ''
  const advC = cents(credit.amount) + cents(credit.remaining)
  return prorateCents(advC, days, windowDays) === cents(credit.amount) ? ` (pro-rated ${days} of ${windowDays} days)` : ' (pro-rated)'
}

export function rentWaterProps({ t, cutoff, roomRow, splits, credit, billNo, copyLabel, billingDate, preparedBy, banner }) {
  const asOf   = addDays(cutoff.water_end, -1)
  const due    = billingDate ? addDays(billingDate, 7) : ''
  const period = periodLabel(cutoff.water_start, cutoff.water_end)
  const room = roomRow || {}
  const sp = splits.find(s => s.room_id === t.room_id && s.tenant_id === t.id && s.utility === 'WATER')
  const charges = [{ label: 'Monthly Rent', mid: period, amount: t.rent }]
  if (!t.special || t.water > 0) charges.push({ label: 'Add: Water (cu. m)', mid: cu(t.waterCons), amount: t.water })
  ;(t.addons || []).filter(a => a.bill_on !== 'ELECTRIC').forEach(a =>
    charges.push({ label: `Add: ${a.label}${a.recurring ? '' : ' · one-time'}`, mid: '', amount: Number(a.amount) }))
  if (credit) charges.push({
    label: 'Less: Advanced Payment',
    mid: [credit.ref, `credited ${peso(credit.amount)} on this bill${proratedNote(credit)}`, `remaining ${peso(credit.remaining)} for the final bill`].filter(Boolean).join(' · '),
    amount: -credit.amount, amountText: '-' + peso(credit.amount),
  })
  return {
    company: COMPANY, copyLabel, peso,
    name: t.name, room: t.room_no, asOf: fmt(asOf), due: fmt(due), billNo, preparedBy,
    charges,
    total: t.rent + t.water + (t.addonRentWater || 0) - (credit ? credit.amount : 0),
    details: t.special ? null : {
      header: ['', 'Prev Reading', 'Actual Reading', 'Actual Room Consumption (cu. m)', 'Personal Consumption'],
      rows: [['Water', reading(room.water_prev), reading(room.water_curr),
              cu((Number(room.water_curr) || 0) - (Number(room.water_prev) || 0)), cu(t.waterCons)]],
    },
    asOfNote: t.special ? '' : `** current reading as of ${fmt(asOf)}`,
    splitNote: sp ? `** custom split: ${Number(sp.weight_pct)}% of room water` : '',
    reprintNote: banner || undefined,
  }
}

export function electricityProps({ t, cutoff, roomRow, splits, billNo, copyLabel, billingDate, preparedBy, banner }) {
  const asOf   = cutoff.electric_end                 // the 10th (reading date)
  const due    = billingDate ? addDays(billingDate, 7) : ''
  const room = roomRow || {}
  const sp = splits.find(s => s.room_id === t.room_id && s.tenant_id === t.id && s.utility === 'ELECTRIC')
  const charges = []
  if (!t.special || t.elec > 0) charges.push({ label: 'Electricity (kWh)', mid: kwh(t.elecCons), amount: t.elec })
  ;(t.addons || []).filter(a => a.bill_on === 'ELECTRIC').forEach(a =>
    charges.push({ label: `Add: ${a.label}${a.recurring ? '' : ' · one-time'}`, mid: '', amount: Number(a.amount) }))
  return {
    company: COMPANY, copyLabel, peso,
    name: t.name, room: t.room_no, asOf: fmt(asOf), due: fmt(due), billNo, preparedBy,
    charges,
    total: t.elec + (t.addonElectric || 0),
    details: t.special ? null : {
      header: ['', 'Prev Reading', 'Actual Reading', 'Actual Room Consumption (kWh)', 'Personal Consumption'],
      rows: [['Electric', reading(room.elec_prev), reading(room.elec_curr),
              kwh((Number(room.elec_curr) || 0) - (Number(room.elec_prev) || 0)), kwh(t.elecCons)]],
    },
    asOfNote: t.special ? '' : `** current reading as of ${fmt(asOf)}`,
    splitNote: sp ? `** custom split: ${Number(sp.weight_pct)}% of room electricity` : '',
    reprintNote: banner || undefined,
  }
}
