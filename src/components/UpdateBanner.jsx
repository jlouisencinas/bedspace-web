import { useEffect, useState } from 'react'
import { RefreshCw } from 'lucide-react'
import { checkNow, isAppStale, subscribeStale } from '../lib/appVersionCheck'

const POLL_MS = 5 * 60 * 1000

export default function UpdateBanner() {
  const [stale, setStale] = useState(isAppStale())

  useEffect(() => {
    const unsubscribe = subscribeStale(setStale)
    const check = () => { if (document.visibilityState !== 'hidden') checkNow() }
    check()
    const timer = setInterval(check, POLL_MS)
    document.addEventListener('visibilitychange', check)
    window.addEventListener('focus', check)
    return () => {
      unsubscribe()
      clearInterval(timer)
      document.removeEventListener('visibilitychange', check)
      window.removeEventListener('focus', check)
    }
  }, [])

  if (!stale) return null
  return (
    <div role="alert" className="sticky top-0 z-40 print:hidden flex flex-wrap items-center gap-3 px-4 py-2.5 border-b border-warning-border bg-warning-bg text-warning-text text-sm">
      <span className="flex-1 min-w-0">A new version of the app is available. Reload to avoid saving with old rules.</span>
      <button type="button" className="btn primary inline-flex items-center gap-1.5" onClick={() => window.location.reload()}>
        <RefreshCw size={14} /> Reload
      </button>
    </div>
  )
}
