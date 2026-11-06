import { describe, it, expect } from 'vitest'
import { normalizePaymentRef, formatPaymentRefs, effectivePaymentLines, canEditPaymentRef, validateStagedRefs } from './paymentRefs'
import { payment } from './__fixtures__/tenants'

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
      { id: 2, amount: 300, payment_date: '2026-10-25', si_no: null, tr_no: '22', notes: null },
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
