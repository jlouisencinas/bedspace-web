import { describe, it, expect } from 'vitest'
import { toHundredths, centsOf, allocateCents, resolveRate, resolveStartReading, checkReadingOrder, splitUtility } from './utilityPieces'
import { dayNum } from './stay'
import { SEP, OCT, NOV, CUTOFFS } from './__fixtures__/cutoffs'

describe('toHundredths / centsOf', () => {
  it('toHundredths has no float residue', () => {
    expect(toHundredths(10434.5)).toBe(1043450)
    expect(toHundredths(0.1 + 0.2)).toBe(30)
    expect(toHundredths('6260')).toBe(626000)
  })

  it.each([
    [10700, 22, 1, 1, 235400],
    [1, 22, 1, 1, 22],
    [100, 22, 1, 3, 733],
    [100, 22, 2, 3, 1467],
    [50, 0.01, 1, 1, 1],
    [1, 12.345, 1, 1, 12],
    [1000, 0.1 + 0.2, 1, 1, 300],
    [0, 22, 1, 1, 0],
  ])('centsOf(%i, %d, %i, %i) = %i', (h, rate, num, den, out) => {
    const r = centsOf(h, rate, num, den)
    expect(r).toBe(out)
    expect(Number.isInteger(r)).toBe(true)
  })
})

describe('allocateCents (largest remainder, BigInt)', () => {
  it('the odd cent goes to the lowest key on a tie', () => {
    const { shares, unbilledCents } = allocateCents(10000, [{ key: 3, w: 1 }, { key: 1, w: 1 }, { key: 2, w: 1 }])
    expect(Object.fromEntries(shares)).toEqual({ 1: 3334, 2: 3333, 3: 3333 })
    expect(unbilledCents).toBe(0)
  })

  it('the largest fractional remainder wins before the tie rule', () => {
    const { shares } = allocateCents(100, [{ key: 1, w: 1 }, { key: 2, w: 2 }])
    expect(Object.fromEntries(shares)).toEqual({ 1: 33, 2: 67 })
  })

  it('the unbilled (vacant) share is last in the tie order', () => {
    expect(allocateCents(101, [{ key: 1, w: 1 }], 1n)).toEqual({ shares: new Map([[1, 51]]), unbilledCents: 50 })
  })

  it('with no weight everything is unbilled; a negative total throws', () => {
    expect(allocateCents(500, [{ key: 1, w: 0 }], 0n)).toEqual({ shares: new Map([[1, 0]]), unbilledCents: 500 })
    expect(() => allocateCents(-1, [{ key: 1, w: 1 }])).toThrow('allocateCents: negative total')
  })
})

describe('resolveRate', () => {
  it('uses the cutoff\'s own rate', () => {
    expect(resolveRate(CUTOFFS, OCT, 'WATER')).toEqual({ rate: 22, note: null, warning: null })
  })
  it('falls back to the most recent earlier cutoff with a rate, and says so', () => {
    const cutoffs = [SEP, OCT, { ...NOV, electric_bedspace_rate: 0, electric_rate_override: undefined }]
    const r = resolveRate(cutoffs, cutoffs[2], 'ELECTRIC')
    expect(r.rate).toBe(22)
    expect(r.note).toBe('rate from Oct 2026 - not set for Nov 2026')
    expect(r.warning).toBe('The electric rate of Nov 2026 is not set; the rate of Oct 2026 was used.')
  })
  it('a 0 line with a warning when no rate exists anywhere', () => {
    const r = resolveRate([{ ...SEP, water_bedspace_rate: null }], { ...SEP, water_bedspace_rate: null }, 'WATER')
    expect(r).toEqual({ rate: 0, note: null, warning: 'No water rate is set for Sep 2026 or any earlier cutoff; the line is 0.' })
  })
})

