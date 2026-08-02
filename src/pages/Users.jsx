import { useEffect, useState, useCallback } from 'react'
import { supabase } from '../lib/supabase'
import { useAuth } from '../lib/auth'
import { useToast } from '../components/Toast'
import { UserPlus, X, AlertTriangle } from 'lucide-react'

const ROLES = ['admin', 'user', 'viewer']

const ROLE_CONFIG = {
  admin:  { bg: 'bg-amber-50',   text: 'text-amber-800',  label: 'Admin'  },
  user:   { bg: 'bg-blue-50',    text: 'text-blue-700',   label: 'User'   },
  viewer: { bg: 'bg-slate-100',  text: 'text-slate-500',  label: 'Viewer' },
}

function RoleBadge({ role }) {
  const c = ROLE_CONFIG[role] || ROLE_CONFIG.viewer
  return (
    <span className={`inline-flex items-center px-2.5 py-1 rounded-full text-[11px] font-bold uppercase tracking-wide ${c.bg} ${c.text}`}>
      {c.label}
    </span>
  )
}

function Avatar({ email }) {
  const initials = (email || '?').slice(0, 2).toUpperCase()
  return (
    <div className="w-8 h-8 rounded-full bg-navy-500/15 text-navy-600 flex items-center justify-center text-[12px] font-bold shrink-0">
      {initials}
    </div>
  )
}

function CreateUserModal({ onClose, onCreated }) {
  const [form, setForm] = useState({ email: '', password: '', role: 'viewer' })
  const [busy, setBusy] = useState(false)
  const [err,  setErr]  = useState('')
  const set = (k, v) => setForm(f => ({ ...f, [k]: v }))

  async function submit(e) {
    e.preventDefault(); setErr(''); setBusy(true)
    try {
      const { data, error } = await supabase.auth.signUp({
        email:    form.email.trim(),
        password: form.password,
        options:  { emailRedirectTo: undefined },
      })
      if (error) throw error
      const userId = data.user?.id
      if (!userId) throw new Error('User created but ID not returned — check Supabase Auth settings.')
      if (form.role !== 'viewer') {
        const { error: roleErr } = await supabase.from('profiles').update({ role: form.role }).eq('id', userId)
        if (roleErr) throw roleErr
      }
      onCreated()
    } catch (ex) { setErr(ex.message) }
    finally { setBusy(false) }
  }

  return (
    <div className="overlay" onClick={e => e.stopPropagation()}>
      <div className="modal modal-sm">
        <div className="modal-head">
          <h3>Add New User</h3>
          <button className="btn-close" onClick={onClose}><X size={16} /></button>
        </div>
        <form onSubmit={submit}>
          <div className="modal-body">
            <div className="mb-4 p-3 bg-amber-50 border border-amber-100 rounded-xl text-[12px] text-amber-700">
              <AlertTriangle size={13} className="shrink-0 mt-px inline mr-1" /> Requires <strong>Allow new users to sign up</strong> to be enabled in Supabase Auth. Disable again after.
            </div>
            <div className="form-grid grid-cols-1">
              <div className="fg">
                <label>Email address</label>
                <input type="email" required autoFocus value={form.email}
                  onChange={e => set('email', e.target.value)} placeholder="staff@example.com" />
              </div>
              <div className="fg">
                <label>Temporary password</label>
                <input type="password" required minLength={8} value={form.password}
                  onChange={e => set('password', e.target.value)} placeholder="Min. 8 characters" />
              </div>
              <div className="fg">
                <label>Role</label>
                <select value={form.role} onChange={e => set('role', e.target.value)}>
                  {ROLES.map(r => (
                    <option key={r} value={r}>{r.charAt(0).toUpperCase() + r.slice(1)}</option>
                  ))}
                </select>
              </div>
            </div>
            {err && (
              <div className="mt-3 p-3 bg-red-50 text-red-700 text-[13px] rounded-xl border border-red-100">{err}</div>
            )}
          </div>
          <div className="modal-foot">
            <button type="button" className="btn secondary" onClick={onClose}>Cancel</button>
            <button type="submit" className="btn primary" disabled={busy}>
              {busy ? 'Creating…' : 'Create User'}
            </button>
          </div>
        </form>
      </div>
    </div>
  )
}

