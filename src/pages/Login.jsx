import { useState } from 'react'
import { useAuth } from '../lib/auth'
import { BedDouble, CreditCard, Zap, Users, Eye, EyeOff, Mail, Lock, AlertCircle } from 'lucide-react'

export default function Login() {
  const { signIn } = useAuth()
  const [email,    setEmail]    = useState('')
  const [password, setPassword] = useState('')
  const [showPw,   setShowPw]   = useState(false)
  const [busy,     setBusy]     = useState(false)
  const [err,      setErr]      = useState('')

  async function submit(e) {
    e.preventDefault()
    setErr(''); setBusy(true)
    const { error } = await signIn(email.trim(), password)
    if (error) { setErr(error.message); setBusy(false) }
  }

  return (
    <div className="relative min-h-screen flex overflow-hidden bg-gradient-to-br from-amber-50 via-white to-slate-100">
      <div aria-hidden="true" className="pointer-events-none absolute -top-24 -right-24 w-72 h-72 rounded-full bg-[#F2A623]/10 blur-3xl" />
      <div aria-hidden="true" className="pointer-events-none absolute -bottom-32 -left-24 w-80 h-80 rounded-full bg-[#333]/10 blur-3xl" />

      {/* ── Left brand panel (lg+) ── */}
      <div className="relative hidden lg:flex w-[480px] shrink-0 flex-col justify-center p-12 overflow-hidden"
           style={{ background: 'linear-gradient(160deg, #2b2b2b 0%, #333333 100%)' }}>
        <div aria-hidden="true" className="absolute top-0 left-0 h-1.5 w-full bg-[#F2A623]" />
        <div aria-hidden="true" className="pointer-events-none absolute -bottom-20 -right-20 w-64 h-64 rounded-full bg-[#F2A623]/15 blur-2xl" />

        <div className="relative">
          <div className="inline-flex bg-white rounded-2xl p-3 shadow-lg mb-10">
            <img src="/bedspace-logo-full.png" alt="Bedspace Manager" width={120} height={120}
                 className="w-[120px] h-[120px] object-contain" />
          </div>

          <h1 className="text-white text-[32px] font-bold leading-snug mb-4">
            Manage your<br />property with ease
          </h1>
          <p className="text-white/70 text-[14px] leading-relaxed max-w-xs">
            Track bed occupancy, utilities, billing, and tenant details — all in one place.
          </p>

          <div className="mt-8 flex flex-col gap-3">
            {[
              [BedDouble,   'Live bed map & occupancy tracking'],
              [CreditCard,  'Automated billing & payment logs'],
              [Zap,         'Utility split calculations'],
              [Users,       'Multi-role team access'],
            ].map(([Icon, text]) => (
              <div key={text} className="flex items-center gap-3 text-white/80 text-[13px]">
                <span className="inline-flex items-center justify-center w-8 h-8 rounded-lg bg-[#F2A623]/15 shrink-0">
                  <Icon size={15} aria-hidden="true" className="text-[#F2A623]" />
                </span>
                {text}
              </div>
            ))}
          </div>
        </div>
      </div>

      {/* ── Right form panel ── */}
      <div className="relative flex-1 flex items-center justify-center p-4 sm:p-6">
        <div className="w-full max-w-[400px]">
          <img src="/bedspace-logo-full.png" alt="Bedspace Manager" width={112} height={112}
               className="lg:hidden mx-auto mb-6 w-[112px] h-[112px] object-contain" />

          <div className="bg-white rounded-2xl shadow-xl shadow-slate-900/5 border border-slate-100 p-6 sm:p-8">
            <h2 className="text-[24px] font-bold text-slate-900 mb-1">Welcome back</h2>
            <p className="text-slate-600 text-sm mb-7">Sign in to your account to continue.</p>

            <form onSubmit={submit} className="space-y-4">
              <div>
                <label htmlFor="login-email" className="block text-[13px] font-semibold text-slate-700 mb-1.5">
                  Email address
                </label>
                <div className="relative">
                  <Mail size={16} aria-hidden="true"
                        className="pointer-events-none absolute left-3.5 top-1/2 -translate-y-1/2 text-slate-400" />
                  <input
                    id="login-email"
                    type="email"
                    autoComplete="username"
                    value={email}
                    onChange={e => setEmail(e.target.value)}
                    required
                    placeholder="you@example.com"
                    className="w-full h-11 pl-10 pr-3.5 text-[16px] sm:text-[15px] text-slate-900 bg-white border border-slate-300 rounded-xl
                               placeholder:text-slate-400
                               focus:outline-none focus:ring-2 focus:ring-amber-500/40 focus:border-amber-500
                               transition-colors"
                  />
                </div>
              </div>

              <div>
                <label htmlFor="login-password" className="block text-[13px] font-semibold text-slate-700 mb-1.5">
                  Password
                </label>
                <div className="relative">
                  <Lock size={16} aria-hidden="true"
                        className="pointer-events-none absolute left-3.5 top-1/2 -translate-y-1/2 text-slate-400" />
                  <input
                    id="login-password"
                    type={showPw ? 'text' : 'password'}
                    autoComplete="current-password"
                    value={password}
                    onChange={e => setPassword(e.target.value)}
                    required
                    placeholder="••••••••"
                    className="w-full h-11 pl-10 pr-12 text-[16px] sm:text-[15px] text-slate-900 bg-white border border-slate-300 rounded-xl
                               placeholder:text-slate-400 [&::-ms-reveal]:hidden
                               focus:outline-none focus:ring-2 focus:ring-amber-500/40 focus:border-amber-500
                               transition-colors"
                  />
                  <button
                    type="button"
                    onClick={() => setShowPw(v => !v)}
                    onMouseDown={e => e.preventDefault()}
                    aria-label={showPw ? 'Hide password' : 'Show password'}
                    aria-pressed={showPw}
                    className="absolute right-1 top-1/2 -translate-y-1/2 w-10 h-10 inline-flex items-center justify-center
                               rounded-lg text-slate-500 hover:text-slate-800
                               focus:outline-none focus-visible:ring-2 focus-visible:ring-amber-600 transition-colors"
                  >
                    {showPw ? <EyeOff size={16} /> : <Eye size={16} />}
                  </button>
                </div>
              </div>

              {err && (
                <div role="alert"
                     className="flex items-start gap-2 bg-red-50 text-red-700 text-[13px] rounded-xl px-4 py-3 border border-red-100 break-words">
                  <AlertCircle size={16} aria-hidden="true" className="shrink-0 mt-px" />
                  <span className="min-w-0">{err}</span>
                </div>
              )}

              <button
                type="submit"
                disabled={busy}
                className="w-full h-11 bg-[#F2A623] hover:bg-[#e09612] text-[#333] font-semibold text-[15px]
                           rounded-xl transition-colors duration-150 mt-1 shadow-sm
                           focus:outline-none focus-visible:ring-2 focus-visible:ring-amber-600 focus-visible:ring-offset-2
                           disabled:opacity-60 disabled:cursor-not-allowed disabled:hover:bg-[#F2A623]"
              >
                {busy ? 'Signing in…' : 'Sign in'}
              </button>
            </form>
          </div>

          <p className="text-slate-500 text-[12px] text-center mt-6">
            Accounts are created by the administrator.
          </p>
        </div>
      </div>
    </div>
  )
}
