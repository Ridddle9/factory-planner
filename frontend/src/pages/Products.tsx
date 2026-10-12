import { useEffect, useState } from 'react'
import { api } from '../api'
import type { Product, ProductCategory, ProductTeamCapacity } from '../types'

export default function Products() {
  const [list, setList] = useState<Product[]>([])
  const [categories, setCategories] = useState<ProductCategory[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [showForm, setShowForm] = useState(false)
  const [editing, setEditing] = useState<Product | null>(null)
  const [form, setForm] = useState({ code: '', name: '', categoryId: '', capacityPerDay: '' })
  const [saving, setSaving] = useState(false)
  const [search, setSearch] = useState('')
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
    setForm({ code: '', name: '', categoryId: categories[0]?.id ?? '', capacityPerDay: '' })
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

  const filtered = search.trim()
    ? list.filter(p => p.code.toLowerCase().includes(search.toLowerCase()) || p.name.toLowerCase().includes(search.toLowerCase()))
    : list

  if (loading) return <div className="card">Загрузка...</div>

  return (
    <>
      <h1 className="page-title">Товары</h1>
      {error && <div className="error">{error}</div>}
      <div className="card">
        <div className="toolbar">
          <button type="button" className="btn btn-primary" onClick={openCreate} disabled={categories.length === 0}>Добавить товар</button>
          <input
            style={{ marginLeft: 8, padding: '4px 8px', border: '1px solid var(--border)', borderRadius: 4, fontSize: '0.875rem' }}
            placeholder="Поиск по коду / названию"
            value={search}
            onChange={e => setSearch(e.target.value)}
          />
        </div>

        {(showForm || editing !== null) && (
          <div style={{ marginBottom: '1rem', paddingBottom: '1rem', borderBottom: '1px solid var(--border)' }}>
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
              Произв. на 1 человека/день
              <span style={{ fontWeight: 400, color: 'var(--text-muted)', marginLeft: 6, fontSize: '0.82rem' }}>
                (оставьте пустым — возьмёт из 1С)
              </span>
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
          <div className="empty">{search ? 'Ничего не найдено' : 'Нет товаров. Сначала добавьте категории.'}</div>
        ) : (
          <table>
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
                  <td>{p.code}</td>
                  <td>{p.name}</td>
                  <td>{p.category?.name ?? '—'}</td>
                  <td style={{ fontVariantNumeric: 'tabular-nums' }}>
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
                  <td>
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
            style={{ minWidth: 380, maxWidth: 560, maxHeight: '80vh', overflowY: 'auto' }}
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
