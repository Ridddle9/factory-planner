import { useEffect, useState } from 'react'
import './list-pages.css'
import { api } from '../api'
import { useScrollToForm } from '../useScrollToForm'
import type { Workshop } from '../types'

export default function Workshops() {
  const [list, setList] = useState<Workshop[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [showForm, setShowForm] = useState(false)
  const [editing, setEditing] = useState<Workshop | null>(null)
  const formRef = useScrollToForm(editing?.id ?? (showForm ? 'new' : null))
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
    <div className="list-page">
      <div className="page-heading">
        <div>
          <h1 className="page-title">Участки</h1>
          <p className="page-description">Производственные участки вашей компании.</p>
        </div>
        <div className="page-heading-actions">
          <button type="button" className="btn btn-primary" onClick={openCreate}>Добавить участок</button>
        </div>
      </div>
      {error && <div className="error">{error}</div>}
      <div className="card list-card">
        {(showForm || editing !== null) && (
          <div className="form-panel" ref={formRef}>
            <h3 className="form-panel-title">{editing ? 'Изменение участка' : 'Новый участок'}</h3>
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
          <table className="stack sticky-head">
            <thead>
              <tr>
                <th>Название</th>
                <th style={{ width: 140 }}></th>
              </tr>
            </thead>
            <tbody>
              {list.map(w => (
                <tr key={w.id}>
                  <td className="stack-title">{w.name}</td>
                  <td className="stack-actions">
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
    </div>
  )
}
