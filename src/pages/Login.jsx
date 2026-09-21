import { useState } from 'react'
import { useAuth } from '../lib/auth'
import BrandIcon from '../components/BrandIcon'
import { BedDouble, CreditCard, Zap, Users, Eye, EyeOff } from 'lucide-react'

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
    <div className="min-h-screen flex bg-slate-50">
      {/* ── Left branding panel ── */}
      <div className="hidden lg:flex w-[420px] shrink-0 flex-col justify-between p-10"
           style={{ background: 'linear-gradient(160deg, #1C1714 0%, #292420 60%, #3a3028 100%)' }}>
        <div className="flex items-center gap-3">
          <BrandIcon size={36} className="text-white/90" />
          <span className="text-white font-bold text-[16px] tracking-tight">Bedspace Manager</span>
        </div>

        <div className="my-auto">
          <h1 className="text-white text-[32px] font-bold leading-snug mb-4">
            Manage your<br />property with ease
          </h1>
          <p className="text-white/60 text-[14px] leading-relaxed max-w-xs">
            Track bed occupancy, utilities, billing, and tenant details — all in one place.
          </p>

          {/* Feature pills */}
          <div className="mt-8 flex flex-col gap-3">
            {[
              [BedDouble,   'Live bed map & occupancy tracking'],
              [CreditCard,  'Automated billing & payment logs'],
              [Zap,         'Utility split calculations'],
              [Users,       'Multi-role team access'],
            ].map(([Icon, text]) => (
              <div key={text} className="flex items-center gap-3 text-white/70 text-[13px]">
                <Icon size={15} className="shrink-0 text-white/50" />
                {text}
              </div>
            ))}
          </div>
        </div>

      </div>

      {/* ── Right form panel ── */}
      <div className="flex-1 flex items-center justify-center p-6">
        <div className="w-full max-w-[360px]">
          {/* Mobile brand */}
          <div className="lg:hidden flex items-center gap-2.5 mb-8">
            <BrandIcon size={32} className="text-navy-500 shrink-0" />
            <span className="font-bold text-slate-900 text-[16px]">Bedspace Manager</span>
          </div>

          <h2 className="text-[24px] font-bold text-slate-900 mb-1">Welcome back</h2>
          <p className="text-slate-500 text-sm mb-7">Sign in to your account to continue.</p>

          <form onSubmit={submit} className="space-y-4">
            <div>
              <label className="block text-[12px] font-semibold text-slate-600 mb-1.5 uppercase tracking-wide">
                Email address
              </label>
              <input
                type="email"
                autoComplete="username"
                value={email}
                onChange={e => setEmail(e.target.value)}
                required
                placeholder="you@example.com"
                className="w-full px-3.5 py-2.5 text-[14px] text-slate-900 bg-white border border-slate-200 rounded-xl
                           placeholder:text-slate-400
                           focus:outline-none focus:ring-2 focus:ring-navy-700/25 focus:border-navy-600
                           transition-all"
              />
            </div>

            <div>
              <label className="block text-[12px] font-semibold text-slate-600 mb-1.5 uppercase tracking-wide">
                Password
              </label>
              <div className="relative">
                <input
                  type={showPw ? 'text' : 'password'}
                  autoComplete="current-password"
                  value={password}
                  onChange={e => setPassword(e.target.value)}
                  required
                  placeholder="••••••••"
                  className="w-full pl-3.5 pr-11 py-2.5 text-[14px] text-slate-900 bg-white border border-slate-200 rounded-xl
                             placeholder:text-slate-400 [&::-ms-reveal]:hidden
                             focus:outline-none focus:ring-2 focus:ring-navy-700/25 focus:border-navy-600
                             transition-all"
                />
                <button
                  type="button"
                  onClick={() => setShowPw(v => !v)}
                  onMouseDown={e => e.preventDefault()}
                  aria-label={showPw ? 'Hide password' : 'Show password'}
                  className="absolute right-1.5 top-1/2 -translate-y-1/2 p-2 rounded-lg text-slate-500 hover:text-slate-700
                             focus:outline-none focus-visible:ring-2 focus-visible:ring-navy-600 transition-colors"
                >
                  {showPw ? <EyeOff size={16} /> : <Eye size={16} />}
                </button>
              </div>
            </div>

            {err && (
              <div className="bg-red-50 text-red-700 text-[13px] rounded-xl px-4 py-3 border border-red-100">
                {err}
              </div>
            )}

            <button
              type="submit"
              disabled={busy}
              className="w-full py-2.5 bg-navy-500 hover:bg-navy-600 text-navy-950 font-semibold text-[14px]
                         rounded-xl transition-all duration-150 active:scale-[0.98]
                         disabled:opacity-60 disabled:cursor-not-allowed mt-1 shadow-sm"
            >
              {busy ? 'Signing in…' : 'Sign in'}
            </button>
          </form>

          <p className="text-slate-400 text-[12px] text-center mt-6">
            Accounts are created by the administrator.
          </p>
        </div>
      </div>
    </div>
  )
}
