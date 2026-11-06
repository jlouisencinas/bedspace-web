// Thin I/O around appVersion.js: fetches /version.json and blocks money writes from a tab that runs an older build.
// Fail-open: an unreachable or malformed /version.json never blocks (a hosting blip must not stop a move-out).
import { compareBuilds, parseVersionPayload, STALE_APP_MESSAGE } from './appVersion'

const RUNNING = typeof __APP_BUILD_ID__ !== 'undefined' ? __APP_BUILD_ID__ : 'dev'

let stale = false
const listeners = new Set()

function markStale() {
  if (stale) return
  stale = true
  for (const fn of listeners) fn(true)
}

export const isAppStale = () => stale

export function subscribeStale(fn) {
  listeners.add(fn)
  return () => listeners.delete(fn)
}

export async function fetchDeployedBuild() {
  try {
    const res = await fetch('/version.json', { cache: 'no-store' })
    if (!res || !res.ok) return null
    return parseVersionPayload(await res.json())
  } catch {
    return null
  }
}

/** Fetches the deployed build and records a stale tab. Returns 'current' | 'stale' | 'unknown'. */
export async function checkNow({ running = RUNNING } = {}) {
  if (stale) return 'stale'
  const verdict = compareBuilds(running, await fetchDeployedBuild())
  if (verdict === 'stale') markStale()
  return verdict
}

/** First statement of every money write: throws (with .stale) before anything is written when a newer build is deployed. */
export async function assertAppCurrent(opts) {
  if ((await checkNow(opts)) === 'stale') throw Object.assign(new Error(STALE_APP_MESSAGE), { stale: true })
}
