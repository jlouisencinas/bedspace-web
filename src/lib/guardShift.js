import { useEffect, useState } from 'react'

// The guard account is shared, so the person on duty types their name after every sign-in.
// A shift is bound to the session's last_sign_in_at: a new sign-in (even on the same account and
// device) invalidates it, while a token refresh / tab refocus of the same session does not.

const SHIFT_PREFIX = 'bedspace.guardShift.'
const RECENT_KEY = 'bedspace.guardRecentNames'
const CHANGE_EVENT = 'bedspace:guardshift'
const MAX_AGE_MS = 12 * 60 * 60 * 1000
const MAX_RECENT = 5

export const cleanDutyName = s => String(s ?? '').replace(/\s+/g, ' ').trim()
export const validDutyName = s => { const n = cleanDutyName(s); return n.length >= 2 && n.length <= 60 }

function read(key) {
  try { return JSON.parse(localStorage.getItem(key) || 'null') } catch { return null }
}
function emit() {
  try { window.dispatchEvent(new Event(CHANGE_EVENT)) } catch { /* no window */ }
}

// last_sign_in_at can be missing from a session; then a per-device marker stands in for it. It lives under
// SHIFT_PREFIX so clearAllShifts() (every sign-out / user switch) removes it and the next sign-in gets a new one.
const FALLBACK_PREFIX = SHIFT_PREFIX + 'signin.'
function signInKey(uid, signInAt) {
  if (signInAt) return signInAt
  if (!uid) return null
  try {
    let v = localStorage.getItem(FALLBACK_PREFIX + uid)
    if (!v) { v = `local:${new Date().toISOString()}`; localStorage.setItem(FALLBACK_PREFIX + uid, v) }
    return v
  } catch {
    return 'local:unavailable'
  }
}

export function getShift(uid, rawSignInAt) {
  const signInAt = signInKey(uid, rawSignInAt)
  if (!uid || !signInAt) return null
  const s = read(SHIFT_PREFIX + uid)
  if (!s || typeof s !== 'object' || s.signInAt !== signInAt) return null
  const started = Date.parse(s.startedAt)
  if (!Number.isFinite(started) || Date.now() - started > MAX_AGE_MS) return null
  if (!validDutyName(s.name)) return null
  return { name: cleanDutyName(s.name), startedAt: s.startedAt, signInAt: s.signInAt }
}

export function setShift(uid, rawSignInAt, name) {
  if (!uid) throw new Error('Your session has no user. Sign out and sign in again.')
  if (!validDutyName(name)) throw new Error('Enter who is on duty (2 to 60 characters).')
  const signInAt = signInKey(uid, rawSignInAt)
  localStorage.setItem(SHIFT_PREFIX + uid, JSON.stringify({ name: cleanDutyName(name), startedAt: new Date().toISOString(), signInAt }))
  emit()
}

export function clearShift(uid) {
  if (uid) localStorage.removeItem(SHIFT_PREFIX + uid)
  emit()
}

export function clearAllShifts() {
  try {
    const keys = []
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i)
      if (k && k.startsWith(SHIFT_PREFIX)) keys.push(k)
    }
    keys.forEach(k => localStorage.removeItem(k))
  } catch { /* storage unavailable */ }
  emit()
}

export function getRecentNames() {
  const list = read(RECENT_KEY)
  return Array.isArray(list) ? list.filter(validDutyName).map(cleanDutyName).slice(0, MAX_RECENT) : []
}

export function addRecentName(name) {
  const n = cleanDutyName(name)
  if (!validDutyName(n)) return
  const next = [n, ...getRecentNames().filter(x => x.toLowerCase() !== n.toLowerCase())].slice(0, MAX_RECENT)
  localStorage.setItem(RECENT_KEY, JSON.stringify(next))
  emit()
}

export function removeRecentName(name) {
  const n = cleanDutyName(name).toLowerCase()
  localStorage.setItem(RECENT_KEY, JSON.stringify(getRecentNames().filter(x => x.toLowerCase() !== n)))
  emit()
}

// Re-reads on shift changes in this tab, on other tabs (storage event), and every minute so the
// 12-hour expiry brings the prompt back without any interaction.
export function useGuardShift(uid, signInAt) {
  const [, setTick] = useState(0)
  useEffect(() => {
    const bump = () => setTick(t => t + 1)
    window.addEventListener(CHANGE_EVENT, bump)
    window.addEventListener('storage', bump)
    const timer = setInterval(bump, 60 * 1000)
    return () => {
      window.removeEventListener(CHANGE_EVENT, bump)
      window.removeEventListener('storage', bump)
      clearInterval(timer)
    }
  }, [])
  return getShift(uid, signInAt)
}
