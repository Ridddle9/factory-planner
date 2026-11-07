import { useEffect, useState } from 'react'
import { api } from '../api'
import { useScrollToForm } from '../useScrollToForm'
import type { Product, ProductCategory, ProductTeamCapacity } from '../types'

export default function Products() {
  const [list, setList] = useState<Product[]>([])
  const [categories, setCategories] = useState<ProductCategory[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [showForm, setShowForm] = useState(false)
  const [editing, setEditing] = useState<Product | null>(null)
  const formRef = useScrollToForm(editing?.id ?? (showForm ? 'new' : null))
  const [form, setForm] = useState({ code: '', name: '', categoryId: '', capacityPerDay: '' })
  const [saving, setSaving] = useState(false)
  const [search, setSearch] = useState('')
  const [categoryFilter, setCategoryFilter] = useState('')
  const [capacityModal, setCapacityModal] = useState<Product | null>(null)

  const load = async () => {
    setLoading(true)
    const [prodRes, catRes] = await Promise.all([
      api.get<Product[]>('/products'),
      api.get<ProductCategory[]>('/categories'),
    ])
    setLoading(false)
    if (prodRes.error) { setError(prodRes.error); return }
    if (catRes.data) setCategories(catRes.data)
    setList(prodRes.data ?? [])
    setError(null)
  }

  useEffect(() => { load() }, [])

  const openCreate = () => {
    setShowForm(true)
    setEditing(null)
    // Если список отфильтрован по категории — новый товар сразу в ней
    setForm({ code: '', name: '', categoryId: categoryFilter || categories[0]?.id || '', capacityPerDay: '' })
  }

  const openEdit = (p: Product) => {
    setEditing(p)
    setForm({ code: p.code, name: p.name, categoryId: p.categoryId, capacityPerDay: p.capacityPerDay != null ? String(p.capacityPerDay) : '' })
    setShowForm(true)
  }

  const save = async () => {
    if (!form.code.trim() || !form.name.trim()) return
    if (!form.categoryId && !editing) return
    setSaving(true)

    const capValue = form.capacityPerDay.trim()
    const body: Record<string, unknown> = {
      code: form.code.trim(),
      name: form.name.trim(),
      categoryId: form.categoryId || undefined,
    }
    if (capValue !== '') {
      const n = parseInt(capValue, 10)
      if (isNaN(n) || n <= 0) { setError('Производительность должна быть положительным числом'); setSaving(false); return }
      body.capacityPerDay = n
    }

    if (editing) {
      const { error: e } = await api.put(`/products/${editing.id}`, body)
      if (e) setError(e)
      else { setEditing(null); setShowForm(false); load() }
    } else {
      const { error: e } = await api.post('/products', body)
      if (e) setError(e)
      else { setForm({ code: '', name: '', categoryId: categories[0]?.id ?? '', capacityPerDay: '' }); setShowForm(false); load() }
    }
    setSaving(false)
  }

  const unlock = async (p: Product) => {
    const { error: e } = await api.put(`/products/${p.id}`, { capacityLocked: false })
    if (e) setError(e)
    else load()
  }

  const remove = async (id: string) => {
    if (!confirm('Удалить товар?')) return
    const { error: e } = await api.delete(`/products/${id}`)
    if (e) setError(e)
    else load()
  }

  // Поиск по коду/названию и фильтр по категории работают вместе
  const q = search.trim().toLowerCase()
  const filtered = list.filter(p =>
    (!categoryFilter || p.categoryId === categoryFilter) &&
    (!q || p.code.toLowerCase().includes(q) || p.name.toLowerCase().includes(q)))
  const countByCategory = list.reduce<Record<string, number>>((acc, p) => {
    acc[p.categoryId] = (acc[p.categoryId] ?? 0) + 1
    return acc
  }, {})

  if (loading) return <div className="card">Загрузка...</div>

  return (
    <>
      <h1 className="page-title">Товары</h1>
      <p className="page-description">Номенклатура и производительность по каждому товару.</p>
      {error && <div className="error">{error}</div>}
      <div className="card">
        <div className="toolbar">
          <button type="button" className="btn btn-primary" onClick={openCreate} disabled={categories.length === 0}>Добавить товар</button>
          <input
            className="toolbar-search toolbar-field"
            placeholder="Поиск по коду / названию"
            value={search}
            onChange={e => setSearch(e.target.value)}
          />
          <select
            className="toolbar-field toolbar-select"
            value={categoryFilter}
            onChange={e => setCategoryFilter(e.target.value)}
            aria-label="Фильтр по категории"
          >
            <option value="">Все категории ({list.length})</option>
            {categories.map(c => (
              <option key={c.id} value={c.id}>{c.name || '—'} ({countByCategory[c.id] ?? 0})</option>
            ))}
          </select>
          {(search || categoryFilter) && (
            <button type="button" className="btn btn-secondary" onClick={() => { setSearch(''); setCategoryFilter('') }}>Сбросить</button>
          )}
        </div>
        {(search || categoryFilter) && (
          <div className="toolbar-summary">Показано {filtered.length} из {list.length}</div>
        )}

        {(showForm || editing !== null) && (
          <div className="form-panel" ref={formRef}>
            <h3 className="form-panel-title">{editing ? 'Изменение товара' : 'Новый товар'}</h3>
            <label>Код</label>
            <input value={form.code} onChange={e => setForm(f => ({ ...f, code: e.target.value }))} placeholder="Код" />
            <label>Название</label>
            <input value={form.name} onChange={e => setForm(f => ({ ...f, name: e.target.value }))} placeholder="Название" />
            <label>Категория</label>
            <select value={form.categoryId} onChange={e => setForm(f => ({ ...f, categoryId: e.target.value }))}>
              <option value="">— выберите —</option>
              {categories.map(c => (
                <option key={c.id} value={c.id}>{c.name}</option>
              ))}
            </select>
            <label>
              Производительность на 1 человека в день
              <span className="form-hint">Оставьте пустым — возьмётся из 1С</span>
            </label>
            <input
              type="number"
              min={1}
              value={form.capacityPerDay}
              onChange={e => setForm(f => ({ ...f, capacityPerDay: e.target.value }))}
              placeholder="авто из 1С"
            />
            <div className="form-actions">
              <button type="button" className="btn btn-primary" onClick={save} disabled={saving}>{editing ? 'Сохранить' : 'Создать'}</button>
              <button type="button" className="btn btn-secondary" onClick={() => { setShowForm(false); setEditing(null) }}>Отмена</button>
            </div>
          </div>
        )}

        {filtered.length === 0 ? (
          <div className="empty">{search || categoryFilter ? 'Ничего не найдено' : 'Нет товаров. Сначала добавьте категории.'}</div>
        ) : (
          <table className="stack sticky-head">
            <thead>
              <tr>
                <th>Код</th>
                <th>Название</th>
                <th>Категория</th>
                <th title="Количество единиц, которое производит 1 человек за смену (8 ч). Мощность бригады = это число × количество людей в бригаде.">Произв. на чел./день</th>
                <th style={{ width: 180 }}></th>
              </tr>
            </thead>
            <tbody>
              {filtered.map(p => (
                <tr key={p.id}>
                  <td data-label="Код">{p.code}</td>
                  <td className="stack-title">{p.name}</td>
                  <td data-label="Категория">{p.category?.name ?? '—'}</td>
                  <td data-label="Произв. на чел./день" style={{ fontVariantNumeric: 'tabular-nums' }}>
                    {p.teamCapacities && p.teamCapacities.length > 0 ? (
                      <button
                        type="button"
                        className="btn btn-secondary btn-sm"
                        onClick={() => setCapacityModal(p)}
                      >
                        Смотреть
                      </button>
                    ) : p.capacityPerDay != null ? (
                      <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
                        {p.capacityPerDay}
                        {p.capacityLocked && (
                          <span title="Ручное значение — не перезаписывается при синке" style={{ fontSize: '0.8rem', cursor: 'help' }}>🔒</span>
                        )}
                      </span>
                    ) : (
                      <span style={{ color: 'var(--text-muted)' }}>—</span>
                    )}
                  </td>
                  <td className="stack-actions">
                    <button type="button" className="btn btn-secondary btn-sm" onClick={() => openEdit(p)}>Изменить</button>
                    {' '}
                    {p.capacityLocked && (
                      <button type="button" className="btn btn-secondary btn-sm" onClick={() => unlock(p)} title="Разблокировать — следующий синк перезапишет из 1С">
                        Сбросить
                      </button>
                    )}
                    {p.capacityLocked ? ' ' : ''}
                    <button type="button" className="btn btn-danger btn-sm" onClick={() => remove(p.id)}>Удалить</button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {capacityModal && (
        <div
          style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.45)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1000 }}
          onClick={() => setCapacityModal(null)}
        >
          <div
            className="card"
            style={{ width: 'min(560px, calc(100vw - 24px))', maxHeight: '80vh', overflowY: 'auto' }}
            onClick={e => e.stopPropagation()}
          >
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: '0.5rem' }}>
              <div>
                <div style={{ fontWeight: 600, fontSize: '1rem' }}>Производительность по бригадам</div>
                <div style={{ color: 'var(--text-secondary)', fontSize: '0.85rem', marginTop: 2 }}>{capacityModal.name}</div>
              </div>
              <button type="button" className="btn btn-secondary btn-sm" onClick={() => setCapacityModal(null)}>✕</button>
            </div>
            <table>
              <thead>
                <tr>
                  <th>Бригада</th>
                  <th style={{ textAlign: 'right' }}>Произв. на чел./день</th>
                </tr>
              </thead>
              <tbody>
                {(capacityModal.teamCapacities as ProductTeamCapacity[]).map(ptc => (
                  <tr key={ptc.id}>
                    <td>{ptc.team.name}</td>
                    <td style={{ textAlign: 'right', fontVariantNumeric: 'tabular-nums' }}>
                      {ptc.capacityPerDay.toLocaleString('ru-RU')}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </>
  )
}
