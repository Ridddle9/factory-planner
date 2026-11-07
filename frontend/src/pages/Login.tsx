import { useState } from 'react'
import { useNavigate, Link } from 'react-router-dom'
import { useAuth } from '../contexts/AuthContext'
import AuthFrame from './AuthFrame'

export default function Login() {
  const { refresh } = useAuth()
  const navigate = useNavigate()
  const [form, setForm] = useState({ inn: '', email: '', password: '' })
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)

  function set(field: string, val: string) {
    setForm(f => ({ ...f, [field]: val }))
    setError('')
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    setLoading(true)
    setError('')
    try {
      const r = await fetch('/api/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(form),
      })
      const data = await r.json()
      if (!r.ok) {
        if (data.error === 'pending') {
          setError('Ваша заявка ещё не подтверждена руководителем. Попробуйте позже.')
        } else {
          setError(data.error || data.message || 'Ошибка входа')
        }
        return
      }
      await refresh()
      navigate('/')
    } catch {
      setError('Ошибка сети')
    } finally {
      setLoading(false)
    }
  }

  return (
    <AuthFrame>
      <header className="auth-heading">
        <p className="auth-eyebrow">Ваше рабочее пространство</p>
        <h1>Вход в систему</h1>
        <p>Войдите с данными вашей компании.</p>
      </header>

      <form onSubmit={handleSubmit} className="auth-form">
        <label>
          ИНН компании
          <input
            className="input"
            type="text"
            value={form.inn}
            onChange={e => set('inn', e.target.value)}
            placeholder="1234567890"
            required
          />
        </label>
        <label>
          Email
          <input
            className="input"
            type="email"
            value={form.email}
            onChange={e => set('email', e.target.value)}
            placeholder="you@company.ru"
            required
          />
        </label>
        <label>
          Пароль
          <input
            className="input"
            type="password"
            value={form.password}
            onChange={e => set('password', e.target.value)}
            placeholder="••••••••"
            required
          />
        </label>
        {error && <div className="auth-error" role="alert">{error}</div>}
        <button className="btn auth-submit" type="submit" disabled={loading}>
          {loading ? 'Вход...' : 'Войти'}
        </button>
      </form>

      <p className="auth-switch">Нет аккаунта? <Link to="/register">Подать заявку</Link></p>
    </AuthFrame>
  )
}
