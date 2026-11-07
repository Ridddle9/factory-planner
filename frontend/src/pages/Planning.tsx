import { useEffect, useState, useMemo } from 'react'
import { api } from '../api'
import './planning.css'
import type { Team } from '../types'
import TeamLoad from './TeamLoad'

interface OrderCompletion {
  orderId: string
  orderNumber: string
  customer: string
  manager: string | null
  approvedAt: string | null
  totalItems: number
  unplannedItems: number
  totalQuantity: number
  totalPlanned: number
  totalProduced: number
  remaining: number
  completionPct: number
  expectedCompletionDate: string | null
  replanCount: number
}

// Сегодня по местному времени (toISOString дал бы дату по UTC — ночью по Москве это ещё вчера)
function todayISO() {
  const d = new Date()
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}
function formatDate(s: string) {
  return new Date(s).toLocaleDateString('ru-RU', { day: '2-digit', month: '2-digit' })
}
function formatDateFull(s: string) {
  return new Date(s).toLocaleDateString('ru-RU', { day: '2-digit', month: '2-digit', year: 'numeric' })
}
function daysDiff(a: string, b: string) {
  return Math.round((new Date(a).getTime() - new Date(b).getTime()) / 86400000)
}
type Tab = 'team-load' | 'orders-completion' | 'fact-day' | 'unplanned'


