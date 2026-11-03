import { createContext, useContext, useEffect, useRef, useState } from 'react'
import { supabase } from './supabase'
import { clearAllShifts } from './guardShift'

const AuthCtx = createContext(null)
export const useAuth = () => useContext(AuthCtx)

/**
 * Tracks the Supabase session + the user's role (admin | user | viewer | guard).
 *   session === undefined  → still loading
 *   session === null       → logged out
 *   role    === null       → role not resolved yet, or logged out
 *   loading stays true until the role resolves whenever a session exists, so
 *   role-gated routes are never mounted (and deep links never redirected) early.
 *   A failed profile lookup resolves to 'viewer' (least privilege).
 *   signInAt (the session user's last_sign_in_at) binds the guard's duty-name shift to one
 *   sign-in: every new sign-in invalidates it, a token refresh / tab refocus does not.
 *
 * Role capabilities:
 *   viewer  → read-only (Dashboard, Bed Map, Reports)
 *   user    → day-to-day ops (+ Tenants, Utilities, Billing, Activity, Visitor Log)
 *             protected-field edits go through the approval workflow
 *   admin   → full access + approves/rejects override requests
 *   guard   → "Security / Front desk": the Visitor Log only (no sidebar, no other route)
 */
export function AuthProvider({ children }) {
  const [session, setSession] = useState(undefined)
  const [role, setRole] = useState(null)
  const [roleLoading, setRoleLoading] = useState(false)
  const lastUserId = useRef(null)

  useEffect(() => {
    if (!supabase) { setSession(null); return }
    supabase.auth.getSession().then(({ data }) => {
      if (!lastUserId.current) lastUserId.current = data.session?.user?.id ?? null
      setSession(data.session ?? null)
    })

    const { data: sub } = supabase.auth.onAuthStateChange((event, s) => {
      // A restored session also emits SIGNED_IN on page load, so only a *different* known user clears shifts.
      if (event === 'SIGNED_OUT') { clearAllShifts(); lastUserId.current = null }
      else if (s?.user?.id) {
        if (event === 'SIGNED_IN' && lastUserId.current && lastUserId.current !== s.user.id) clearAllShifts()
        lastUserId.current = s.user.id
      }
      // TOKEN_REFRESHED fires on tab focus — skip it to prevent re-renders when
      // the user is the same. SIGNED_IN on tab-switch also fires; compare user ID.
      if (event === 'TOKEN_REFRESHED') return
      setSession(prev => {
        const next = s ?? null
        if (prev?.user?.id === next?.user?.id) return prev  // same user, no re-render
        return next
      })
    })
    return () => sub.subscription.unsubscribe()
  }, [])

  useEffect(() => {
    let cancelled = false
    async function loadRole() {
      if (!session?.user) { setRole(null); return }
      setRole(null)
      setRoleLoading(true)
      let resolved = 'viewer'
      try {
        const { data } = await supabase
          .from('profiles').select('role').eq('id', session.user.id).single()
        resolved = data?.role || 'viewer'
      } catch {
        // fail closed: least privilege if the profile lookup throws
      }
      if (!cancelled) { setRole(resolved); setRoleLoading(false) }
    }
    loadRole()
    return () => { cancelled = true }
  }, [session?.user?.id])  // only re-fetch role when the user ID itself changes

  const signIn  = (email, password) => supabase.auth.signInWithPassword({ email, password })
  const signOut = () => { clearAllShifts(); return supabase.auth.signOut() }

  const value = {
    session,
    user: session?.user || null,
    role,
    isAdmin:  role === 'admin',
    isUser:   role === 'user',
    isViewer: role === 'viewer',
    isGuard:  role === 'guard',
    signInAt: session?.user?.last_sign_in_at ?? null,
    loading: session === undefined || (!!session && (roleLoading || role === null)),
    signIn, signOut,
  }
  return <AuthCtx.Provider value={value}>{children}</AuthCtx.Provider>
}