describe('resolveStartReading', () => {
  const rows = new Map([[OCT.id, { prev: 6000, curr: 6100 }], [NOV.id, { prev: 6100, curr: 0 }]])
  const base = { utility: 'ELECTRIC', roomId: 11, tenant: { id: 5 }, cutoffs: CUTOFFS, rowsByCutoff: rows }

  it('a typed override wins', () => {
    expect(resolveStartReading({ ...base, moveInISO: '2026-11-15', override: '6123.5' })).toMatchObject({ value: 6123.5, source: 'MANUAL', pos: dayNum('2026-11-14') })
  })
  it('the tenant\'s own move-in reading comes next', () => {
    const interimsAll = [{ id: 1, room_id: 11, utility: 'ELECTRIC', reading_date: '2026-11-15', reading_value: 6130, moving_in_tenant_id: 5 }]
    expect(resolveStartReading({ ...base, moveInISO: '2026-11-15', interimsAll })).toMatchObject({ value: 6130, source: 'MOVE_IN_READING' })
  })
  it('otherwise the latest reading before move-in: a previous tenant\'s move-out reading beats the window opening', () => {
    const interimsAll = [{ id: 2, room_id: 11, utility: 'ELECTRIC', reading_date: '2026-11-12', reading_value: 6110, moving_out_tenant_id: 9 }]
    expect(resolveStartReading({ ...base, moveInISO: '2026-11-15', interimsAll })).toMatchObject({ value: 6110, source: 'PREV_TENANT_MOVE_OUT', date: '2026-11-12' })
    expect(resolveStartReading({ ...base, moveInISO: '2026-11-15' })).toMatchObject({ value: 6100, source: 'CUTOFF_CLOSING', cutoff_id: OCT.id })
  })
  it('no reading at all is an error the staff must fix by hand', () => {
    expect(resolveStartReading({ ...base, rowsByCutoff: new Map(), moveInISO: '2026-11-15' })).toEqual({ error: 'No starting electric reading could be found for the stay. Enter it by hand.' })
  })
})

describe('checkReadingOrder', () => {
  const interimsAll = [
    { room_id: 11, utility: 'WATER', reading_date: '2026-11-05', reading_value: 520, cutoff_id: NOV.id, moving_out_tenant_id: 8 },
    { room_id: 11, utility: 'WATER', reading_date: '2026-11-25', reading_value: 505, cutoff_id: NOV.id, moving_out_tenant_id: 9 },
    { room_id: 11, utility: 'WATER', reading_date: '2026-12-20', reading_value: 400, cutoff_id: 99, moving_out_tenant_id: 10 },
  ]
  it('lower than an earlier reading, higher than a later reading in the same cutoff: errors; another cutoff: one warning', () => {
    const r = checkReadingOrder({ utility: 'WATER', roomId: 11, moveOutISO: '2026-11-15', value: 510, finalCutoffId: NOV.id, interimsAll })
    expect(r.errors).toEqual([
      'Water reading 510 (2026-11-15) is lower than the earlier room reading 520 of 2026-11-05. Check the reading.',
      'Water reading 510 (2026-11-15) is higher than the later room reading 505 of 2026-11-25 in the same cutoff. Check the reading, or delete the wrong interim reading in Billing.',
    ])
    expect(r.warnings).toEqual(['Water: 1 later reading in another cutoff is lower than this reading (latest 2026-12-20, value 400); check it in Billing.'])
  })
  it('ignores the leavers\' own readings', () => {
    const r = checkReadingOrder({ utility: 'WATER', roomId: 11, moveOutISO: '2026-11-15', value: 510, finalCutoffId: NOV.id, interimsAll, groupIds: [8, 9, 10] })
    expect(r).toEqual({ errors: [], warnings: [] })
  })
})

