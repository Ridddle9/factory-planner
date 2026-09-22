import { useEffect, useState } from 'react'
import { useParams, Link } from 'react-router-dom'
import { api } from '../api'
import type { Order, OrderItem, Product } from '../types'

export default function OrderDetail() {
  const { id } = useParams<{ id: string }>()
  const [order, setOrder] = useState<Order | null>(null)
  const [items, setItems] = useState<OrderItem[]>([])
  const [products, setProducts] = useState<Product[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [editingOrder, setEditingOrder] = useState(false)
  const [orderForm, setOrderForm] = useState({ orderNumber: '', customer: '', description: '', manager: '', paymentTerms: '' })
  const [itemForm, setItemForm] = useState({ productId: '', quantity: 1 })
  const [showItemForm, setShowItemForm] = useState(false)
  const [editingItem, setEditingItem] = useState<OrderItem | null>(null)
  const [saving, setSaving] = useState(false)

  const load = async () => {
    if (!id) return
    setLoading(true)
    const [ordersRes, itemsRes, productsRes] = await Promise.all([
      api.get<Order[]>('/orders'),
      api.get<OrderItem[]>(`/order-items?orderId=${id}`),
      api.get<Product[]>('/products'),
    ])
    setLoading(false)
    if (ordersRes.error) {
      setError(ordersRes.error)
      return
    }
    const ord = (ordersRes.data ?? []).find(o => o.id === id)
    setOrder(ord ?? null)
    if (ord) {
      setOrderForm({
        orderNumber: ord.orderNumber,
        customer: ord.customer,
        description: ord.description ?? '',
        manager: ord.manager ?? '',
        paymentTerms: ord.paymentTerms ?? '',
      })
    }
    setItems(itemsRes.data ?? [])
    setProducts(productsRes.data ?? [])
    setError(null)
  }

  useEffect(() => {
    load()
  }, [id])

  const saveOrder = async () => {
    if (!order) return
    setSaving(true)
    const body: Record<string, unknown> = {
      orderNumber: orderForm.orderNumber.trim(),
      customer: orderForm.customer.trim(),
      description: orderForm.description.trim() || null,
      manager: orderForm.manager.trim() || null,
      paymentTerms: orderForm.paymentTerms.trim() || null,
    }
    const { error: e } = await api.put(`/orders/${order.id}`, body)
    if (e) setError(e)
    else {
      setEditingOrder(false)
      load()
    }
    setSaving(false)
  }

  const addItem = async () => {
    if (!id || !itemForm.productId || itemForm.quantity < 1) return
    setSaving(true)
    const { error: e } = await api.post('/order-items', {
      orderId: id,
      productId: itemForm.productId,
      quantity: Math.floor(Number(itemForm.quantity)) || 1,
    })
    if (e) setError(e)
    else {
      setItemForm({ productId: '', quantity: 1 })
      setShowItemForm(false)
      load()
    }
    setSaving(false)
  }

  const updateItem = async () => {
    if (!editingItem) return
    setSaving(true)
    const { error: e } = await api.put(`/order-items/${editingItem.id}`, {
      productId: editingItem.productId,
      quantity: Math.floor(Number(editingItem.quantity)) || 1,
    })
    if (e) setError(e)
    else {
      setEditingItem(null)
      load()
    }
    setSaving(false)
  }

  const removeItem = async (itemId: string) => {
    if (!confirm('Удалить позицию?')) return
    const { error: e } = await api.delete(`/order-items/${itemId}`)
    if (e) setError(e)
    else load()
  }

  const [autoPlanning, setAutoPlanning] = useState(false)
  const [autoPlanMessage, setAutoPlanMessage] = useState<string | null>(null)
  const [replanning, setReplanning] = useState(false)
  const [replanMessage, setReplanMessage] = useState<string | null>(null)

  const replanOrder = async () => {
    if (!id) return
    setReplanning(true)
    setReplanMessage(null)
    setAutoPlanMessage(null)
    const { data, error: e } = await api.post<{ message: string; successful: number; overloaded: number }>(`/orders/${id}/replan`, { force: false })
    setReplanning(false)
    if (e) {
      setError(e)
      return
    }
    if (data) {
      setReplanMessage(data.message ?? `Перепланировано: ${data.successful} позиций. ${data.overloaded ? `Перегрузка: ${data.overloaded}.` : ''}`)
      load()
    }
  }

  const autoPlanOrder = async () => {
    if (!id) return
    setAutoPlanning(true)
    setAutoPlanMessage(null)
    const { data, error: e } = await api.post<{ successful: number; failed: number; overloaded: number; totalItems: number }>(`/orders/${id}/auto-plan`, {})
    setAutoPlanning(false)
    if (e) {
      setError(e)
      return
    }
    if (data) {
      setAutoPlanMessage(`Создано задач: ${data.successful} из ${data.totalItems}. ${data.overloaded ? `Перегрузка по срокам: ${data.overloaded} позиций.` : ''}`)
      load()
    }
  }

  const autoPlanItem = async (itemId: string) => {
    setAutoPlanning(true)
    setAutoPlanMessage(null)
    const { data, error: e } = await api.post<{ tasksCreated: number; overloaded: boolean }>(`/order-items/${itemId}/auto-plan`, {})
    setAutoPlanning(false)
    if (e) {
      setError(e)
      return
    }
    if (data) {
      setAutoPlanMessage(data.overloaded ? `Создано ${data.tasksCreated} задач (часть после срока).` : `Создано ${data.tasksCreated} задач.`)
      load()
    }
  }

  if (loading) return <div className="card">Загрузка...</div>
  if (!order) return <div className="card">Заказ не найден. <Link to="/orders">К списку заказов</Link></div>

  return (
    <>
      <h1 className="page-title">
        <Link to="/orders">Заказы</Link> → {order.orderNumber}
      </h1>
      {error && <div className="error">{error}</div>}
      <div className="card">
        {!editingOrder ? (
          <>
            <p><strong>Клиент:</strong> {order.customer}</p>
            <p><strong>Менеджер:</strong> {order.manager ?? '—'}</p>
            {order.description && <p><strong>Описание:</strong> {order.description}</p>}
            <button type="button" className="btn btn-secondary" onClick={() => setEditingOrder(true)}>Изменить заказ</button>
          </>
        ) : (
          <>
            <label>Номер заказа</label>
            <input value={orderForm.orderNumber} onChange={e => setOrderForm(f => ({ ...f, orderNumber: e.target.value }))} />
            <label>Клиент</label>
            <input value={orderForm.customer} onChange={e => setOrderForm(f => ({ ...f, customer: e.target.value }))} />
            <label>Описание</label>
            <textarea value={orderForm.description} onChange={e => setOrderForm(f => ({ ...f, description: e.target.value }))} />
            <label>Менеджер</label>
            <input value={orderForm.manager} onChange={e => setOrderForm(f => ({ ...f, manager: e.target.value }))} />
            <label>Условия оплаты</label>
            <input value={orderForm.paymentTerms} onChange={e => setOrderForm(f => ({ ...f, paymentTerms: e.target.value }))} />
            <div className="form-actions">
              <button type="button" className="btn btn-primary" onClick={saveOrder} disabled={saving}>Сохранить</button>
              <button type="button" className="btn btn-secondary" onClick={() => setEditingOrder(false)}>Отмена</button>
            </div>
          </>
        )}
      </div>
      <div className="card">
        <h2 style={{ marginTop: 0 }}>Позиции заказа</h2>
        {(autoPlanMessage || replanMessage) && (
          <div style={{ marginBottom: '0.5rem', color: '#2a7c59', fontSize: '0.9rem' }}>
            {autoPlanMessage}
            {replanMessage && <div>{replanMessage}</div>}
          </div>
        )}
        <div className="toolbar">
          <button type="button" className="btn btn-primary" onClick={() => { setShowItemForm(true); setEditingItem(null) }} disabled={products.length === 0}>
            Добавить позицию
          </button>
          <button type="button" className="btn btn-primary" onClick={autoPlanOrder} disabled={items.length === 0 || autoPlanning} title="Нужны: срок поставки у заказа и назначенные бригады у категории товара (Справочники → Категории → Бригады)">
            {autoPlanning ? 'Планирование…' : 'Автоплан по заказу'}
          </button>
          <button type="button" className="btn btn-secondary" onClick={replanOrder} disabled={items.length === 0 || replanning} title="Удалить старые задачи и перепланировать заказ с учётом текущей загрузки">
            {replanning ? 'Перепланирование…' : 'Перепланировать заказ'}
          </button>
        </div>
        <p style={{ margin: '0.25rem 0 0', fontSize: '0.8rem', color: '#666' }}>
          Автоплан: нужны <strong>бригады у категории</strong> (Справочники → Категории → «Бригады»). Перепланирование удаляет старые задачи и заново распределяет позиции с учётом загрузки.
        </p>
        {(showItemForm || editingItem) && (
          <div style={{ marginBottom: '1rem', paddingBottom: '1rem', borderBottom: '1px solid #eee' }}>
            <label>Товар</label>
            <select
              value={editingItem?.productId ?? itemForm.productId}
              onChange={e => editingItem ? setEditingItem({ ...editingItem, productId: e.target.value }) : setItemForm(f => ({ ...f, productId: e.target.value }))}
              disabled={!!editingItem}
            >
              <option value="">— выберите —</option>
              {products.map(p => (
                <option key={p.id} value={p.id}>{p.code} — {p.name}</option>
              ))}
            </select>
            <label>Количество</label>
            <input
              type="number"
              min={1}
              value={editingItem ? editingItem.quantity : itemForm.quantity}
              onChange={e => editingItem ? setEditingItem({ ...editingItem, quantity: Number(e.target.value) || 1 }) : setItemForm(f => ({ ...f, quantity: Number(e.target.value) || 1 }))}
            />
            <div className="form-actions">
              <button type="button" className="btn btn-primary" onClick={editingItem ? updateItem : addItem} disabled={saving}>
                {editingItem ? 'Сохранить' : 'Добавить'}
              </button>
              <button type="button" className="btn btn-secondary" onClick={() => { setShowItemForm(false); setEditingItem(null) }}>Отмена</button>
            </div>
          </div>
        )}
        {items.length === 0 ? (
          <div className="empty">Нет позиций. Добавьте товары из справочника.</div>
        ) : (
          <table>
            <thead>
              <tr>
                <th>Товар</th>
                <th>Код</th>
                <th>Количество</th>
                <th>К обеспечению</th>
                <th style={{ width: 220 }}></th>
              </tr>
            </thead>
            <tbody>
              {items.map(item => (
                <tr key={item.id}>
                  <td>{item.product?.name ?? '—'}</td>
                  <td>{item.product?.code ?? '—'}</td>
                  <td>{item.quantity}</td>
                  <td>{item.remainingQuantity !== undefined ? item.remainingQuantity : '—'}</td>
                  <td>
                    <button type="button" className="btn btn-primary btn-sm" onClick={() => autoPlanItem(item.id)} disabled={autoPlanning}>Автоплан</button>
                    {' '}
                    <button type="button" className="btn btn-secondary btn-sm" onClick={() => setEditingItem(item)}>Изменить</button>
                    {' '}
                    <button type="button" className="btn btn-danger btn-sm" onClick={() => removeItem(item.id)}>Удалить</button>
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
