import { describe, it, expect } from 'vitest'
import { peso, addDays, buildPrintUnits, statementProps, DRAFT_BANNER } from './finalBillStatement'

const NBSP = ' '
const t = (name, bed) => ({ name, beds: { bed_letter: bed, rooms: { room_no: '101' } } })
const bill = (id, lines, extra = {}) => ({
  id, status: 'FINAL', move_out_date: '2026-11-30', prepared_by: '', lines,
  net_amount: lines.reduce((s, l) => s + Math.round(l.amount * 100), 0) / 100,
  details: { water: { prev: 500, curr: 510, roomCons: 10, personalCons: 10 } }, ...extra,
})

describe('formatting', () => {
  it('peso', () => {
    expect(peso(1234.5)).toBe('₱1,234.50')
    expect(peso(null)).toBe('₱0.00')
    expect(peso(0.005)).toBe('₱0.01')
    expect(peso(-5)).toBe('₱-5.00')
  })
  it('addDays across a month and a year end', () => {
    expect(addDays('2026-11-30', 7)).toBe('2026-12-07')
    expect(addDays('2026-12-28T00:00:00Z', 7)).toBe('2027-01-04')
    expect(addDays('2026-03-01', -1)).toBe('2026-02-28')
  })
})

describe('buildPrintUnits', () => {
  it('one unit per bill, sibling beds of the same name/room/date summed into one', () => {
    const units = buildPrintUnits([
      { bill: bill(13, [{ label: 'Rent', amount: 100, kind: 'charge', source: 'RENT' }]), tenant: t('Tenant Pair', 'B') },
      { bill: bill(12, [{ label: 'Rent', amount: 200, kind: 'charge', source: 'RENT' }]), tenant: t('Tenant Pair', 'A') },
      { bill: bill(20, [{ label: 'Rent', amount: 50, kind: 'charge', source: 'RENT' }]), tenant: t('Tenant Solo', 'C') },
    ])
    expect(units.map(u => [u.key, u.label, !!u.combined])).toEqual([[12, 'Bed A & B', true], [20, 'Bed C', false]])
    expect(units[0].view.net_amount).toBe(300)
    expect(units[0].view.lines[0].amount).toBe(300)
  })
})

describe('statementProps', () => {
  const unit = (lines) => buildPrintUnits([{ bill: bill(7, lines), tenant: t('Tenant Golden', 'A') }])[0]

  it('a saved bill: FINAL-<room>-<series>, due 7 days after the billing date', () => {
    const p = statementProps(unit([
      { label: 'Rent', amount: 1000, kind: 'charge', source: 'RENT' },
      { label: 'Add: Water (cu. m)', mid: '10.00', rate: 23, amount: 230, kind: 'charge', source: 'WATER' },
      { label: 'Less: Deposit Payment', mid: 'TR# 7001', amount: -500, kind: 'credit', source: 'DEPOSIT' },
      { label: 'Advance forfeited', mid: 'S.I# 5001', amount: 0, kind: 'forfeit', original: 6750, source: 'ADVANCE' },
    ]), { copyLabel: 'Tenant copy', series: 7, preparedBy: 'Staff', billingDate: '2026-11-30' })
    expect(p.billNo).toBe('FINAL-101-0007')
    expect(p.draftBanner).toBeUndefined()
    expect(p.asOf).toBe('30-Nov-2026')
    expect(p.due).toBe('7-Dec-2026')
    expect(p.total).toBe(730)
    expect(p.totalLabel).toBe('Total amount due')
    expect(p.charges.map(c => [c.label, c.amountText, c.rateText])).toEqual([
      ['Rent', undefined, undefined],
      ['Add: Water (cu. m)', undefined, `23.00 /${NBSP}cu.${NBSP}m`],
      ['Less: Deposit Payment', '-₱500.00', undefined],
      ['Advance forfeited', undefined, undefined],
    ])
    expect(p.charges[3].mid).toBe('S.I# 5001 · ₱6,750.00 forfeited')
    expect(p.details.rows).toEqual([['Water', '500', '510', '10.00', '10.00']])
  })

  it('a draft: Billing No. DRAFT and the draft banner; a negative net is an amount to return', () => {
    const p = statementProps(unit([{ label: 'Less: Deposit Payment', amount: -6381.61, kind: 'credit', source: 'DEPOSIT' }]), { copyLabel: 'x', draft: true })
    expect(p.billNo).toBe('DRAFT')
    expect(p.draftBanner).toBe(DRAFT_BANNER)
    expect(p.total).toBe(6381.61)
    expect(p.totalLabel).toBe('Amount to be returned:')
    expect(p.due).toBe('')
  })
})
