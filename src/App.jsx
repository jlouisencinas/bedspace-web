import { BrowserRouter, Routes, Route, NavLink, Navigate } from 'react-router-dom'
import { isMissingConfig } from './lib/supabase'
import { AuthProvider, useAuth } from './lib/auth'
import Login      from './pages/Login'
import Dashboard  from './pages/Dashboard'
import BedMap     from './pages/BedMap'
import Tenants    from './pages/Tenants'
import Utilities  from './pages/Utilities'
import Billing    from './pages/Billing'
import Reports    from './pages/Reports'
import PrintRentWater from './pages/PrintRentWater'
import PrintElectricity from './pages/PrintElectricity'
import Activity   from './pages/Activity'

// Shown when .env credentials are missing
function SetupScreen() {
  return (
    <div style={{
      display:'flex', alignItems:'center', justifyContent:'center',
      minHeight:'100vh', background:'#F0F4F8', padding:24
    }}>
      <div style={{
        background:'#fff', borderRadius:12, padding:32,
        maxWidth:480, width:'100%', boxShadow:'0 4px 24px rgba(0,0,0,.1)',
        borderTop:'4px solid #1B3A8C'
      }}>
        <div style={{ fontSize:32, marginBottom:12 }}>🏠</div>
        <h2 style={{ fontSize:20, fontWeight:800, color:'#0F172A', marginBottom:8 }}>
          Bedspace Manager
        </h2>
        <p style={{ color:'#DC2626', fontWeight:600, marginBottom:20, fontSize:14 }}>
          ⚠️ Supabase credentials not configured
        </p>
        <ol style={{ color:'#334155', fontSize:13, lineHeight:2, paddingLeft:20 }}>
          <li>Set <code style={{ background:'#F1F5F9', padding:'1px 6px', borderRadius:4 }}>VITE_SUPABASE_URL</code> and <code style={{ background:'#F1F5F9', padding:'1px 6px', borderRadius:4 }}>VITE_SUPABASE_ANON_KEY</code></li>
          <li>Locally: in <code style={{ background:'#F1F5F9', padding:'1px 6px', borderRadius:4 }}>.env</code>. On Vercel: Project → Settings → Environment Variables, then redeploy.</li>
        </ol>
      </div>
    </div>
  )
}

const ALL_TABS = [
  { to: '/',          label: 'Dashboard'    },
  { to: '/beds',      label: 'Bed Map'      },
  { to: '/tenants',   label: 'Tenants'      },
  { to: '/utilities', label: 'Utilities'    },
  { to: '/billing',   label: 'Billing'      },
  { to: '/reports',   label: 'Reports'      },
  { to: '/activity',  label: 'Activity Log' },
]
const OWNER_TABS = [
  { to: '/',          label: 'Dashboard' },
  { to: '/reports',   label: 'Reports'   },
]

function Layout() {
  const { isAdmin, user, signOut } = useAuth()
  const tabs = isAdmin ? ALL_TABS : OWNER_TABS

  return (
    <div className="app-shell">
      <header className="topbar">
        <div className="topbar-brand"><span>🏠</span>Bedspace Manager</div>
        <nav className="topbar-nav">
          {tabs.map(({ to, label }) => (
            <NavLink
              key={to}
              to={to}
              end={to === '/'}
              className={({ isActive }) => 'nav-link' + (isActive ? ' active' : '')}
            >
              {label}
            </NavLink>
          ))}
        </nav>
        <div className="topbar-user">
          <span className={'role-badge ' + (isAdmin ? 'admin' : 'owner')}>{isAdmin ? 'Admin' : 'Owner'}</span>
          <span className="topbar-email" title={user?.email}>{user?.email}</span>
          <button className="btn-signout" onClick={signOut}>Sign out</button>
        </div>
      </header>

      <Routes>
        <Route path="/"         element={<Dashboard />} />
        <Route path="/reports"  element={<Reports />}   />
        {isAdmin && <>
          <Route path="/beds"      element={<BedMap />}    />
          <Route path="/tenants"   element={<Tenants />}   />
          <Route path="/utilities" element={<Utilities />} />
          <Route path="/billing"   element={<Billing />}   />
          <Route path="/print/rent-water"  element={<PrintRentWater />} />
          <Route path="/print/electricity" element={<PrintElectricity />} />
          <Route path="/activity"  element={<Activity />}  />
        </>}
        {/* Anything an owner isn't allowed to reach falls back to Dashboard */}
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </div>
  )
}

function Gate() {
  const { session, loading } = useAuth()
  if (isMissingConfig) return <SetupScreen />
  if (loading) return <div className="loading-screen"><div className="spinner" /></div>
  if (!session) return <Login />
  return (
    <BrowserRouter>
      <Layout />
    </BrowserRouter>
  )
}

export default function App() {
  return (
    <AuthProvider>
      <Gate />
    </AuthProvider>
  )
}
