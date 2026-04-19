import { Outlet, NavLink, useNavigate } from 'react-router-dom'
import { useAuth } from './contexts/AuthContext'

export default function Layout({ children }: { children?: React.ReactNode }) {
  const { user, logout } = useAuth()
  const navigate = useNavigate()

  async function handleLogout() {
    await logout()
    navigate('/login')
  }

  return (
    <div className="layout">
      <nav className="nav">
        <div className="nav-logo">
          <div className="nav-logo-icon">⚙</div>
          <div>
            <h1>Factory Planner</h1>
            <span>Производственное планирование</span>
          </div>
        </div>
        <ul>
          <li>
            <span className="nav-section-label">Справочники</span>
            <ul>
              <li><NavLink to="/workshops" end className={({ isActive }) => isActive ? 'active' : ''}>Участки</NavLink></li>
              <li><NavLink to="/categories" className={({ isActive }) => isActive ? 'active' : ''}>Категории</NavLink></li>
              <li><NavLink to="/products" className={({ isActive }) => isActive ? 'active' : ''}>Товары</NavLink></li>
              <li><NavLink to="/teams" className={({ isActive }) => isActive ? 'active' : ''}>Бригады</NavLink></li>
            </ul>
          </li>
          <li>
            <span className="nav-section-label">Работа</span>
            <ul>
              <li><NavLink to="/orders" className={({ isActive }) => isActive ? 'active' : ''}>Заказы</NavLink></li>
              <li><NavLink to="/schedule" className={({ isActive }) => isActive ? 'active' : ''}>График</NavLink></li>
              <li><NavLink to="/planning" className={({ isActive }) => isActive ? 'active' : ''}>Аналитика</NavLink></li>
              <li><NavLink to="/import" className={({ isActive }) => isActive ? 'active' : ''}>Импорт Excel</NavLink></li>
            </ul>
          </li>
          {user?.role === 'ADMIN' && (
            <li>
              <span className="nav-section-label">Администрирование</span>
              <ul>
                <li><NavLink to="/admin/approvals" className={({ isActive }) => isActive ? 'active' : ''}>Заявки на доступ</NavLink></li>
              </ul>
            </li>
          )}
        </ul>

        <div style={{ padding: '12px 16px', borderTop: '1px solid rgba(255,255,255,0.1)', marginTop: 'auto' }}>
          <div style={{ fontSize: 12, color: 'rgba(255,255,255,0.6)', marginBottom: 6 }}>
            {user?.email}
            {user?.role === 'ADMIN' && (
              <span style={{ marginLeft: 6, background: 'rgba(255,255,255,0.15)', borderRadius: 4, padding: '1px 5px', fontSize: 10 }}>
                ADMIN
              </span>
            )}
          </div>
          <div style={{ fontSize: 11, color: 'rgba(255,255,255,0.4)', marginBottom: 8 }}>
            {user?.company.name}
          </div>
          <button
            onClick={handleLogout}
            style={{ background: 'rgba(255,255,255,0.1)', border: 'none', color: 'rgba(255,255,255,0.7)', cursor: 'pointer', padding: '5px 10px', borderRadius: 4, fontSize: 12, width: '100%' }}
          >
            Выйти
          </button>
        </div>
      </nav>
      <main className="main">
        {children ?? <Outlet />}
      </main>
    </div>
  )
}
