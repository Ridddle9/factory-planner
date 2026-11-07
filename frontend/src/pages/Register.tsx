import { useState } from 'react'
import { Link } from 'react-router-dom'
import AuthFrame from './AuthFrame'

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
      <AuthFrame>
        <div className="auth-success">
          <p className="auth-eyebrow">Доступ к рабочему пространству</p>
          <h1>Заявка отправлена</h1>
          <p>Руководитель вашей компании должен подтвердить доступ.
            После подтверждения вы сможете войти в систему.</p>
          <Link to="/login" className="btn auth-submit">Перейти ко входу</Link>
        </div>
      </AuthFrame>
    )
  }

  return (
    <AuthFrame>
      <header className="auth-heading">
        <p className="auth-eyebrow">Доступ к рабочему пространству</p>
        <h1>Регистрация</h1>
        <p>Первый пользователь компании становится руководителем.</p>
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
          Название компании
          <input
            className="input"
            type="text"
            value={form.companyName}
            onChange={e => set('companyName', e.target.value)}
            placeholder="ООО Производство"
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
          Пароль (минимум 6 символов)
          <input
            className="input"
            type="password"
            value={form.password}
            onChange={e => set('password', e.target.value)}
            placeholder="••••••••"
            required
            minLength={6}
          />
        </label>
        {error && <div className="auth-error" role="alert">{error}</div>}
        <button className="btn auth-submit" type="submit" disabled={loading}>
          {loading ? 'Регистрация...' : 'Зарегистрироваться'}
        </button>
      </form>

      <p className="auth-switch">Уже есть аккаунт? <Link to="/login">Войти</Link></p>
    </AuthFrame>
  )
}
