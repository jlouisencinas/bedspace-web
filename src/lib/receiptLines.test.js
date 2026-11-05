import { describe, it, expect } from 'vitest'
import {
  parseMoney, moneyProblem, dbToCents, centsToNumber, centsToInput, fmtCents, sumCents, planDeposit,
  normalizeRef, nameMatches, blankLine, refsOf, validateLines,
} from './receiptLines'

describe('parseMoney (typed text -> integer cents, never rounded)', () => {
  it.each([
    ['3000', 300000],
    ['3000.5', 300050],
    ['3000.50', 300050],
    ['3,000.50', 300050],
    ['1,234,567.89', 123456789],
    ['0.1', 10],
    ['0.05', 5],
    ['  12.30  ', 1230],
    [12.5, 1250],
    ['99999999.99', 9999999999],
  ])('%j -> %i', (input, cents) => {
    expect(parseMoney(input)).toBe(cents)
    expect(Number.isInteger(parseMoney(input))).toBe(true)
  })

  it.each([
    [''], ['   '], [null], [undefined], ['-5'], ['1.234'], ['₱100'], ['P100'], ['1,23'], ['12,3456'],
    ['123456789'], ['1e3'], ['abc'], ['.50'], ['10.'],
  ])('%j -> null', (input) => {
    expect(parseMoney(input)).toBeNull()
  })
})

describe('moneyProblem', () => {
  it('names why an amount was refused', () => {
    expect(moneyProblem('')).toBe('enter an amount')
    expect(moneyProblem(null)).toBe('enter an amount')
    expect(moneyProblem('-5')).toBe('amount cannot be negative')
    expect(moneyProblem('1.234')).toBe('amount can have at most 2 decimals (it is never rounded)')
    expect(moneyProblem('1,000.555')).toBe('amount can have at most 2 decimals (it is never rounded)')
    expect(moneyProblem('₱100')).toMatch(/^amount is not a valid number/)
  })
})

describe('cents conversions', () => {
  it('dbToCents rounds numeric(…,2) values to whole cents, without float residue', () => {
    expect(dbToCents('1234.56')).toBe(123456)
    expect(dbToCents(0.1 + 0.2)).toBe(30)
    expect(dbToCents(1.15)).toBe(115)
    expect(dbToCents(0)).toBe(0)
  })

  it('dbToCents / centsToNumber round-trip every 2-decimal value', () => {
    for (const cents of [0, 1, 5, 10, 99, 100, 101, 12345, 300050, 675000, 9999999999]) {
      expect(dbToCents(centsToNumber(cents))).toBe(cents)
    }
    expect(centsToNumber(123456)).toBe(1234.56)
  })

  it('centsToInput and fmtCents format exactly', () => {
    expect(centsToInput(300050)).toBe('3000.50')
    expect(centsToInput(5)).toBe('0.05')
    expect(centsToInput(-5)).toBe('-0.05')
    expect(fmtCents(123456789)).toBe('P1,234,567.89')
    expect(fmtCents(0)).toBe('P0.00')
    expect(fmtCents(-100000)).toBe('-P1,000.00')
  })

  it('sumCents adds only valid amounts', () => {
    expect(sumCents([{ amount: '4,000.00' }, { amount: '2000' }, { amount: 'x' }, { amount: '0.10' }, null])).toBe(600010)
    expect(sumCents(null)).toBe(0)
  })
})

describe('planDeposit (reservation R vs deposit due)', () => {
  it('requirements §5 example: rent 6,000, reservation 3,000 -> collect 3,000 more', () => {
    expect(planDeposit({ dueCents: 600000, reservationCents: 300000 })).toEqual({ shortfallCents: 300000, overageCents: 0, state: 'SHORT' })
  })
  it('no reservation, exact, and over', () => {
    expect(planDeposit({ dueCents: 600000, reservationCents: 0 })).toEqual({ shortfallCents: 600000, overageCents: 0, state: 'NONE' })
    expect(planDeposit({ dueCents: 300000, reservationCents: 300000 })).toEqual({ shortfallCents: 0, overageCents: 0, state: 'FULL' })
    expect(planDeposit({ dueCents: 300000, reservationCents: 450000 })).toEqual({ shortfallCents: 0, overageCents: 150000, state: 'OVER' })
    expect(planDeposit({})).toEqual({ shortfallCents: 0, overageCents: 0, state: 'NONE' })
  })
})

