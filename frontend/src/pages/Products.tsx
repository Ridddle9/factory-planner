import { useEffect, useState } from 'react'
import { api } from '../api'
import type { Product, ProductCategory } from '../types'

export default function Products() {
  const [list, setList] = useState<Product[]>([])
  const [categories, setCategories] = useState<ProductCategory[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [showForm, setShowForm] = useState(false)
  const [editing, setEditing] = useState<Product | null>(null)
  const [form, setForm] = useState({ code: '', name: '', categoryId: '' })
  const [saving, setSaving] = useState(false)

  const load = async () => {
    setLoading(true)
    const [prodRes, catRes] = await Promise.all([
      api.get<Product[]>('/products'),
      api.get<ProductCategory[]>('/categories'),
    ])
    setLoading(false)
    if (prodRes.error) {
      setError(prodRes.error)
      return
    }
    if (catRes.data) setCategories(catRes.data)
    setList(prodRes.data ?? [])
    setError(null)
  }

  useEffect(() => {
    load()
  }, [])

  const openCreate = () => {
    setShowForm(true)
    setEditing(null)
    setForm({ code: '', name: '', categoryId: categories[0]?.id ?? '' })
  }

  const openEdit = (p: Product) => {
    setEditing(p)
    setForm({ code: p.code, name: p.name, categoryId: p.categoryId })
  }

  const save = async () => {
    if (!form.code.trim() || !form.name.trim()) return
    if (!form.categoryId && !editing) return
    setSaving(true)
    if (editing) {
      const { error: e } = await api.put(`/products/${editing.id}`, {
        code: form.code.trim(),
        name: form.name.trim(),
        categoryId: form.categoryId || undefined,
      })
      if (e) setError(e)
      else {
        setEditing(null)
        setShowForm(false)
        load()
      }
    } else {
      const { error: e } = await api.post('/products', {
        code: form.code.trim(),
        name: form.name.trim(),
        categoryId: form.categoryId,
      })
      if (e) setError(e)
      else {
        setForm({ code: '', name: '', categoryId: categories[0]?.id ?? '' })
        setShowForm(false)
        load()
      }
    }
    setSaving(false)
  }

  const remove = async (id: string) => {
    if (!confirm('Удалить товар?')) return
    const { error: e } = await api.delete(`/products/${id}`)
    if (e) setError(e)
    else load()
  }

  if (loading) return <div className="card">Загрузка...</div>

  return (
    <>
      <h1 className="page-title">Товары</h1>
      {error && <div className="error">{error}</div>}
      <div className="card">
        <div className="toolbar">
          <button type="button" className="btn btn-primary" onClick={openCreate} disabled={categories.length === 0}>Добавить товар</button>
        </div>
        {(showForm || editing !== null) && (
          <div style={{ marginBottom: '1rem', paddingBottom: '1rem', borderBottom: '1px solid #eee' }}>
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
            <div className="form-actions">
              <button type="button" className="btn btn-primary" onClick={save} disabled={saving}>{editing ? 'Сохранить' : 'Создать'}</button>
              <button type="button" className="btn btn-secondary" onClick={() => { setShowForm(false); setEditing(null); setForm({ code: '', name: '', categoryId: '' }) }}>Отмена</button>
            </div>
          </div>
        )}
        {list.length === 0 ? (
          <div className="empty">Нет товаров. Сначала добавьте категории.</div>
        ) : (
          <table>
            <thead>
              <tr>
                <th>Код</th>
                <th>Название</th>
                <th>Категория</th>
                <th style={{ width: 140 }}></th>
              </tr>
            </thead>
            <tbody>
              {list.map(p => (
                <tr key={p.id}>
                  <td>{p.code}</td>
                  <td>{p.name}</td>
                  <td>{p.category?.name ?? '—'}</td>
                  <td>
                    <button type="button" className="btn btn-secondary btn-sm" onClick={() => openEdit(p)}>Изменить</button>
                    {' '}
                    <button type="button" className="btn btn-danger btn-sm" onClick={() => remove(p.id)}>Удалить</button>
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
