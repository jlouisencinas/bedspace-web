import { useCallback, useEffect, useRef, useState } from 'react'
import { Navigate, useSearchParams } from 'react-router-dom'
import { useAuth } from '../lib/auth'
import { useToast } from '../components/Toast'
import { clearShift, useGuardShift } from '../lib/guardShift'
import { fetchGuardList, fetchInsideNowFull } from '../lib/visitors'
import { maybeAutoPurge } from '../lib/idPhoto'
import GuardShell, { GUARD_TABS, TABBAR_H } from '../components/GuardShell'
import GuardShiftPrompt from '../components/GuardShiftPrompt'
import VisitorCheckIn from '../components/VisitorCheckIn'
import VisitorInsideList from '../components/VisitorInsideList'
import VisitorTodayLog from '../components/VisitorTodayLog'
import VisitorHistory from '../components/VisitorHistory'

const POLL_MS = 60 * 1000

// Lists refresh every 60 s, when the tab becomes visible, and after every action. States always come
// from the server; the device clock is only used through the server offset.
function useVisitorPoll(fetcher) {
  const [rows, setRows] = useState([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [updatedAt, setUpdatedAt] = useState(null)
  const [offset, setOffset] = useState(0)
  const busy = useRef(false)
  const again = useRef(false)

  const refresh = useCallback(async () => {
    if (busy.current) { again.current = true; return }
    busy.current = true
    setLoading(true)
    try {
      do {
        again.current = false
        const data = await fetcher()
        const serverNow = data.find(r => r.server_now)?.server_now
        const off = serverNow ? Date.parse(serverNow) - Date.now() : null
        if (off !== null) setOffset(off)
        setRows(data)
        setError('')
        setUpdatedAt(Date.now() + (off ?? 0))
      } while (again.current)
    } catch (e) {
      setError(`Could not load visitors: ${e.message}`)
    } finally {
      busy.current = false
      setLoading(false)
    }
  }, [fetcher])

  useEffect(() => {
    refresh()
    const timer = setInterval(refresh, POLL_MS)
    const onVisible = () => { if (document.visibilityState === 'visible') refresh() }
    document.addEventListener('visibilitychange', onVisible)
    return () => { clearInterval(timer); document.removeEventListener('visibilitychange', onVisible) }
  }, [refresh])

  const noteServerTime = useCallback(iso => {
    const t = Date.parse(iso)
    if (Number.isFinite(t)) setOffset(t - Date.now())
  }, [])

  return { rows, loading, error, updatedAt, offset, refresh, noteServerTime }
}

function useServerClock(offset) {
  const [t, setT] = useState(Date.now())
  useEffect(() => {
    const timer = setInterval(() => setT(Date.now()), 15 * 1000)
    return () => clearInterval(timer)
  }, [])
  return t + offset
}

function GuardVisitorLog() {
  const { user, signInAt, signOut } = useAuth()
  const shift = useGuardShift(user?.id, signInAt)
  const [params, setParams] = useSearchParams()
  const raw = params.get('tab')
  const tab = GUARD_TABS.some(t => t.id === raw) ? raw : 'checkin'
  const setTab = t => setParams(t === 'checkin' ? {} : { tab: t }, { replace: true })
  const { show, ToastEl } = useToast()
  const poll = useVisitorPoll(fetchGuardList)
  const nowMs = useServerClock(poll.offset)

  if (!shift) return <GuardShiftPrompt />

  const inside = poll.rows.filter(r => !r.check_out_at)
  const red = inside.filter(r => r.state === 'RED').length

  return (
    <GuardShell dutyName={shift.name} nowMs={nowMs} tab={tab} onTab={setTab} insideCount={inside.length} redCount={red}
      onEndShift={() => clearShift(user?.id)} onSignOut={signOut}>
      <div className={tab === 'checkin' ? '' : 'hidden'}>
        <VisitorCheckIn layout="guard" guardName={shift.name} recordedBy={shift.name} nowMs={nowMs} show={show}
          onCheckedIn={r => { poll.noteServerTime(r.check_in_at); poll.refresh() }} />
      </div>
      {tab === 'inside' && (
        <VisitorInsideList rows={inside} masked guardName={shift.name} nowMs={nowMs} show={show} onChanged={poll.refresh}
          updatedAt={poll.updatedAt} onRefresh={poll.refresh} loading={poll.loading} error={poll.error} />
      )}
      {tab === 'today' && <VisitorTodayLog rows={poll.rows} nowMs={nowMs} loading={poll.loading} error={poll.error} />}
      {/* The toast stack is position:fixed; a transformed wrapper re-anchors it above the tab bar and Check in button. */}
      <div className="fixed inset-x-0 h-0 z-[9999] pointer-events-none" style={{ bottom: `calc(${TABBAR_H} + 60px)`, transform: 'translateZ(0)' }}>
        {ToastEl}
      </div>
    </GuardShell>
  )
}

function StaffVisitorLog() {
  const { isAdmin, user } = useAuth()
  const [tab, setTab] = useState('desk')
  const [deskTab, setDeskTab] = useState('checkin')
  const { show, ToastEl } = useToast()
  const poll = useVisitorPoll(fetchInsideNowFull)
  const nowMs = useServerClock(poll.offset)

  useEffect(() => {
    if (!isAdmin) return
    maybeAutoPurge()
      .then(r => {
        if (r && (r.expired || r.orphans)) show(`ID photo retention: removed ${r.expired} expired photo${r.expired === 1 ? '' : 's'} and ${r.orphans} unused upload${r.orphans === 1 ? '' : 's'}.`, 'success', { duration: 6000 })
      })
      .catch(e => show(`Automatic ID photo purge failed: ${e.message}`, 'error', { duration: 8000 }))
  }, [isAdmin])

  const seg = (value, current, set, label) => (
    <button key={value} type="button" onClick={() => set(value)} aria-pressed={current === value}
      className={`px-4 min-h-[40px] rounded-md text-[13px] font-semibold transition-all ${current === value ? 'bg-surface text-ink shadow-sm' : 'text-ink-muted hover:text-ink-secondary'}`}>
      {label}
    </button>
  )

  return (
    <div className="page">
      {ToastEl}
      <div className="page-header flex-wrap">
        <div>
          <h1 className="page-title">Visitor Log</h1>
          <p className="page-sub">Check-in / check-out with ID photo, overnight requests and history</p>
        </div>
        <div className="flex gap-1.5 p-1 bg-surface-3 rounded-lg">
          {seg('desk', tab, setTab, 'Front desk')}
          {seg('history', tab, setTab, 'History')}
        </div>
      </div>

      {tab === 'desk' ? (
        <>
          <div className="lg:hidden flex gap-1.5 p-1 bg-surface-3 rounded-lg mb-4 w-fit">
            {seg('checkin', deskTab, setDeskTab, 'Check in')}
            {seg('inside', deskTab, setDeskTab, `Inside (${poll.rows.length})`)}
          </div>
          <div className="grid grid-cols-1 lg:grid-cols-[minmax(0,28rem)_minmax(0,1fr)] gap-6 items-start">
            <div className={`${deskTab === 'checkin' ? '' : 'hidden'} lg:block lg:sticky lg:top-4 lg:max-h-[calc(100vh-2rem)] lg:overflow-y-auto lg:pr-1 w-full max-w-md`}>
              <VisitorCheckIn layout="staff" recordedBy={user?.email || 'you'} nowMs={nowMs} show={show}
                onCheckedIn={r => { poll.noteServerTime(r.check_in_at); poll.refresh() }} />
            </div>
            <div className={`${deskTab === 'inside' ? '' : 'hidden'} lg:block min-w-0`}>
              <VisitorInsideList rows={poll.rows} masked={false} nowMs={nowMs} show={show} onChanged={poll.refresh}
                updatedAt={poll.updatedAt} onRefresh={poll.refresh} loading={poll.loading} error={poll.error} />
            </div>
          </div>
        </>
      ) : (
        <VisitorHistory isAdmin={isAdmin} nowMs={nowMs} show={show} onChanged={poll.refresh} />
      )}
    </div>
  )
}

export default function VisitorLog() {
  const { isGuard, isAdmin, isUser } = useAuth()
  if (isGuard) return <GuardVisitorLog />
  if (!isAdmin && !isUser) return <Navigate to="/" replace />
  return <StaffVisitorLog />
}
