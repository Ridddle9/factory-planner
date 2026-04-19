import { useEffect, useState, useMemo } from 'react'
import { api } from '../api'
import type { DailyTask, Team } from '../types'

interface OrderCompletion {
  orderId: string
  orderNumber: string
  customer: string
  manager: string | null
  approvedAt: string | null
  dueDate: string | null
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

function todayISO() {
  return new Date().toISOString().slice(0, 10)
}
function addDays(iso: string, days: number) {
  const d = new Date(iso)
  d.setDate(d.getDate() + days)
  return d.toISOString().slice(0, 10)
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
function getDatesInRange(from: string, to: string) {
  const dates: string[] = []
  const cur = new Date(from)
  const end = new Date(to)
  while (cur <= end) { dates.push(cur.toISOString().slice(0, 10)); cur.setDate(cur.getDate() + 1) }
  return dates
}
function isWeekend(iso: string) {
  const d = new Date(iso + 'T00:00:00').getDay()
  return d === 0 || d === 6
}

interface UnderloadItem {
  teamId: string; teamName: string; date: string
  planned: number; loadFraction: number; utilization: number
}
interface TeamLoadCategory {
  categoryId: string; categoryName: string; capacity: number; planned: number; utilization: number
}
interface TeamLoadDay {
  date: string; totalLoadFraction: number; categories: Record<string, TeamLoadCategory>
}

type Tab = 'overload' | 'underload' | 'team-load' | 'orders-completion'


function UtilBar({ value, capacity }: { value: number; capacity: number }) {
  const pct = capacity > 0 ? Math.min(100, (value / capacity) * 100) : 0
  const color = pct >= 90 ? 'var(--success)' : pct >= 50 ? 'var(--warning)' : 'var(--danger)'
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
      <div style={{ flex: 1, height: 8, background: '#e2e8f0', borderRadius: 4, overflow: 'hidden', minWidth: 80 }}>
        <div style={{ width: `${pct}%`, height: '100%', background: color, borderRadius: 4, transition: 'width 0.3s' }} />
      </div>
      <span style={{ fontSize: '0.78rem', fontWeight: 600, color, minWidth: 38, textAlign: 'right' }}>{pct.toFixed(0)}%</span>
    </div>
  )
}

export default function Planning() {
  const [tab, setTab] = useState<Tab>('overload')
  const [dateFrom, setDateFrom] = useState(todayISO())
  const [dateTo, setDateTo] = useState(addDays(todayISO(), 13))
  const [teamId, setTeamId] = useState('')

  const [overloadTasks, setOverloadTasks] = useState<DailyTask[]>([])
  const [underloaded, setUnderloaded] = useState<UnderloadItem[]>([])
  const [teamLoad, setTeamLoad] = useState<{ teamName: string; loads: TeamLoadDay[] } | null>(null)
  const [ordersCompletion, setOrdersCompletion] = useState<OrderCompletion[]>([])
  const [completionSearch, setCompletionSearch] = useState('')

  const [teams, setTeams] = useState<Team[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [replanning, setReplanning] = useState(false)
  const [replanResult, setReplanResult] = useState<string | null>(null)

  useEffect(() => {
    api.get<Team[]>('/teams').then(({ data }) => data && setTeams(data))
  }, [])

  const loadOverload = async () => {
    setLoading(true); setError(null)
    const params = new URLSearchParams({ dateFrom })
    if (dateTo) params.set('dateTo', dateTo)
    const { data, error: e } = await api.get<{ count: number; tasks: DailyTask[] }>(`/planning/overload?${params}`)
    setLoading(false)
    if (e) setError(e); else setOverloadTasks(data?.tasks ?? [])
  }

  const loadUnderload = async () => {
    setLoading(true); setError(null)
    const { data, error: e } = await api.get<{ count: number; underloaded: UnderloadItem[] }>(
      `/planning/underload?dateFrom=${dateFrom}&dateTo=${dateTo}`
    )
    setLoading(false)
    if (e) setError(e); else setUnderloaded(data?.underloaded ?? [])
  }

  const loadTeamLoad = async () => {
    if (!teamId) return
    setLoading(true); setError(null)
    const { data, error: e } = await api.get<{ teamName: string; loads: TeamLoadDay[] }>(
      `/planning/team-load?teamId=${teamId}&dateFrom=${dateFrom}&dateTo=${dateTo}`
    )
    setLoading(false)
    if (e) setError(e); else setTeamLoad(data ? { teamName: data.teamName, loads: data.loads ?? [] } : null)
  }

  const loadOrdersCompletion = async () => {
    setLoading(true); setError(null)
    const { data, error: e } = await api.get<{ count: number; orders: OrderCompletion[] }>('/planning/orders-completion')
    setLoading(false)
    if (e) setError(e); else setOrdersCompletion(data?.orders ?? [])
  }

  // Автозагрузка при смене вкладки / фильтров
  useEffect(() => {
    if (tab === 'overload') loadOverload()
    if (tab === 'underload') loadUnderload()
    if (tab === 'orders-completion') loadOrdersCompletion()
  }, [tab, dateFrom, dateTo])

  useEffect(() => {
    if (tab === 'team-load' && teamId) loadTeamLoad()
  }, [tab, teamId, dateFrom, dateTo])

  const replanQueue = async () => {
    if (!confirm('Удалить все незапущенные задачи и перепланировать все позиции от старых заказов к новым?')) return
    setReplanning(true); setReplanResult(null)
    const { data, error: e } = await api.post<{ message: string; deletedTasks: number; planned: number; failed: number }>(
      '/planning/replan-queue', {}
    )
    setReplanning(false)
    if (e) setReplanResult(`Ошибка: ${e}`)
    else if (data) setReplanResult(`${data.message} Удалено задач: ${data.deletedTasks}.`)
  }

  // ── Перегрузка: группировка по заказу ────────────────────────────
  const overloadByOrder = useMemo(() => {
    const map = new Map<string, { orderNumber: string; dueDate: string | null; tasks: DailyTask[] }>()
    for (const t of overloadTasks) {
      const orderId = t.orderItem?.order?.orderNumber ?? '—'
      if (!map.has(orderId)) map.set(orderId, {
        orderNumber: t.orderItem?.order?.orderNumber ?? '—',
        dueDate: t.orderItem?.order?.dueDate ?? null,
        tasks: [],
      })
      map.get(orderId)!.tasks.push(t)
    }
    return Array.from(map.values())
  }, [overloadTasks])

  // ── Недогрузка: группировка по бригаде ───────────────────────────
  const underloadByTeam = useMemo(() => {
    const map = new Map<string, { teamName: string; days: UnderloadItem[] }>()
    for (const u of underloaded) {
      if (!map.has(u.teamId)) map.set(u.teamId, { teamName: u.teamName, days: [] })
      map.get(u.teamId)!.days.push(u)
    }
    return Array.from(map.values()).sort((a, b) => a.teamName.localeCompare(b.teamName, 'ru'))
  }, [underloaded])

  // ── Загрузка бригады: матрица категория × дата ────────────────────
  const teamLoadMatrix = useMemo(() => {
    if (!teamLoad) return null
    const catMap = new Map<string, { name: string; data: Map<string, TeamLoadCategory> }>()
    for (const day of teamLoad.loads) {
      for (const cat of Object.values(day.categories)) {
        if (!catMap.has(cat.categoryId)) catMap.set(cat.categoryId, { name: cat.categoryName, data: new Map() })
        catMap.get(cat.categoryId)!.data.set(day.date.slice(0, 10), cat)
      }
    }
    return Array.from(catMap.values()).sort((a, b) => a.name.localeCompare(b.name, 'ru'))
  }, [teamLoad])

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

  const dates = useMemo(() => getDatesInRange(dateFrom, dateTo), [dateFrom, dateTo])

  const HEADER_BG = 'var(--sidebar-bg)'
  const HEADER_COLOR = '#e2e8f0'

  return (
    <>
      <div className="page-header">
        <h1 className="page-title">Аналитика планирования</h1>
        <button type="button" className="btn btn-secondary" onClick={replanQueue} disabled={replanning}>
          {replanning ? 'Перепланирую...' : 'Перепланировать очередь'}
        </button>
      </div>

      {replanResult && (
        <div className="card" style={{ marginBottom: 16, padding: '12px 16px', background: 'var(--success-light)', border: '1px solid #BBF7D0', color: 'var(--success)' }}>
          {replanResult}
        </div>
      )}
      {error && <div className="error">{error}</div>}

      <div className="card">
        {/* Табы */}
        <div className="tabs" style={{ marginBottom: '1.25rem' }}>
          {([
            ['overload',          'Перегрузка'],
            ['underload',         'Недогрузка'],
            ['team-load',         'Загрузка бригады'],
            ['orders-completion', 'Завершение заказов'],
          ] as [Tab, string][]).map(([t, label]) => (
            <button key={t} type="button" className={`tab ${tab === t ? 'active' : ''}`} onClick={() => setTab(t)}>
              {label}
              {t === 'overload' && overloadTasks.length > 0 && (
                <span className="badge badge-danger" style={{ marginLeft: 6 }}>{overloadTasks.length}</span>
              )}
            </button>
          ))}
        </div>

        {/* ── ПЕРЕГРУЗКА ── */}
        {tab === 'overload' && (
          <>
            <div className="toolbar">
              <label style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                С: <input type="date" value={dateFrom} onChange={e => setDateFrom(e.target.value)} />
              </label>
              <label style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                По: <input type="date" value={dateTo} onChange={e => setDateTo(e.target.value)} />
              </label>
              {loading && <span style={{ color: 'var(--text-muted)', fontSize: '0.85rem' }}>Загрузка…</span>}
            </div>

            {overloadTasks.length === 0 && !loading ? (
              <div className="empty">Нет перегруженных задач за период.</div>
            ) : (
              <div>
                {overloadByOrder.map(group => {
                  const latestDate = group.tasks.reduce((m, t) => t.date > m ? t.date : m, '')
                  const overDays = group.dueDate ? daysDiff(latestDate.slice(0, 10), group.dueDate.slice(0, 10)) : null
                  return (
                    <div key={group.orderNumber} style={{ marginBottom: '1rem' }}>
                      <div style={{
                        display: 'flex', alignItems: 'center', gap: 10,
                        background: '#fef2f2', border: '1px solid #fecaca',
                        borderRadius: '6px 6px 0 0', padding: '6px 12px',
                      }}>
                        <span style={{ fontWeight: 700 }}>{group.orderNumber}</span>
                        {group.dueDate && (
                          <span style={{ fontSize: '0.8rem', color: 'var(--text-muted)' }}>
                            срок: {formatDateFull(group.dueDate)}
                          </span>
                        )}
                        {overDays !== null && overDays > 0 && (
                          <span className="badge badge-danger">+{overDays} дн.</span>
                        )}
                        <span style={{ marginLeft: 'auto', fontSize: '0.8rem', color: 'var(--text-muted)' }}>
                          {group.tasks.length} задач
                        </span>
                      </div>
                      <table style={{ width: '100%', borderCollapse: 'collapse', borderTop: 'none' }}>
                        <thead>
                          <tr style={{ background: '#fff5f5', fontSize: '0.75rem', textTransform: 'uppercase', letterSpacing: '0.04em', color: 'var(--text-muted)' }}>
                            <th style={{ padding: '4px 12px', textAlign: 'left' }}>Дата</th>
                            <th style={{ padding: '4px 12px', textAlign: 'left' }}>Товар</th>
                            <th style={{ padding: '4px 12px', textAlign: 'right' }}>План</th>
                            <th style={{ padding: '4px 12px', textAlign: 'left' }}>Бригада</th>
                            <th style={{ padding: '4px 12px', textAlign: 'right' }}>Просрочка</th>
                          </tr>
                        </thead>
                        <tbody>
                          {group.tasks.map(t => {
                            const over = group.dueDate ? daysDiff(t.date.slice(0, 10), group.dueDate.slice(0, 10)) : null
                            return (
                              <tr key={t.id} style={{ borderBottom: '1px solid var(--border)' }}>
                                <td style={{ padding: '5px 12px', fontWeight: 600 }}>{formatDateFull(t.date)}</td>
                                <td style={{ padding: '5px 12px', fontSize: '0.85rem' }}>
                                  <span style={{ fontWeight: 600 }}>{t.orderItem?.product?.code ?? '—'}</span>
                                </td>
                                <td style={{ padding: '5px 12px', textAlign: 'right' }}>{t.plannedQuantity}</td>
                                <td style={{ padding: '5px 12px', color: 'var(--text-muted)', fontSize: '0.82rem' }}>{t.team?.name ?? '—'}</td>
                                <td style={{ padding: '5px 12px', textAlign: 'right' }}>
                                  {over !== null && over > 0 && <span className="badge badge-danger">+{over} дн.</span>}
                                </td>
                              </tr>
                            )
                          })}
                        </tbody>
                      </table>
                    </div>
                  )
                })}
              </div>
            )}
          </>
        )}

        {/* ── НЕДОГРУЗКА ── */}
        {tab === 'underload' && (
          <>
            <div className="toolbar">
              <label style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                С: <input type="date" value={dateFrom} onChange={e => setDateFrom(e.target.value)} />
              </label>
              <label style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                По: <input type="date" value={dateTo} onChange={e => setDateTo(e.target.value)} />
              </label>
              {loading && <span style={{ color: 'var(--text-muted)', fontSize: '0.85rem' }}>Загрузка…</span>}
            </div>

            {underloaded.length === 0 && !loading ? (
              <div className="empty">Нет недогруженных дней за период.</div>
            ) : (
              <div>
                {underloadByTeam.map(group => {
                  const avgUtil = group.days.reduce((s, d) => s + d.utilization, 0) / group.days.length
                  return (
                    <div key={group.teamName} style={{ marginBottom: '1.25rem' }}>
                      <div style={{
                        display: 'flex', alignItems: 'center', gap: 12,
                        background: 'var(--sidebar-bg)', color: HEADER_COLOR,
                        borderRadius: '6px 6px 0 0', padding: '6px 12px',
                      }}>
                        <span style={{ fontWeight: 700 }}>{group.teamName}</span>
                        <span style={{ fontSize: '0.78rem', opacity: 0.75 }}>
                          {group.days.length} дн. · ср. загрузка: {avgUtil.toFixed(0)}%
                        </span>
                      </div>
                      <table style={{ width: '100%', borderCollapse: 'collapse' }}>
                        <thead>
                          <tr style={{ background: '#f8fafc', fontSize: '0.75rem', textTransform: 'uppercase', letterSpacing: '0.04em', color: 'var(--text-muted)' }}>
                            <th style={{ padding: '4px 12px', textAlign: 'left' }}>Дата</th>
                            <th style={{ padding: '4px 12px', textAlign: 'right' }}>Загрузка</th>
                            <th style={{ padding: '4px 12px', textAlign: 'right' }}>Свободно</th>
                            <th style={{ padding: '4px 12px', width: 200 }}>График</th>
                          </tr>
                        </thead>
                        <tbody>
                          {group.days.map((u, i) => (
                            <tr key={`${u.teamId}-${u.date}-${i}`} style={{ borderBottom: '1px solid var(--border)' }}>
                              <td style={{ padding: '5px 12px', fontWeight: 600 }}>{formatDateFull(u.date)}</td>
                              <td style={{ padding: '5px 12px', textAlign: 'right' }}>{u.utilization.toFixed(0)}%</td>
                              <td style={{ padding: '5px 12px', textAlign: 'right', color: 'var(--warning)', fontWeight: 600 }}>{(100 - u.utilization).toFixed(0)}%</td>
                              <td style={{ padding: '5px 12px' }}><UtilBar value={u.loadFraction} capacity={1} /></td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  )
                })}
              </div>
            )}
          </>
        )}

        {/* ── ЗАГРУЗКА БРИГАДЫ ── */}
        {tab === 'team-load' && (
          <>
            <div className="toolbar">
              <label style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                Бригада:
                <select value={teamId} onChange={e => setTeamId(e.target.value)} style={{ width: 220 }}>
                  <option value="">— выберите —</option>
                  {teams.map(t => <option key={t.id} value={t.id}>{t.name}</option>)}
                </select>
              </label>
              <label style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                С: <input type="date" value={dateFrom} onChange={e => setDateFrom(e.target.value)} />
              </label>
              <label style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                По: <input type="date" value={dateTo} onChange={e => setDateTo(e.target.value)} />
              </label>
              {loading && <span style={{ color: 'var(--text-muted)', fontSize: '0.85rem' }}>Загрузка…</span>}
            </div>

            {!teamId && <div className="empty">Выберите бригаду.</div>}
            {teamId && !loading && !teamLoad && <div className="empty">Нет данных.</div>}
            {teamLoad && teamLoadMatrix && (
              <>
                <h3 style={{ margin: '0 0 0.75rem', fontWeight: 700 }}>{teamLoad.teamName}</h3>
                {teamLoadMatrix.length === 0 ? (
                  <div className="empty">Нет задач за период.</div>
                ) : (
                  <div style={{ overflowX: 'auto' }}>
                    <table style={{ borderCollapse: 'collapse', fontSize: '0.8rem', tableLayout: 'fixed' }}>
                      <colgroup>
                        <col style={{ width: 220 }} />
                        {dates.map(d => <col key={d} style={{ width: 72 }} />)}
                      </colgroup>
                      <thead>
                        <tr>
                          <th style={{
                            position: 'sticky', left: 0, zIndex: 2, background: HEADER_BG, color: HEADER_COLOR,
                            padding: '6px 10px', textAlign: 'left', borderRight: '2px solid var(--primary)',
                            fontWeight: 600, fontSize: '0.75rem', textTransform: 'uppercase',
                          }}>Категория</th>
                          {dates.map(d => (
                            <th key={d} style={{
                              background: isWeekend(d) ? '#1e2d3d' : HEADER_BG, color: isWeekend(d) ? '#64748b' : HEADER_COLOR,
                              padding: '4px 2px', textAlign: 'center', borderRight: '1px solid rgba(255,255,255,0.07)',
                            }}>
                              <div style={{ fontSize: '0.65rem', opacity: 0.7 }}>{new Date(d + 'T00:00:00').toLocaleDateString('ru-RU', { weekday: 'short' })}</div>
                              <div style={{ fontSize: '0.75rem' }}>{formatDate(d)}</div>
                            </th>
                          ))}
                        </tr>
                      </thead>
                      <tbody>
                        {teamLoadMatrix.map((cat, ri) => (
                          <tr key={cat.name} style={{ background: ri % 2 === 0 ? '#fff' : '#f8fafc' }}>
                            <td style={{
                              position: 'sticky', left: 0, zIndex: 1, background: ri % 2 === 0 ? '#fff' : '#f8fafc',
                              padding: '5px 10px', borderRight: '2px solid var(--primary)',
                              fontWeight: 500, fontSize: '0.78rem', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                            }} title={cat.name}>{cat.name}</td>
                            {dates.map(d => {
                              const cell = cat.data.get(d)
                              if (!cell) return (
                                <td key={d} style={{ borderRight: '1px solid #e2e8f0', background: isWeekend(d) ? '#f8fafc' : undefined }} />
                              )
                              const pct = cell.capacity > 0 ? Math.min(100, (cell.planned / cell.capacity) * 100) : 0
                              const bg = pct >= 90 ? '#DCFCE7' : pct >= 50 ? '#FEF9C3' : '#FEE2E2'
                              const col = pct >= 90 ? '#16a34a' : pct >= 50 ? '#d97706' : '#dc2626'
                              return (
                                <td key={d} style={{ textAlign: 'center', padding: '3px 2px', borderRight: '1px solid #e2e8f0', background: bg }}
                                  title={`${cell.planned} / ${cell.capacity} (${pct.toFixed(0)}%)`}>
                                  <div style={{ fontWeight: 700, fontSize: '0.82rem', color: col }}>{cell.planned}</div>
                                  <div style={{ fontSize: '0.65rem', color: '#6b7280' }}>{pct.toFixed(0)}%</div>
                                </td>
                              )
                            })}
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </>
            )}
          </>
        )}

        {/* ── ЗАВЕРШЕНИЕ ЗАКАЗОВ ── */}
        {tab === 'orders-completion' && (
          <>
            <div className="toolbar">
              <input
                type="text"
                placeholder="Поиск по номеру, клиенту, менеджеру…"
                value={completionSearch}
                onChange={e => setCompletionSearch(e.target.value)}
                style={{ width: 280 }}
              />
              <button type="button" className="btn btn-secondary" onClick={loadOrdersCompletion} disabled={loading}>
                {loading ? 'Загрузка…' : '↻ Обновить'}
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
              <table style={{ width: '100%', borderCollapse: 'collapse' }}>
                <thead>
                  <tr style={{ background: '#f8fafc', fontSize: '0.75rem', textTransform: 'uppercase', letterSpacing: '0.04em', color: 'var(--text-muted)' }}>
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
                    const isLate = ord.dueDate && ord.expectedCompletionDate && ord.expectedCompletionDate > ord.dueDate
                    const today = todayISO()
                    const daysUntil = ord.expectedCompletionDate
                      ? daysDiff(ord.expectedCompletionDate.slice(0, 10), today)
                      : null

                    return (
                      <tr key={ord.orderId} style={{ borderBottom: '1px solid var(--border)', background: i % 2 === 0 ? '#fff' : '#f8fafc' }}>
                        <td style={{ padding: '8px 12px', fontWeight: 700 }}>{ord.orderNumber}</td>
                        <td style={{ padding: '8px 12px', fontSize: '0.82rem', color: 'var(--text-muted)', maxWidth: 180, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={ord.customer}>{ord.customer}</td>
                        <td style={{ padding: '8px 12px', fontSize: '0.82rem', color: 'var(--text-muted)' }}>{ord.manager ?? '—'}</td>
                        <td style={{ padding: '8px 12px', fontSize: '0.82rem' }}>{ord.approvedAt ? formatDate(ord.approvedAt) : '—'}</td>
                        <td style={{ padding: '8px 12px', textAlign: 'right', fontWeight: 600, color: ord.remaining > 0 ? 'var(--text)' : 'var(--success)' }}>
                          {ord.remaining > 0 ? ord.remaining : <span className="badge badge-success">✓</span>}
                        </td>
                        <td style={{ padding: '8px 12px' }}>
                          {/* Двойной прогресс-бар: факт (зелёный) + план (синий) */}
                          <div style={{ position: 'relative', height: 10, background: '#e2e8f0', borderRadius: 5, overflow: 'hidden' }}
                            title={`Запланировано: ${ord.totalPlanned}, Выполнено: ${ord.totalProduced} / ${ord.totalQuantity}`}>
                            <div style={{ position: 'absolute', left: 0, top: 0, height: '100%', width: `${plannedPct}%`, background: '#93C5FD', borderRadius: 5 }} />
                            <div style={{ position: 'absolute', left: 0, top: 0, height: '100%', width: `${donePct}%`, background: '#22c55e', borderRadius: 5 }} />
                          </div>
                          <div style={{ fontSize: '0.7rem', color: 'var(--text-muted)', marginTop: 2, display: 'flex', justifyContent: 'space-between' }}>
                            <span>план {ord.totalPlanned}/{ord.totalQuantity}</span>
                            {ord.unplannedItems > 0 && <span style={{ color: 'var(--danger)' }}>{ord.unplannedItems} не в плане</span>}
                          </div>
                        </td>
                        <td style={{ padding: '8px 12px' }}>
                          {ord.expectedCompletionDate ? (
                            <span style={{ fontWeight: 600, color: isLate ? 'var(--danger)' : daysUntil !== null && daysUntil <= 3 ? 'var(--warning)' : 'var(--success)' }}>
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
                        <td style={{ padding: '8px 12px', textAlign: 'center' }}>
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
      </div>
    </>
  )
}
