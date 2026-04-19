import { useEffect, useState } from 'react'
import { api } from '../api'
import type { Workshop } from '../types'

export default function Workshops() {
  const [list, setList] = useState<Workshop[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [showForm, setShowForm] = useState(false)
  const [editing, setEditing] = useState<Workshop | null>(null)
  const [formName, setFormName] = useState('')
  const [saving, setSaving] = useState(false)

  const load = async () => {
    setLoading(true)
    const { data, error: e } = await api.get<Workshop[]>('/workshops')
    setLoading(false)
    if (e) {
      setError(e)
      return
    }
    setList(data ?? [])
    setError(null)
  }

  useEffect(() => {
    load()
  }, [])

  const openCreate = () => {
    setShowForm(true)
    setEditing(null)
    setFormName('')
  }

  const openEdit = (w: Workshop) => {
    setEditing(w)
    setFormName(w.name)
  }

  const save = async () => {
    if (!formName.trim()) return
    setSaving(true)
    if (editing) {
      const { error: e } = await api.put(`/workshops/${editing.id}`, { name: formName.trim() })
      if (e) setError(e)
      else {
        setEditing(null)
        setShowForm(false)
        load()
      }
    } else {
      const { error: e } = await api.post('/workshops', { name: formName.trim() })
      if (e) setError(e)
      else {
        setFormName('')
        setShowForm(false)
        load()
      }
    }
    setSaving(false)
  }

  const remove = async (id: string) => {
    if (!confirm('Удалить участок?')) return
    const { error: e } = await api.delete(`/workshops/${id}`)
    if (e) setError(e)
    else load()
  }

  if (loading) return <div className="card">Загрузка...</div>

  return (
    <>
      <h1 className="page-title">Участки</h1>
      {error && <div className="error">{error}</div>}
      <div className="card">
        <div className="toolbar">
          <button type="button" className="btn btn-primary" onClick={openCreate}>Добавить участок</button>
        </div>
        {(showForm || editing !== null) && (
          <div style={{ marginBottom: '1rem', paddingBottom: '1rem', borderBottom: '1px solid #eee' }}>
            <label>Название</label>
            <input value={formName} onChange={e => setFormName(e.target.value)} placeholder="Название участка" />
            <div className="form-actions">
              <button type="button" className="btn btn-primary" onClick={save} disabled={saving}>
                {editing ? 'Сохранить' : 'Создать'}
              </button>
              <button type="button" className="btn btn-secondary" onClick={() => { setShowForm(false); setEditing(null); setFormName('') }}>Отмена</button>
            </div>
          </div>
        )}
        {list.length === 0 ? (
          <div className="empty">Нет участков. Добавьте первый.</div>
        ) : (
          <table>
            <thead>
              <tr>
                <th>Название</th>
                <th style={{ width: 140 }}></th>
              </tr>
            </thead>
            <tbody>
              {list.map(w => (
                <tr key={w.id}>
                  <td>{w.name}</td>
                  <td>
                    <button type="button" className="btn btn-secondary btn-sm" onClick={() => openEdit(w)}>Изменить</button>
                    {' '}
                    <button type="button" className="btn btn-danger btn-sm" onClick={() => remove(w.id)}>Удалить</button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </>
  )
}
