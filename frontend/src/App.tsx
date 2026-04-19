import { Routes, Route, Navigate } from 'react-router-dom'
import { AuthProvider, useAuth } from './contexts/AuthContext'
import Layout from './Layout'
import Login from './pages/Login'
import Register from './pages/Register'
import AdminApproval from './pages/AdminApproval'
import Workshops from './pages/Workshops'
import Categories from './pages/Categories'
import Products from './pages/Products'
import Teams from './pages/Teams'
import Orders from './pages/Orders'
import OrderDetail from './pages/OrderDetail'
import DailyPlan from './pages/DailyPlan'
import Schedule from './pages/Schedule'
import Planning from './pages/Planning'
import Import from './pages/Import'

function ProtectedRoutes() {
  const { user, loading } = useAuth()

  if (loading) {
    return (
      <div style={{ minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
        <span style={{ color: '#64748b' }}>Загрузка...</span>
      </div>
    )
  }

  if (!user) return <Navigate to="/login" replace />

  return (
    <Layout>
      <Routes>
        <Route path="/" element={<Workshops />} />
        <Route path="/workshops" element={<Workshops />} />
        <Route path="/categories" element={<Categories />} />
        <Route path="/products" element={<Products />} />
        <Route path="/teams" element={<Teams />} />
        <Route path="/orders" element={<Orders />} />
        <Route path="/orders/:id" element={<OrderDetail />} />
        <Route path="/plan" element={<DailyPlan />} />
        <Route path="/schedule" element={<Schedule />} />
        <Route path="/planning" element={<Planning />} />
        <Route path="/import" element={<Import />} />
        {user.role === 'ADMIN' && (
          <Route path="/admin/approvals" element={<AdminApproval />} />
        )}
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </Layout>
  )
}

function App() {
  return (
    <AuthProvider>
      <div className="app">
        <Routes>
          <Route path="/login" element={<LoginGate />} />
          <Route path="/register" element={<RegisterGate />} />
          <Route path="/*" element={<ProtectedRoutes />} />
        </Routes>
      </div>
    </AuthProvider>
  )
}

function LoginGate() {
  const { user, loading } = useAuth()
  if (loading) return null
  if (user) return <Navigate to="/" replace />
  return <Login />
}

function RegisterGate() {
  const { user, loading } = useAuth()
  if (loading) return null
  if (user) return <Navigate to="/" replace />
  return <Register />
}

export default App
