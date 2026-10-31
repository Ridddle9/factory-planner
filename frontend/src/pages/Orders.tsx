import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { api } from '../api'
import { useScrollToForm } from '../useScrollToForm'
import type { Order } from '../types'

type CompletionInfo = { expectedCompletionDate: string | null; completionPct: number }
type CompletionMap = Record<string, CompletionInfo>

type Tab = 'active' | 'archive'

export default function Orders() {
  const [list, setList] = useState<Order[]>([])
  const [completion, setCompletion] = useState<CompletionMap>({})
  const [tab, setTab] = useState<Tab>('active')
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [showForm, setShowForm] = useState(false)
  const formRef = useScrollToForm(showForm ? 'new' : null)
  const [form, setForm] = useState({
    orderNumber: '',
    customer: '',
    description: '',
    manager: '',
    paymentTerms: '',
  })
  const [saving, setSaving] = useState(false)
  const [search, setSearch] = useState('')

  const load = async () => {
    setLoading(true)
    const [ordersRes, completionRes] = await Promise.all([
      api.get<Order[]>('/orders'),
      api.get<{ orders: { orderId: string; expectedCompletionDate: string | null; completionPct: number }[] }>('/planning/orders-completion'),
    ])
    setLoading(false)
    if (ordersRes.error) { setError(ordersRes.error); return }
    setList(ordersRes.data ?? [])
    const map: CompletionMap = {}
    for (const c of completionRes.data?.orders ?? []) {
      map[c.orderId] = { expectedCompletionDate: c.expectedCompletionDate, completionPct: c.completionPct }
    }
    setCompletion(map)
    setError(null)
  }

  useEffect(() => { load() }, [])

  const openCreate = () => {
    setShowForm(true)
    setForm({ orderNumber: '', customer: '', description: '', manager: '', paymentTerms: '' })
  }

  const save = async () => {
    if (!form.orderNumber.trim() || !form.customer.trim()) return
    setSaving(true)
    const body: Record<string, unknown> = {
      orderNumber: form.orderNumber.trim(),
      customer: form.customer.trim(),
    }
    if (form.description.trim()) body.description = form.description.trim()
    if (form.manager.trim()) body.manager = form.manager.trim()
    if (form.paymentTerms.trim()) body.paymentTerms = form.paymentTerms.trim()
    const { error: e } = await api.post('/orders', body)
    if (e) setError(e)
    else { setShowForm(false); load() }
    setSaving(false)
  }

  const remove = async (id: string, e: React.MouseEvent) => {
    e.preventDefault()
    e.stopPropagation()
    if (!confirm('Удалить заказ?')) return
    const { error: err } = await api.delete(`/orders/${id}`)
    if (err) setError(err)
    else load()
  }

  const formatDate = (s: string | null) => {
    if (!s) return '—'
    return new Date(s).toLocaleDateString('ru-RU')
  }

  const priorityLabel = (p: number) => {
    if (p <= 5)  return { text: 'Критический', color: '#dc2626' }
    if (p <= 10) return { text: 'Высокий',     color: '#ea580c' }
    if (p <= 20) return { text: 'Средний',      color: 'var(--text-muted)' }
    return              { text: 'Низкий',       color: 'var(--text-muted)', opacity: 0.6 }
  }

  const isDone = (id: string) => (completion[id]?.completionPct ?? 0) >= 100

  const active = list.filter(o => !isDone(o.id))
  const archive = list.filter(o => isDone(o.id))
  const tabList = tab === 'active' ? active : archive

  // Поиск: номер заказа (можно часть — «7988»), клиент, менеджер, код или название товара в заказе
  const norm = (v: string | null | undefined) => (v ?? '').toLowerCase().replace(/ё/g, 'е')
  const q = norm(search.trim())
  const shown = q
    ? tabList.filter(o =>
        norm(o.orderNumber).includes(q) || norm(o.customer).includes(q) || norm(o.manager).includes(q) ||
        (o.items ?? []).some(i => norm(i.product?.code).includes(q) || norm(i.product?.name).includes(q)))
    : tabList

  const tabStyle = (t: Tab): React.CSSProperties => ({
    padding: '6px 18px',
    fontWeight: tab === t ? 700 : 400,
    color: tab === t ? 'var(--primary)' : 'var(--text-muted)',
    background: 'none',
    border: 'none',
    borderBottom: tab === t ? '2px solid var(--primary)' : '2px solid transparent',
    cursor: 'pointer',
    fontSize: '0.9rem',
  })

  if (loading) return <div className="card">Загрузка...</div>

  return (
    <>
      <h1 className="page-title">Заказы</h1>
      {error && <div className="error">{error}</div>}
      <div className="card">

        {/* Tabs */}
        <div style={{ display: 'flex', gap: 0, borderBottom: '1px solid var(--border)', marginBottom: '1rem' }}>
          <button style={tabStyle('active')} onClick={() => setTab('active')}>
            Актуальные {active.length > 0 && <span style={{ marginLeft: 4, fontSize: '0.78rem', opacity: 0.7 }}>({active.length})</span>}
          </button>
          <button style={tabStyle('archive')} onClick={() => setTab('archive')}>
            Архив {archive.length > 0 && <span style={{ marginLeft: 4, fontSize: '0.78rem', opacity: 0.7 }}>({archive.length})</span>}
          </button>
        </div>

        <div className="toolbar" style={{ marginBottom: q ? 16 : '1rem' }}>
          {tab === 'active' && <button type="button" className="btn btn-primary" onClick={openCreate}>Создать заказ</button>}
          <input
            className="toolbar-search toolbar-field"
            type="search"
            placeholder="Поиск: номер, клиент, менеджер, товар"
            value={search}
            onChange={e => setSearch(e.target.value)}
          />
          {search && <button type="button" className="btn btn-secondary" onClick={() => setSearch('')}>Сбросить</button>}
        </div>
        {q && <div className="toolbar-summary">Найдено {shown.length} из {tabList.length}</div>}

        {showForm && tab === 'active' && (
          <div className="form-panel" ref={formRef}>
            <h3 className="form-panel-title">Новый заказ</h3>
            <label>Номер заказа *</label>
            <input value={form.orderNumber} onChange={e => setForm(f => ({ ...f, orderNumber: e.target.value }))} placeholder="00ЦБ-001213" />
            <label>Клиент *</label>
            <input value={form.customer} onChange={e => setForm(f => ({ ...f, customer: e.target.value }))} placeholder="Клиент" />
            <label>Описание</label>
            <textarea value={form.description} onChange={e => setForm(f => ({ ...f, description: e.target.value }))} placeholder="Описание" />
            <label>Менеджер</label>
            <input value={form.manager} onChange={e => setForm(f => ({ ...f, manager: e.target.value }))} placeholder="Менеджер" />
            <label>Условия оплаты</label>
            <input value={form.paymentTerms} onChange={e => setForm(f => ({ ...f, paymentTerms: e.target.value }))} placeholder="Рассрочка 60 к.дней" />
            <div className="form-actions">
              <button type="button" className="btn btn-primary" onClick={save} disabled={saving}>Создать</button>
              <button type="button" className="btn btn-secondary" onClick={() => setShowForm(false)}>Отмена</button>
            </div>
          </div>
        )}

        {shown.length === 0 ? (
          <div className="empty">
            {q ? 'Ничего не найдено.' : tab === 'active' ? 'Нет актуальных заказов.' : 'Нет архивных заказов.'}
          </div>
        ) : (
          <table className="stack sticky-head">
            <thead>
              <tr>
                <th>Номер</th>
                <th>Клиент</th>
                {tab === 'active' && <th>Готово по плану</th>}
                <th>Приоритет</th>
                <th>Менеджер</th>
                <th>Позиций</th>
                <th style={{ width: 100 }}></th>
              </tr>
            </thead>
            <tbody>
              {shown.map(o => {
                const info = completion[o.id]
                const expected = info?.expectedCompletionDate ?? null
                return (
                  <tr key={o.id}>
                    <td className="stack-title"><Link to={`/orders/${o.id}`}>{o.orderNumber}</Link></td>
                    <td data-label="Клиент">{o.customer}</td>
                    {tab === 'active' && (
                      <td data-label="Готово по плану" style={{ color: expected ? '#16a34a' : 'var(--text-muted)', fontWeight: expected ? 600 : undefined }}>
                        {expected ? formatDate(expected) : '—'}
                      </td>
                    )}
                    <td data-label="Приоритет">
                      {(() => { const pl = priorityLabel(o.priority ?? 20); return <span style={{ color: pl.color, fontSize: '0.82rem', fontWeight: 600 }}>{pl.text}</span> })()}
                    </td>
                    <td data-label="Менеджер">{o.manager ?? '—'}</td>
                    <td data-label="Позиций">{o.items?.length ?? 0}</td>
                    <td className="stack-actions">
                      <button type="button" className="btn btn-danger btn-sm" onClick={e => remove(o.id, e)}>Удалить</button>
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        )}
      </div>
    </>
  )
}
