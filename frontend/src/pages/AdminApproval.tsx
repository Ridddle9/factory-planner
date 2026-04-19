import { useEffect, useState } from 'react'

interface PendingUser {
  id: string
  email: string
  createdAt: string
}

export default function AdminApproval() {
  const [users, setUsers] = useState<PendingUser[]>([])
  const [loading, setLoading] = useState(true)
  const [processing, setProcessing] = useState<string | null>(null)

  async function load() {
    setLoading(true)
    try {
      const r = await fetch('/api/admin/users/pending')
      if (r.ok) setUsers(await r.json())
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => { load() }, [])

  async function decide(userId: string, status: 'APPROVED' | 'REJECTED') {
    setProcessing(userId)
    try {
      await fetch(`/api/admin/users/${userId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status }),
      })
      setUsers(u => u.filter(x => x.id !== userId))
    } finally {
      setProcessing(null)
    }
  }

  return (
    <div>
      <h2>Заявки на доступ</h2>

      {loading && <p style={{ color: '#64748b' }}>Загрузка...</p>}

      {!loading && users.length === 0 && (
        <div className="card" style={{ color: '#64748b', padding: '2rem', textAlign: 'center' }}>
          Новых заявок нет
        </div>
      )}

      {users.map(u => (
        <div key={u.id} className="card" style={{ display: 'flex', alignItems: 'center', gap: 16, marginBottom: 8, padding: '12px 16px' }}>
          <div style={{ flex: 1 }}>
            <strong>{u.email}</strong>
            <div style={{ fontSize: 12, color: '#94a3b8' }}>
              Подал заявку: {new Date(u.createdAt).toLocaleString('ru-RU')}
            </div>
          </div>
          <button
            className="btn"
            onClick={() => decide(u.id, 'APPROVED')}
            disabled={processing === u.id}
            style={{ background: '#16a34a', minWidth: 100 }}
          >
            Разрешить
          </button>
          <button
            className="btn"
            onClick={() => decide(u.id, 'REJECTED')}
            disabled={processing === u.id}
            style={{ background: '#dc2626', minWidth: 100 }}
          >
            Отклонить
          </button>
        </div>
      ))}
    </div>
  )
}