export default function Planning() {
  const [tab, setTab] = useState<Tab>('team-load')
  const [ordersCompletion, setOrdersCompletion] = useState<OrderCompletion[]>([])
  const [completionSearch, setCompletionSearch] = useState('')

  interface FactDayCategory { categoryId: string; categoryName: string; actual: number; items: number }
  interface FactDayTeam { teamId: string; teamName: string; totalActual: number; categories: FactDayCategory[] }
  const [factDayDate, setFactDayDate] = useState(todayISO())
  const [factDayData, setFactDayData] = useState<{ date: string; taskCount: number; teams: FactDayTeam[] } | null>(null)

  interface UnplannedItem {
    taskId: string; orderNumber: string; customer: string
    productCode: string; productName: string; categoryName: string | null; actualQuantity: number
  }
  const [unplannedData, setUnplannedData] = useState<{ date: string | null; count: number; items: UnplannedItem[] } | null>(null)

  const [teams, setTeams] = useState<Team[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  useEffect(() => {
    api.get<Team[]>('/teams').then(({ data }) => data && setTeams(data))
  }, [])

  const loadOrdersCompletion = async () => {
    setLoading(true); setError(null)
    const { data, error: e } = await api.get<{ count: number; orders: OrderCompletion[] }>('/planning/orders-completion')
    setLoading(false)
    if (e) setError(e); else setOrdersCompletion(data?.orders ?? [])
  }

  const loadUnplanned = async () => {
    setLoading(true); setError(null)
    const { data, error: e } = await api.get<{ date: string | null; count: number; items: UnplannedItem[] }>('/planning/unplanned-production')
    setLoading(false)
    if (e) setError(e); else setUnplannedData(data ?? null)
  }

  const loadFactDay = async (date: string) => {
    setLoading(true); setError(null)
    const { data, error: e } = await api.get<{ date: string; taskCount: number; teams: FactDayTeam[] }>(`/planning/fact-day?date=${date}`)
    setLoading(false)
    if (e) setError(e); else setFactDayData(data ?? null)
  }

  // Автозагрузка при смене вкладки / фильтров
  useEffect(() => {
    if (tab === 'orders-completion') loadOrdersCompletion()
    if (tab === 'fact-day') loadFactDay(factDayDate)
    if (tab === 'unplanned') loadUnplanned()
  }, [tab])

  // ── Завершение заказов: фильтрация и счётчики ─────────────────────
  const filteredOrders = useMemo(() => {
    if (!completionSearch.trim()) return ordersCompletion
    const q = completionSearch.toLowerCase()
    return ordersCompletion.filter(o =>
      o.orderNumber.toLowerCase().includes(q) ||
      o.customer.toLowerCase().includes(q) ||
      (o.manager ?? '').toLowerCase().includes(q)
    )
  }, [ordersCompletion, completionSearch])

  const completionStats = useMemo(() => ({
    done: ordersCompletion.filter(o => o.completionPct === 100).length,
    inProgress: ordersCompletion.filter(o => o.completionPct > 0 && o.completionPct < 100).length,
    notStarted: ordersCompletion.filter(o => o.completionPct === 0 && o.totalPlanned > 0).length,
    notPlanned: ordersCompletion.filter(o => o.totalPlanned === 0).length,
  }), [ordersCompletion])

  const HEADER_BG = 'var(--plan-header)'
  const HEADER_COLOR = 'var(--text-secondary)'

  return (
    <div className="planning-page">
      <div className="page-heading">
        <div>
          <h1 className="page-title">Аналитика планирования</h1>
          <p className="planning-description">План, фактический выпуск и доступные мощности.</p>
        </div>
      </div>

      {error && <div className="error">{error}</div>}

      {/* Табы */}
      <div className="tabs planning-tabs">
        {([
          ['team-load',         'Загрузка бригад'],
          // «Завершение заказов» пока скрыто (вкладка и данные остались)
          ['fact-day',          'Факт за день'],
          ['unplanned',         'Незапланированный факт'],
        ] as [Tab, string][]).map(([t, label]) => (
          <button key={t} type="button" className={`tab ${tab === t ? 'active' : ''}`} onClick={() => setTab(t)}>
            {label}
            {t === 'unplanned' && unplannedData && unplannedData.count > 0 && (
              <span className="badge badge-warning" style={{ marginLeft: 6 }}>{unplannedData.count}</span>
            )}
          </button>
        ))}
      </div>

      <div className="card planning-card">
        {/* ── ЗАГРУЗКА БРИГАД ── */}
        {tab === 'team-load' && <TeamLoad teams={teams} />}

        {/* ── ЗАВЕРШЕНИЕ ЗАКАЗОВ ── */}
        {tab === 'orders-completion' && (
          <>
            <div className="toolbar">
              <input
                type="text"
                placeholder="Поиск по номеру, клиенту, менеджеру…"
                value={completionSearch}
                onChange={e => setCompletionSearch(e.target.value)}
                className="toolbar-search"
                style={{ width: 280 }}
              />
              <button type="button" className="btn btn-secondary" onClick={loadOrdersCompletion} disabled={loading}>
                {loading ? 'Загрузка…' : 'Обновить'}
              </button>
            </div>

            {ordersCompletion.length > 0 && (
              <div style={{ display: 'flex', gap: '0.75rem', marginBottom: '1rem', flexWrap: 'wrap' }}>
                {completionStats.done > 0 && <span className="badge badge-success" style={{ fontSize: '0.83rem', padding: '4px 10px' }}>Готово: {completionStats.done}</span>}
                {completionStats.inProgress > 0 && <span className="badge badge-warning" style={{ fontSize: '0.83rem', padding: '4px 10px' }}>В работе: {completionStats.inProgress}</span>}
                {completionStats.notStarted > 0 && <span className="badge badge-neutral" style={{ fontSize: '0.83rem', padding: '4px 10px' }}>Запланировано: {completionStats.notStarted}</span>}
                {completionStats.notPlanned > 0 && <span className="badge badge-danger" style={{ fontSize: '0.83rem', padding: '4px 10px' }}>Не в плане: {completionStats.notPlanned}</span>}
                <span style={{ marginLeft: 'auto', fontSize: '0.82rem', color: 'var(--text-muted)', alignSelf: 'center' }}>
                  {filteredOrders.length} из {ordersCompletion.length} заказов
                </span>
              </div>
            )}

            {filteredOrders.length === 0 && !loading ? (
              <div className="empty">Нет заказов.</div>
            ) : (
              <table className="stack" style={{ width: '100%', borderCollapse: 'collapse' }}>
                <thead>
                  <tr style={{ background: 'var(--plan-surface-muted)', fontSize: '0.75rem', textTransform: 'none', letterSpacing: '0', color: 'var(--text-muted)' }}>
                    <th style={{ padding: '6px 12px', textAlign: 'left' }}>Заказ</th>
                    <th style={{ padding: '6px 12px', textAlign: 'left' }}>Клиент</th>
                    <th style={{ padding: '6px 12px', textAlign: 'left' }}>Менеджер</th>
                    <th style={{ padding: '6px 12px', textAlign: 'left' }}>Согласован</th>
                    <th style={{ padding: '6px 12px', textAlign: 'right' }}>Остаток</th>
                    <th style={{ padding: '6px 12px', minWidth: 160 }}>Выполнение</th>
                    <th style={{ padding: '6px 12px', textAlign: 'left' }}>Завершится</th>
                    <th style={{ padding: '6px 12px', textAlign: 'center' }} title="Сколько раз перепланировался заказ">↺</th>
                  </tr>
                </thead>
                <tbody>
                  {filteredOrders.map((ord, i) => {
                    const plannedPct = ord.totalQuantity > 0 ? Math.min(100, (ord.totalPlanned / ord.totalQuantity) * 100) : 0
                    const donePct = ord.totalQuantity > 0 ? Math.min(100, (ord.totalProduced / ord.totalQuantity) * 100) : 0
                    const today = todayISO()
                    const daysUntil = ord.expectedCompletionDate
                      ? daysDiff(ord.expectedCompletionDate.slice(0, 10), today)
                      : null

                    return (
                      <tr key={ord.orderId} style={{ borderBottom: '1px solid var(--border)', background: i % 2 === 0 ? '#fff' : 'var(--plan-surface-muted)' }}>
                        <td className="stack-title" style={{ padding: '8px 12px', fontWeight: 600 }}>{ord.orderNumber}</td>
                        <td data-label="Клиент" style={{ padding: '8px 12px', fontSize: '0.82rem', color: 'var(--text-muted)', maxWidth: 180, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={ord.customer}>{ord.customer}</td>
                        <td data-label="Менеджер" style={{ padding: '8px 12px', fontSize: '0.82rem', color: 'var(--text-muted)' }}>{ord.manager ?? '—'}</td>
                        <td data-label="Согласован" style={{ padding: '8px 12px', fontSize: '0.82rem' }}>{ord.approvedAt ? formatDate(ord.approvedAt) : '—'}</td>
                        <td data-label="Остаток" style={{ padding: '8px 12px', textAlign: 'right', fontWeight: 600, color: ord.remaining > 0 ? 'var(--text)' : 'var(--success)' }}>
                          {ord.remaining > 0 ? ord.remaining : <span className="badge badge-success">✓</span>}
                        </td>
                        <td className="stack-block" style={{ padding: '8px 12px' }}>
                          {/* Двойной прогресс-бар: факт (зелёный) + план (синий) */}
                          <div style={{ position: 'relative', height: 10, background: 'var(--border)', borderRadius: 5, overflow: 'hidden' }}
                            title={`Запланировано: ${ord.totalPlanned}, Выполнено: ${ord.totalProduced} / ${ord.totalQuantity}`}>
                            <div style={{ position: 'absolute', left: 0, top: 0, height: '100%', width: `${plannedPct}%`, background: 'var(--plan-scheduled-border)', borderRadius: 5 }} />
                            <div style={{ position: 'absolute', left: 0, top: 0, height: '100%', width: `${donePct}%`, background: 'var(--success)', borderRadius: 5 }} />
                          </div>
                          <div style={{ fontSize: '0.75rem', color: 'var(--text-muted)', marginTop: 2, display: 'flex', justifyContent: 'space-between' }}>
                            <span>план {ord.totalPlanned} · факт <span style={{ color: 'var(--success)', fontWeight: 600 }}>{ord.totalProduced}</span> / {ord.totalQuantity}</span>
                            {ord.unplannedItems > 0 && <span style={{ color: 'var(--danger)' }}>{ord.unplannedItems} не в плане</span>}
                          </div>
                        </td>
                        <td data-label="Завершится" style={{ padding: '8px 12px' }}>
                          {ord.expectedCompletionDate ? (
                            <span style={{ fontWeight: 600, color: daysUntil !== null && daysUntil <= 3 ? 'var(--warning)' : 'var(--success)' }}>
                              {formatDateFull(ord.expectedCompletionDate)}
                              {daysUntil !== null && daysUntil >= 0 && (
                                <span style={{ marginLeft: 6, fontSize: '0.75rem', fontWeight: 400, color: 'var(--text-muted)' }}>
                                  (+{daysUntil} дн.)
                                </span>
                              )}
                            </span>
                          ) : ord.totalPlanned === 0 ? (
                            <span className="badge badge-danger">Не в плане</span>
                          ) : (
                            <span style={{ color: 'var(--text-muted)' }}>—</span>
                          )}
                        </td>
                        <td data-label="Перепланирований" style={{ padding: '8px 12px', textAlign: 'center' }}>
                          {ord.replanCount > 0 ? (
                            <span title={`Перепланировался ${ord.replanCount} раз`} style={{ fontSize: '0.8rem', color: ord.replanCount >= 3 ? 'var(--danger)' : 'var(--text-muted)' }}>
                              ↺{ord.replanCount}
                            </span>
                          ) : (
                            <span style={{ color: 'var(--text-muted)', fontSize: '0.8rem' }}>—</span>
                          )}
                        </td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            )}
          </>
        )}
        {/* ── НЕЗАПЛАНИРОВАННЫЙ ФАКТ ── */}
        {tab === 'unplanned' && (
          <>
            <div className="toolbar">
              <button type="button" className="btn btn-secondary" onClick={loadUnplanned} disabled={loading}>
                {loading ? 'Загрузка…' : 'Обновить'}
              </button>
              {unplannedData?.date && (
                <span style={{ fontSize: '0.83rem', color: 'var(--text-muted)' }}>
                  Последняя дата с фактом: <strong>{formatDateFull(new Date(unplannedData.date).toISOString().slice(0, 10))}</strong>
                </span>
              )}
            </div>

            {!unplannedData && !loading && <div className="empty">Нет данных.</div>}

            {unplannedData && unplannedData.count === 0 && (
              <div className="empty" style={{ color: 'var(--success)' }}>
                Всё произведённое было запланировано — незапланированного факта нет.
              </div>
            )}

            {unplannedData && unplannedData.count > 0 && (
              <>
                <div style={{ marginBottom: 12, padding: '8px 12px', background: 'var(--warning-light)', border: '1px solid var(--plan-warning-border)', borderRadius: 6, fontSize: '0.85rem', color: 'var(--warning)' }}>
                  Произведено без плана: <strong>{unplannedData.count} позиций</strong>
                </div>
                <table className="stack" style={{ width: '100%', borderCollapse: 'collapse' }}>
                  <thead>
                    <tr style={{ background: 'var(--plan-surface-muted)', fontSize: '0.75rem', textTransform: 'none', letterSpacing: '0', color: 'var(--text-muted)' }}>
                      <th style={{ padding: '6px 12px', textAlign: 'left' }}>Заказ</th>
                      <th style={{ padding: '6px 12px', textAlign: 'left' }}>Клиент</th>
                      <th style={{ padding: '6px 12px', textAlign: 'left' }}>Категория</th>
                      <th style={{ padding: '6px 12px', textAlign: 'left' }}>Продукт</th>
                      <th style={{ padding: '6px 12px', textAlign: 'right' }}>Факт, шт.</th>
                    </tr>
                  </thead>
                  <tbody>
                    {unplannedData.items.map((item, i) => (
                      <tr key={item.taskId} style={{ borderBottom: '1px solid var(--border)', background: i % 2 === 0 ? '#fff' : 'var(--plan-surface-muted)' }}>
                        <td className="stack-title" style={{ padding: '7px 12px', fontWeight: 600 }}>{item.orderNumber}</td>
                        <td data-label="Клиент" style={{ padding: '7px 12px', fontSize: '0.82rem', color: 'var(--text-muted)', maxWidth: 160, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={item.customer}>{item.customer}</td>
                        <td data-label="Категория" style={{ padding: '7px 12px', fontSize: '0.82rem', color: 'var(--text-muted)' }}>{item.categoryName ?? '—'}</td>
                        <td className="stack-block" style={{ padding: '7px 12px', fontSize: '0.82rem' }}>
                          <span style={{ fontWeight: 600 }}>{item.productCode}</span>
                          <div style={{ fontSize: '0.75rem', color: 'var(--text-muted)', marginTop: 1 }}>{item.productName}</div>
                        </td>
                        <td data-label="Факт, шт." style={{ padding: '7px 12px', textAlign: 'right', fontWeight: 600, color: 'var(--warning)' }}>
                          {item.actualQuantity.toLocaleString('ru-RU')}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </>
            )}
          </>
        )}

        {/* ── ФАКТ ЗА ДЕНЬ ── */}
        {tab === 'fact-day' && (
          <>
            <div className="toolbar">
              <label style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                Дата: <input type="date" value={factDayDate} onChange={e => { setFactDayDate(e.target.value); loadFactDay(e.target.value) }} />
              </label>
              <button type="button" className="btn btn-secondary" onClick={() => loadFactDay(factDayDate)} disabled={loading}>
                {loading ? 'Загрузка…' : 'Обновить'}
              </button>
              {factDayData && (
                <span style={{ fontSize: '0.83rem', color: 'var(--text-muted)' }}>
                  {factDayData.taskCount} записей · {factDayData.teams.length} бригад
                </span>
              )}
            </div>

            {!factDayData && !loading && <div className="empty">Нет данных за выбранную дату.</div>}

            {factDayData && factDayData.teams.length === 0 && (
              <div className="empty">Факт за {factDayDate} не найден — сделайте синк из 1С.</div>
            )}

            {factDayData && factDayData.teams.map(team => (
              <div key={team.teamId} style={{ marginBottom: '1.25rem' }}>
                <div style={{
                  display: 'flex', alignItems: 'center', gap: 12,
                  background: HEADER_BG, color: HEADER_COLOR,
                  borderRadius: '6px 6px 0 0', padding: '6px 12px',
                }}>
                  <span style={{ fontWeight: 600 }}>{team.teamName}</span>
                  <span style={{ marginLeft: 'auto', fontWeight: 600, fontSize: '0.9rem' }}>
                    {team.totalActual.toLocaleString('ru-RU')} шт.
                  </span>
                </div>
                <table className="stack" style={{ width: '100%', borderCollapse: 'collapse' }}>
                  <thead>
                    <tr style={{ background: 'var(--plan-surface-muted)', fontSize: '0.75rem', textTransform: 'none', letterSpacing: '0', color: 'var(--text-muted)' }}>
                      <th style={{ padding: '4px 12px', textAlign: 'left' }}>Категория</th>
                      <th style={{ padding: '4px 12px', textAlign: 'right' }}>Позиций</th>
                      <th style={{ padding: '4px 12px', textAlign: 'right' }}>Факт, шт.</th>
                    </tr>
                  </thead>
                  <tbody>
                    {team.categories.map((cat, i) => (
                      <tr key={cat.categoryId} style={{ borderBottom: '1px solid var(--border)', background: i % 2 === 0 ? '#fff' : 'var(--plan-surface-muted)' }}>
                        <td className="stack-title" style={{ padding: '6px 12px', fontWeight: 500 }}>{cat.categoryName}</td>
                        <td data-label="Позиций" style={{ padding: '6px 12px', textAlign: 'right', color: 'var(--text-muted)', fontSize: '0.82rem' }}>{cat.items}</td>
                        <td data-label="Факт, шт." style={{ padding: '6px 12px', textAlign: 'right', fontWeight: 600, color: 'var(--success)' }}>
                          {cat.actual.toLocaleString('ru-RU')}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ))}
          </>
        )}
      </div>
    </div>
  )
}
