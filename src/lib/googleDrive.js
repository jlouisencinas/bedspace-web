const API_KEY       = import.meta.env.VITE_GOOGLE_API_KEY
const CLIENT_ID     = import.meta.env.VITE_GOOGLE_CLIENT_ID
const PARENT_FOLDER = import.meta.env.VITE_GOOGLE_DRIVE_PARENT_FOLDER_ID
const SCOPES        = 'https://www.googleapis.com/auth/drive.file'

export function isDriveConfigured() {
  return !!(API_KEY && CLIENT_ID)
}

let _tokenClient = null
let _accessToken = null
let _gisLoaded   = false

// localStorage keys — token persists across browser restarts until it expires (~1 hr)
const TK = 'gd_tok'
const EK = 'gd_exp'

function saveToken(token) {
  _accessToken = token
  try {
    localStorage.setItem(TK, token)
    localStorage.setItem(EK, String(Date.now() + 55 * 60 * 1000))
  } catch {}
}

function loadToken() {
  try {
    // Also migrate tokens saved under old key names from previous versions
    for (const [tk, ek] of [[TK, EK], ['gd_token', 'gd_expiry'], ['SK', 'EK']]) {
      const token  = localStorage.getItem(tk)
      const expiry = Number(localStorage.getItem(ek))
      if (token && expiry && Date.now() < expiry) {
        _accessToken = token
        if (tk !== TK) { localStorage.setItem(TK, token); localStorage.setItem(EK, String(expiry)) }
        return true
      }
    }
  } catch {}
  return false
}

function clearToken() {
  _accessToken = null
  try { localStorage.removeItem(TK); localStorage.removeItem(EK) } catch {}
}

export function isDriveConnected() { return !!_accessToken }

function loadScript(src) {
  return new Promise((resolve, reject) => {
    if (document.querySelector(`script[src="${src}"]`)) { resolve(); return }
    const s = document.createElement('script')
    s.src = src; s.async = true
    s.onload = resolve; s.onerror = reject
    document.head.appendChild(s)
  })
}

async function ensureGis() {
  if (_gisLoaded) return
  await loadScript('https://accounts.google.com/gsi/client')
  _tokenClient = window.google.accounts.oauth2.initTokenClient({
    client_id: CLIENT_ID,
    scope:     SCOPES,
    callback:  () => {},
  })
  _gisLoaded = true
}

function silentAuth() {
  return new Promise((resolve, reject) => {
    // 5-second safety timeout — prompt:'none' sometimes never calls the callback
    const t = setTimeout(() => reject(new Error('timeout')), 5000)
    _tokenClient.callback = res => {
      clearTimeout(t)
      if (res.error) { reject(new Error(res.error)); return }
      saveToken(res.access_token)
      resolve()
    }
    _tokenClient.requestAccessToken({ prompt: 'none' })
  })
}

// Call on Documents tab open. After resolving, check isDriveConnected() — if true, no Connect button needed.
export async function preloadDrive() {
  if (!isDriveConfigured()) return
  await ensureGis()
  if (_accessToken) return  // already in memory
  loadToken()               // restore from localStorage if not expired; no-op if expired
}

// MUST be called directly from a button onClick (no await before this call).
export function connectDrive() {
  if (!_tokenClient) return Promise.reject(new Error('Drive not ready — please try again.'))
  return new Promise((resolve, reject) => {
    _tokenClient.callback = res => {
      if (res.error) { reject(new Error(res.error_description || res.error)); return }
      saveToken(res.access_token)
      resolve()
    }
    _tokenClient.requestAccessToken({ prompt: 'consent' })
  })
}

// ── Drive REST helpers ─────────────────────────────────────────────────────────

async function driveJSON(method, path, queryParams, jsonBody) {
  const url = new URL(`https://www.googleapis.com/drive/v3/${path}`)
  if (queryParams) Object.entries(queryParams).forEach(([k, v]) => url.searchParams.set(k, v))
  const res = await fetch(url.toString(), {
    method,
    headers: { Authorization: `Bearer ${_accessToken}`, 'Content-Type': 'application/json' },
    body: jsonBody ? JSON.stringify(jsonBody) : undefined,
  })
  if (!res.ok) {
    const err = await res.json().catch(() => ({}))
    throw new Error(err.error?.message || `Drive API error (${res.status})`)
  }
  return res.json()
}

async function findFolder(name, parentId) {
  const q = `name='${name.replace(/'/g, "\\'")}' and mimeType='application/vnd.google-apps.folder' and '${parentId}' in parents and trashed=false`
  const data = await driveJSON('GET', 'files', { q, fields: 'files(id)', pageSize: '1' })
  return data.files?.[0]?.id ?? null
}

async function createFolder(name, parentId) {
  const data = await driveJSON('POST', 'files', { fields: 'id' }, {
    name, mimeType: 'application/vnd.google-apps.folder', parents: [parentId],
  })
  return data.id
}

export async function getOrCreateTenantFolder(tenantName, roomNo) {
  if (!_accessToken) throw new Error('Not connected to Google Drive.')
  const rootId   = PARENT_FOLDER || 'root'
  const roomName = `Room ${roomNo}`
  const roomId   = (await findFolder(roomName, rootId))   ?? await createFolder(roomName, rootId)
  const tenantId = (await findFolder(tenantName, roomId)) ?? await createFolder(tenantName, roomId)
  return tenantId
}

export async function uploadFileToDrive(file, folderId) {
  if (!_accessToken) throw new Error('Not connected to Google Drive.')
  const form = new FormData()
  form.append('metadata', new Blob([JSON.stringify({ name: file.name, parents: [folderId] })], { type: 'application/json' }))
  form.append('file', file)
  const res = await fetch(
    'https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id,name,webViewLink,size',
    { method: 'POST', headers: { Authorization: `Bearer ${_accessToken}` }, body: form }
  )
  if (!res.ok) {
    const err = await res.json().catch(() => ({}))
    throw new Error(err.error?.message || `Drive upload failed (${res.status})`)
  }
  return res.json()
}

export function signOutDrive() {
  if (_accessToken) window.google?.accounts?.oauth2?.revoke(_accessToken)
  clearToken()
}
