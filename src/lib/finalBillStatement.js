/**
 * src/lib/finalBillStatement.js
 * -----------------------------
 * Pure: turns final bills (saved rows, or an on-screen draft) into the props of the printed Statement. Shared by the print page and
 * the "Preview bill" overlay so both always show the same statement.
 */
import { combineBillsForPrint, groupBillsForPrint } from './finalBill'

export const COMPANY = {
  address:    'JP Rizal ext., Cor Lapu-Lapu street, Brgy. West Rembo, Taguig City',
  bankName:   'NJL Corp.',
  bankAcct:   '00 138 802 7530',
  bankBranch: 'BDO Valero-Salcedo Branch',
}
export const DRAFT_BANNER = 'DRAFT - not saved, not yet a final bill'

export const peso = n => '₱' + Number(n || 0).toLocaleString('en-PH', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
const signedPeso = n => (Number(n) < 0 ? '-' : '') + peso(Math.abs(Number(n) || 0))
const rate = n => '₱' + Number(n || 0).toLocaleString('en-PH', { minimumFractionDigits: 2, maximumFractionDigits: 4 })
const cu = n => Number(n || 0).toLocaleString('en-PH', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
const reading = n => (n == null ? '—' : Number(n).toLocaleString('en-PH', { maximumFractionDigits: 2, useGrouping: false }))

export const addDays = (iso, n) => new Date(Date.parse(iso.slice(0, 10) + 'T00:00:00Z') + n * 86400000).toISOString().slice(0, 10)
const MO = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec']
const fmt = (iso) => { if (!iso) return ''; const [y,m,d] = iso.slice(0,10).split('-'); return `${+d}-${MO[+m-1]}-${y}` }

function toCharge(l) {
  const credit = l.kind === 'credit'
  const forfeit = l.kind === 'forfeit'
  return {
    label: l.label,
    mid: forfeit && l.original != null ? [l.mid, `${peso(l.original)} forfeited`].filter(Boolean).join(' · ') : l.mid,
    rateText: l.rate != null ? rate(l.rate) : undefined,
    amount: l.amount,
    amountText: credit || l.kind === 'payment' || Number(l.amount) < 0 ? signedPeso(l.amount) : undefined,
    italic: l.kind === 'unsettled',
  }
}

const SOURCE_NAME = { PREV_TENANT_MOVE_OUT: "previous tenant's move-out reading", MOVE_IN_READING: 'move-in reading', CUTOFF_CLOSING: 'cutoff closing reading', CUTOFF_PREV: 'cutoff opening reading', MANUAL: 'entered by staff' }

function footNotesOf(bill) {
  const d = bill.details || {}
  const out = []
  const stay = d.stay
  if (stay) {
    for (const [k, name] of [['water', 'Water'], ['electric', 'Electricity']]) {
      const sr = stay.start_readings?.[k]
      if (sr && d[k]) out.push(`${name} starts at ${reading(d[k].prev)} (${SOURCE_NAME[sr.source] || sr.source}${sr.date && sr.source !== 'MANUAL' ? `, ${fmt(sr.date)}` : ''}).`)
    }
    out.push(...(stay.rate_notes || []))
    if (stay.rounding_rule) out.push(stay.rounding_rule)
  }
  for (const l of bill.lines || []) if (l.rate_note && !(stay?.rate_notes || []).some(n => n.endsWith(l.rate_note))) out.push(`${l.label}: ${l.rate_note}`)
  return out
}

/**
 * [{ bill, tenant }] -> statements. Bills of one group (same name, room, move-out date, non-void) become ONE summed statement.
 * tenant = { name, beds: { bed_letter, rooms: { room_no } } }. A unit is { key, items, view, tenant, combined, label }.
 */
export function buildPrintUnits(list) {
  return groupBillsForPrint(list.map(x => ({
    ...x, name: x.tenant?.name, room: x.tenant?.beds?.rooms?.room_no ?? '', bed: x.tenant?.beds?.bed_letter ?? '',
  }))).map(u => {
    const first = u.items[0]
    if (!u.combined) return { key: first.bill.id, items: u.items, view: first.bill, tenant: first.tenant, combined: null, label: `Bed ${first.bed}` }
    const lowest = Math.min(...u.items.map(i => i.bill.id))
    const c = combineBillsForPrint(u.items)
    return {
      key: lowest, items: u.items, tenant: first.tenant, combined: c, label: `Bed ${u.items.map(i => i.bed).join(' & ')}`,
      view: { id: lowest, status: first.bill.status, move_out_date: first.bill.move_out_date, lines: c.lines, details: c.details, net_amount: c.net_amount, prepared_by: u.items.map(i => i.bill.prepared_by).find(Boolean) || '' },
    }
  })
}

/** Props of one Statement copy. draft: Billing No. "DRAFT" and the draft banner; otherwise FINAL-<room>-<series>. */
export function statementProps(unit, { copyLabel, series, preparedBy, billingDate, draft = false }) {
  const { view: bill, tenant } = unit
  const net = Number(bill.net_amount)
  const refund = net < 0
  const d = bill.details || {}
  const room = tenant?.beds?.rooms?.room_no ?? ''
  const rows = []
  if (d.water)    rows.push(['Water', reading(d.water.prev), reading(d.water.curr), d.water.roomCons != null ? cu(d.water.roomCons) : '—', cu(d.water.personalCons)])
  if (d.electric) rows.push(['Electricity', reading(d.electric.prev), reading(d.electric.curr), d.electric.roomCons != null ? cu(d.electric.roomCons) : '—', cu(d.electric.personalCons)])
  return {
    company: COMPANY, copyLabel, peso,
    name: tenant?.name, room,
    asOf: fmt(bill.move_out_date), due: billingDate ? fmt(addDays(billingDate, 7)) : '',
    billNo: draft ? 'DRAFT' : `FINAL-${room}-${String(series ?? unit.key).padStart(4, '0')}`,
    preparedBy: preparedBy ?? '', flow: true,
    ...(draft ? { draftBanner: DRAFT_BANNER } : {}),
    charges: bill.lines.map(toCharge),
    total: Math.abs(net),
    totalLabel: refund ? 'Amount to be returned:' : 'Total amount due',
    totalColor: refund ? '#15803d' : undefined,
    details: rows.length ? {
      header: ['', d.stay ? 'Start Reading' : 'Previous Reading', d.stay ? 'Move-out Reading' : 'Current Reading', 'Actual Room Consumption', 'Personal Consumption'],
      rows,
    } : null,
    asOfNote: rows.length ? `** Current Reading as of ${fmt(bill.move_out_date)}` : '',
    checkNote: unit.combined
      ? unit.items.map(i => (i.bill.details?.advance_check?.text ? `Bed ${i.bed}: ${i.bill.details.advance_check.text}` : '')).filter(Boolean).join(' ')
      : (d.advance_check?.text || ''),
    footNotes: unit.combined
      ? [unit.combined.bedNote, ...new Set(unit.items.flatMap(i => footNotesOf(i.bill)))]
      : footNotesOf(bill),
  }
}
