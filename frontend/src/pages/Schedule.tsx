import { useEffect, useState, useMemo, useRef, useCallback } from 'react'
import { api } from '../api'
import type { DailyTask, Order, OrderItem, Team, Workshop } from '../types'

function todayISO() {
  return new Date().toISOString().slice(0, 10)
}

function addDays(iso: string, days: number) {
  const d = new Date(iso)
  d.setDate(d.getDate() + days)
  return d.toISOString().slice(0, 10)
}

function getDatesInRange(from: string, to: string): string[] {
  const dates: string[] = []
  const cur = new Date(from)
  const end = new Date(to)
  while (cur <= end) {
    dates.push(cur.toISOString().slice(0, 10))
    cur.setDate(cur.getDate() + 1)
  }
  return dates
}

function formatDateShort(iso: string) {
  const d = new Date(iso + 'T00:00:00')
  return d.toLocaleDateString('ru-RU', { day: '2-digit', month: '2-digit' })
}

function formatDayOfWeek(iso: string) {
  return new Date(iso + 'T00:00:00').toLocaleDateString('ru-RU', { weekday: 'short' })
}

function isWeekend(iso: string) {
  const d = new Date(iso + 'T00:00:00').getDay()
  return d === 0 || d === 6
}

type CellData = {
  taskId: string
  teamId: string | null
  teamName: string | null
  plannedQuantity: number
  actualQuantity: number | null
  comment: string | null
}

type RowData = {
  orderItemId: string
  workshopName: string
  teamName: string
  productCode: string
  productName: string
  orderNumber: string
  orderId: string
  quantity: number
  remainingQuantity?: number
  cells: Record<string, CellData>
}

// column load: fractional brigade-day usage per date
// planned = Σ(qty/cap), capacity = number of distinct teams (brigade-days available)
type DateLoad = { planned: number; capacity: number }

type PopupState = {
  rowId: string
  date: string
  x: number
  y: number
  cell: CellData | null
}

type Mode = 'idle' | 'moving'

// load, effectiveCapacity, available — в долях бригадо-дня (0.0–1.0+)
type TeamLoad = { load: number; effectiveCapacity: number; available: number }

const STICKY_W = [150, 190]

