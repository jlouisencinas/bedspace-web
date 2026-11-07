import { describe, it, expect } from 'vitest'
import { normalizePaymentRef, formatPaymentRefs, effectivePaymentLines, canEditPaymentRef, validateStagedRefs, canCorrectPaymentAmount, validateAmountCorrection } from './paymentRefs'
import { buildCollectionRows } from './collectionsRows'
import { payment, tenant } from './__fixtures__/tenants'

describe('normalizePaymentRef', () => {
  it('blank is allowed and stored as null', () => {
    for (const raw of ['', '   ', null, undefined]) {
      expect(normalizePaymentRef('SI', raw)).toEqual({ value: null, error: null })
      expect(normalizePaymentRef('TR', raw)).toEqual({ value: null, error: null })
    }
  })

  it('strips a typed prefix to the bare number', () => {
    expect(normalizePaymentRef('SI', ' S.I#  1234 ')).toEqual({ value: '1234', error: null })
    expect(normalizePaymentRef('SI', 'SI No. 77')).toEqual({ value: '77', error: null })
    expect(normalizePaymentRef('TR', 'T.R# 55')).toEqual({ value: '55', error: null })
    expect(normalizePaymentRef('TR', '#9')).toEqual({ value: '9', error: null })
  })

  it('refuses no digit, too long, middle dot and control characters', () => {
    expect(normalizePaymentRef('SI', 'abc').error).toMatch(/digit/)
    expect(normalizePaymentRef('SI', '1'.repeat(31)).error).toMatch(/too long/)
    expect(normalizePaymentRef('SI', '1'.repeat(30)).value).toBe('1'.repeat(30))
    expect(normalizePaymentRef('SI', '12·3').error).toMatch(/·/)
    expect(normalizePaymentRef('SI', '12\n3').error).toMatch(/control/)
    expect(normalizePaymentRef('TR', '12\t3').error).toMatch(/control/)
  })

  it('refuses the other kind of number in a field, naming the right field', () => {
    expect(normalizePaymentRef('SI', 'T.R# 5')).toEqual({ value: null, error: 'That looks like a T.R#; this field takes the S.I#.' })
    expect(normalizePaymentRef('TR', 'S.I# 5')).toEqual({ value: null, error: 'That looks like an S.I#; this field takes the T.R#.' })
  })

  it('accepts a combined number like normalizeReceiptRef does', () => {
    expect(normalizePaymentRef('SI', '121 & TR# 133')).toEqual({ value: '121 & TR# 133', error: null })
  })
})

