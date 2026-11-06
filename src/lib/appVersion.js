// Pure build-version comparison (no I/O). The running bundle's id is baked in by vite.config.js (__APP_BUILD_ID__);
// the deployed id comes from /version.json, written by the same build.

export const STALE_APP_MESSAGE = 'The app was updated. Reload the page, then try again. Nothing was changed.'

const isId = (v) => typeof v === 'string' && v.trim() !== ''

/** 'current' | 'stale' | 'unknown'. Unknown (never blocks) when either id is missing or the running build is local dev. */
export function compareBuilds(running, deployed) {
  if (!isId(running) || !isId(deployed) || running === 'dev') return 'unknown'
  return running === deployed ? 'current' : 'stale'
}

/** The build id from a parsed /version.json body, else null (an HTML page from the SPA rewrite, a missing or non-string id). */
export function parseVersionPayload(json) {
  if (!json || typeof json !== 'object' || Array.isArray(json)) return null
  return isId(json.buildId) ? json.buildId : null
}
