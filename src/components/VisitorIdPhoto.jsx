import { useEffect, useState } from 'react'
import { Loader2, ImageOff, X, RefreshCw } from 'lucide-react'
import { signedPhotoUrl } from '../lib/idPhoto'
import { fmtDateYear } from '../lib/visitors'

// Only admins can read the visitor-ids bucket; everyone else gets the status text.
export default function VisitorIdPhoto({ path, purgedAt, isAdmin, className = 'h-40' }) {
  const [url, setUrl] = useState(null)
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)
  const [big, setBig] = useState(false)
  const [attempt, setAttempt] = useState(0)

  useEffect(() => {
    if (!isAdmin || purgedAt || !path) return
    let cancelled = false
    setLoading(true); setError(''); setUrl(null)
    signedPhotoUrl(path)
      .then(u => { if (!cancelled) setUrl(u) })
      .catch(e => { if (!cancelled) setError(e.message) })
      .finally(() => { if (!cancelled) setLoading(false) })
    return () => { cancelled = true }
  }, [path, purgedAt, isAdmin, attempt])

  if (purgedAt) {
    return <div className="text-[13px] text-ink-muted">Photo deleted {fmtDateYear(purgedAt)} (90-day retention)</div>
  }
  if (!isAdmin) {
    return <div className="text-[13px] text-ink-muted">Photo on file — visible to admin only</div>
  }
  if (loading) {
    return <div className={`${className} w-full max-w-xs rounded-lg bg-surface-3 flex items-center justify-center text-ink-faint`}><Loader2 size={20} className="animate-spin" /></div>
  }
  if (error || !url) {
    return (
      <div className="flex items-center gap-2 text-[13px] text-danger-text">
        <ImageOff size={16} className="shrink-0" />
        <span className="flex-1">Could not load the ID photo{error ? `: ${error}` : ''}</span>
        <button type="button" className="btn-xs gray" onClick={() => setAttempt(a => a + 1)}><RefreshCw size={12} /> Retry</button>
      </div>
    )
  }
  return (
    <>
      <button type="button" onClick={() => setBig(true)} className="block focus:outline-none focus-visible:ring-2 focus-visible:ring-navy-500 rounded-lg" title="Tap to enlarge">
        <img src={url} alt="Visitor ID" onError={() => setError('the link expired, retry')}
          className={`${className} w-auto max-w-full rounded-lg border border-line object-contain bg-surface-3`} />
      </button>
      {big && (
        <div className="fixed inset-0 z-[60] flex items-center justify-center p-4" style={{ background: 'var(--overlay)' }} onClick={() => setBig(false)}
          role="dialog" aria-modal="true" aria-label="Visitor ID photo">
          <img src={url} alt="Visitor ID, enlarged" className="max-w-full max-h-full rounded-lg shadow-modal object-contain" />
          <button type="button" onClick={() => setBig(false)} aria-label="Close"
            className="absolute top-4 right-4 w-12 h-12 rounded-full bg-surface text-ink flex items-center justify-center shadow-modal"
            style={{ marginTop: 'env(safe-area-inset-top)' }}>
            <X size={20} />
          </button>
        </div>
      )}
    </>
  )
}
