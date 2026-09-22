import { useEffect, useState, useMemo } from 'react'
import { api } from '../api'
import type { DailyTask, Team } from '../types'

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

type Tab = 'team-load' | 'orders-completion' | 'fact-day' | 'unplanned'
type TeamLoadSubMode = 'brigade' | 'overload' | 'underload'


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
  const [tab, setTab] = useState<Tab>('team-load')
  const [subMode, setSubMode] = useState<TeamLoadSubMode>('brigade')
  const [dateFrom, setDateFrom] = useState(todayISO())
  const [dateTo, setDateTo] = useState(addDays(todayISO(), 13))
  const [teamId, setTeamId] = useState('')

  const [overloadTasks, setOverloadTasks] = useState<DailyTask[]>([])
  const [underloaded, setUnderloaded] = useState<UnderloadItem[]>([])
  const [teamLoad, setTeamLoad] = useState<{ teamName: string; loads: TeamLoadDay[] } | null>(null)
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
  }, [tab, dateFrom, dateTo])

  useEffect(() => {
    if (tab === 'team-load' && subMode === 'brigade' && teamId) loadTeamLoad()
    if (tab === 'team-load' && subMode === 'overload') loadOverload()
    if (tab === 'team-load' && subMode === 'underload') loadUnderload()
  }, [tab, subMode, teamId, dateFrom, dateTo])

  // ── Перегрузка: группировка по заказу ────────────────────────────
  const overloadByOrder = useMemo(() => {
    const map = new Map<string, { orderNumber: string; tasks: DailyTask[] }>()
    for (const t of overloadTasks) {
      const orderId = t.orderItem?.order?.orderNumber ?? '—'
      if (!map.has(orderId)) map.set(orderId, {
        orderNumber: t.orderItem?.order?.orderNumber ?? '—',
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
      </div>

      {error && <div className="error">{error}</div>}

      <div className="card">
        {/* Табы */}
        <div className="tabs" style={{ marginBottom: '1.25rem' }}>
          {([
            ['team-load',         'Загрузка бригады'],
            ['orders-completion', 'Завершение заказов'],
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

        {/* ── ЗАГРУЗКА БРИГАДЫ (+ перегрузка / недогрузка) ── */}
        {tab === 'team-load' && (
          <>
            <div className="toolbar">
              {subMode === 'brigade' && (
                <label style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                  Бригада:
                  <select value={teamId} onChange={e => setTeamId(e.target.value)} style={{ width: 220 }}>
                    <option value="">— выберите —</option>
                    {teams.map(t => <option key={t.id} value={t.id}>{t.name}</option>)}
                  </select>
                </label>
              )}
              <label style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                С: <input type="date" value={dateFrom} onChange={e => setDateFrom(e.target.value)} />
              </label>
              <label style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                По: <input type="date" value={dateTo} onChange={e => setDateTo(e.target.value)} />
              </label>
              <div style={{ marginLeft: 'auto', display: 'flex', gap: 6 }}>
                <button
                  type="button"
                  className={`btn btn-sm ${subMode === 'brigade' ? 'btn-primary' : 'btn-secondary'}`}
                  onClick={() => setSubMode('brigade')}
                >По бригаде</button>
                <button
                  type="button"
                  className={`btn btn-sm ${subMode === 'overload' ? 'btn-primary' : 'btn-secondary'}`}
                  onClick={() => setSubMode('overload')}
                >
                  Перегруженные
                  {overloadTasks.length > 0 && subMode !== 'overload' && (
                    <span className="badge badge-danger" style={{ marginLeft: 5 }}>{overloadTasks.length}</span>
                  )}
                </button>
                <button
                  type="button"
                  className={`btn btn-sm ${subMode === 'underload' ? 'btn-primary' : 'btn-secondary'}`}
                  onClick={() => setSubMode('underload')}
                >Недогруженные</button>
              </div>
              {loading && <span style={{ color: 'var(--text-muted)', fontSize: '0.85rem' }}>Загрузка…</span>}
            </div>

            {/* По бригаде */}
            {subMode === 'brigade' && (
              <>
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

            {/* Перегруженные */}
            {subMode === 'overload' && (
              overloadTasks.length === 0 && !loading ? (
                <div className="empty">Нет перегруженных задач за период.</div>
              ) : (
                <div>
                  {overloadByOrder.map(group => (
                    <div key={group.orderNumber} style={{ marginBottom: '1rem' }}>
                      <div style={{
                        display: 'flex', alignItems: 'center', gap: 10,
                        background: '#fef2f2', border: '1px solid #fecaca',
                        borderRadius: '6px 6px 0 0', padding: '6px 12px',
                      }}>
                        <span style={{ fontWeight: 700 }}>{group.orderNumber}</span>
                        <span style={{ marginLeft: 'auto', fontSize: '0.8rem', color: 'var(--text-muted)' }}>{group.tasks.length} задач</span>
                      </div>
                      <table style={{ width: '100%', borderCollapse: 'collapse', borderTop: 'none' }}>
                        <thead>
                          <tr style={{ background: '#fff5f5', fontSize: '0.75rem', textTransform: 'uppercase', letterSpacing: '0.04em', color: 'var(--text-muted)' }}>
                            <th style={{ padding: '4px 12px', textAlign: 'left' }}>Дата</th>
                            <th style={{ padding: '4px 12px', textAlign: 'left' }}>Товар</th>
                            <th style={{ padding: '4px 12px', textAlign: 'right' }}>План</th>
                            <th style={{ padding: '4px 12px', textAlign: 'left' }}>Бригада</th>
                          </tr>
                        </thead>
                        <tbody>
                          {group.tasks.map(t => (
                            <tr key={t.id} style={{ borderBottom: '1px solid var(--border)' }}>
                              <td style={{ padding: '5px 12px', fontWeight: 600 }}>{formatDateFull(t.date)}</td>
                              <td style={{ padding: '5px 12px', fontSize: '0.85rem' }}><span style={{ fontWeight: 600 }}>{t.orderItem?.product?.code ?? '—'}</span></td>
                              <td style={{ padding: '5px 12px', textAlign: 'right' }}>{t.plannedQuantity}</td>
                              <td style={{ padding: '5px 12px', color: 'var(--text-muted)', fontSize: '0.82rem' }}>{t.team?.name ?? '—'}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  ))}
                </div>
              )
            )}

            {/* Недогруженные */}
            {subMode === 'underload' && (
              underloaded.length === 0 && !loading ? (
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
              )
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
                            <span>план {ord.totalPlanned} · факт <span style={{ color: '#16a34a', fontWeight: 600 }}>{ord.totalProduced}</span> / {ord.totalQuantity}</span>
                            {ord.unplannedItems > 0 && <span style={{ color: 'var(--danger)' }}>{ord.unplannedItems} не в плане</span>}
                          </div>
                        </td>
                        <td style={{ padding: '8px 12px' }}>
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
        {/* ── НЕЗАПЛАНИРОВАННЫЙ ФАКТ ── */}
        {tab === 'unplanned' && (
          <>
            <div className="toolbar">
              <button type="button" className="btn btn-secondary" onClick={loadUnplanned} disabled={loading}>
                {loading ? 'Загрузка…' : '↻ Обновить'}
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
                <div style={{ marginBottom: 12, padding: '8px 12px', background: '#fef9c3', border: '1px solid #fde047', borderRadius: 6, fontSize: '0.85rem', color: '#854d0e' }}>
                  Произведено без плана: <strong>{unplannedData.count} позиций</strong>
                </div>
                <table style={{ width: '100%', borderCollapse: 'collapse' }}>
                  <thead>
                    <tr style={{ background: '#f8fafc', fontSize: '0.75rem', textTransform: 'uppercase', letterSpacing: '0.04em', color: 'var(--text-muted)' }}>
                      <th style={{ padding: '6px 12px', textAlign: 'left' }}>Заказ</th>
                      <th style={{ padding: '6px 12px', textAlign: 'left' }}>Клиент</th>
                      <th style={{ padding: '6px 12px', textAlign: 'left' }}>Категория</th>
                      <th style={{ padding: '6px 12px', textAlign: 'left' }}>Продукт</th>
                      <th style={{ padding: '6px 12px', textAlign: 'right' }}>Факт, шт.</th>
                    </tr>
                  </thead>
                  <tbody>
                    {unplannedData.items.map((item, i) => (
                      <tr key={item.taskId} style={{ borderBottom: '1px solid var(--border)', background: i % 2 === 0 ? '#fff' : '#fefce8' }}>
                        <td style={{ padding: '7px 12px', fontWeight: 700 }}>{item.orderNumber}</td>
                        <td style={{ padding: '7px 12px', fontSize: '0.82rem', color: 'var(--text-muted)', maxWidth: 160, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={item.customer}>{item.customer}</td>
                        <td style={{ padding: '7px 12px', fontSize: '0.82rem', color: 'var(--text-muted)' }}>{item.categoryName ?? '—'}</td>
                        <td style={{ padding: '7px 12px', fontSize: '0.82rem' }}>
                          <span style={{ fontWeight: 600 }}>{item.productCode}</span>
                          <div style={{ fontSize: '0.75rem', color: 'var(--text-muted)', marginTop: 1 }}>{item.productName}</div>
                        </td>
                        <td style={{ padding: '7px 12px', textAlign: 'right', fontWeight: 700, color: '#d97706' }}>
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
                {loading ? 'Загрузка…' : '↻ Обновить'}
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
                  <span style={{ fontWeight: 700 }}>{team.teamName}</span>
                  <span style={{ marginLeft: 'auto', fontWeight: 700, fontSize: '0.9rem' }}>
                    {team.totalActual.toLocaleString('ru-RU')} шт.
                  </span>
                </div>
                <table style={{ width: '100%', borderCollapse: 'collapse' }}>
                  <thead>
                    <tr style={{ background: '#f8fafc', fontSize: '0.75rem', textTransform: 'uppercase', letterSpacing: '0.04em', color: 'var(--text-muted)' }}>
                      <th style={{ padding: '4px 12px', textAlign: 'left' }}>Категория</th>
                      <th style={{ padding: '4px 12px', textAlign: 'right' }}>Позиций</th>
                      <th style={{ padding: '4px 12px', textAlign: 'right' }}>Факт, шт.</th>
                    </tr>
                  </thead>
                  <tbody>
                    {team.categories.map((cat, i) => (
                      <tr key={cat.categoryId} style={{ borderBottom: '1px solid var(--border)', background: i % 2 === 0 ? '#fff' : '#f8fafc' }}>
                        <td style={{ padding: '6px 12px', fontWeight: 500 }}>{cat.categoryName}</td>
                        <td style={{ padding: '6px 12px', textAlign: 'right', color: 'var(--text-muted)', fontSize: '0.82rem' }}>{cat.items}</td>
                        <td style={{ padding: '6px 12px', textAlign: 'right', fontWeight: 700, color: '#16a34a' }}>
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
    </>
  )
}
