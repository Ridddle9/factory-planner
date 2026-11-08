import { useEffect, useState } from 'react'
import './list-pages.css'
import { api } from '../api'
import { useScrollToForm } from '../useScrollToForm'
import type { Workshop } from '../types'

const categoriesLabel = (n: number) =>
  `${n} ${n % 10 === 1 && n % 100 !== 11 ? 'категория' : n % 10 >= 2 && n % 10 <= 4 && (n % 100 < 12 || n % 100 > 14) ? 'категории' : 'категорий'}`

export default function Workshops() {
  const [list, setList] = useState<Workshop[]>([])
  // Скрытые участки: не видны нигде в приложении, но синк из 1С и планирование по ним продолжаются
  const [hiddenList, setHiddenList] = useState<Workshop[]>([])
  const [tab, setTab] = useState<'active' | 'hidden'>('active')
  const [cantDelete, setCantDelete] = useState<Workshop | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [showForm, setShowForm] = useState(false)
  const [editing, setEditing] = useState<Workshop | null>(null)
  const formRef = useScrollToForm(editing?.id ?? (showForm ? 'new' : null))
  const [formName, setFormName] = useState('')
  const [saving, setSaving] = useState(false)

  const load = async () => {
    setLoading(true)
    const [{ data, error: e }, { data: hidden }] = await Promise.all([
      api.get<Workshop[]>('/workshops'),
      api.get<Workshop[]>('/workshops?hidden=1'),
    ])
    setLoading(false)
    if (e) {
      setError(e)
      return
    }
    setList(data ?? [])
    setHiddenList(hidden ?? [])
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

  const setVisible = async (w: Workshop, visible: boolean, confirmed = false) => {
    if (!visible && !confirmed && !confirm(`Скрыть участок «${w.name}»?\n\nЕго категории, товары, позиции заказов, задачи и бригады, занятые только им, пропадут из всех разделов. Синк из 1С и планирование продолжатся. Вернуть можно на вкладке «Скрытые».`)) return
    const { error: e } = await api.put(`/workshops/${w.id}`, { visible })
    if (e) setError(e)
    else load()
  }

  // Участок с категориями удалить нельзя (удалились бы и категории) — предлагаем скрыть
  const remove = async (w: Workshop) => {
    if ((w._count?.categories ?? 0) > 0) { setCantDelete(w); return }
    if (!confirm(`Удалить участок «${w.name}»?`)) return
    const { error: e } = await api.delete(`/workshops/${w.id}`)
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
        {tab === 'active' && (
          <div className="page-heading-actions">
            <button type="button" className="btn btn-primary" onClick={openCreate}>Добавить участок</button>
          </div>
        )}
      </div>
      {error && <div className="error">{error}</div>}
      <div className="card list-card">
        <div className="tabs list-tabs list-tabs-inset">
          <button type="button" className={`tab ${tab === 'active' ? 'active' : ''}`} onClick={() => setTab('active')}>Активные</button>
          <button type="button" className={`tab ${tab === 'hidden' ? 'active' : ''}`} onClick={() => setTab('hidden')}>
            Скрытые{hiddenList.length > 0 && <span className="badge badge-neutral" style={{ marginLeft: 6 }}>{hiddenList.length}</span>}
          </button>
        </div>
        {tab === 'hidden' ? (
          hiddenList.length === 0 ? (
            <div className="empty">Скрытых участков нет.</div>
          ) : (
            <>
              <div className="list-note">
                Скрытые участки не видны в приложении вместе с их категориями, но синк из 1С и планирование по ним продолжаются.
              </div>
              <table className="stack sticky-head">
                <thead>
                  <tr>
                    <th>Название</th>
                    <th>Категорий</th>
                    <th style={{ width: 160 }}></th>
                  </tr>
                </thead>
                <tbody>
                  {hiddenList.map(w => (
                    <tr key={w.id}>
                      <td className="stack-title">{w.name}</td>
                      <td data-label="Категорий">{w._count?.categories ?? 0}</td>
                      <td className="stack-actions">
                        <button type="button" className="btn btn-primary btn-sm" onClick={() => setVisible(w, true)}>Восстановить</button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </>
          )
        ) : (<>
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
                <th>Категорий</th>
                <th style={{ width: 220 }}></th>
              </tr>
            </thead>
            <tbody>
              {list.map(w => (
                <tr key={w.id}>
                  <td className="stack-title">{w.name}</td>
                  <td data-label="Категорий">{w._count?.categories ?? 0}</td>
                  <td className="stack-actions">
                    <button type="button" className="btn btn-secondary btn-sm" onClick={() => openEdit(w)}>Изменить</button>
                    {' '}
                    <button type="button" className="btn btn-secondary btn-sm" onClick={() => setVisible(w, false)}>Скрыть</button>
                    {' '}
                    <button type="button" className="btn btn-danger btn-sm" onClick={() => remove(w)}>Удалить</button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        </>)}
      </div>

      {cantDelete && (
        <div className="modal-backdrop" onClick={e => { if (e.target === e.currentTarget) setCantDelete(null) }}>
          <div className="modal-card" role="dialog" aria-modal="true" aria-labelledby="cant-delete-title">
            <h3 id="cant-delete-title" className="form-panel-title">Участок нельзя удалить</h3>
            <p style={{ margin: '0 0 0.6rem', lineHeight: 1.5 }}>
              В участке «{cantDelete.name}» {categoriesLabel(cantDelete._count?.categories ?? 0)}. Удалить участок можно только после того, как все его категории перенесены в другие участки или удалены.
            </p>
            <p style={{ margin: '0 0 0.6rem', lineHeight: 1.5, color: 'var(--text-secondary)' }}>
              Вместо удаления участок можно скрыть: он пропадёт из всех разделов вместе с категориями, а синк из 1С и планирование продолжатся. Вернуть его можно на вкладке «Скрытые».
            </p>
            <p style={{ margin: '0 0 1.25rem', lineHeight: 1.5, color: 'var(--text-secondary)' }}>
              Если участок приходит синком из 1С, лучше скрыть его, чем удалять: после удаления следующий синк создаст участок заново.
            </p>
            <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', flexWrap: 'wrap' }}>
              <button type="button" className="btn btn-secondary" onClick={() => setCantDelete(null)}>Отмена</button>
              <button type="button" className="btn btn-primary" autoFocus
                onClick={async () => { const w = cantDelete; setCantDelete(null); await setVisible(w, false, true) }}>
                Скрыть участок
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
