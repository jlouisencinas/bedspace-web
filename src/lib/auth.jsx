import { createContext, useContext, useEffect, useState } from 'react'
import { supabase } from './supabase'

const AuthCtx = createContext(null)
export const useAuth = () => useContext(AuthCtx)

/**
 * Tracks the Supabase session + the user's role (admin | owner).
 *   session === undefined  → still loading
 *   session === null       → logged out
 *   role    === null       → role not resolved yet (only while session loading)
 */
export function AuthProvider({ children }) {
  const [session, setSession] = useState(undefined)
  const [role, setRole] = useState(null)
  const [roleLoading, setRoleLoading] = useState(false)

  useEffect(() => {
    if (!supabase) { setSession(null); return }
    supabase.auth.getSession().then(({ data }) => setSession(data.session ?? null))
    const { data: sub } = supabase.auth.onAuthStateChange((_e, s) => setSession(s ?? null))
    return () => sub.subscription.unsubscribe()
  }, [])

  useEffect(() => {
    let cancelled = false
    async function loadRole() {
      if (!session?.user) { setRole(null); return }
      setRoleLoading(true)
      const { data } = await supabase
        .from('profiles').select('role').eq('id', session.user.id).single()
      if (!cancelled) { setRole(data?.role || 'owner'); setRoleLoading(false) }
    }
    loadRole()
    return () => { cancelled = true }
  }, [session])

  const signIn  = (email, password) => supabase.auth.signInWithPassword({ email, password })
  const signOut = () => supabase.auth.signOut()

  const value = {
    session,
    user: session?.user || null,
    role,
    isAdmin: role === 'admin',
    loading: session === undefined || (!!session && roleLoading),
    signIn, signOut,
  }
  return <AuthCtx.Provider value={value}>{children}</AuthCtx.Provider>
}
