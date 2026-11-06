import { describe, it, expect } from 'vitest'
import { pickStatements, parseIdList } from './monthlyStatement'

const rows = [11, 12, 13, 14, 15].map(id => ({ id, name: `Tenant ${id}` }))

describe('pickStatements (print a selection, keep the full-list Bill No.)', () => {
  it('skip one of five keeps the others at their own positions', () => {
    expect(pickStatements(rows, { skip: [13] }).map(x => x.pos)).toEqual([0, 1, 3, 4])
  })
  it('only the held tenant prints alone at its full-list position', () => {
    expect(pickStatements(rows, { only: [13] })).toEqual([{ t: rows[2], pos: 2 }])
  })
  it('unknown ids are ignored; no selection prints everything; ?tenant= wins', () => {
    expect(pickStatements(rows, { only: [999, 12] }).map(x => x.pos)).toEqual([1])
    expect(pickStatements(rows, { skip: [999] }).map(x => x.pos)).toEqual([0, 1, 2, 3, 4])
    expect(pickStatements(rows, {}).length).toBe(5)
    expect(pickStatements(rows, { tenant: 14, skip: [14] }).map(x => x.pos)).toEqual([3])
  })
  it('parseIdList keeps positive integer ids once', () => {
    expect(parseIdList('13, 5,x,5,-2,0,7.5')).toEqual([13, 5])
    expect(parseIdList(null)).toEqual([])
  })
})
