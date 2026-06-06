import { BrowserRouter, Routes, Route, NavLink } from 'react-router-dom'
import { isMissingConfig } from './lib/supabase'
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
          <li>Go to <a href="https://supabase.com" target="_blank" rel="noreferrer" style={{ color:'#2563EB' }}>supabase.com</a> and create a free project</li>
          <li>Copy <code style={{ background:'#F1F5F9', padding:'1px 6px', borderRadius:4 }}>.env.example</code> to <code style={{ background:'#F1F5F9', padding:'1px 6px', borderRadius:4 }}>.env</code></li>
          <li>Paste your <strong>Project URL</strong> and <strong>anon key</strong> from<br />Supabase → Project Settings → API</li>
          <li>Run <code style={{ background:'#F1F5F9', padding:'1px 6px', borderRadius:4 }}>database/schema.sql</code> in Supabase SQL Editor</li>
          <li>Restart the dev server: <code style={{ background:'#F1F5F9', padding:'1px 6px', borderRadius:4 }}>npm run dev</code></li>
        </ol>
      </div>
    </div>
  )
}

function Layout() {
  return (
    <div className="app-shell">
      <header className="topbar">
        <div className="topbar-brand"><span>🏠</span>Bedspace Manager</div>
        <nav className="topbar-nav">
          {[
            { to: '/',          label: 'Dashboard'    },
            { to: '/beds',      label: 'Bed Map'      },
            { to: '/tenants',   label: 'Tenants'      },
            { to: '/utilities', label: 'Utilities'    },
            { to: '/billing',   label: 'Billing'      },
            { to: '/reports',   label: 'Reports'      },
            { to: '/activity',  label: 'Activity Log' },
          ].map(({ to, label }) => (
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
      </header>

      <Routes>
        <Route path="/"          element={<Dashboard />} />
        <Route path="/beds"      element={<BedMap />}    />
        <Route path="/tenants"   element={<Tenants />}   />
        <Route path="/utilities" element={<Utilities />} />
        <Route path="/billing"   element={<Billing />}   />
        <Route path="/reports"   element={<Reports />}   />
        <Route path="/print/rent-water" element={<PrintRentWater />} />
        <Route path="/print/electricity" element={<PrintElectricity />} />
        <Route path="/activity"  element={<Activity />}  />
      </Routes>
    </div>
  )
}

export default function App() {
  if (isMissingConfig) return <SetupScreen />
  return (
    <BrowserRouter>
      <Layout />
    </BrowserRouter>
  )
}
