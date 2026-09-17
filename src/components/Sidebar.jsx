import { useState } from 'react'
import { NavLink } from 'react-router-dom'
import { useAuth } from '../lib/auth'
import { useTheme } from '../lib/theme'
import {
  LayoutDashboard, LayoutGrid, Users, Wrench, Zap,
  CreditCard, BarChart2, History, CheckSquare, UserCog,
  Menu, X, LogOut, Wallet, Building2, TrendingUp, UserPen,
  Sun, Moon,
} from 'lucide-react'
import BrandIcon from './BrandIcon'

const ALL_NAV = [
  { to: '/',            label: 'Dashboard',   icon: LayoutDashboard, end: true },
  { to: '/beds',        label: 'Bed Map',      icon: LayoutGrid },
  { to: '/tenants',     label: 'Tenants',      icon: Users,          roles: ['admin','user'] },
  { to: '/edit-tenant', label: 'Edit Tenant Profile', icon: UserPen, roles: ['admin','user'] },
  { to: '/collections', label: 'Collections',  icon: Wallet,         roles: ['admin','user'] },
  { to: '/payment-monitoring', label: 'Payment Monitoring', icon: TrendingUp, roles: ['admin','user'] },
  { to: '/maintenance', label: 'Maintenance',  icon: Wrench,         roles: ['admin','user'] },
  { to: '/utilities',   label: 'Utilities',    icon: Zap,            roles: ['admin','user'] },
  { to: '/billing',     label: 'Billing',      icon: CreditCard,     roles: ['admin','user'] },
  { to: '/reports',     label: 'Reports',      icon: BarChart2 },
  { to: '/activity',    label: 'Activity',     icon: History,        roles: ['admin','user'] },
  { to: '/property',   label: 'Property',     icon: Building2,      roles: ['admin','user'] },
  { to: '/approvals',   label: 'Approvals',    icon: CheckSquare,    roles: ['admin'] },
  { to: '/users',       label: 'Users',        icon: UserCog,        roles: ['admin'] },
]

function NavItem({ to, label, Icon, end }) {
  return (
    <NavLink
      to={to}
      end={end}
      className={({ isActive }) =>
        `flex items-center gap-3 px-3 py-2 rounded-lg text-[13px] font-medium transition-all duration-100 group ${
          isActive
            ? 'bg-navy-500/15 text-ink font-semibold'
            : 'text-ink-muted hover:bg-navy-500/8 hover:text-ink-secondary'
        }`
      }
    >
      {({ isActive }) => (
        <>
          <Icon
            size={16}
            className={`shrink-0 transition-colors ${isActive ? 'text-navy-500' : 'text-ink-faint group-hover:text-ink-muted'}`}
          />
          <span>{label}</span>
        </>
      )}
    </NavLink>
  )
}

function AvatarInitials({ email }) {
  const initials = (email || '?').slice(0, 2).toUpperCase()
  return (
    <div className="w-7 h-7 rounded-full bg-navy-100 text-navy-700 flex items-center justify-center text-[11px] font-bold shrink-0">
      {initials}
    </div>
  )
}

function ThemeToggle({ className = '' }) {
  const { isDark, toggleTheme } = useTheme()
  return (
    <button
      onClick={toggleTheme}
      title={isDark ? 'Switch to light mode' : 'Switch to dark mode'}
      className={`p-1.5 rounded-lg hover:bg-surface-3 text-ink-faint hover:text-ink-secondary transition-colors ${className}`}
    >
      {isDark ? <Sun size={16} /> : <Moon size={16} />}
    </button>
  )
}

