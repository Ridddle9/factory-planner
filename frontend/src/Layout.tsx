import { useEffect, useState } from 'react'
import { Outlet, NavLink, useNavigate, useLocation } from 'react-router-dom'
import { ChartBar } from '@phosphor-icons/react/dist/csr/ChartBar'
import { CalendarBlank } from '@phosphor-icons/react/dist/csr/CalendarBlank'
import { ChatCircleDots } from '@phosphor-icons/react/dist/csr/ChatCircleDots'
import { SquaresFour } from '@phosphor-icons/react/dist/csr/SquaresFour'
import { Stack } from '@phosphor-icons/react/dist/csr/Stack'
import { Package } from '@phosphor-icons/react/dist/csr/Package'
import { UsersThree } from '@phosphor-icons/react/dist/csr/UsersThree'
import { ClipboardText } from '@phosphor-icons/react/dist/csr/ClipboardText'
import { UploadSimple } from '@phosphor-icons/react/dist/csr/UploadSimple'
import { ShieldCheck } from '@phosphor-icons/react/dist/csr/ShieldCheck'
import { SignOut } from '@phosphor-icons/react/dist/csr/SignOut'
import { CaretRight } from '@phosphor-icons/react/dist/csr/CaretRight'
import { useAuth } from './contexts/AuthContext'

const sections = [
  { title: 'Рабочее пространство', items: [
    { to: '/orders', title: 'Заказы', icon: ClipboardText },
    { to: '/schedule', title: 'График', icon: CalendarBlank },
    { to: '/planning', title: 'Аналитика', icon: ChartBar },
    { to: '/assistant', title: 'Помощник', icon: ChatCircleDots },
  ] },
  { title: 'Справочники', items: [
    { to: '/workshops', title: 'Участки', icon: SquaresFour },
    { to: '/categories', title: 'Категории', icon: Stack },
    { to: '/products', title: 'Товары', icon: Package },
    { to: '/teams', title: 'Бригады', icon: UsersThree },
  ] },
  { title: 'Управление', items: [
    { to: '/import', title: 'Импорт Excel', icon: UploadSimple },
  ] },
]

export default function Layout({ children }: { children?: React.ReactNode }) {
  const { user, logout } = useAuth()
  const navigate = useNavigate()
  const { pathname } = useLocation()
  const [menuOpen, setMenuOpen] = useState(false)
  const activeSection = sections.find(section => section.items.some(item => pathname.startsWith(item.to)))
  const currentPage = sections.flatMap(section => section.items).find(item => pathname.startsWith(item.to))?.title
    ?? (pathname.startsWith('/admin') ? 'Заявки на доступ' : pathname === '/plan' ? 'План на день' : 'Участки')

  // Меню на телефоне закрывается при переходе на другую страницу
  useEffect(() => { setMenuOpen(false) }, [pathname])

  async function handleLogout() {
    await logout()
    navigate('/login')
  }

  return (
    <div className="layout">
      <a className="skip-link" href="#main-content">Перейти к содержимому</a>
      <header className="mobile-bar">
        <button type="button" className="mobile-bar-menu" aria-label="Открыть меню" aria-expanded={menuOpen} onClick={() => setMenuOpen(true)}>
          <span /><span /><span />
        </button>
        <div className="mobile-bar-title">{currentPage}</div>
        <img className="nav-logo-icon" src="/icon-192.png" alt="" />
      </header>
      {menuOpen && <div className="nav-backdrop" onClick={() => setMenuOpen(false)} />}
      <nav className={menuOpen ? 'nav open' : 'nav'} aria-label="Основная навигация">
        <div className="nav-logo">
          <div>
            <div className="nav-wordmark">Factory Planner<span className="wordmark-period">.</span></div>
            <span>Планирование производства</span>
          </div>
        </div>
        <div className="nav-workspace">
          <span className="workspace-caption">Компания</span>
          <strong title={user?.company.name}>{user?.company.name}</strong>
        </div>
        <ul>
          {sections.map(section => (
            <li key={section.title}>
              <span className="nav-section-label">{section.title}</span>
              <ul>
                {section.items.map(({ to, title, icon: Icon }) => (
                  <li key={to}>
                    <NavLink to={to} className={({ isActive }) => isActive || (to === '/workshops' && pathname === '/') ? 'active' : ''}>
                      <Icon size={18} weight="regular" aria-hidden="true" /><span>{title}</span>
                    </NavLink>
                  </li>
                ))}
                {section.title === 'Управление' && user?.role === 'ADMIN' && (
                  <li><NavLink to="/admin/approvals" className={({ isActive }) => isActive ? 'active' : ''}>
                    <ShieldCheck size={18} aria-hidden="true" /><span>Заявки на доступ</span>
                  </NavLink></li>
                )}
              </ul>
            </li>
          ))}
        </ul>
        <div className="nav-account">
          <div className="account-avatar" aria-hidden="true">{user?.email.slice(0, 1).toUpperCase()}</div>
          <div className="account-info"><strong title={user?.email}>{user?.email}</strong><span>{user?.role === 'ADMIN' ? 'Администратор' : 'Сотрудник'}</span></div>
          <button className="account-logout" onClick={handleLogout} title="Выйти" aria-label="Выйти"><SignOut size={18} /></button>
        </div>
      </nav>
      <div className="workspace-main">
        <header className="workspace-header">
          <div className="workspace-breadcrumb"><span>{activeSection?.title ?? (pathname.startsWith('/admin') ? 'Управление' : 'Справочники')}</span><CaretRight size={12} aria-hidden="true" /><strong>{currentPage}</strong></div>
          <span className="workspace-context">Производственный учёт</span>
        </header>
        <main className="main" id="main-content" tabIndex={-1}>
          {children ?? <Outlet />}
        </main>
      </div>
    </div>
  )
}
