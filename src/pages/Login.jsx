import { useState } from 'react'
import { useAuth } from '../lib/auth'

export default function Login() {
  const { signIn } = useAuth()
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')

  async function submit(e) {
    e.preventDefault()
    setErr(''); setBusy(true)
    const { error } = await signIn(email.trim(), password)
    if (error) { setErr(error.message); setBusy(false) }
    // on success the AuthProvider session listener swaps the screen automatically
  }

  return (
    <div style={{
      display: 'flex', alignItems: 'center', justifyContent: 'center',
      minHeight: '100vh', background: '#F0F4F8', padding: 24,
    }}>
      <form onSubmit={submit} style={{
        background: '#fff', borderRadius: 14, padding: 32, maxWidth: 380, width: '100%',
        boxShadow: '0 8px 30px rgba(15,23,42,.12)', borderTop: '4px solid #1B3A8C',
      }}>
        <div style={{ textAlign: 'center', marginBottom: 20 }}>
          <img src="/bedspace-logo.png" alt="Bedspace" style={{ height: 46, marginBottom: 10 }}
               onError={e => { e.currentTarget.style.display = 'none' }} />
          <h2 style={{ fontSize: 19, fontWeight: 800, color: '#0F172A', margin: 0 }}>Bedspace Manager</h2>
          <p style={{ color: '#64748B', fontSize: 13, margin: '4px 0 0' }}>Sign in to continue</p>
        </div>

        <label style={lbl}>Email</label>
        <input style={inp} type="email" value={email} autoComplete="username"
               onChange={e => setEmail(e.target.value)} required />

        <label style={lbl}>Password</label>
        <input style={inp} type="password" value={password} autoComplete="current-password"
               onChange={e => setPassword(e.target.value)} required />

        {err && <div style={{
          background: '#FEF2F2', color: '#B91C1C', fontSize: 13, borderRadius: 8,
          padding: '8px 12px', margin: '4px 0 12px',
        }}>{err}</div>}

        <button type="submit" disabled={busy} style={{
          width: '100%', background: '#1B3A8C', color: '#fff', border: 'none',
          borderRadius: 8, padding: '11px 0', fontSize: 15, fontWeight: 700,
          cursor: busy ? 'default' : 'pointer', opacity: busy ? .7 : 1, marginTop: 4,
        }}>{busy ? 'Signing in…' : 'Sign in'}</button>

        <p style={{ color: '#94A3B8', fontSize: 11, textAlign: 'center', marginTop: 16 }}>
          Accounts are created by the administrator.
        </p>
      </form>
    </div>
  )
}

const lbl = { display: 'block', fontSize: 12, fontWeight: 600, color: '#334155', margin: '10px 0 4px' }
const inp = {
  width: '100%', boxSizing: 'border-box', border: '1px solid #CBD5E1', borderRadius: 8,
  padding: '10px 12px', fontSize: 14, outline: 'none',
}
