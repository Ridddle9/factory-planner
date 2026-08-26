import { useState } from 'react'
import { Link } from 'react-router-dom'

export default function Register() {
  const [form, setForm] = useState({ inn: '', companyName: '', email: '', password: '' })
  const [error, setError] = useState('')
  const [success, setSuccess] = useState(false)
  const [isFirstUser, setIsFirstUser] = useState(false)
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
      const r = await fetch('/api/auth/register', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(form),
      })
      const data = await r.json()
      if (!r.ok) {
        setError(data.error || 'Ошибка регистрации')
        return
      }
      setIsFirstUser(data.role === 'ADMIN')
      setSuccess(true)
      if (data.role === 'ADMIN') {
        window.location.href = '/onboarding'
      }
    } catch {
      setError('Ошибка сети')
    } finally {
      setLoading(false)
    }
  }

  if (success && !isFirstUser) {
    return (
      <div style={{ minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center', background: '#f1f5f9' }}>
        <div className="card" style={{ width: 400, padding: '2rem', textAlign: 'center' }}>
          <div style={{ fontSize: 48, marginBottom: 12 }}>📋</div>
          <h2>Заявка отправлена</h2>
          <p style={{ color: '#64748b' }}>
            Руководитель вашей компании должен подтвердить доступ.
            После подтверждения вы сможете войти в систему.
          </p>
          <Link to="/login" className="btn" style={{ display: 'inline-block', marginTop: 12 }}>
            Перейти ко входу
          </Link>
        </div>
      </div>
    )
  }

  return (
    <div style={{ minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center', background: '#f1f5f9' }}>
      <div className="card" style={{ width: 400, padding: '2rem' }}>
        <div style={{ textAlign: 'center', marginBottom: '1.5rem' }}>
          <div style={{ fontSize: 32, marginBottom: 8 }}>⚙</div>
          <h2 style={{ margin: 0 }}>Регистрация</h2>
          <p style={{ color: '#64748b', margin: '4px 0 0', fontSize: 13 }}>
            Первый пользователь компании становится руководителем
          </p>
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
            Название компании
            <input
              className="input"
              type="text"
              value={form.companyName}
              onChange={e => set('companyName', e.target.value)}
              placeholder="ООО Производство"
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
            Пароль (минимум 6 символов)
            <input
              className="input"
              type="password"
              value={form.password}
              onChange={e => set('password', e.target.value)}
              placeholder="••••••••"
              required
              minLength={6}
              style={{ display: 'block', width: '100%', marginTop: 4, boxSizing: 'border-box' }}
            />
          </label>

          {error && (
            <div style={{ background: '#fef2f2', border: '1px solid #fecaca', borderRadius: 6, padding: '8px 12px', color: '#b91c1c', fontSize: 13 }}>
              {error}
            </div>
          )}

          <button className="btn" type="submit" disabled={loading} style={{ marginTop: 4 }}>
            {loading ? 'Регистрация...' : 'Зарегистрироваться'}
          </button>
        </form>

        <p style={{ textAlign: 'center', marginTop: 16, fontSize: 13, color: '#64748b' }}>
          Уже есть аккаунт?{' '}
          <Link to="/login" style={{ color: '#2563eb' }}>Войти</Link>
        </p>
      </div>
    </div>
  )
}