describe('splitUtility', () => {
  it('requirements §5 example: electric 6240 -> 6260 at 22, Solo out Oct 22, the pair out Oct 25: 73.34 + 183.33 + 183.33 = 440.00', () => {
    const res = splitUtility({
      utility: 'ELECTRIC',
      startReading: { value: 6240, pos: dayNum('2026-10-09'), label: 'Oct 2026 opening reading' },
      endReading: { value: 6260, pos: dayNum('2026-10-25'), label: 'move-out reading' },
      knownReadings: [{ pos: dayNum('2026-10-22'), value: 6250, label: 'Solo move-out' }],
      cutoffs: CUTOFFS, rowsByCutoff: new Map(),
      participants: [
        { id: 1, moveInNum: dayNum('2026-10-01'), moveOutNum: dayNum('2026-10-22') },
        { id: 2, moveInNum: dayNum('2026-10-01'), moveOutNum: dayNum('2026-10-25') },
        { id: 3, moveInNum: dayNum('2026-10-01'), moveOutNum: dayNum('2026-10-25') },
      ],
    })
    expect(res.errors).toEqual([])
    expect(res.byTenant.get(1).cents).toBe(7334)
    expect(res.byTenant.get(2).cents).toBe(18333)
    expect(res.byTenant.get(3).cents).toBe(18333)
    expect(res.roomCents).toBe(44000)
    expect(res.unbilledCents).toBe(0)
    expect(res.roomCons).toBe(20)
  })

  it('prices each day at its own cutoff and leaves days nobody overlaps unbilled', () => {
    const res = splitUtility({
      utility: 'ELECTRIC',
      startReading: { value: 100, pos: dayNum('2026-10-04'), label: 'start' },
      endReading: { value: 111, pos: dayNum('2026-10-15'), label: 'move-out reading' },
      cutoffs: CUTOFFS, rowsByCutoff: new Map(),
      participants: [{ id: 5, moveInNum: dayNum('2026-10-12'), moveOutNum: dayNum('2026-10-15') }],
    })
    // Oct 5-9 is priced at Sep (20/kWh, 5 of 11 days), Oct 10-15 at Oct (22/kWh, 6 of 11 days).
    expect(res.roomCents).toBe(10000 + 13200)
    expect(res.unbilledCents).toBe(10000)
    expect(res.byTenant.get(5).cents).toBe(13200)
    expect(res.byTenant.get(5).lines.map(l => [l.cutoff_id, l.cents])).toEqual([[OCT.id, 13200]])
    expect(res.warnings).toHaveLength(1)
    expect(res.warnings[0]).toMatch(/no usable meter reading exists at the change from Sep 2026 to Oct 2026/)
  })

  it('uses the cutoff boundary reading when one fits', () => {
    const res = splitUtility({
      utility: 'ELECTRIC',
      startReading: { value: 100, pos: dayNum('2026-10-04'), label: 'start' },
      endReading: { value: 111, pos: dayNum('2026-10-15'), label: 'move-out reading' },
      cutoffs: CUTOFFS, rowsByCutoff: new Map([[SEP.id, { prev: 50, curr: 103 }], [OCT.id, { prev: 103, curr: 0 }]]),
      participants: [{ id: 5, moveInNum: dayNum('2026-10-01'), moveOutNum: dayNum('2026-10-15') }],
    })
    expect(res.points.map(p => p.value)).toEqual([100, 103, 111])
    expect(res.byTenant.get(5).cents).toBe(300 * 20 + 800 * 22)
    expect(res.warnings).toEqual([])
  })

  it('a reading going down is an error; an end before the start is an error', () => {
    const p = [{ id: 5, moveInNum: null, moveOutNum: null }]
    const down = splitUtility({ utility: 'WATER', startReading: { value: 500, pos: dayNum('2026-10-31'), label: 'a' }, endReading: { value: 490, pos: dayNum('2026-11-10'), label: 'b' }, cutoffs: CUTOFFS, participants: p })
    expect(down.errors[0]).toMatch(/^Water reading 490 \(b\) is lower than the earlier reading 500 \(a\)/)
    const back = splitUtility({ utility: 'WATER', startReading: { value: 500, pos: dayNum('2026-11-10'), label: 'a' }, endReading: { value: 510, pos: dayNum('2026-11-10'), label: 'b' }, cutoffs: CUTOFFS, participants: p })
    expect(back.errors[0]).toMatch(/is not after the starting reading/)
  })

  it('shares always add up to the room total (fixed table of odd splits)', () => {
    const cases = [
      [6240, 6261.37, 3, '2026-10-17'],
      [10434, 10541, 5, '2026-10-29'],
      [1, 2.01, 7, '2026-10-12'],
      [300.5, 333.33, 4, '2026-10-30'],
    ]
    for (const [a, b, n, out] of cases) {
      const participants = Array.from({ length: n }, (_, i) => ({ id: i + 1, moveInNum: dayNum('2026-10-01') + i, moveOutNum: i === 0 ? dayNum(out) : null }))
      const res = splitUtility({ utility: 'ELECTRIC', startReading: { value: a, pos: dayNum('2026-10-09'), label: 's' }, endReading: { value: b, pos: dayNum('2026-11-08'), label: 'e' }, cutoffs: CUTOFFS, participants })
      const billed = [...res.byTenant.values()].reduce((s, t) => s + t.cents, 0)
      expect(billed + res.unbilledCents).toBe(res.roomCents)
      expect(res.roomCents).toBe(centsOf(toHundredths(b) - toHundredths(a), 22))
    }
  })
})
