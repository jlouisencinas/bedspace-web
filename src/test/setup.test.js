import { describe, it, expect } from 'vitest'

describe('test safety guard (src/test/setup.js)', () => {
  it('blanks the Supabase config', () => {
    expect(import.meta.env.VITE_SUPABASE_URL || '').toBe('')
    expect(import.meta.env.VITE_SUPABASE_ANON_KEY || '').toBe('')
  })

  it('refuses to import src/lib/supabase.js', async () => {
    const err = await import('../lib/supabase.js').then(() => null, e => e)
    expect(err).toBeInstanceOf(Error)
    expect(String(err.cause?.message ?? err.message)).toMatch(/must not touch the database/)
  })

  it('also refuses a module that imports src/lib/supabase.js', async () => {
    const err = await import('../lib/snapshot.js').then(() => null, e => e)
    expect(err).toBeInstanceOf(Error)
  })

  it('refuses the network', () => {
    expect(() => fetch('https://example.invalid')).toThrow(/must not use the network/)
  })

  it('runs in the business time zone (Asia/Manila, UTC+8)', () => {
    expect(new Date(2026, 10, 5).getTimezoneOffset()).toBe(-480)
  })
})
