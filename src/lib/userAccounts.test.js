import { describe, it, expect } from 'vitest'
import { isExistingAccountSignup } from './userAccounts'

describe('isExistingAccountSignup', () => {
  it('flags the obfuscated response Supabase returns for an already-registered email', () => {
    expect(isExistingAccountSignup({ user: { id: 'u-1', identities: [] }, session: null })).toBe(true)
  })

  it('does not flag a genuinely new user', () => {
    const data = { user: { id: 'u-2', identities: [{ provider: 'email' }] }, session: null }
    expect(isExistingAccountSignup(data)).toBe(false)
  })

  it('does not flag responses without identities information', () => {
    expect(isExistingAccountSignup({ user: { id: 'u-3' } })).toBe(false)
    expect(isExistingAccountSignup({ user: null })).toBe(false)
    expect(isExistingAccountSignup(undefined)).toBe(false)
  })
})
