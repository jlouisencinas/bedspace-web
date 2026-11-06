import { describe, it, expect, vi, afterEach } from 'vitest'
import { compareBuilds, parseVersionPayload, STALE_APP_MESSAGE } from './appVersion'
import { assertAppCurrent, isAppStale } from './appVersionCheck'

describe('compareBuilds', () => {
  it.each([
    ['a-1', 'a-2', 'stale'],
    ['a-1', 'a-1', 'current'],
    ['a-1', null, 'unknown'],
    ['', 'x', 'unknown'],
    [undefined, 'x', 'unknown'],
    ['dev', 'x', 'unknown'],
    ['a-1', 5, 'unknown'],
  ])('compareBuilds(%j, %j) = %s', (running, deployed, out) => {
    expect(compareBuilds(running, deployed)).toBe(out)
  })
})

describe('parseVersionPayload', () => {
  it('returns the build id of a version.json body', () => {
    expect(parseVersionPayload({ buildId: 'x' })).toBe('x')
  })

  it.each([['<html>'], [{}], [{ buildId: 5 }], [{ buildId: '' }], [null], [['x']]])('returns null for %j', (v) => {
    expect(parseVersionPayload(v)).toBeNull()
  })
})

describe('assertAppCurrent', () => {
  afterEach(() => vi.unstubAllGlobals())
  const respond = (body, ok = true) => vi.stubGlobal('fetch', vi.fn(async () => ({ ok, json: async () => body })))

  it('resolves when the deployed build is the running one', async () => {
    respond({ buildId: 'b-1' })
    await expect(assertAppCurrent({ running: 'b-1' })).resolves.toBeUndefined()
  })

  it('fails open when the fetch throws (offline, hosting blip)', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('offline') }))
    await expect(assertAppCurrent({ running: 'b-1' })).resolves.toBeUndefined()
  })

  it('fails open when the response is not ok', async () => {
    respond({ buildId: 'b-2' }, false)
    await expect(assertAppCurrent({ running: 'b-1' })).resolves.toBeUndefined()
  })

  it('fails open when the body is not JSON (the SPA rewrite served index.html)', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => { throw new SyntaxError('Unexpected token <') } })))
    await expect(assertAppCurrent({ running: 'b-1' })).resolves.toBeUndefined()
  })

  it('never blocks a local dev build', async () => {
    respond({ buildId: 'b-2' })
    await expect(assertAppCurrent({ running: 'dev' })).resolves.toBeUndefined()
    expect(isAppStale()).toBe(false)
  })

  // Last in this file: once stale, the module stays stale until the page reloads.
  it('throws the update message with .stale when a newer build is deployed, and stays stale', async () => {
    respond({ buildId: 'b-2' })
    const err = await assertAppCurrent({ running: 'b-1' }).catch(e => e)
    expect(err).toBeInstanceOf(Error)
    expect(err.message).toBe(STALE_APP_MESSAGE)
    expect(err.stale).toBe(true)
    expect(isAppStale()).toBe(true)

    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('offline') }))
    await expect(assertAppCurrent({ running: 'b-1' })).rejects.toMatchObject({ stale: true })
  })
})