export default function Users() {
  const { isAdmin, user: me } = useAuth()
  const [profiles,    setProfiles]   = useState([])
  const [loading,     setLoading]    = useState(true)
  const [savingId,    setSavingId]   = useState(null)
  const [showCreate,  setShowCreate] = useState(false)
  const { show, ToastEl } = useToast()

  const load = useCallback(async () => {
    setLoading(true)
    const { data, error } = await supabase
      .from('profiles').select('id, email, role, created_at').order('created_at', { ascending: true })
    if (!error) setProfiles(data)
    setLoading(false)
  }, [])

  useEffect(() => { load() }, [load])

  async function changeRole(profileId, newRole) {
    setSavingId(profileId)
    const { error } = await supabase.from('profiles').update({ role: newRole }).eq('id', profileId)
    if (error) { show('Failed: ' + error.message, 'error') }
    else {
      setProfiles(prev => prev.map(p => p.id === profileId ? { ...p, role: newRole } : p))
      show('Role updated.', 'success')
    }
    setSavingId(null)
  }

  if (!isAdmin) return (
    <div className="page">
      <div className="empty"><p>You do not have permission to view this page.</p></div>
    </div>
  )

  return (
    <div className="page">
      {ToastEl}

      {/* ── Header ── */}
      <div className="page-header">
        <div>
          <h1 className="page-title">Users</h1>
          <p className="page-sub">Manage app accounts and access roles</p>
        </div>
        <button className="btn primary" onClick={() => setShowCreate(true)}>
          <UserPlus size={14} /> Add User
        </button>
      </div>

      {/* ── Role legend ── */}
      <div className="bg-white rounded-xl border border-slate-200 shadow-card p-4 mb-5 flex flex-wrap gap-5 text-[12px]">
        {[
          ['Admin',  'Full access + approvals management',    'text-amber-700'],
          ['User',   'Day-to-day ops (Tenants, Billing, Utilities)', 'text-blue-700'],
          ['Viewer', 'Read-only (Dashboard, Bed Map, Reports)', 'text-slate-500'],
        ].map(([r, desc, c]) => (
          <div key={r} className="flex items-start gap-2">
            <span className={`font-bold text-[12px] ${c} shrink-0 mt-px`}>{r}</span>
            <span className="text-slate-400">— {desc}</span>
          </div>
        ))}
      </div>

      {/* ── Table ── */}
      {loading ? (
        <div className="loading-screen"><div className="spinner" /></div>
      ) : (
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>User</th>
                <th>Current Role</th>
                <th>Member Since</th>
                <th>Change Role</th>
              </tr>
            </thead>
            <tbody>
              {profiles.map(p => {
                const isMe = p.id === me?.id
                return (
                  <tr key={p.id}>
                    <td>
                      <div className="flex items-center gap-3">
                        <Avatar email={p.email} />
                        <div>
                          <div className="text-[13px] font-medium text-slate-900">{p.email}</div>
                          {isMe && (
                            <div className="text-[10px] text-slate-400 font-medium uppercase tracking-wider mt-0.5">You</div>
                          )}
                        </div>
                      </div>
                    </td>
                    <td><RoleBadge role={p.role} /></td>
                    <td className="text-[12px] text-slate-400">
                      {new Date(p.created_at).toLocaleDateString('en-PH', { month: 'short', day: 'numeric', year: 'numeric' })}
                    </td>
                    <td>
                      {isMe ? (
                        <span className="text-[12px] text-slate-300 italic">Cannot change own role</span>
                      ) : (
                        <div className="flex gap-2">
                          {ROLES.filter(r => r !== p.role).map(r => {
                            const c = ROLE_CONFIG[r]
                            return (
                              <button
                                key={r}
                                disabled={savingId === p.id}
                                onClick={() => changeRole(p.id, r)}
                                className={`px-3 py-1 rounded-full text-[11px] font-semibold border transition-opacity
                                           ${c.bg} ${c.text} border-current/20
                                           hover:opacity-80 disabled:opacity-40`}
                              >
                                {savingId === p.id ? '…' : `→ ${c.label}`}
                              </button>
                            )
                          })}
                        </div>
                      )}
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      )}

      {showCreate && (
        <CreateUserModal
          onClose={() => setShowCreate(false)}
          onCreated={() => { setShowCreate(false); load(); show('User created.', 'success') }}
        />
      )}
    </div>
  )
}