export default function Schedule() {
  const today = todayISO()
  const [dateFrom, setDateFrom] = useState(today)
  const [dateTo, setDateTo] = useState(addDays(today, 6))
  const [workshopId, setWorkshopId] = useState('')
  const [teamId, setTeamId] = useState('')
  const [orderId, setOrderId] = useState('')
  const [tasks, setTasks] = useState<DailyTask[]>([])
  const [workshops, setWorkshops] = useState<Workshop[]>([])
  const [teams, setTeams] = useState<Team[]>([])
  const [orders, setOrders] = useState<Order[]>([])
  const [allOrderItems, setAllOrderItems] = useState<OrderItem[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)

  const [popup, setPopup] = useState<PopupState | null>(null)
  const [mode, setMode] = useState<Mode>('idle')
  const [modeSource, setModeSource] = useState<{ rowId: string; date: string; cell: CellData } | null>(null)

  // popup form state
  const [editQty, setEditQty] = useState(0)
  const [editTeamId, setEditTeamId] = useState('')

  // header load tooltip
  const [headerTooltip, setHeaderTooltip] = useState<{ date: string; x: number; y: number } | null>(null)

  // split form state (inside popup)
  const [showSplitForm, setShowSplitForm] = useState(false)
  const [splitQty2, setSplitQty2] = useState(0)
  const [splitDate2, setSplitDate2] = useState('')
  const [splitLoad, setSplitLoad] = useState<TeamLoad | null>(null)
  const [splitLoadChecking, setSplitLoadChecking] = useState(false)

  const popupRef = useRef<HTMLDivElement>(null)

  const loadFilters = async () => {
    const [w, t, o, oi] = await Promise.all([
      api.get<Workshop[]>('/workshops'),
      api.get<Team[]>('/teams'),
      api.get<Order[]>('/orders'),
      api.get<OrderItem[]>('/order-items'),
    ])
    if (w.data) setWorkshops(w.data)
    if (t.data) setTeams(t.data)
    if (o.data) setOrders(o.data)
    if (oi.data) setAllOrderItems(oi.data)
  }

  const loadPlan = useCallback(async () => {
    setLoading(true)
    const params = new URLSearchParams({ dateFrom, dateTo })
    if (workshopId) params.set('workshopId', workshopId)
    if (teamId) params.set('teamId', teamId)
    if (orderId) params.set('orderId', orderId)
    const { data, error: e } = await api.get<DailyTask[]>(`/daily-tasks/plan?${params}`)
    setLoading(false)
    if (e) { setError(e); return }
    setTasks(data ?? [])
    setError(null)
  }, [dateFrom, dateTo, workshopId, teamId, orderId])

  useEffect(() => { loadFilters() }, [])
  useEffect(() => { loadPlan() }, [loadPlan])

  // close popup on outside click
  useEffect(() => {
    if (!popup) return
    const handler = (e: MouseEvent) => {
      if (popupRef.current && !popupRef.current.contains(e.target as Node)) {
        closePopup()
      }
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [popup])

  const dates = useMemo(() => getDatesInRange(dateFrom, dateTo), [dateFrom, dateTo])

  const rows = useMemo((): RowData[] => {
    const map = new Map<string, RowData>()
    for (const task of tasks) {
      const oi = task.orderItem
      if (!oi) continue
      const date = task.date.slice(0, 10)
      if (!map.has(oi.id)) {
        map.set(oi.id, {
          orderItemId: oi.id,
          workshopName: oi.product?.category?.workshop?.name ?? '—',
          teamName: task.team?.name ?? '—',
          productCode: oi.product?.code ?? '—',
          productName: oi.product?.name ?? '',
          orderNumber: oi.order?.orderNumber ?? '—',
          orderId: oi.order?.id ?? '',
          quantity: oi.quantity,
          cells: {},
        })
      }
      const row = map.get(oi.id)!
      if (task.team?.name && row.teamName === '—') row.teamName = task.team.name
      row.cells[date] = {
        taskId: task.id,
        teamId: task.teamId,
        teamName: task.team?.name ?? null,
        plannedQuantity: task.plannedQuantity,
        actualQuantity: task.actualQuantity,
        comment: task.comment,
      }
    }
    return Array.from(map.values()).sort((a, b) => {
      if (a.workshopName !== b.workshopName) return a.workshopName.localeCompare(b.workshopName, 'ru')
      if (a.teamName !== b.teamName) return a.teamName.localeCompare(b.teamName, 'ru')
      return a.productCode.localeCompare(b.productCode, 'ru')
    })
  }, [tasks])

  // Per-date load for header bar (fractional model)
  const dateLoads = useMemo((): Record<string, DateLoad> => {
    const result: Record<string, DateLoad> = {}
    const teamsByDate: Record<string, Set<string>> = {}
    for (const task of tasks) {
      const date = task.date.slice(0, 10)
      if (!result[date]) result[date] = { planned: 0, capacity: 0 }
      const cap = task.orderItem?.product?.category?.capacityPerTeamPerDay
      if (cap && cap > 0) result[date].planned += task.plannedQuantity / cap
      if (task.teamId) {
        if (!teamsByDate[date]) teamsByDate[date] = new Set()
        teamsByDate[date].add(task.teamId)
      }
    }
    for (const date of Object.keys(result)) {
      result[date].capacity = teamsByDate[date]?.size ?? 0
    }
    return result
  }, [tasks])

  // Per-date per-team load for tooltip: date → [{teamName, loadPct}]
  const dateTeamLoads = useMemo((): Record<string, { teamName: string; loadPct: number }[]> => {
    const byDateTeam: Record<string, Record<string, { teamName: string; load: number }>> = {}
    for (const task of tasks) {
      const date = task.date.slice(0, 10)
      const tid = task.teamId
      if (!tid) continue
      const cap = task.orderItem?.product?.category?.capacityPerTeamPerDay
      if (!cap || cap === 0) continue
      if (!byDateTeam[date]) byDateTeam[date] = {}
      if (!byDateTeam[date][tid]) byDateTeam[date][tid] = { teamName: task.team?.name ?? tid, load: 0 }
      byDateTeam[date][tid].load += task.plannedQuantity / cap
    }
    const result: Record<string, { teamName: string; loadPct: number }[]> = {}
    for (const date of Object.keys(byDateTeam)) {
      result[date] = Object.values(byDateTeam[date])
        .map(t => ({ teamName: t.teamName, loadPct: Math.round(t.load * 100) }))
        .sort((a, b) => b.loadPct - a.loadPct)
    }
    return result
  }, [tasks])

  const cellBg = (cell: CellData | undefined, date: string): string => {
    if (!cell || cell.plannedQuantity === 0) return 'transparent'
    if (date < today && cell.actualQuantity === null) return '#FEE2E2'
    if (cell.actualQuantity !== null && cell.actualQuantity >= cell.plannedQuantity) return '#DCFCE7'
    if (cell.actualQuantity !== null && cell.actualQuantity > 0) return '#FEF9C3'
    return '#DBEAFE'
  }

  const HEADER_BG = 'var(--sidebar-bg)'
  const HEADER_COLOR = '#e2e8f0'
  const stickyLeft = (i: number) => STICKY_W.slice(0, i).reduce((a, b) => a + b, 0)

  const closePopup = () => {
    setPopup(null)
    if (mode !== 'idle') {
      setMode('idle')
      setModeSource(null)
    }
  }

  const openPopup = (e: React.MouseEvent, row: RowData, date: string, cell: CellData | null) => {
    e.stopPropagation()

    // Moving mode: clicking target cell
    if (mode === 'moving' && modeSource) {
      if (modeSource.rowId !== row.orderItemId) return // different item, ignore
      if (cell) {
        setError('Эта дата уже занята для данной позиции')
        return
      }
      handleMove(modeSource.cell.taskId, modeSource.date, date)
      return
    }

    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect()
    setEditQty(cell?.plannedQuantity ?? 0)
    setEditTeamId(cell?.teamId ?? '')
    setShowSplitForm(false)
    setSplitQty2(cell ? Math.floor(cell.plannedQuantity / 2) : 0)
    setSplitDate2(todayISO())
    setSplitLoad(null)
    setPopup({
      rowId: row.orderItemId,
      date,
      x: rect.left,
      y: rect.bottom + 4,
      cell,
    })
  }

  const handleCreateOrUpdate = async () => {
    if (!popup) return
    setSaving(true)
    if (popup.cell) {
      await api.put(`/daily-tasks/${popup.cell.taskId}`, {
        plannedQuantity: editQty,
        teamId: editTeamId || null,
      })
    } else {
      const row = rows.find(r => r.orderItemId === popup.rowId)
      if (!row) { setSaving(false); return }
      const oi = allOrderItems.find(o => o.id === popup.rowId)
      const defQty = oi?.remainingQuantity ?? editQty
      await api.post('/daily-tasks', {
        orderItemId: popup.rowId,
        date: new Date(popup.date).toISOString(),
        plannedQuantity: editQty || defQty,
        teamId: editTeamId || undefined,
      })
    }
    setSaving(false)
    closePopup()
    loadPlan()
  }

  const handleDelete = async () => {
    if (!popup?.cell) return
    if (!confirm('Удалить задачу?')) return
    await api.delete(`/daily-tasks/${popup.cell.taskId}`)
    closePopup()
    loadPlan()
  }

  const startMove = () => {
    if (!popup?.cell) return
    setModeSource({ rowId: popup.rowId, date: popup.date, cell: popup.cell })
    setMode('moving')
    setPopup(null)
  }

  const handleMove = async (taskId: string, _fromDate: string, toDate: string) => {
    setSaving(true)
    const { error: e } = await api.put(`/daily-tasks/${taskId}`, { date: new Date(toDate).toISOString() })
    setSaving(false)
    setMode('idle')
    setModeSource(null)
    if (e) setError(e)
    else loadPlan()
  }

  const checkSplitLoad = async (teamId: string | null, date: string) => {
    if (!teamId || !date) { setSplitLoad(null); return }
    setSplitLoadChecking(true)
    const { data } = await api.get<TeamLoad>(`/teams/${teamId}/load?date=${date}`)
    setSplitLoadChecking(false)
    setSplitLoad(data ?? null)
  }

  const confirmSplit = async () => {
    if (!popup?.cell) return
    const total = popup.cell.plannedQuantity
    const qty1 = total - splitQty2
    if (qty1 <= 0 || splitQty2 <= 0) { setError('Оба количества должны быть больше 0'); return }
    setSaving(true)
    const { error: e } = await api.post(`/daily-tasks/${popup.cell.taskId}/split`, {
      qty1,
      date2: new Date(splitDate2).toISOString(),
      qty2: splitQty2,
    })
    setSaving(false)
    if (e) { setError(e); return }
    setShowSplitForm(false)
    closePopup()
    loadPlan()
  }

  const loadBarColor = (load: DateLoad | undefined) => {
    if (!load || load.capacity === 0) return '#94a3b8'
    const pct = load.planned / load.capacity
    if (pct >= 1) return '#ef4444'
    if (pct >= 0.75) return '#f59e0b'
    return '#22c55e'
  }

  const loadBarWidth = (load: DateLoad | undefined) => {
    if (!load || load.capacity === 0) return 0
    return Math.min(100, Math.round((load.planned / load.capacity) * 100))
  }

  const cursorStyle = mode !== 'idle' ? 'crosshair' : undefined

  return (
    <>
      <h1 className="page-title">График производства</h1>
      {error && (
        <div className="error" onClick={() => setError(null)} style={{ cursor: 'pointer' }}>
          {error} ✕
        </div>
      )}

      {mode !== 'idle' && (
        <div style={{ background: '#fef9c3', border: '1px solid #fde047', borderRadius: 8, padding: '0.5rem 1rem', marginBottom: '0.75rem', display: 'flex', justifyContent: 'space-between', alignItems: 'center', fontSize: '0.85rem' }}>
          <span>
            {`Переносим «${modeSource?.cell.plannedQuantity} шт» — кликните на пустую ячейку той же позиции`}
          </span>
          <button className="btn btn-secondary btn-sm" onClick={() => { setMode('idle'); setModeSource(null) }}>Отмена</button>
        </div>
      )}

      <div className="card">
        <div className="toolbar">
          <label style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
            С: <input type="date" value={dateFrom} onChange={e => setDateFrom(e.target.value)} />
          </label>
          <label style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
            По: <input type="date" value={dateTo} onChange={e => setDateTo(e.target.value)} />
          </label>
          <label style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
            Участок:
            <select value={workshopId} onChange={e => setWorkshopId(e.target.value)}>
              <option value="">— все —</option>
              {workshops.map(w => <option key={w.id} value={w.id}>{w.name}</option>)}
            </select>
          </label>
          <label style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
            Бригада:
            <select value={teamId} onChange={e => setTeamId(e.target.value)}>
              <option value="">— все —</option>
              {teams.map(t => <option key={t.id} value={t.id}>{t.name}</option>)}
            </select>
          </label>
          <label style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
            Заказ:
            <select value={orderId} onChange={e => setOrderId(e.target.value)}>
              <option value="">— все —</option>
              {orders.map(o => <option key={o.id} value={o.id}>{o.orderNumber}</option>)}
            </select>
          </label>
        </div>

        <div style={{ display: 'flex', gap: '1.25rem', marginBottom: '0.75rem', fontSize: '0.78rem', flexWrap: 'wrap', color: 'var(--text-muted)' }}>
          {[
            { bg: '#DBEAFE', border: '#93C5FD', label: 'Запланировано' },
            { bg: '#DCFCE7', border: '#86EFAC', label: 'Выполнено' },
            { bg: '#FEF9C3', border: '#FDE047', label: 'Частично' },
            { bg: '#FEE2E2', border: '#FCA5A5', label: 'Просрочено' },
          ].map(({ bg, border, label }) => (
            <span key={label} style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
              <span style={{ display: 'inline-block', width: 12, height: 12, background: bg, border: `1px solid ${border}`, borderRadius: 2 }} />
              {label}
            </span>
          ))}
          <span style={{ color: 'var(--text-muted)', marginLeft: 8 }}>· Кликните ячейку для редактирования</span>
        </div>

        {loading ? (
          <div className="empty">Загрузка...</div>
        ) : rows.length === 0 ? (
          <div className="empty">Нет задач за выбранный период.</div>
        ) : (
          <div style={{ overflowX: 'auto', position: 'relative', cursor: cursorStyle }}>
            <table style={{ borderCollapse: 'collapse', fontSize: '0.8rem', tableLayout: 'fixed' }}>
              <colgroup>
                <col style={{ width: STICKY_W[0] }} />
                <col style={{ width: STICKY_W[1] }} />
                {dates.map(d => <col key={d} style={{ width: 70 }} />)}
              </colgroup>
              <thead>
                <tr>
                  {(['Бригада', 'Заказ / Товар'] as const).map((label, i) => (
                    <th key={label} style={{
                      position: 'sticky', left: stickyLeft(i), zIndex: 3,
                      background: HEADER_BG, color: HEADER_COLOR,
                      padding: '6px 8px', textAlign: 'left',
                      borderRight: i === 1 ? '2px solid #cbd5e1' : '1px solid rgba(255,255,255,0.1)',
                      whiteSpace: 'nowrap', fontWeight: 600, fontSize: '0.75rem', textTransform: 'uppercase', letterSpacing: '0.04em'
                    }}>{label}</th>
                  ))}
                  {dates.map(d => {
                    const load = dateLoads[d]
                    const barW = loadBarWidth(load)
                    const barColor = loadBarColor(load)
                    return (
                      <th key={d}
                        onMouseEnter={e => { if (dateTeamLoads[d]?.length) setHeaderTooltip({ date: d, x: e.clientX, y: e.clientY }) }}
                        onMouseMove={e => { if (headerTooltip?.date === d) setHeaderTooltip({ date: d, x: e.clientX, y: e.clientY }) }}
                        onMouseLeave={() => setHeaderTooltip(null)}
                        style={{
                          background: isWeekend(d) ? '#1e2d3d' : HEADER_BG,
                          color: isWeekend(d) ? '#64748b' : HEADER_COLOR,
                          padding: '4px 2px', textAlign: 'center',
                          borderRight: '1px solid rgba(255,255,255,0.07)',
                          fontWeight: d === today ? 700 : 400,
                        }}>
                        <div style={{ fontSize: '0.68rem', opacity: 0.75 }}>{formatDayOfWeek(d)}</div>
                        <div style={{ fontSize: '0.78rem' }}>{formatDateShort(d)}</div>
                        {barW > 0 && (
                          <div style={{ margin: '2px 4px 0', height: 3, borderRadius: 2, background: 'rgba(255,255,255,0.1)' }}>
                            <div style={{ width: `${barW}%`, height: '100%', borderRadius: 2, background: barColor, transition: 'width 0.3s' }} />
                          </div>
                        )}
                      </th>
                    )
                  })}
                </tr>
              </thead>
              <tbody>
                {(() => {
                  // Pre-compute rowspan for team column:
                  // consecutive rows with same workshopName+teamName get merged
                  const teamSpans = rows.map((row, i) => {
                    if (i > 0 && rows[i - 1]!.teamName === row.teamName && rows[i - 1]!.workshopName === row.workshopName) return 0
                    let span = 1
                    while (i + span < rows.length && rows[i + span]!.teamName === row.teamName && rows[i + span]!.workshopName === row.workshopName) span++
                    return span
                  })

                  const result: React.ReactNode[] = []
                  let lastWorkshop = ''

                  rows.forEach((row, i) => {
                    // Workshop section header row
                    if (row.workshopName !== lastWorkshop) {
                      lastWorkshop = row.workshopName
                      result.push(
                        <tr key={`ws-${row.workshopName}-${i}`}>
                          <td colSpan={2 + dates.length} style={{
                            position: 'sticky', left: 0,
                            background: '#1e293b', color: '#94a3b8',
                            padding: '3px 10px',
                            fontWeight: 700, fontSize: '0.7rem', textTransform: 'uppercase', letterSpacing: '0.06em',
                            borderTop: i > 0 ? '2px solid #cbd5e1' : undefined,
                          }}>
                            {row.workshopName}
                          </td>
                        </tr>
                      )
                    }

                    const rowBg = i % 2 === 0 ? '#fff' : '#f8fafc'
                    const teamSpan = teamSpans[i]!

                    result.push(
                      <tr key={row.orderItemId} style={{ height: 38 }}>
                        {/* Team cell — only on first row of each span group */}
                        {teamSpan > 0 && (
                          <td rowSpan={teamSpan} style={{
                            position: 'sticky', left: stickyLeft(0), zIndex: 1, background: '#f1f5f9',
                            padding: '4px 8px', borderRight: '1px solid var(--border)',
                            overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                            color: 'var(--text-muted)', fontSize: '0.78rem',
                            verticalAlign: 'middle', borderBottom: '1px solid var(--border)',
                          }} title={row.teamName}>{row.teamName}</td>
                        )}
                        {/* Product cell */}
                        <td style={{
                          position: 'sticky', left: stickyLeft(1), zIndex: 1, background: rowBg,
                          padding: '4px 8px', borderRight: '2px solid #cbd5e1',
                          overflow: 'hidden',
                        }}>
                          <div style={{ fontWeight: 600, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }} title={row.orderNumber}>
                            {row.orderNumber}
                          </div>
                          <div style={{ fontSize: '0.7rem', color: 'var(--text-muted)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }} title={`${row.productCode} — ${row.productName}`}>
                            {row.productName || row.productCode}
                          </div>
                        </td>
                        {/* Date cells */}
                        {dates.map(d => {
                          const cell = row.cells[d]
                          const bg = cellBg(cell, d)
                          const isSource = modeSource?.rowId === row.orderItemId && modeSource?.date === d
                          const isValidTarget = mode === 'moving' && modeSource?.rowId === row.orderItemId && !cell && !isSource
                          return (
                            <td
                              key={d}
                              onClick={e => openPopup(e, row, d, cell ?? null)}
                              style={{
                                textAlign: 'center', padding: '3px 2px',
                                borderRight: '1px solid #e2e8f0',
                                background: isSource ? '#fef08a' : bg,
                                transition: 'background 0.15s',
                                cursor: mode === 'idle' ? 'pointer' : (isValidTarget ? 'crosshair' : 'default'),
                                outline: isValidTarget ? '2px dashed #60a5fa' : 'none',
                                outlineOffset: -2,
                              }}
                              title={cell
                                ? `План: ${cell.plannedQuantity}${cell.actualQuantity !== null ? `, Факт: ${cell.actualQuantity}` : ''}${cell.comment ? `\n${cell.comment}` : ''}`
                                : isValidTarget ? 'Кликните, чтобы перенести сюда' : undefined}
                            >
                              {cell && cell.plannedQuantity > 0 && (
                                <>
                                  <div style={{ fontWeight: 600, lineHeight: 1.2 }}>{cell.plannedQuantity}</div>
                                  {cell.actualQuantity !== null && (
                                    <div style={{ fontSize: '0.68rem', color: '#374151', lineHeight: 1 }}>✓{cell.actualQuantity}</div>
                                  )}
                                </>
                              )}
                              {isValidTarget && !cell && (
                                <div style={{ fontSize: '0.7rem', color: '#93c5fd', lineHeight: 1 }}>+</div>
                              )}
                            </td>
                          )
                        })}
                      </tr>
                    )
                  })

                  return result
                })()}
              </tbody>
            </table>
          </div>
        )}

        {!loading && rows.length > 0 && (
          <div style={{ marginTop: '0.5rem', fontSize: '0.78rem', color: 'var(--text-muted)' }}>
            {rows.length} позиций · {dates.length} дней
          </div>
        )}
      </div>

      {/* Header load tooltip */}
      {headerTooltip && (dateTeamLoads[headerTooltip.date] ?? []).length > 0 && (
        <div style={{
          position: 'fixed',
          left: headerTooltip.x + 12,
          top: headerTooltip.y + 12,
          zIndex: 1000,
          background: '#1e293b',
          color: '#e2e8f0',
          borderRadius: 8,
          padding: '0.5rem 0.75rem',
          fontSize: '0.78rem',
          pointerEvents: 'none',
          boxShadow: '0 4px 16px rgba(0,0,0,0.3)',
          minWidth: 180,
        }}>
          {(dateTeamLoads[headerTooltip.date] ?? []).map(t => {
            const over = t.loadPct >= 100
            const warn = t.loadPct >= 75
            return (
              <div key={t.teamName} style={{ display: 'flex', justifyContent: 'space-between', gap: 16, padding: '2px 0' }}>
                <span style={{ opacity: 0.8 }}>{t.teamName}</span>
                <span style={{ fontWeight: 700, color: over ? '#f87171' : warn ? '#fbbf24' : '#4ade80' }}>
                  {t.loadPct}%
                </span>
              </div>
            )
          })}
        </div>
      )}

      {/* Cell popup */}
      {popup && (
        <div
          ref={popupRef}
          style={{
            position: 'fixed',
            left: Math.min(popup.x, window.innerWidth - 280),
            top: Math.max(10, Math.min(popup.y, window.innerHeight - 480)),
            maxHeight: 'calc(100vh - 20px)',
            overflowY: 'auto',
            width: 260,
            background: '#fff',
            border: '1px solid var(--border)',
            borderRadius: 10,
            boxShadow: '0 8px 24px rgba(0,0,0,0.13)',
            zIndex: 100,
            padding: '0.75rem',
            fontSize: '0.82rem',
          }}
          onClick={e => e.stopPropagation()}
        >
          {/* Header */}
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: '0.5rem' }}>
            <div>
              <div style={{ fontWeight: 700 }}>
                {rows.find(r => r.orderItemId === popup.rowId)?.productCode ?? ''}
              </div>
              <div style={{ color: 'var(--text-muted)', fontSize: '0.75rem' }}>
                {rows.find(r => r.orderItemId === popup.rowId)?.orderNumber ?? ''} · {popup.date}
              </div>
            </div>
            <button style={{ background: 'none', border: 'none', cursor: 'pointer', fontSize: '1rem', color: 'var(--text-muted)', lineHeight: 1 }} onClick={closePopup}>✕</button>
          </div>

          {popup.cell ? (
            <>
              {/* Existing task */}
              <div style={{ display: 'flex', gap: '0.5rem', marginBottom: '0.5rem', alignItems: 'center' }}>
                <label style={{ fontSize: '0.78rem', color: 'var(--text-muted)', whiteSpace: 'nowrap' }}>Кол-во</label>
                <input
                  type="number" min={0} value={editQty}
                  onChange={e => setEditQty(Number(e.target.value))}
                  style={{ width: 70 }}
                  autoFocus
                />
                {popup.cell.actualQuantity !== null && (
                  <span style={{ fontSize: '0.75rem', color: '#16a34a' }}>✓{popup.cell.actualQuantity}</span>
                )}
              </div>
              <div style={{ marginBottom: '0.75rem' }}>
                <label style={{ fontSize: '0.78rem', color: 'var(--text-muted)', display: 'block', marginBottom: 3 }}>Бригада</label>
                <select value={editTeamId} onChange={e => setEditTeamId(e.target.value)} style={{ width: '100%' }}>
                  <option value="">— не назначена —</option>
                  {teams.map(t => <option key={t.id} value={t.id}>{t.name}</option>)}
                </select>
              </div>
              {!showSplitForm ? (
                <div style={{ display: 'flex', flexDirection: 'column', gap: '0.35rem' }}>
                  <button className="btn btn-primary" style={{ width: '100%' }} onClick={handleCreateOrUpdate} disabled={saving}>
                    Сохранить
                  </button>
                  <div style={{ display: 'flex', gap: '0.35rem' }}>
                    <button className="btn btn-secondary" style={{ flex: 1 }} onClick={startMove}>
                      Перенести →
                    </button>
                    <button className="btn btn-secondary" style={{ flex: 1 }} onClick={() => setShowSplitForm(true)}>
                      Разбить ÷
                    </button>
                  </div>
                  <button className="btn btn-danger" style={{ width: '100%' }} onClick={handleDelete} disabled={saving}>
                    Удалить
                  </button>
                </div>
              ) : (
                /* Split form */
                <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
                  <div style={{ fontSize: '0.78rem', fontWeight: 600, color: 'var(--text-muted)' }}>
                    Разбить {popup.cell.plannedQuantity} шт
                  </div>
                  <div style={{ display: 'flex', alignItems: 'center', gap: '0.4rem', fontSize: '0.8rem' }}>
                    <span style={{ color: 'var(--text-muted)', whiteSpace: 'nowrap' }}>
                      Здесь останется:
                    </span>
                    <strong>{popup.cell.plannedQuantity - splitQty2}</strong>
                  </div>
                  <div>
                    <label style={{ fontSize: '0.78rem', color: 'var(--text-muted)', display: 'block', marginBottom: 3 }}>
                      Перенести на другую дату (шт)
                    </label>
                    <input
                      type="number" min={1} max={popup.cell.plannedQuantity - 1}
                      value={splitQty2}
                      onChange={e => {
                        const v = Math.min(popup.cell!.plannedQuantity - 1, Math.max(1, Number(e.target.value)))
                        setSplitQty2(v)
                        setSplitLoad(null)
                      }}
                      style={{ width: '100%' }}
                      autoFocus
                    />
                  </div>
                  <div>
                    <label style={{ fontSize: '0.78rem', color: 'var(--text-muted)', display: 'block', marginBottom: 3 }}>
                      Дата
                    </label>
                    <input
                      type="date" value={splitDate2}
                      onChange={e => { setSplitDate2(e.target.value); setSplitLoad(null) }}
                      style={{ width: '100%' }}
                    />
                  </div>
                  {/* Check load button */}
                  {!splitLoad && (
                    <button
                      className="btn btn-secondary"
                      style={{ width: '100%' }}
                      onClick={() => checkSplitLoad(popup.cell!.teamId, splitDate2)}
                      disabled={splitLoadChecking || !splitDate2 || !popup.cell.teamId}
                    >
                      {splitLoadChecking ? 'Проверяем...' : popup.cell.teamId ? 'Проверить загрузку →' : 'Бригада не назначена — всё равно разбить'}
                    </button>
                  )}
                  {/* Load result */}
                  {splitLoad && (() => {
                    const categoryCapacity = allOrderItems.find(o => o.id === popup.rowId)?.product?.category?.capacityPerTeamPerDay ?? null
                    const availableQty = categoryCapacity !== null ? Math.floor(splitLoad.available * categoryCapacity) : null
                    const fits = availableQty !== null && availableQty >= splitQty2
                    return (
                      <div style={{
                        padding: '0.4rem 0.6rem', borderRadius: 6, fontSize: '0.78rem',
                        background: fits ? '#f0fdf4' : '#fef2f2',
                        border: `1px solid ${fits ? '#86efac' : '#fca5a5'}`,
                        color: fits ? '#15803d' : '#dc2626',
                      }}>
                        {fits ? (
                          <>Бригада может выполнить. Свободно: <strong>{availableQty}</strong> шт</>
                        ) : (
                          <>⚠ Бригада перегружена. Свободно: <strong>{availableQty ?? '?'}</strong> шт, нужно: <strong>{splitQty2}</strong></>
                        )}
                      </div>
                    )
                  })()}
                  <div style={{ display: 'flex', gap: '0.35rem' }}>
                    <button
                      className="btn btn-primary"
                      style={{ flex: 1 }}
                      onClick={confirmSplit}
                      disabled={saving || splitQty2 <= 0 || splitQty2 >= popup.cell.plannedQuantity}
                    >
                      Разбить
                    </button>
                    <button className="btn btn-secondary" style={{ flex: 1 }} onClick={() => setShowSplitForm(false)}>
                      Назад
                    </button>
                  </div>
                </div>
              )}
              {popup.cell.comment && !showSplitForm && (
                <div style={{ marginTop: '0.5rem', fontSize: '0.75rem', color: 'var(--text-muted)', borderTop: '1px solid var(--border)', paddingTop: '0.4rem' }}>
                  {popup.cell.comment}
                </div>
              )}
            </>
          ) : (
            <>
              {/* Empty cell — create */}
              <div style={{ color: 'var(--text-muted)', marginBottom: '0.5rem', fontSize: '0.78rem' }}>
                Создать задачу на эту дату
              </div>
              <div style={{ display: 'flex', gap: '0.5rem', marginBottom: '0.5rem', alignItems: 'center' }}>
                <label style={{ fontSize: '0.78rem', color: 'var(--text-muted)', whiteSpace: 'nowrap' }}>Кол-во</label>
                <input
                  type="number" min={0} value={editQty}
                  onChange={e => setEditQty(Number(e.target.value))}
                  style={{ width: 70 }}
                  autoFocus
                />
              </div>
              <div style={{ marginBottom: '0.75rem' }}>
                <label style={{ fontSize: '0.78rem', color: 'var(--text-muted)', display: 'block', marginBottom: 3 }}>Бригада</label>
                <select value={editTeamId} onChange={e => setEditTeamId(e.target.value)} style={{ width: '100%' }}>
                  <option value="">— не назначена —</option>
                  {teams.map(t => <option key={t.id} value={t.id}>{t.name}</option>)}
                </select>
              </div>
              <button className="btn btn-primary" style={{ width: '100%' }} onClick={handleCreateOrUpdate} disabled={saving}>
                Создать
              </button>
            </>
          )}
        </div>
      )}
    </>
  )
}