describe('formatPaymentRefs', () => {
  it('prints S.I# / T.R# with a middle dot, T.R# not TR#', () => {
    expect(formatPaymentRefs({ si_no: '1', tr_no: '2' })).toBe('S.I# 1 · T.R# 2')
    expect(formatPaymentRefs({ si_no: null, tr_no: '2' })).toBe('T.R# 2')
    expect(formatPaymentRefs({ si_no: '1', tr_no: '' })).toBe('S.I# 1')
    expect(formatPaymentRefs({ si_no: null, tr_no: null })).toBe('')
    expect(formatPaymentRefs({})).toBe('')
    expect(formatPaymentRefs({ tr_no: '2' })).not.toMatch(/(^|\s)TR#/)
  })
})

describe('effectivePaymentLines', () => {
  it('hides void rows and voided payments, newest first', () => {
    const pays = [
      payment({ id: 1, tenant_id: 1, category: 'RENT_WATER', amount: 500, payment_date: '2026-10-20', si_no: '11' }),
      payment({ id: 2, tenant_id: 1, category: 'RENT_WATER', amount: 300, payment_date: '2026-10-25', tr_no: '22' }),
      payment({ id: 3, tenant_id: 1, category: 'RENT_WATER', amount: -500, payment_date: '2026-10-26', pay_type: 'VOID', voids_payment_id: 1 }),
    ]
    expect(effectivePaymentLines(pays)).toEqual([
      { id: 2, amount: 300, payment_date: '2026-10-25', si_no: null, tr_no: '22', notes: null, category: 'RENT_WATER', pay_type: 'PAYMENT' },
    ])
  })

  it('orders newest first by date then id; never returns a void row', () => {
    const pays = [
      payment({ id: 5, tenant_id: 1, category: 'ELECTRICITY', amount: 100, payment_date: '2026-10-01' }),
      payment({ id: 7, tenant_id: 1, category: 'ELECTRICITY', amount: 100, payment_date: '2026-10-05' }),
      payment({ id: 8, tenant_id: 1, category: 'ELECTRICITY', amount: 100, payment_date: '2026-10-05' }),
      payment({ id: 9, tenant_id: 1, category: 'ELECTRICITY', amount: -50, pay_type: 'VOID' }),
      payment({ id: 10, tenant_id: 1, category: 'ELECTRICITY', amount: 0 }),
    ]
    expect(effectivePaymentLines(pays).map(l => l.id)).toEqual([8, 7, 5])
    expect(effectivePaymentLines([])).toEqual([])
    expect(effectivePaymentLines(null)).toEqual([])
  })
})

describe('canEditPaymentRef', () => {
  const blank = payment({ id: 1, tenant_id: 1, category: 'RENT_WATER', amount: 500, si_no: null, tr_no: null })
  const withSi = { ...blank, si_no: '123' }

  it('staff fill an empty number but never change one', () => {
    expect(canEditPaymentRef({ role: 'user', payment: blank, field: 'si' })).toEqual({ canFill: true, canChange: false })
    expect(canEditPaymentRef({ role: 'user', payment: withSi, field: 'si' })).toEqual({ canFill: false, canChange: false })
    expect(canEditPaymentRef({ role: 'user', payment: withSi, field: 'tr' })).toEqual({ canFill: true, canChange: false })
    expect(canEditPaymentRef({ role: 'user', payment: { ...withSi, tr_no: '9' } })).toEqual({ canFill: false, canChange: false })
  })

  it('admin changes or clears an existing number', () => {
    expect(canEditPaymentRef({ role: 'admin', payment: withSi, field: 'si' })).toEqual({ canFill: false, canChange: true })
    expect(canEditPaymentRef({ role: 'admin', payment: blank, field: 'si' })).toEqual({ canFill: true, canChange: false })
  })

  it('viewer, guard and unknown roles get nothing', () => {
    for (const role of ['viewer', 'guard', null, 'owner']) {
      expect(canEditPaymentRef({ role, payment: blank })).toEqual({ canFill: false, canChange: false })
    }
  })

  it('void rows, voided payments and non-positive amounts are not editable, even by an admin', () => {
    const none = { canFill: false, canChange: false }
    expect(canEditPaymentRef({ role: 'admin', payment: { ...blank, voids_payment_id: 4, amount: -500 } })).toEqual(none)
    expect(canEditPaymentRef({ role: 'admin', payment: { ...blank, pay_type: 'VOID' } })).toEqual(none)
    expect(canEditPaymentRef({ role: 'admin', payment: withSi, voided: true })).toEqual(none)
    expect(canEditPaymentRef({ role: 'admin', payment: { ...blank, amount: 0 } })).toEqual(none)
    expect(canEditPaymentRef({ role: 'admin', payment: null })).toEqual(none)
  })
})

describe('validateStagedRefs', () => {
  const t = name => ({ name })
  it('one bad T.R# among three cells -> exactly one error with that cell and field', () => {
    const staged = [
      { key: '1:RENT_WATER', siNo: 'S.I# 100', trNo: '', tenant: t('Tenant A'), category: 'RENT_WATER' },
      { key: '2:ELECTRICITY', siNo: '', trNo: 'abc', tenant: t('Tenant B'), category: 'ELECTRICITY' },
      { key: '3:RENT_WATER', siNo: '', trNo: '', tenant: t('Tenant C'), category: 'RENT_WATER' },
    ]
    const errs = validateStagedRefs(staged)
    expect(errs).toHaveLength(1)
    expect(errs[0]).toMatchObject({ key: '2:ELECTRICITY', field: 'tr' })
    expect(errs[0].message).toMatch(/^Tenant B · Electricity · T\.R#: /)
  })

  it('all valid or blank -> no errors', () => {
    expect(validateStagedRefs([
      { key: '1:RENT_WATER', siNo: '1', trNo: 'T.R# 2', tenant: t('Tenant A'), category: 'RENT_WATER' },
      { key: '1:ELECTRICITY', tenant: t('Tenant A'), category: 'ELECTRICITY' },
    ])).toEqual([])
    expect(validateStagedRefs([])).toEqual([])
  })
})

describe('validateAmountCorrection', () => {
  const p = payment({ id: 1, tenant_id: 1, category: 'RENT_WATER', amount: 193.8 })
  const reason = 'Typed the wrong amount'

  it('parses grouped and peso-prefixed input in exact cents', () => {
    for (const raw of ['5,193.80', '₱ 5193.8', ' 5193.80 ']) {
      expect(validateAmountCorrection({ payment: p, newAmount: raw, reason })).toEqual({
        ok: true, error: null, noChange: false, voidsLine: false, oldCents: 19380, newCents: 519380, deltaCents: 500000, newAmount: 5193.8, reason,
      })
    }
  })

  it('refuses negative, non-numeric, empty, more than 2 decimals and exponent input', () => {
    for (const raw of ['-5', '-0.01', 'abc', '', '   ', '1.234', '1e3', null, undefined]) {
      const v = validateAmountCorrection({ payment: p, newAmount: raw, reason })
      expect(v.ok).toBe(false)
      expect(v.noChange).toBe(false)
      expect(v.error).toMatch(/\S/)
    }
    expect(validateAmountCorrection({ payment: p, newAmount: '1.234', reason }).error).toMatch(/2 decimals/)
    expect(validateAmountCorrection({ payment: p, newAmount: '-5', reason }).error).toMatch(/negative/)
    expect(validateAmountCorrection({ payment: p, newAmount: '123456789', reason }).ok).toBe(false)
    expect(validateAmountCorrection({ payment: null, newAmount: '5', reason }).ok).toBe(false)
  })

  it('0 voids the whole line: allowed, delta is minus the old amount, reason still required', () => {
    for (const raw of ['0', '0.00', '₱ 0', '0.0']) {
      expect(validateAmountCorrection({ payment: p, newAmount: raw, reason })).toEqual({
        ok: true, error: null, noChange: false, voidsLine: true, oldCents: 19380, newCents: 0, deltaCents: -19380, newAmount: 0, reason,
      })
    }
    expect(validateAmountCorrection({ payment: p, newAmount: '0', reason: ' ' })).toMatchObject({ ok: false, voidsLine: true, error: expect.stringMatching(/reason/) })
    expect(validateAmountCorrection({ payment: p, newAmount: '5000', reason }).voidsLine).toBe(false)
  })

  it('the same amount is "no change", not an error, and needs no reason', () => {
    for (const raw of ['193.8', '193.80', '₱193.80']) {
      const v = validateAmountCorrection({ payment: p, newAmount: raw, reason: '' })
      expect(v).toMatchObject({ ok: false, error: null, noChange: true, deltaCents: 0 })
    }
  })

  it('requires a reason of at most 200 characters', () => {
    expect(validateAmountCorrection({ payment: p, newAmount: '5000', reason: '' })).toMatchObject({ ok: false, noChange: false })
    expect(validateAmountCorrection({ payment: p, newAmount: '5000', reason: '   ' }).error).toMatch(/reason/)
    expect(validateAmountCorrection({ payment: p, newAmount: '5000', reason: 'x'.repeat(201) }).error).toMatch(/too long/)
    expect(validateAmountCorrection({ payment: p, newAmount: '5000', reason: ` ${'x'.repeat(200)} ` })).toMatchObject({ ok: true, reason: 'x'.repeat(200) })
  })

  it('0.1 + 0.2 style amounts give an exact cent delta', () => {
    const small = payment({ id: 2, tenant_id: 1, category: 'ELECTRICITY', amount: 0.1 })
    expect(validateAmountCorrection({ payment: small, newAmount: '0.30', reason })).toMatchObject({ ok: true, oldCents: 10, newCents: 30, deltaCents: 20 })
    const odd = payment({ id: 3, tenant_id: 1, category: 'ELECTRICITY', amount: 1.15 })
    expect(validateAmountCorrection({ payment: odd, newAmount: '1.16', reason }).deltaCents).toBe(1)
  })
})

describe('canCorrectPaymentAmount', () => {
  const p = payment({ id: 1, tenant_id: 1, category: 'RENT_WATER', amount: 500 })

  it('admin and staff may correct an in-force payment; viewer, guard and no role may not', () => {
    expect(canCorrectPaymentAmount({ role: 'admin', payment: p })).toBe(true)
    expect(canCorrectPaymentAmount({ role: 'user', payment: p })).toBe(true)
    expect(canCorrectPaymentAmount({ role: 'user', payment: { ...p, category: 'ELECTRICITY', si_no: '12', tr_no: '34' } })).toBe(true)
    for (const role of ['viewer', 'guard', null, undefined, 'owner']) expect(canCorrectPaymentAmount({ role, payment: p })).toBe(false)
  })

  it('refuses void rows, voided payments, non-positive amounts and other categories', () => {
    const role = 'admin'
    expect(canCorrectPaymentAmount({ role, payment: { ...p, voids_payment_id: 9 } })).toBe(false)
    expect(canCorrectPaymentAmount({ role, payment: { ...p, pay_type: 'VOID' } })).toBe(false)
    expect(canCorrectPaymentAmount({ role, payment: p, voided: true })).toBe(false)
    expect(canCorrectPaymentAmount({ role, payment: { ...p, amount: 0 } })).toBe(false)
    expect(canCorrectPaymentAmount({ role, payment: { ...p, amount: -500 } })).toBe(false)
    expect(canCorrectPaymentAmount({ role, payment: { ...p, category: null } })).toBe(false)
    expect(canCorrectPaymentAmount({ role, payment: { ...p, category: 'OTHER' } })).toBe(false)
    expect(canCorrectPaymentAmount({ role, payment: null })).toBe(false)
  })
})

describe('amount correction (void + re-record) in the Collections line list and cell', () => {
  const BILLED = { rent: 5000, water: 193.8 }
  const perTenant = [{ id: 1, name: 'Tenant 1', room_no: '101', bed: 'A', elec: 0, ...BILLED }]
  const t1 = tenant({ id: 1 })
  const A = payment({ id: 1, tenant_id: 1, cutoff_id: 2, category: 'RENT_WATER', amount: 193.8, si_no: '11', tr_no: '22' })
  const B = payment({ id: 2, tenant_id: 1, cutoff_id: 2, category: 'RENT_WATER', amount: 5193.8 })
  const voidOf = (orig, id) => payment({ id, tenant_id: 1, cutoff_id: 2, category: orig.category, amount: -orig.amount, payment_date: '2026-11-07', pay_type: 'VOID', voids_payment_id: orig.id })
  const correct = (orig, id, amount) => payment({ ...orig, id, amount, notes: `Corrects payment #${orig.id}` })
  const rw = pays => buildCollectionRows({ perTenant, tenants: [t1], payments: pays })[0].status.rw

  it('lists only the replacement, at the original date with the same numbers, carrying category and pay type', () => {
    const lines = effectivePaymentLines([A, voidOf(A, 3), correct(A, 4, 5000)])
    expect(lines).toEqual([{ id: 4, amount: 5000, payment_date: A.payment_date, si_no: '11', tr_no: '22', notes: 'Corrects payment #1', category: 'RENT_WATER', pay_type: 'PAYMENT' }])
  })

  it('a wrongly entered extra line shows Overpaid; voiding it settles to Paid; correcting the other line down shows Partial', () => {
    expect(rw([A, B])).toMatchObject({ state: 'over', paid: 5387.6, over: 193.8 })
    expect(rw([A, voidOf(A, 3), B])).toMatchObject({ state: 'paid', paid: 5193.8, over: 0, remaining: 0 })
    expect(rw([A, voidOf(A, 3), B, voidOf(B, 4), correct(B, 5, 5000)])).toMatchObject({ state: 'partial', paid: 5000, remaining: 193.8 })
    expect(rw([A, B, voidOf(B, 4), correct(B, 5, 5000)])).toMatchObject({ state: 'paid', paid: 5193.8 })
    expect(rw([A, voidOf(A, 3), correct(A, 4, 5193.81)])).toMatchObject({ state: 'over', over: 0.01 })
  })

  it('correcting a line to ₱0 writes only the void row: the line disappears and the cell settles to Paid', () => {
    const pays = [A, B, voidOf(A, 3)]
    expect(effectivePaymentLines(pays).map(l => [l.id, l.amount])).toEqual([[2, 5193.8]])
    expect(rw(pays)).toMatchObject({ state: 'paid', paid: 5193.8, over: 0, remaining: 0 })
    const v = validateAmountCorrection({ payment: A, newAmount: '0', reason: 'Entered by mistake' })
    expect(Math.round(5387.6 * 100) + v.deltaCents).toBe(519380)
  })

  it('a corrected line can be corrected again; only the newest replacement is listed', () => {
    const A1 = correct(A, 4, 5000)
    const pays = [A, voidOf(A, 3), A1, voidOf(A1, 5), correct(A1, 6, 5193.8)]
    expect(effectivePaymentLines(pays).map(l => [l.id, l.amount])).toEqual([[6, 5193.8]])
    expect(rw(pays)).toMatchObject({ state: 'paid', paid: 5193.8 })
  })
})
