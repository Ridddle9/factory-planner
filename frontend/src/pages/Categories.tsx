import { useEffect, useState } from 'react'
import { api } from '../api'
import type { ProductCategory, Team, Workshop } from '../types'

export default function Categories() {
  const [list, setList] = useState<ProductCategory[]>([])
  const [workshops, setWorkshops] = useState<Workshop[]>([])
  const [teams, setTeams] = useState<Team[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [showForm, setShowForm] = useState(false)
  const [editing, setEditing] = useState<ProductCategory | null>(null)
  const [form, setForm] = useState({ name: '', capacityPerTeamPerDay: 220, workshopId: '' })
  const [saving, setSaving] = useState(false)
  const [teamsForCategory, setTeamsForCategory] = useState<string | null>(null)
  const [categoryTeams, setCategoryTeams] = useState<Team[]>([])
  const [addTeamId, setAddTeamId] = useState('')
  const [loadingTeams, setLoadingTeams] = useState(false)

  const load = async () => {
    setLoading(true)
    const [catRes, workRes, teamsRes] = await Promise.all([
      api.get<ProductCategory[]>('/categories'),
      api.get<Workshop[]>('/workshops'),
      api.get<Team[]>('/teams'),
    ])
    setLoading(false)
    if (catRes.error) {
      setError(catRes.error)
      return
    }
    if (workRes.data) setWorkshops(workRes.data)
    if (teamsRes.data) setTeams(teamsRes.data)
    setList(catRes.data ?? [])
    setError(null)
  }

  const openTeams = async (categoryId: string) => {
    setTeamsForCategory(categoryId)
    setLoadingTeams(true)
    const { data } = await api.get<Team[]>(`/categories/${categoryId}/teams`)
    setCategoryTeams(data ?? [])
    setLoadingTeams(false)
    setAddTeamId('')
  }

  const addTeamToCategory = async () => {
    if (!teamsForCategory || !addTeamId) return
    setSaving(true)
    const { error: e } = await api.post('/category-teams', { categoryId: teamsForCategory, teamId: addTeamId })
    if (e) setError(e)
    else {
      const { data } = await api.get<Team[]>(`/categories/${teamsForCategory}/teams`)
      setCategoryTeams(data ?? [])
      setAddTeamId('')
    }
    setSaving(false)
  }

  const removeTeamFromCategory = async (teamId: string) => {
    if (!teamsForCategory) return
    setSaving(true)
    const { error: e } = await api.delete(`/category-teams?categoryId=${teamsForCategory}&teamId=${teamId}`)
    if (e) setError(e)
    else {
      setCategoryTeams(prev => prev.filter(t => t.id !== teamId))
    }
    setSaving(false)
  }

  useEffect(() => {
    load()
  }, [])

  const openCreate = () => {
    setShowForm(true)
    setEditing(null)
    setForm({
      name: '',
      capacityPerTeamPerDay: 220,
      workshopId: workshops[0]?.id ?? '',
    })
  }

  const openEdit = (c: ProductCategory) => {
    setEditing(c)
    setForm({
      name: c.name,
      capacityPerTeamPerDay: c.capacityPerTeamPerDay,
      workshopId: c.workshopId,
    })
  }

  const save = async () => {
    if (!form.name.trim()) return
    const capacity = Math.floor(Number(form.capacityPerTeamPerDay)) || 1
    if (!form.workshopId && !editing) return
    setSaving(true)
    if (editing) {
      const { error: e } = await api.put(`/categories/${editing.id}`, {
        name: form.name.trim(),
        capacityPerTeamPerDay: capacity,
        workshopId: form.workshopId || undefined,
      })
      if (e) setError(e)
      else {
        setEditing(null)
        setShowForm(false)
        load()
      }
    } else {
      const { error: e } = await api.post('/categories', {
        name: form.name.trim(),
        capacityPerTeamPerDay: capacity,
        workshopId: form.workshopId,
      })
      if (e) setError(e)
      else {
        setForm({ name: '', capacityPerTeamPerDay: 220, workshopId: workshops[0]?.id ?? '' })
        setShowForm(false)
        load()
      }
    }
    setSaving(false)
  }

  const remove = async (id: string) => {
    if (!confirm('Удалить категорию?')) return
    const { error: e } = await api.delete(`/categories/${id}`)
    if (e) setError(e)
    else load()
  }

  if (loading) return <div className="card">Загрузка...</div>

  return (
    <>
      <h1 className="page-title">Категории номенклатуры</h1>
      {error && <div className="error">{error}</div>}
      <div className="card">
        <div className="toolbar">
          <button type="button" className="btn btn-primary" onClick={openCreate} disabled={workshops.length === 0}>
            Добавить категорию
          </button>
        </div>
        {(showForm || editing !== null) && (
          <div style={{ marginBottom: '1rem', paddingBottom: '1rem', borderBottom: '1px solid #eee' }}>
            <label>Название</label>
            <input value={form.name} onChange={e => setForm(f => ({ ...f, name: e.target.value }))} placeholder="Категория" />
            <label>Мощность на бригаду/день</label>
            <input type="number" min={1} value={form.capacityPerTeamPerDay} onChange={e => setForm(f => ({ ...f, capacityPerTeamPerDay: Number(e.target.value) || 1 }))} />
            <label>Участок</label>
            <select value={form.workshopId} onChange={e => setForm(f => ({ ...f, workshopId: e.target.value }))}>
              <option value="">— выберите —</option>
              {workshops.map(w => (
                <option key={w.id} value={w.id}>{w.name}</option>
              ))}
            </select>
            <div className="form-actions">
              <button type="button" className="btn btn-primary" onClick={save} disabled={saving}>{editing ? 'Сохранить' : 'Создать'}</button>
              <button type="button" className="btn btn-secondary" onClick={() => { setShowForm(false); setEditing(null); setForm({ name: '', capacityPerTeamPerDay: 220, workshopId: '' }) }}>Отмена</button>
            </div>
          </div>
        )}
        {list.length === 0 ? (
          <div className="empty">Нет категорий. Сначала добавьте участки.</div>
        ) : (
          <table>
            <thead>
              <tr>
                <th>Название</th>
                <th>Участок</th>
                <th>Мощность/день</th>
                <th style={{ width: 220 }}></th>
              </tr>
            </thead>
            <tbody>
              {list.map(c => (
                <tr key={c.id}>
                  <td>{c.name}</td>
                  <td>{c.workshop?.name ?? '—'}</td>
                  <td>{c.capacityPerTeamPerDay}</td>
                  <td>
                    <button type="button" className="btn btn-secondary btn-sm" onClick={() => openTeams(c.id)}>Бригады</button>
                    {' '}
                    <button type="button" className="btn btn-secondary btn-sm" onClick={() => openEdit(c)}>Изменить</button>
                    {' '}
                    <button type="button" className="btn btn-danger btn-sm" onClick={() => remove(c.id)}>Удалить</button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        {teamsForCategory && (
          <div style={{ marginTop: '1rem', padding: '1rem', border: '1px solid #eee', borderRadius: 8 }}>
            <h3 style={{ margin: '0 0 0.5rem' }}>Бригады категории «{list.find(c => c.id === teamsForCategory)?.name ?? ''}»</h3>
            {loadingTeams ? (
              <p>Загрузка...</p>
            ) : (
              <>
                <ul style={{ listStyle: 'none', padding: 0, margin: '0 0 0.75rem' }}>
                  {categoryTeams.length === 0 ? (
                    <li style={{ color: '#888' }}>Нет назначенных бригад</li>
                  ) : (
                    categoryTeams.map(t => (
                      <li key={t.id} style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', marginBottom: '0.25rem' }}>
                        {t.name}
                        <button type="button" className="btn btn-danger btn-sm" onClick={() => removeTeamFromCategory(t.id)} disabled={saving}>Убрать</button>
                      </li>
                    ))
                  )}
                </ul>
                <div style={{ display: 'flex', gap: '0.5rem', alignItems: 'center', flexWrap: 'wrap' }}>
                  <select value={addTeamId} onChange={e => setAddTeamId(e.target.value)} style={{ width: 220 }}>
                    <option value="">— добавить бригаду —</option>
                    {teams.filter(t => !categoryTeams.some(ct => ct.id === t.id)).map(t => (
                      <option key={t.id} value={t.id}>{t.name}</option>
                    ))}
                  </select>
                  <button type="button" className="btn btn-primary btn-sm" onClick={addTeamToCategory} disabled={!addTeamId || saving}>Добавить</button>
                  <button type="button" className="btn btn-secondary btn-sm" onClick={() => setTeamsForCategory(null)}>Закрыть</button>
                </div>
              </>
            )}
          </div>
        )}
      </div>
    </>
  )
}