describe('refs and names', () => {
  it('normalizeRef compares T.R# spellings equal', () => {
    for (const r of ['TR# 121', 'tr 121', 'TR121', 'T.R. 121', 'T.R# 121', '#121', ' 121 ']) expect(normalizeRef(r)).toBe('121')
  })
  it('nameMatches ignores case and extra spaces', () => {
    expect(nameMatches('  Tenant   Alpha ', 'tenant alpha')).toBe(true)
    expect(nameMatches('Tenant Alpha', 'Tenant Beta')).toBe(false)
  })
  it('blankLine and refsOf', () => {
    expect(blankLine({ amount: '100' })).toEqual({ amount: '100', mode: '', refNo: '', bankRef: '', date: '' })
    expect(refsOf([{ refNo: ' 500 ' }, { refNo: '' }, {}])).toEqual(['500'])
  })
})

describe('validateLines', () => {
  const line = (amount, extra = {}) => ({ amount, mode: 'CASH', refNo: '', bankRef: '', date: '2026-10-01', ...extra })

  it('split advance lines that add up to the due amount pass', () => {
    const r = validateLines({ kind: 'ADVANCE', dueCents: 600000, lines: [line('4,000.00', { mode: 'BANK' }), line('2000')] })
    expect(r).toEqual({ errors: [], totalCents: 600000, diffCents: 0 })
  })

  it('a shortfall names both figures and the difference', () => {
    const r = validateLines({ kind: 'ADVANCE', dueCents: 600000, lines: [line('5000')] })
    expect(r.diffCents).toBe(100000)
    expect(r.errors).toEqual(['Advance lines total P5,000.00 but the advance due is P6,000.00 (short P1,000.00).'])
  })

  it('an overage is reported as over', () => {
    const r = validateLines({ kind: 'DEPOSIT', dueCents: 300000, lines: [line('3000.01')] })
    expect(r.errors).toEqual(['Deposit lines total P3,000.01 but the deposit due is P3,000.00 (over P0.01).'])
  })

  it('no lines and nothing due is valid', () => {
    expect(validateLines({ kind: 'DEPOSIT', dueCents: 0, lines: [] })).toEqual({ errors: [], totalCents: 0, diffCents: 0 })
  })

  it('bad amount, missing mode and date are each reported, and the sum check is skipped', () => {
    const r = validateLines({ kind: 'DEPOSIT', dueCents: 300000, lines: [{ amount: '1.234', mode: '', date: '' }, line('0')] })
    expect(r.errors).toEqual([
      'Deposit line 1: amount can have at most 2 decimals (it is never rounded).',
      'Deposit line 1: choose BANK or CASH.',
      'Deposit line 1: date is required.',
      'Deposit line 2: amount must be greater than 0.',
    ])
  })

  it('reservation lines need a T.R#, no future date, and have no sum check', () => {
    const r = validateLines({ kind: 'RESERVATION', dueCents: null, maxDate: '2026-10-05', lines: [line('1000'), line('500', { refNo: '501', date: '2026-10-06' })] })
    expect(r.errors).toEqual([
      'Reservation payment line 1: T.R# is required.',
      'Reservation payment line 2: date cannot be in the future.',
    ])
    expect(r.totalCents).toBe(150000)
    expect(r.diffCents).toBe(0)
  })

  it('a ref already used by a reservation payment on the bed is blocked, also inside a combined ref', () => {
    const r = validateLines({ kind: 'DEPOSIT', dueCents: 300000, reservationRefs: ['TR# 133'], lines: [line('3000', { refNo: 'TR# 121 & TR# 133' })] })
    expect(r.errors).toHaveLength(1)
    expect(r.errors[0]).toMatch(/^Deposit line 1: reference "TR# 121 & TR# 133" is already used by a reservation payment/)
  })
})
