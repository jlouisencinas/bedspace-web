import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom'
import { isMissingConfig } from './lib/supabase'
import { AuthProvider, useAuth } from './lib/auth'
import BrandIcon      from './components/BrandIcon'
import { AlertTriangle } from 'lucide-react'
import Sidebar        from './components/Sidebar'
import Login          from './pages/Login'
import Dashboard      from './pages/Dashboard'
import BedMap         from './pages/BedMap'
import Tenants        from './pages/Tenants'
import EditTenantProfile from './pages/EditTenantProfile'
import Collections    from './pages/Collections'
import Utilities      from './pages/Utilities'
import Billing        from './pages/Billing'
import Reports        from './pages/Reports'
import PrintRentWater    from './pages/PrintRentWater'
import PrintElectricity  from './pages/PrintElectricity'
import Activity       from './pages/Activity'
import Approvals      from './pages/Approvals'
import Users          from './pages/Users'
import NotificationSettings from './pages/NotificationSettings'
import Maintenance    from './pages/Maintenance'
import Property      from './pages/Property'
import PaymentMonitoring from './pages/PaymentMonitoring'
import OccupancySimulator from './pages/OccupancySimulator'

function SetupScreen() {
  return (
    <div className="flex items-center justify-center min-h-screen bg-surface-2 p-6">
      <div className="bg-surface rounded-2xl p-8 max-w-md w-full shadow-modal border-t-4 border-navy-700">
        <BrandIcon size={36} className="text-navy-500 mb-3" />
        <h2 className="text-xl font-bold text-ink mb-1">Bedspace Manager</h2>
        <p className="text-danger-text font-semibold text-sm mb-5 flex items-center gap-1.5"><AlertTriangle size={14} className="shrink-0" /> Supabase credentials not configured</p>
        <ol className="text-ink-secondary text-sm leading-8 list-decimal pl-5">
          <li>Set <code className="bg-surface-3 px-1.5 py-0.5 rounded text-xs">VITE_SUPABASE_URL</code> and <code className="bg-surface-3 px-1.5 py-0.5 rounded text-xs">VITE_SUPABASE_ANON_KEY</code></li>
          <li>Locally: in <code className="bg-surface-3 px-1.5 py-0.5 rounded text-xs">.env</code>. On Vercel: Project → Settings → Environment Variables, then redeploy.</li>
        </ol>
      </div>
    </div>
  )
}

function Layout() {
  const { isAdmin, isUser } = useAuth()

  return (
    <div className="app-shell">
      <Sidebar />
      {/* Offset for mobile top bar */}
      <main className="main-content pt-0 lg:pt-0">
        <div className="pt-13 lg:pt-0">
          <Routes>
            {/* All roles */}
            <Route path="/"        element={<Dashboard />} />
            <Route path="/reports" element={<Reports />}   />
            <Route path="/beds"    element={<BedMap />}    />

            {/* user + admin */}
            {(isAdmin || isUser) && <>
              <Route path="/tenants"     element={<Tenants />}     />
              <Route path="/edit-tenant" element={<EditTenantProfile />} />
              <Route path="/collections" element={<Collections />} />
              <Route path="/payment-monitoring" element={<PaymentMonitoring />} />
              <Route path="/maintenance" element={<Maintenance />} />
              <Route path="/utilities"   element={<Utilities />}   />
              <Route path="/billing"     element={<Billing />}     />
              <Route path="/activity"    element={<Activity />}    />
              <Route path="/property"   element={<Property />}    />
              <Route path="/occupancy-simulator" element={<OccupancySimulator />} />
            </>}

            {/* admin only */}
            {isAdmin && <>
              <Route path="/print/rent-water"  element={<PrintRentWater />}   />
              <Route path="/print/electricity" element={<PrintElectricity />} />
              <Route path="/approvals"         element={<Approvals />}        />
              <Route path="/users"             element={<Users />}            />
              <Route path="/notification-settings" element={<NotificationSettings />} />
            </>}

            <Route path="*" element={<Navigate to="/" replace />} />
          </Routes>
        </div>
      </main>
    </div>
  )
}

function Gate() {
  const { session, loading } = useAuth()
  if (isMissingConfig) return <SetupScreen />
  if (loading) return (
    <div className="loading-screen">
      <div className="spinner" />
      <span className="text-navy-500 font-semibold text-sm">Loading…</span>
    </div>
  )
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
