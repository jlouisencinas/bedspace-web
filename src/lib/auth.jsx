import { createContext, useContext, useEffect, useState } from 'react'
import { supabase } from './supabase'

const AuthCtx = createContext(null)
export const useAuth = () => useContext(AuthCtx)

/**
 * Tracks the Supabase session + the user's role (admin | user | viewer).
 *   session === undefined  → still loading
 *   session === null       → logged out
 *   role    === null       → role not resolved yet, or logged out
 *   loading stays true until the role resolves whenever a session exists, so
 *   role-gated routes are never mounted (and deep links never redirected) early.
 *   A failed profile lookup resolves to 'viewer' (least privilege).
 *
 * Role capabilities:
 *   viewer  → read-only (Dashboard, Bed Map, Reports)
 *   user    → day-to-day ops (+ Tenants, Utilities, Billing, Activity)
 *             protected-field edits go through the approval workflow
 *   admin   → full access + approves/rejects override requests
 */
export function AuthProvider({ children }) {
  const [session, setSession] = useState(undefined)
  const [role, setRole] = useState(null)
  const [roleLoading, setRoleLoading] = useState(false)

  useEffect(() => {
    if (!supabase) { setSession(null); return }
    supabase.auth.getSession().then(({ data }) => setSession(data.session ?? null))

    const { data: sub } = supabase.auth.onAuthStateChange((event, s) => {
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
  const signOut = () => supabase.auth.signOut()

  const value = {
    session,
    user: session?.user || null,
    role,
    isAdmin:  role === 'admin',
    isUser:   role === 'user',
    isViewer: role === 'viewer',
    loading: session === undefined || (!!session && (roleLoading || role === null)),
    signIn, signOut,
  }
  return <AuthCtx.Provider value={value}>{children}</AuthCtx.Provider>
}
