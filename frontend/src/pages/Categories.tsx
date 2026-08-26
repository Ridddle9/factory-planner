import { useEffect, useState } from 'react'
import { api } from '../api'
import type { CategoryBlock, ProductCategory, Team, Workshop } from '../types'

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

  // --- Блоки категории ---
  const [blocksForCategory, setBlocksForCategory] = useState<string | null>(null)
  const [blocks, setBlocks] = useState<CategoryBlock[]>([])
  const [loadingBlocks, setLoadingBlocks] = useState(false)
  const [blockForm, setBlockForm] = useState({ startDate: '', endDate: '', reason: '', cascade: true })
  const [savingBlock, setSavingBlock] = useState(false)

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

  const openBlocks = async (categoryId: string) => {
    setBlocksForCategory(categoryId)
    setLoadingBlocks(true)
    const { data } = await api.get<CategoryBlock[]>(`/categories/${categoryId}/blocks`)
    setBlocks(data ?? [])
    setLoadingBlocks(false)
    const today = new Date().toISOString().slice(0, 10)
    setBlockForm({ startDate: today, endDate: today, reason: '', cascade: true })
  }

  const createBlock = async () => {
    if (!blocksForCategory || !blockForm.startDate || !blockForm.endDate) return
    setSavingBlock(true)
    const { error: e } = await api.post(`/categories/${blocksForCategory}/blocks`, {
      startDate: blockForm.startDate,
      endDate: blockForm.endDate,
      reason: blockForm.reason || undefined,
      cascadeTasks: blockForm.cascade,
    })
    if (e) setError(e)
    else {
      const { data } = await api.get<CategoryBlock[]>(`/categories/${blocksForCategory}/blocks`)
      setBlocks(data ?? [])
      setBlockForm(f => ({ ...f, reason: '' }))
    }
    setSavingBlock(false)
  }

  const deleteBlock = async (blockId: string) => {
    if (!blocksForCategory) return
    const { error: e } = await api.delete(`/category-blocks/${blockId}`)
    if (e) setError(e)
    else setBlocks(prev => prev.filter(b => b.id !== blockId))
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
            <label>Мощность по умолчанию, ед./день <span style={{ fontWeight: 400, color: 'var(--text-muted)', fontSize: '0.82rem' }}>(фолбэк — если у продукта нет мощности из маршрутизации 1С)</span></label>
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
                <th title="Фолбэк — используется только если у продукта нет мощности из маршрутизации 1С">Мощность по умолч.</th>
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
                    <button type="button" className="btn btn-secondary btn-sm" onClick={() => openBlocks(c.id)}>Блоки</button>
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
      </div>

      {teamsForCategory && (
        <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.4)', zIndex: 1000, display: 'flex', alignItems: 'center', justifyContent: 'center' }}
          onClick={e => { if (e.target === e.currentTarget) setTeamsForCategory(null) }}>
          <div style={{ background: '#fff', borderRadius: 12, padding: 24, width: 480, maxWidth: '90vw', boxShadow: '0 8px 32px rgba(0,0,0,0.18)' }}>
            <h3 style={{ margin: '0 0 1rem' }}>Бригады категории «{list.find(c => c.id === teamsForCategory)?.name ?? ''}»</h3>
            {loadingTeams ? (
              <p>Загрузка...</p>
            ) : (
              <>
                <ul style={{ listStyle: 'none', padding: 0, margin: '0 0 1rem' }}>
                  {categoryTeams.length === 0 ? (
                    <li style={{ color: '#888' }}>Нет назначенных бригад</li>
                  ) : (
                    categoryTeams.map(t => (
                      <li key={t.id} style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', marginBottom: '0.5rem' }}>
                        <span style={{ flex: 1 }}>{t.name}</span>
                        <button type="button" className="btn btn-danger btn-sm" onClick={() => removeTeamFromCategory(t.id)} disabled={saving}>Убрать</button>
                      </li>
                    ))
                  )}
                </ul>
                <div style={{ display: 'flex', gap: '0.5rem', alignItems: 'center', flexWrap: 'wrap' }}>
                  <select value={addTeamId} onChange={e => setAddTeamId(e.target.value)} style={{ flex: 1, minWidth: 180 }}>
                    <option value="">— добавить бригаду —</option>
                    {teams.filter(t => !categoryTeams.some(ct => ct.id === t.id)).map(t => (
                      <option key={t.id} value={t.id}>{t.name}</option>
                    ))}
                  </select>
                  <button type="button" className="btn btn-primary btn-sm" onClick={addTeamToCategory} disabled={!addTeamId || saving}>Добавить</button>
                </div>
              </>
            )}
            <div style={{ marginTop: 16, textAlign: 'right' }}>
              <button type="button" className="btn btn-secondary" onClick={() => setTeamsForCategory(null)}>Закрыть</button>
            </div>
          </div>
        </div>
      )}
      {blocksForCategory && (
        <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.4)', zIndex: 1000, display: 'flex', alignItems: 'center', justifyContent: 'center' }}
          onClick={e => { if (e.target === e.currentTarget) setBlocksForCategory(null) }}>
          <div style={{ background: '#fff', borderRadius: 12, padding: 24, width: 520, maxWidth: '90vw', boxShadow: '0 8px 32px rgba(0,0,0,0.18)' }}>
            <h3 style={{ margin: '0 0 1rem' }}>
              Блоки производства — «{list.find(c => c.id === blocksForCategory)?.name ?? ''}»
            </h3>
            {loadingBlocks ? <p>Загрузка...</p> : (
              <>
                {blocks.length === 0 ? (
                  <p style={{ color: 'var(--text-muted)', margin: '0 0 1rem' }}>Нет активных блоков</p>
                ) : (
                  <ul style={{ listStyle: 'none', padding: 0, margin: '0 0 1rem' }}>
                    {blocks.map(b => (
                      <li key={b.id} style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', marginBottom: '0.5rem', padding: '0.5rem 0.75rem', background: '#fef2f2', borderRadius: 6, border: '1px solid #fecaca' }}>
                        <span style={{ fontWeight: 600, fontVariantNumeric: 'tabular-nums', fontSize: '0.875rem' }}>
                          {b.startDate.slice(0, 10)} — {b.endDate.slice(0, 10)}
                        </span>
                        {b.reason && <span style={{ color: 'var(--text-muted)', fontSize: '0.82rem', flex: 1 }}>· {b.reason}</span>}
                        <button type="button" className="btn btn-danger btn-sm" onClick={() => deleteBlock(b.id)}>Снять</button>
                      </li>
                    ))}
                  </ul>
                )}

                <div style={{ borderTop: '1px solid var(--border)', paddingTop: '1rem' }}>
                  <p style={{ margin: '0 0 0.5rem', fontWeight: 600, fontSize: '0.875rem' }}>Добавить блок</p>
                  <div style={{ display: 'flex', gap: '0.5rem', flexWrap: 'wrap', alignItems: 'flex-end' }}>
                    <div>
                      <label style={{ fontSize: '0.75rem', color: 'var(--text-muted)', display: 'block', marginBottom: 2 }}>С</label>
                      <input type="date" value={blockForm.startDate} onChange={e => setBlockForm(f => ({ ...f, startDate: e.target.value }))} style={{ padding: '4px 8px', border: '1px solid var(--border)', borderRadius: 4 }} />
                    </div>
                    <div>
                      <label style={{ fontSize: '0.75rem', color: 'var(--text-muted)', display: 'block', marginBottom: 2 }}>По</label>
                      <input type="date" value={blockForm.endDate} onChange={e => setBlockForm(f => ({ ...f, endDate: e.target.value }))} style={{ padding: '4px 8px', border: '1px solid var(--border)', borderRadius: 4 }} />
                    </div>
                    <div style={{ flex: 1, minWidth: 120 }}>
                      <label style={{ fontSize: '0.75rem', color: 'var(--text-muted)', display: 'block', marginBottom: 2 }}>Причина</label>
                      <input value={blockForm.reason} onChange={e => setBlockForm(f => ({ ...f, reason: e.target.value }))} placeholder="нет запчастей…" style={{ width: '100%', padding: '4px 8px', border: '1px solid var(--border)', borderRadius: 4 }} />
                    </div>
                  </div>
                  <label style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', marginTop: '0.75rem', fontSize: '0.875rem', cursor: 'pointer' }}>
                    <input type="checkbox" checked={blockForm.cascade} onChange={e => setBlockForm(f => ({ ...f, cascade: e.target.checked }))} />
                    Сдвинуть задачи из этого периода вправо автоматически
                  </label>
                  <div style={{ marginTop: '0.75rem' }}>
                    <button type="button" className="btn btn-primary btn-sm" onClick={createBlock} disabled={savingBlock || !blockForm.startDate || !blockForm.endDate}>
                      {savingBlock ? 'Сохранение...' : 'Заблокировать'}
                    </button>
                  </div>
                </div>
              </>
            )}
            <div style={{ marginTop: 16, textAlign: 'right' }}>
              <button type="button" className="btn btn-secondary" onClick={() => setBlocksForCategory(null)}>Закрыть</button>
            </div>
          </div>
        </div>
      )}
    </>
  )
}
