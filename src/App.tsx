import { Navigate, Route, Routes } from 'react-router-dom'
import { useAuth } from './lib/auth'
import { Logo } from './components/ui'
import { Gate, Layout, navFor } from './components/Layout'
import { Login, PinScreen } from './pages/Login'
import { Floor } from './pages/Floor'
import { SessionPage } from './pages/Session'
import { InvoicePage, ShiftPage } from './pages/Billing'
import { Kitchen } from './pages/Kitchen'
import { CountDetail, CountSheet, CountsPage, DeliveryPage, PrepPage, ReorderPage, StockPage, SuppliersPage, WastePage } from './pages/Inventory'
import { BookPage, ReservationsPage } from './pages/Reservations'
import { AdminPage, AlertsPage, Dashboard, NotFound, Reports, SyncPage } from './pages/Manage'
import { ShiftsPage, TimeClock } from './pages/Team'

function Home() {
  const { role } = useAuth()
  return <Navigate to={navFor(role)[0]?.to ?? '/stock'} replace />
}

export default function App() {
  const auth = useAuth()
  if (!auth.ready) return <div className="grid place-items-center h-full"><Logo className="h-16 opacity-80 animate-pulse" /></div>
  return (
    <Routes>
      <Route path="/book" element={<BookPage />} />
      {auth.who.mode === 'none' ? <Route path="*" element={<Login />} />
        : auth.who.mode === 'device' && !auth.staff ? <Route path="*" element={<PinScreen />} />
        : (
          <Route element={<Layout />}>
            <Route index element={<Home />} />
            <Route path="dashboard" element={<Gate roles={['owner', 'manager']}><Dashboard /></Gate>} />
            <Route path="floor" element={<Gate roles={['server', 'cashier', 'manager']}><Floor /></Gate>} />
            <Route path="session/:id" element={<Gate roles={['server', 'cashier', 'manager']}><SessionPage /></Gate>} />
            <Route path="invoice/:id" element={<Gate roles={['cashier', 'manager']}><InvoicePage /></Gate>} />
            <Route path="shift" element={<Gate roles={['cashier', 'manager']}><ShiftPage /></Gate>} />
            <Route path="kitchen" element={<Gate roles={['kitchen', 'manager']}><Kitchen /></Gate>} />
            <Route path="reservations" element={<Gate roles={['cashier', 'manager']}><ReservationsPage /></Gate>} />
            <Route path="stock" element={<StockPage />} />
            <Route path="deliveries" element={<Gate roles={['kitchen', 'manager']}><DeliveryPage /></Gate>} />
            <Route path="prep" element={<Gate roles={['kitchen', 'manager']}><PrepPage /></Gate>} />
            <Route path="waste" element={<WastePage />} />
            <Route path="counts" element={<Gate roles={['kitchen', 'manager']}><CountsPage /></Gate>} />
            <Route path="counts/new/:type" element={<Gate roles={['kitchen', 'manager']}><CountSheet /></Gate>} />
            <Route path="counts/:id" element={<Gate roles={['kitchen', 'manager']}><CountDetail /></Gate>} />
            <Route path="suppliers" element={<Gate roles={['manager', 'kitchen']}><SuppliersPage /></Gate>} />
            <Route path="reorder" element={<Gate roles={['manager']}><ReorderPage /></Gate>} />
            <Route path="reports" element={<Gate roles={['manager']}><Reports /></Gate>} />
            <Route path="admin" element={<Gate roles={['manager']}><AdminPage /></Gate>} />
            <Route path="time" element={<TimeClock />} />
            <Route path="shifts" element={<Gate roles={['manager']}><ShiftsPage /></Gate>} />
            <Route path="alerts" element={<AlertsPage />} />
            <Route path="sync" element={<SyncPage />} />
            <Route path="*" element={<NotFound />} />
          </Route>
        )}
    </Routes>
  )
}
