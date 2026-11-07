import { useEffect, useState } from 'react'

interface PendingUser {
  id: string
  email: string
  createdAt: string
}

interface CompanyUser {
  id: string
  email: string
  role: string
  status: string
  createdAt: string
}

const STATUS_LABEL: Record<string, string> = {
  APPROVED: 'Активен',
  PENDING: 'Ожидает',
  REJECTED: 'Отклонён',
}

const STATUS_COLOR: Record<string, string> = {
  APPROVED: 'var(--success)',
  PENDING: 'var(--warning)',
  REJECTED: 'var(--danger)',
}

const STATUS_BG: Record<string, string> = {
  APPROVED: 'var(--success-light)',
  PENDING: 'var(--warning-light)',
  REJECTED: 'var(--danger-light)',
}

export default function AdminApproval() {
  const [users, setUsers] = useState<PendingUser[]>([])
  const [loading, setLoading] = useState(true)
  const [processing, setProcessing] = useState<string | null>(null)

  const [allUsers, setAllUsers] = useState<CompanyUser[]>([])
  const [allUsersLoading, setAllUsersLoading] = useState(true)

  const [syncToken, setSyncToken] = useState<string | null>(null)
  const [tokenVisible, setTokenVisible] = useState(false)
  const [tokenLoading, setTokenLoading] = useState(true)
  const [copied, setCopied] = useState(false)
  const [regenerating, setRegenerating] = useState(false)

  async function load() {
    setLoading(true)
    try {
      const r = await fetch('/api/admin/users/pending')
      if (r.ok) setUsers(await r.json())
    } finally {
      setLoading(false)
    }
  }

  async function loadAllUsers() {
    setAllUsersLoading(true)
    try {
      const r = await fetch('/api/admin/users')
      if (r.ok) setAllUsers(await r.json())
    } finally {
      setAllUsersLoading(false)
    }
  }

  async function loadToken() {
    setTokenLoading(true)
    try {
      const r = await fetch('/api/admin/sync-token')
      if (r.ok) {
        const data = await r.json()
        setSyncToken(data.syncToken)
      }
    } finally {
      setTokenLoading(false)
    }
  }

  useEffect(() => {
    load()
    loadAllUsers()
    loadToken()
  }, [])

  async function decide(userId: string, status: 'APPROVED' | 'REJECTED') {
    setProcessing(userId)
    try {
      const r = await fetch(`/api/admin/users/${userId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status }),
      })
      if (r.ok) {
        setUsers(u => u.filter(x => x.id !== userId))
        loadAllUsers()
      }
    } finally {
      setProcessing(null)
    }
  }

  async function copyToken() {
    if (!syncToken) return
    await navigator.clipboard.writeText(syncToken)
    setCopied(true)
    setTimeout(() => setCopied(false), 2000)
  }

  async function regenerateToken() {
    if (!confirm('Старый токен перестанет работать. Нужно будет обновить настройки в расширении 1С. Продолжить?')) return
    setRegenerating(true)
    try {
      const r = await fetch('/api/admin/sync-token/regenerate', { method: 'POST' })
      if (r.ok) {
        const data = await r.json()
        setSyncToken(data.syncToken)
        setTokenVisible(true)
      }
    } finally {
      setRegenerating(false)
    }
  }

  return (
    <div>
      {/* Блок синхронизации с 1С */}
      <h2>Синхронизация с 1С</h2>
      <div className="card" style={{ marginBottom: 24 }}>
        <div style={{ marginBottom: 8, color: 'var(--text-secondary)', fontSize: 14 }}>
          Этот токен вводится в расширение 1С (<strong>ФабрикаПланнер</strong>) в поле «Токен».
          Без него синхронизация не пройдёт.
        </div>

        {tokenLoading ? (
          <span style={{ color: 'var(--text-muted)' }}>Загрузка...</span>
        ) : (
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
            <code style={{
              flex: 1,
              background: 'var(--table-header-bg)',
              padding: '8px 12px',
              borderRadius: 6,
              fontSize: 13,
              letterSpacing: tokenVisible ? undefined : 2,
              userSelect: tokenVisible ? 'text' : 'none',
              minWidth: 0,
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
            }}>
              {tokenVisible ? syncToken : '•'.repeat(36)}
            </code>
            <button
              className="btn"
              onClick={() => setTokenVisible(v => !v)}
              style={{ background: 'var(--text-secondary)', color: '#fff', minWidth: 80 }}
            >
              {tokenVisible ? 'Скрыть' : 'Показать'}
            </button>
            <button
              className="btn"
              onClick={copyToken}
              style={{ background: copied ? 'var(--success)' : 'var(--primary)', color: '#fff', minWidth: 90 }}
            >
              {copied ? 'Скопировано' : 'Скопировать'}
            </button>
            <button
              className="btn"
              onClick={regenerateToken}
              disabled={regenerating}
              style={{ background: 'var(--danger)', color: '#fff', minWidth: 110 }}
            >
              {regenerating ? 'Генерация...' : 'Перегенерировать'}
            </button>
          </div>
        )}
      </div>

      {/* Заявки на доступ */}
      <h2>Заявки на доступ</h2>

      {loading && <p style={{ color: 'var(--text-secondary)' }}>Загрузка...</p>}

      {!loading && users.length === 0 && (
        <div className="card" style={{ color: 'var(--text-secondary)', padding: '2rem', textAlign: 'center' }}>
          Новых заявок нет
        </div>
      )}

      {users.map(u => (
        <div key={u.id} className="card" style={{ display: 'flex', alignItems: 'center', gap: 16, marginBottom: 8, padding: '12px 16px' }}>
          <div style={{ flex: 1 }}>
            <strong>{u.email}</strong>
            <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>
              Подал заявку: {new Date(u.createdAt).toLocaleString('ru-RU')}
            </div>
          </div>
          <button
            className="btn"
            onClick={() => decide(u.id, 'APPROVED')}
            disabled={processing === u.id}
            style={{ background: 'var(--success)', minWidth: 100 }}
          >
            Разрешить
          </button>
          <button
            className="btn"
            onClick={() => decide(u.id, 'REJECTED')}
            disabled={processing === u.id}
            style={{ background: 'var(--danger)', minWidth: 100 }}
          >
            Отклонить
          </button>
        </div>
      ))}

      {/* Все пользователи компании */}
      <h2 style={{ marginTop: 32 }}>Пользователи компании</h2>

      {allUsersLoading && <p style={{ color: 'var(--text-secondary)' }}>Загрузка...</p>}

      {!allUsersLoading && (
        <div className="card card-flush" style={{ padding: 0, overflow: 'hidden' }}>
          <table className="stack" style={{ width: '100%', borderCollapse: 'collapse', fontSize: 14 }}>
            <thead>
              <tr style={{ background: 'var(--bg)', borderBottom: '1px solid var(--border)' }}>
                <th style={{ textAlign: 'left', padding: '10px 16px', fontWeight: 600, color: 'var(--text-secondary)' }}>Email</th>
                <th style={{ textAlign: 'left', padding: '10px 16px', fontWeight: 600, color: 'var(--text-secondary)' }}>Роль</th>
                <th style={{ textAlign: 'left', padding: '10px 16px', fontWeight: 600, color: 'var(--text-secondary)' }}>Статус</th>
                <th style={{ textAlign: 'left', padding: '10px 16px', fontWeight: 600, color: 'var(--text-secondary)' }}>Дата регистрации</th>
              </tr>
            </thead>
            <tbody>
              {allUsers.map((u, i) => (
                <tr
                  key={u.id}
                  style={{ borderBottom: i < allUsers.length - 1 ? '1px solid var(--table-header-bg)' : undefined }}
                >
                  <td className="stack-title" style={{ padding: '10px 16px' }}>{u.email}</td>
                  <td data-label="Роль" style={{ padding: '10px 16px', color: u.role === 'ADMIN' ? 'var(--primary)' : 'var(--text-secondary)' }}>
                    {u.role === 'ADMIN' ? 'Администратор' : 'Сотрудник'}
                  </td>
                  <td data-label="Статус" style={{ padding: '10px 16px' }}>
                    <span style={{
                      display: 'inline-block',
                      padding: '2px 8px',
                      borderRadius: 12,
                      fontSize: 12,
                      fontWeight: 600,
                      background: STATUS_BG[u.status] ?? 'var(--table-header-bg)',
                      color: STATUS_COLOR[u.status] ?? 'var(--text-muted)',
                    }}>
                      {STATUS_LABEL[u.status] ?? u.status}
                    </span>
                  </td>
                  <td data-label="Дата регистрации" style={{ padding: '10px 16px', color: 'var(--text-muted)', fontSize: 13 }}>
                    {new Date(u.createdAt).toLocaleString('ru-RU')}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}
