import { useState } from 'react'
import { useNavigate, Link } from 'react-router-dom'
import { useAuth } from '../contexts/AuthContext'

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
    <div style={{ minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center', background: '#f1f5f9' }}>
      <div className="card" style={{ width: 380, padding: '2rem' }}>
        <div style={{ textAlign: 'center', marginBottom: '1.5rem' }}>
          <div style={{ fontSize: 32, marginBottom: 8 }}>⚙</div>
          <h2 style={{ margin: 0 }}>Factory Planner</h2>
          <p style={{ color: '#64748b', margin: '4px 0 0' }}>Вход в систему</p>
        </div>

        <form onSubmit={handleSubmit} style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          <label style={{ fontSize: 13, color: '#374151' }}>
            ИНН компании
            <input
              className="input"
              type="text"
              value={form.inn}
              onChange={e => set('inn', e.target.value)}
              placeholder="1234567890"
              required
              style={{ display: 'block', width: '100%', marginTop: 4, boxSizing: 'border-box' }}
            />
          </label>

          <label style={{ fontSize: 13, color: '#374151' }}>
            Email
            <input
              className="input"
              type="email"
              value={form.email}
              onChange={e => set('email', e.target.value)}
              placeholder="you@company.ru"
              required
              style={{ display: 'block', width: '100%', marginTop: 4, boxSizing: 'border-box' }}
            />
          </label>

          <label style={{ fontSize: 13, color: '#374151' }}>
            Пароль
            <input
              className="input"
              type="password"
              value={form.password}
              onChange={e => set('password', e.target.value)}
              placeholder="••••••••"
              required
              style={{ display: 'block', width: '100%', marginTop: 4, boxSizing: 'border-box' }}
            />
          </label>

          {error && (
            <div style={{ background: '#fef2f2', border: '1px solid #fecaca', borderRadius: 6, padding: '8px 12px', color: '#b91c1c', fontSize: 13 }}>
              {error}
            </div>
          )}

          <button className="btn" type="submit" disabled={loading} style={{ marginTop: 4 }}>
            {loading ? 'Вход...' : 'Войти'}
          </button>
        </form>

        <p style={{ textAlign: 'center', marginTop: 16, fontSize: 13, color: '#64748b' }}>
          Нет аккаунта?{' '}
          <Link to="/register" style={{ color: '#2563eb' }}>Подать заявку</Link>
        </p>
      </div>
    </div>
  )
}
