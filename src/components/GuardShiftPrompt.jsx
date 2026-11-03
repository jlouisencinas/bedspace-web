import { useState } from 'react'
import { ShieldCheck, X, LogOut } from 'lucide-react'
import { useAuth } from '../lib/auth'
import { addRecentName, cleanDutyName, getRecentNames, removeRecentName, setShift, validDutyName } from '../lib/guardShift'

export default function GuardShiftPrompt() {
  const { user, signInAt, signOut } = useAuth()
  const [recent, setRecent] = useState(getRecentNames)
  const [picked, setPicked] = useState('')
  const [typed, setTyped] = useState('')
  const [error, setError] = useState('')

  const name = cleanDutyName(typed) || picked
  const canStart = validDutyName(name)

  function start(e) {
    e.preventDefault()
    setError('')
    try {
      setShift(user?.id, signInAt, name)
      addRecentName(name)
    } catch (err) {
      setError(err.message)
    }
  }

  function forget(n) {
    removeRecentName(n)
    setRecent(getRecentNames())
    if (picked === n) setPicked('')
  }

  return (
    <div className="min-h-full bg-surface-2 flex items-center justify-center p-4"
      style={{ paddingTop: 'max(16px, env(safe-area-inset-top))', paddingBottom: 'max(16px, env(safe-area-inset-bottom))' }}>
      <form onSubmit={start} className="guard-form w-full max-w-sm bg-surface border border-line rounded-2xl shadow-card p-5 space-y-4">
        <div className="flex items-center gap-3">
          <div className="w-11 h-11 rounded-full bg-success-bg text-success-text flex items-center justify-center shrink-0">
            <ShieldCheck size={22} />
          </div>
          <h1 className="text-[18px] font-bold text-ink">Who is on duty?</h1>
        </div>
        <p className="text-[14px] text-ink-secondary">
          This account is shared. Your name is saved with every check-in, check-out and overnight request.
        </p>

        {recent.length > 0 && (
          <div>
            <div className="text-[13px] font-semibold text-ink-muted mb-2">Recent</div>
            <div className="flex flex-wrap gap-2">
              {recent.map(n => {
                const active = !cleanDutyName(typed) && picked === n
                return (
                  <div key={n} className={`flex items-center rounded-full border min-h-[48px] max-w-full ${active ? 'border-navy-500 bg-navy-500/15' : 'border-line bg-surface'}`}>
                    <button type="button" onClick={() => { setPicked(n); setTyped('') }}
                      className="pl-4 pr-2 min-h-[48px] text-[15px] font-medium text-ink truncate focus:outline-none focus-visible:ring-2 focus-visible:ring-navy-500 rounded-l-full">
                      {n}
                    </button>
                    <button type="button" onClick={() => forget(n)} aria-label={`Remove ${n} from this device`}
                      className="w-12 min-h-[48px] flex items-center justify-center text-ink-faint hover:text-ink rounded-r-full focus:outline-none focus-visible:ring-2 focus-visible:ring-navy-500">
                      <X size={16} />
                    </button>
                  </div>
                )
              })}
            </div>
          </div>
        )}

        <div className="fg">
          <label htmlFor="duty-name">{recent.length ? 'Or type a new name' : 'Your name'}</label>
          <input id="duty-name" type="text" value={typed} maxLength={60} autoCapitalize="words" autoComplete="off"
            onChange={e => setTyped(e.target.value)} placeholder="e.g. Juan Dela Cruz"
            className="!text-[16px] !py-3" />
        </div>

        {error && <div className="p-3 rounded-xl bg-danger-bg text-danger-text border border-danger-border text-[14px]">{error}</div>}

        <button type="submit" disabled={!canStart} className="btn primary w-full !min-h-[52px] !text-[16px]">
          Start shift
        </button>
        <button type="button" onClick={signOut}
          className="w-full min-h-[48px] flex items-center justify-center gap-2 text-[14px] text-ink-muted hover:text-ink rounded-lg focus:outline-none focus-visible:ring-2 focus-visible:ring-navy-500">
          <LogOut size={15} /> Sign out
        </button>
      </form>
    </div>
  )
}
