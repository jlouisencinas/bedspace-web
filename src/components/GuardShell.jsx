import { useState } from 'react'
import { AlertTriangle, LogIn, Users, ListChecks, Menu, LogOut, UserCheck, Sun, Moon, X } from 'lucide-react'
import { useTheme } from '../lib/theme'
import { fmtTime } from '../lib/visitors'

export const GUARD_TABS = [
  { id: 'checkin', label: 'Check in', icon: LogIn },
  { id: 'inside',  label: 'Inside',   icon: Users },
  { id: 'today',   label: 'Today',    icon: ListChecks },
]

// Bottom tab bar height (64px) + safe area; content and the sticky Check in button sit above it.
export const TABBAR_H = 'calc(64px + env(safe-area-inset-bottom))'

export function BottomSheet({ title, onClose, children, footer }) {
  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center animate-fade-in" style={{ background: 'var(--overlay)' }}
      onClick={onClose} role="dialog" aria-modal="true" aria-label={title}>
      <div className="w-full max-w-xl bg-surface rounded-t-2xl shadow-modal border-t border-line animate-slide-up max-h-[90vh] flex flex-col"
        onClick={e => e.stopPropagation()} style={{ paddingBottom: 'env(safe-area-inset-bottom)' }}>
        <div className="flex items-start justify-between gap-3 px-4 pt-4 pb-2">
          <h2 className="text-[16px] font-semibold text-ink">{title}</h2>
          <button type="button" onClick={onClose} aria-label="Close"
            className="w-12 h-12 -mr-2 -mt-2 flex items-center justify-center rounded-lg text-ink-faint hover:text-ink focus:outline-none focus-visible:ring-2 focus-visible:ring-navy-500">
            <X size={18} />
          </button>
        </div>
        <div className="px-4 pb-2 overflow-y-auto">{children}</div>
        {footer && <div className="px-4 pt-2 pb-4 flex gap-3">{footer}</div>}
      </div>
    </div>
  )
}

export default function GuardShell({ dutyName, nowMs, tab, onTab, insideCount, redCount, onEndShift, onSignOut, children }) {
  const [menuOpen, setMenuOpen] = useState(false)
  const { isDark, toggleTheme } = useTheme()

  return (
    <div className="min-h-full bg-canvas">
      <header className="sticky top-0 z-30 bg-surface border-b border-line" style={{ paddingTop: 'env(safe-area-inset-top)' }}>
        <div className="max-w-xl mx-auto h-14 px-4 flex items-center gap-3">
          <div className="flex-1 min-w-0">
            <div className="text-[16px] font-semibold text-ink leading-tight">Visitor Log</div>
            <div className="text-[13px] text-ink-muted truncate">On duty: {dutyName}</div>
          </div>
          <div className="text-[15px] font-semibold tabular-nums text-ink" aria-label="Server time (Manila)">{fmtTime(nowMs)}</div>
          <button type="button" onClick={() => setMenuOpen(true)} aria-label="Menu"
            className="w-12 h-12 -mr-2 flex items-center justify-center rounded-lg text-ink-muted hover:bg-surface-2 focus:outline-none focus-visible:ring-2 focus-visible:ring-navy-500">
            <Menu size={22} />
          </button>
        </div>
        {redCount > 0 && (
          <button type="button" onClick={() => onTab('inside')}
            className="w-full bg-danger-bg text-danger-text border-t border-danger-border focus:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-navy-500">
            <div className="max-w-xl mx-auto px-4 min-h-[48px] flex items-center gap-2 text-[14px] font-semibold text-left">
              <AlertTriangle size={18} className="shrink-0" />
              {redCount} must leave: overnight not approved
            </div>
          </button>
        )}
      </header>

      <main className="max-w-xl mx-auto px-3 pt-3" style={{ paddingBottom: `calc(${TABBAR_H} + 84px)` }}>
        {children}
      </main>

      <nav className="fixed bottom-0 inset-x-0 z-30 bg-surface border-t border-line" style={{ paddingBottom: 'env(safe-area-inset-bottom)' }}
        aria-label="Visitor Log sections">
        <div className="max-w-xl mx-auto h-16 grid grid-cols-3">
          {GUARD_TABS.map(({ id, label, icon: Icon }) => {
            const active = tab === id
            return (
              <button key={id} type="button" onClick={() => onTab(id)} aria-current={active ? 'page' : undefined}
                className={`relative flex flex-col items-center justify-center gap-0.5 min-h-[48px] text-[13px] font-medium focus:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-navy-500
                  ${active ? 'text-ink' : 'text-ink-muted'}`}>
                {active && <span className="absolute top-0 inset-x-6 h-[3px] rounded-b bg-navy-500" />}
                <span className="relative">
                  <Icon size={22} />
                  {id === 'inside' && redCount > 0 && (
                    <span className="absolute -top-0.5 -right-1 w-2.5 h-2.5 rounded-full bg-danger-text ring-2 ring-surface" aria-label="Visitors must leave" />
                  )}
                </span>
                <span>{id === 'inside' ? `${label} (${insideCount})` : label}</span>
              </button>
            )
          })}
        </div>
      </nav>

      {menuOpen && (
        <BottomSheet title="Menu" onClose={() => setMenuOpen(false)}>
          <div className="space-y-2 pb-3">
            <button type="button" onClick={() => { setMenuOpen(false); onEndShift() }}
              className="w-full min-h-[52px] px-4 flex items-center gap-3 rounded-xl border border-line bg-surface text-[15px] text-ink hover:bg-surface-2 focus:outline-none focus-visible:ring-2 focus-visible:ring-navy-500">
              <UserCheck size={18} className="text-ink-muted" /> End shift (change who is on duty)
            </button>
            <button type="button" onClick={() => { setMenuOpen(false); onSignOut() }}
              className="w-full min-h-[52px] px-4 flex items-center gap-3 rounded-xl border border-line bg-surface text-[15px] text-ink hover:bg-surface-2 focus:outline-none focus-visible:ring-2 focus-visible:ring-navy-500">
              <LogOut size={18} className="text-ink-muted" /> Sign out
            </button>
            <button type="button" onClick={toggleTheme}
              className="w-full min-h-[52px] px-4 flex items-center gap-3 rounded-xl border border-line bg-surface text-[15px] text-ink hover:bg-surface-2 focus:outline-none focus-visible:ring-2 focus-visible:ring-navy-500">
              {isDark ? <Sun size={18} className="text-ink-muted" /> : <Moon size={18} className="text-ink-muted" />}
              {isDark ? 'Light mode' : 'Dark mode'}
            </button>
          </div>
        </BottomSheet>
      )}
    </div>
  )
}