function SidebarContent({ role, user, signOut, navItems, onClose }) {
  const roleLabel = role === 'admin' ? 'Admin' : role === 'user' ? 'User' : 'Viewer'
  const roleColor = role === 'admin'
    ? 'bg-navy-100 text-navy-700'
    : role === 'user'
      ? 'bg-info-bg text-info-text'
      : 'bg-surface-3 text-ink-muted'

  return (
    <div className="flex flex-col h-full">
      {/* Brand */}
      <div className="flex items-center justify-between px-4 py-4" style={{ borderBottom: '1px solid var(--border)' }}>
        <div className="flex items-center gap-2.5">
          <BrandIcon size={28} className="text-navy-500 shrink-0" />
          <span className="text-[14px] font-bold text-ink tracking-tight">Bedspace</span>
        </div>
        <div className="flex items-center gap-1">
          <ThemeToggle />
          {onClose && (
            <button onClick={onClose} className="p-1 rounded-lg hover:bg-surface-3 text-ink-faint">
              <X size={18} />
            </button>
          )}
        </div>
      </div>

      {/* Navigation */}
      <nav className="flex-1 overflow-y-auto px-3 py-3 space-y-0.5">
        {navItems.map(({ to, label, icon: Icon, end }) => (
          <NavItem key={to} to={to} label={label} Icon={Icon} end={end} />
        ))}
      </nav>

      {/* User footer */}
      <div className="px-4 py-3" style={{ borderTop: '1px solid var(--border)' }}>
        <div className="flex items-center gap-2.5 mb-2.5">
          <AvatarInitials email={user?.email} />
          <div className="flex-1 min-w-0">
            <div className="text-[12px] font-medium text-ink-secondary truncate">{user?.email}</div>
            <span className={`inline-block mt-0.5 text-[10px] font-bold uppercase tracking-wider px-1.5 py-0.5 rounded ${roleColor}`}>
              {roleLabel}
            </span>
          </div>
        </div>
        <button
          onClick={signOut}
          className="flex items-center gap-2 w-full px-2.5 py-1.5 rounded-lg text-[12px] font-medium text-ink-faint hover:bg-navy-500/10 hover:text-ink-secondary transition-colors"
        >
          <LogOut size={13} className="text-ink-faint" />
          Sign out
        </button>
      </div>
    </div>
  )
}

export default function Sidebar() {
  const { isAdmin, isUser, role, user, signOut } = useAuth()
  const [mobileOpen, setMobileOpen] = useState(false)

  const navItems = ALL_NAV.filter(item => {
    if (!item.roles) return true
    if (isAdmin) return true
    if (isUser && item.roles.includes('user')) return true
    return false
  })

  const props = { role, user, signOut, navItems }

  return (
    <>
      {/* ── Mobile top bar ── */}
      <div className="sidebar-mobile-bar lg:hidden fixed top-0 left-0 right-0 h-13 bg-surface z-30 flex items-center px-4 gap-3 shadow-sm" style={{ borderBottom: '1px solid var(--border)' }}>
        <button
          onClick={() => setMobileOpen(true)}
          className="p-1.5 rounded-lg hover:bg-surface-2 text-ink-muted"
        >
          <Menu size={20} />
        </button>
        <div className="flex items-center gap-2 flex-1">
          <BrandIcon size={24} className="text-navy-500 shrink-0" />
          <span className="text-[14px] font-bold text-ink">Bedspace</span>
        </div>
        <ThemeToggle />
      </div>

      {/* ── Mobile overlay ── */}
      {mobileOpen && (
        <div className="lg:hidden fixed inset-0 z-50 flex animate-fade-in">
          <div className="w-[240px] h-full shadow-modal flex flex-col animate-slide-in-left" style={{ background: 'var(--surface-2)' }}>
            <SidebarContent {...props} onClose={() => setMobileOpen(false)} />
          </div>
          <div
            className="flex-1"
            style={{ background: 'var(--overlay)' }}
            onClick={() => setMobileOpen(false)}
          />
        </div>
      )}

      {/* ── Desktop sidebar ── */}
      <div className="sidebar-desktop hidden lg:flex w-[240px] shrink-0 flex-col h-screen sticky top-0 z-20" style={{ background: 'var(--surface-2)', borderRight: '1px solid var(--border)' }}>
        <SidebarContent {...props} />
      </div>
    </>
  )
}
