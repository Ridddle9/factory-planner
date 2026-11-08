import { useEffect, useState, useMemo, useRef, useCallback } from 'react'
import { api } from '../api'
import './planning.css'
import type { DailyTask, Order, OrderItem, Team, Workshop } from '../types'
import { X } from '@phosphor-icons/react/dist/csr/X'
import { CaretDown } from '@phosphor-icons/react/dist/csr/CaretDown'
import { ArrowCounterClockwise } from '@phosphor-icons/react/dist/csr/ArrowCounterClockwise'
import { PushPin } from '@phosphor-icons/react/dist/csr/PushPin'

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

// «Закрепил: artem@… · 31.10.2026 14:32» — для подсказки и окна задачи
function manualInfo(cell: { manualAt: string | null; manualBy: string | null }) {
  if (!cell.manualAt && !cell.manualBy) return 'Кто и когда закрепил — неизвестно (правка до 01.11.2026)'
  const when = cell.manualAt ? new Date(cell.manualAt).toLocaleString('ru-RU', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' }) : ''
  return `Закрепил: ${[cell.manualBy, when].filter(Boolean).join(' · ')}`
}

// Нерабочий день: выходной или праздник (те же праздники, что у планировщика — RUSSIAN_HOLIDAYS в src/index.ts)
const HOLIDAYS = ['01-01', '01-02', '01-03', '01-04', '01-05', '01-06', '01-07', '01-08', '02-23', '03-08', '05-01', '05-09', '06-12', '11-04']
function isOffDay(iso: string) {
  const d = new Date(iso + 'T00:00:00').getDay()
  return d === 0 || d === 6 || HOLIDAYS.includes(iso.slice(5))
}

type CellData = {
  taskId: string
  teamId: string | null
  teamName: string | null
  plannedQuantity: number
  actualQuantity: number | null
  comment: string | null
  manual: boolean
  // Кто и когда закрепил (ручная правка); у правок до 01.11.2026 неизвестно
  manualAt: string | null
  manualBy: string | null
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


// load, effectiveCapacity, available — в долях бригадо-дня (0.0–1.0+)
type TeamLoad = { load: number; effectiveCapacity: number; available: number }

const STICKY_W = [150, 190]
const STICKY_W_MOBILE = [72, 112]
const MOBILE_QUERY = '(max-width: 768px)'

// Цвет полоски статуса задачи в списке дня (те же статусы, что и фон ячейки в сетке)
const STATUS_BORDER: Record<string, string> = {
  'var(--danger-light)': 'var(--danger)',
  'var(--success-light)': 'var(--success)',
  'var(--warning-light)': 'var(--warning)',
  'var(--plan-scheduled)': 'var(--plan-scheduled-border)',
}

// Режим «заполнять освободившееся место» при переносе — последний выбор пользователя в этом браузере
const MOVE_FILL_KEY = 'schedule-move-fill'
function loadMoveFill(): boolean {
  try { return localStorage.getItem(MOVE_FILL_KEY) !== 'empty' } catch { return true }
}
function saveMoveFill(fill: boolean) {
  try { localStorage.setItem(MOVE_FILL_KEY, fill ? 'fill' : 'empty') } catch { /* приватный режим */ }
}

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

  // Телефон: вид «День» (список задач дня) или «Таблица» (сетка), действия спрятаны под кнопку
  const [isMobile, setIsMobile] = useState(() => window.matchMedia(MOBILE_QUERY).matches)
  useEffect(() => {
    const mq = window.matchMedia(MOBILE_QUERY)
    const onChange = (e: MediaQueryListEvent) => setIsMobile(e.matches)
    mq.addEventListener('change', onChange)
    return () => mq.removeEventListener('change', onChange)
  }, [])
  const [mobileView, setMobileView] = useState<'day' | 'grid'>('day')
  const [mobileDate, setMobileDate] = useState(today)
  const [showActions, setShowActions] = useState(false)
  // Окно «Перенос задачи»: дата и бригада вводятся, а не выбираются кликом по клетке
  // fill — занимать ли освободившееся место следующими задачами бригады (последний выбор помним);
  // whole — перенести позицию целиком (все её дни без факта: wholeDays дней, wholeQty шт)
  type MoveDialog = { taskId: string; rowId: string; fromDate: string; fromTeamId: string | null; qty: number; manual: boolean; date: string; teamId: string; fill: boolean; whole: boolean; wholeDays: number; wholeQty: number }
  const [moveDialog, setMoveDialog] = useState<MoveDialog | null>(null)
  const [moveTeams, setMoveTeams] = useState<{ teamId: string; teamName: string; perDay: number }[]>([])
  const [moveTargetLoad, setMoveTargetLoad] = useState<TeamLoad | null>(null)
  // Итог переноса: что сдвинулось вправо и что встало на освободившееся место
  type Cascade = {
    shifted: { orderNumber: string; product: string; date: string; prevDate: string }[]
    pulled: { orderNumber: string; product: string; qty: number; date: string }[]
    overload: { load: number; capacity: number } | null
    mergedIntoOwn: boolean
    filled: boolean
  }
  type MoveResult = Cascade & { title: string; freedDate: string; targetDate: string; heading?: string }
  const [moveResult, setMoveResult] = useState<MoveResult | null>(null)
  // Сколько у позиции в графике (дни, штуки) — для галочки «вся позиция» в окне задачи
  const [planSummary, setPlanSummary] = useState<{ days: number; qty: number } | null>(null)
  const [deleteWhole, setDeleteWhole] = useState(false)
  // «Не в графике»: позиции, у которых часть количества не стоит в плане (сняли вручную и т. п.)
  type OffItem = {
    orderItemId: string; orderNumber: string; customer: string; productCode: string; productName: string; categoryName: string
    transferDate: string | null; quantity: number; planned: number; gap: number; manualQty: number
    offPlanAt: string | null; offPlanBy: string | null; offPlanTeamId: string | null; offPlanTeamName: string | null
    reason: 'manual' | 'unplanned' | 'noTeam'
  }
  const [offItems, setOffItems] = useState<OffItem[]>([])
  // Ячейки «оставлено пустым» (перенос без заполнения): показываем, пока у бригады там свободно
  type EmptySlot = {
    orderItemId: string; date: string; teamId: string | null; teamName: string | null; createdAt: string; createdBy: string | null; stillFree: boolean
    orderNumber: string; orderId: string; quantity: number; productCode: string; productName: string; workshopName: string
  }
  const [emptySlots, setEmptySlots] = useState<EmptySlot[]>([])
  const [showOff, setShowOff] = useState(false)
  type ReturnDialog = { item: OffItem; mode: 'fifo' | 'date'; date: string; teamId: string }
  const [returnDialog, setReturnDialog] = useState<ReturnDialog | null>(null)
  const [returnTeams, setReturnTeams] = useState<{ teamId: string; teamName: string; perDay: number }[]>([])


  // Undo
  type UndoAction = { label: string; fn: () => Promise<void> }
  const [undoAction, setUndoAction] = useState<UndoAction | null>(null)

  // Rollover result
  type RolloverResult = { rolled: number; items: { orderNumber: string; productCode: string; shortfall: number }[]; overloadedTeams: string[] }
  const [rolloverResult, setRolloverResult] = useState<RolloverResult | null>(null)
  const [rollingOver, setRollingOver] = useState(false)

  // Excel export
  const [showExport, setShowExport] = useState(false)
  const [exportFrom, setExportFrom] = useState(today)
  const [exportTo, setExportTo] = useState(addDays(today, 30))
  const [exporting, setExporting] = useState(false)

  const downloadExcel = async () => {
    setExporting(true)
    try {
      const res = await fetch(`/api/planning/export-excel?from=${exportFrom}&to=${exportTo}`, { credentials: 'include' })
      if (!res.ok) { alert('Ошибка при экспорте'); return }
      const blob = await res.blob()
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = `plan_${exportFrom}_${exportTo}.xlsx`
      a.click()
      URL.revokeObjectURL(url)
      setShowExport(false)
    } finally {
      setExporting(false)
    }
  }

  // Planning actions
  const [planningUnplanned, setPlanningUnplanned] = useState(false)
  const [replanning, setReplanning] = useState(false)
  const [planResult, setPlanResult] = useState<string | null>(null)
  const [noTeamCategories, setNoTeamCategories] = useState<{ id: string; name: string; workshopName: string }[] | null>(null)
  const [loadingNoTeam, setLoadingNoTeam] = useState(false)
  const [allTeamsList, setAllTeamsList] = useState<Team[]>([])
  const [assigningCategory, setAssigningCategory] = useState<string | null>(null)
  const [assignTeamId, setAssignTeamId] = useState('')
  const [assignSaving, setAssignSaving] = useState(false)

  const planUnplanned = async () => {
    setPlanningUnplanned(true); setPlanResult(null)
    const { data, error: e } = await api.post<{ total: number; planned: number; skipped: number; noTeam: number }>(
      '/order-items/plan-unplanned', {}
    )
    setPlanningUnplanned(false)
    if (e) { setPlanResult(`Ошибка: ${e}`); return }
    if (!data) return
    if (data.total === 0) {
      setPlanResult('Все позиции уже запланированы.')
    } else {
      const parts = [`Запланировано: ${data.planned} из ${data.total} позиций.`]
      if (data.noTeam > 0) parts.push(`Нет бригады для категории: ${data.noTeam} поз. — нажмите «Категории без бригад».`)
      if (data.skipped > 0) parts.push(`Пропущено: ${data.skipped}.`)
      setPlanResult(parts.join(' '))
    }
    loadPlan()
  }

  const replanQueue = async () => {
    if (!confirm('Удалить все незапущенные задачи и перепланировать все позиции от старых заказов к новым?')) return
    setReplanning(true); setPlanResult(null)
    const { data, error: e } = await api.post<{ message: string; deletedTasks: number; planned: number; failed: number }>(
      '/planning/replan-queue', {}
    )
    setReplanning(false)
    if (e) setPlanResult(`Ошибка: ${e}`)
    else if (data) setPlanResult(`${data.message} Удалено задач: ${data.deletedTasks}.`)
    loadPlan()
  }

  const fetchNoTeamCategories = async () => {
    if (noTeamCategories !== null) { setNoTeamCategories(null); return }
    setLoadingNoTeam(true)
    const [ntRes, teamsRes] = await Promise.all([
      api.get<{ id: string; name: string; workshopName: string }[]>('/categories/no-team'),
      api.get<Team[]>('/teams'),
    ])
    setLoadingNoTeam(false)
    setNoTeamCategories(ntRes.data ?? [])
    setAllTeamsList(teamsRes.data ?? [])
  }

  const assignTeam = async (categoryId: string) => {
    if (!assignTeamId) return
    setAssignSaving(true)
    const { error: e } = await api.post('/category-teams', { categoryId, teamId: assignTeamId })
    setAssignSaving(false)
    if (e) return
    setAssignTeamId('')
    setAssigningCategory(null)
    const { data } = await api.get<{ id: string; name: string; workshopName: string }[]>('/categories/no-team')
    setNoTeamCategories(data ?? [])
  }

  // popup form state
  const [editQty, setEditQty] = useState(0)
  const [editTeamId, setEditTeamId] = useState('')

  // header load tooltip
  const [headerTooltip, setHeaderTooltip] = useState<{ date: string; x: number; y: number } | null>(null)
  // Подсказка в таблице (название товара, план/факт клетки) — сразу при наведении, без задержки title
  const [tip, setTip] = useState<{ text: string; x: number; y: number } | null>(null)
  const tipProps = (text: string) => ({
    onMouseEnter: (e: React.MouseEvent) => setTip({ text, x: e.clientX, y: e.clientY }),
    onMouseMove: (e: React.MouseEvent) => setTip({ text, x: e.clientX, y: e.clientY }),
    onMouseLeave: () => setTip(null),
  })

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
    const [{ data, error: e }, { data: slots }] = await Promise.all([
      api.get<DailyTask[]>(`/daily-tasks/plan?${params}`),
      api.get<EmptySlot[]>(`/daily-tasks/empty-slots?dateFrom=${dateFrom}&dateTo=${dateTo}`),
    ])
    setLoading(false)
    if (e) { setError(e); return }
    setEmptySlots((slots ?? []).filter(sl => sl.stillFree))
    setTasks(data ?? [])
    setError(null)
  }, [dateFrom, dateTo, workshopId, teamId, orderId])

  // Список «Не в графике» обновляется вместе с планом (удаление, перенос, «Запланировать»)
  const loadOffSchedule = useCallback(async () => {
    const { data } = await api.get<OffItem[]>('/order-items/off-schedule')
    setOffItems(data ?? [])
  }, [])
  useEffect(() => { loadOffSchedule() }, [tasks, loadOffSchedule])

  useEffect(() => { loadFilters() }, [])
  useEffect(() => { loadPlan() }, [loadPlan])

  // close popup on outside click
  useEffect(() => {
    if (!popup) return
    const handler = (e: MouseEvent | TouchEvent) => {
      if (popupRef.current && !popupRef.current.contains(e.target as Node)) {
        closePopup()
      }
    }
    document.addEventListener('mousedown', handler)
    document.addEventListener('touchstart', handler)
    return () => {
      document.removeEventListener('mousedown', handler)
      document.removeEventListener('touchstart', handler)
    }
  }, [popup])

  const dates = useMemo(() => getDatesInRange(dateFrom, dateTo), [dateFrom, dateTo])

  // Выбранный день на телефоне всегда внутри выбранного периода
  useEffect(() => {
    if (!dates.includes(mobileDate)) setMobileDate(dates.includes(today) ? today : dates[0] ?? today)
  }, [dates, mobileDate, today])

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
        manual: task.manuallyPlaced ?? false,
        manualAt: task.manualAt ?? null,
        manualBy: task.manualBy ?? null,
      }
    }
    // Позиция, у которой в периоде осталась только пометка «оставлено пустым», — тоже строкой
    for (const sl of emptySlots) {
      if (map.has(sl.orderItemId)) continue
      if ((workshopId || teamId || orderId) && !(teamId && sl.teamId === teamId) && !(orderId && sl.orderId === orderId)) continue
      map.set(sl.orderItemId, {
        orderItemId: sl.orderItemId, workshopName: sl.workshopName, teamName: sl.teamName ?? '—',
        productCode: sl.productCode, productName: sl.productName, orderNumber: sl.orderNumber, orderId: sl.orderId,
        quantity: sl.quantity, cells: {},
      })
    }
    const slotItems = new Set(emptySlots.map(sl => sl.orderItemId))
    return Array.from(map.values())
      .filter(row => Object.values(row.cells).some(c => c.plannedQuantity > 0) || slotItems.has(row.orderItemId))
      .sort((a, b) => {
        if (a.workshopName !== b.workshopName) return a.workshopName.localeCompare(b.workshopName, 'ru')
        if (a.teamName !== b.teamName) return a.teamName.localeCompare(b.teamName, 'ru')
        if (a.orderNumber !== b.orderNumber) return a.orderNumber.localeCompare(b.orderNumber, 'ru', { numeric: true })
        return a.productCode.localeCompare(b.productCode, 'ru')
      })
  }, [tasks, emptySlots, workshopId, teamId, orderId])

  const emptySlotMap = useMemo(() => new Map(emptySlots.map(sl => [`${sl.orderItemId}|${sl.date}`, sl])), [emptySlots])

  // При первом открытии на телефоне — ближайший день с задачами (например, если сегодня выходной)
  const autoPickedDay = useRef(false)
  useEffect(() => {
    if (autoPickedDay.current || rows.length === 0) return
    autoPickedDay.current = true
    const hasTasks = (d: string) => rows.some(r => (r.cells[d]?.plannedQuantity ?? 0) > 0)
    if (hasTasks(mobileDate)) return
    const next = dates.find(d => d >= mobileDate && hasTasks(d)) ?? dates.find(hasTasks)
    if (next) setMobileDate(next)
  }, [rows, dates, mobileDate])

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
    if (date < today && cell.actualQuantity === null) return 'var(--danger-light)'
    if (cell.actualQuantity !== null && cell.actualQuantity >= cell.plannedQuantity) return 'var(--success-light)'
    if (cell.actualQuantity !== null && cell.actualQuantity > 0) return 'var(--warning-light)'
    return 'var(--plan-scheduled)'
  }

  const HEADER_BG = 'var(--plan-header)'
  const HEADER_COLOR = 'var(--text-secondary)'
  const stickyW = isMobile ? STICKY_W_MOBILE : STICKY_W
  const stickyLeft = (i: number) => stickyW.slice(0, i).reduce((a, b) => a + b, 0)

  const closePopup = () => {
    setPopup(null)
  }

  const openPopup = (e: React.MouseEvent, row: RowData, date: string, cell: CellData | null) => {
    e.stopPropagation()

    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect()
    setEditQty(cell?.plannedQuantity ?? 0)
    setEditTeamId(cell?.teamId ?? '')
    setShowSplitForm(false)
    setSplitQty2(cell ? Math.floor(cell.plannedQuantity / 2) : 0)
    setSplitDate2(todayISO())
    setSplitLoad(null)
    setDeleteWhole(false)
    setPlanSummary(null)
    if (cell) api.get<{ days: number; qty: number }>(`/order-items/${row.orderItemId}/plan-summary`).then(({ data }) => setPlanSummary(data ?? null))
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
      const prevQty = popup.cell.plannedQuantity
      const prevTeamId = popup.cell.teamId
      const prevManual = popup.cell.manual
      const taskId = popup.cell.taskId
      // Без изменений — не сохраняем, иначе задача зря станет ручной
      if (editQty !== prevQty || (editTeamId || null) !== prevTeamId) {
        await api.put(`/daily-tasks/${taskId}`, { plannedQuantity: editQty, teamId: editTeamId || null })
        setUndoAction({
          label: `Вернуть ${prevQty} шт.`,
          fn: async () => { await api.put(`/daily-tasks/${taskId}`, { plannedQuantity: prevQty, teamId: prevTeamId, manuallyPlaced: prevManual }) },
        })
      }
    } else {
      const oi = allOrderItems.find(o => o.id === popup.rowId)
      const defQty = oi?.remainingQuantity ?? editQty
      const { data } = await api.post<{ id: string }>('/daily-tasks', {
        orderItemId: popup.rowId,
        date: new Date(popup.date).toISOString(),
        plannedQuantity: editQty || defQty,
        teamId: editTeamId || undefined,
      })
      if (data?.id) {
        const createdId = data.id
        setUndoAction({ label: 'Удалить созданную задачу', fn: async () => { await api.delete(`/daily-tasks/${createdId}`) } })
      }
    }
    setSaving(false)
    closePopup()
    loadPlan()
  }

  // Удалить задачу (или позицию целиком — все дни). Снятое попадает в «Не в графике», автоматика его не вернёт
  const handleDelete = async () => {
    if (!popup?.cell) return
    const whole = deleteWhole && (planSummary?.days ?? 0) > 1
    if (!confirm(whole ? `Снять с графика всю позицию — ${planSummary!.days} дн., ${planSummary!.qty} шт?` : 'Удалить задачу?')) return
    const { taskId } = popup.cell
    const orderItemId = popup.rowId
    const row = rows.find(r => r.orderItemId === orderItemId)
    const { data, error: e } = await api.delete(`/daily-tasks/${taskId}${whole ? '?whole=1' : ''}`) as { data?: { removed: number; deleted: { date: string; teamId: string | null; plannedQuantity: number }[] }; error?: string }
    if (e) { setError(e); return }
    const deleted = data?.deleted ?? []
    if ((data?.removed ?? 0) > 0) setPlanResult(`${row?.orderNumber ?? ''} · ${data!.removed} шт сняты с графика — позиция в списке «Не в графике».`)
    setUndoAction(deleted.length ? {
      label: `Восстановить ${deleted.reduce((s, t) => s + t.plannedQuantity, 0)} шт.`,
      fn: async () => {
        for (const t of deleted) {
          await api.post('/daily-tasks', { orderItemId, date: t.date, plannedQuantity: t.plannedQuantity, teamId: t.teamId || undefined })
        }
      },
    } : null)
    closePopup()
    loadPlan()
  }

  // «Вернуть в график» из списка «Не в графике»: в очередь (FIFO) или с конкретной даты
  const openReturn = async (item: OffItem) => {
    setReturnDialog({ item, mode: 'fifo', date: todayISO(), teamId: item.offPlanTeamId ?? '' })
    const { data } = await api.get<{ teamId: string; teamName: string; perDay: number }[]>(`/order-items/${item.orderItemId}/teams`)
    setReturnTeams(data ?? [])
    const first = data?.[0]?.teamId ?? ''
    setReturnDialog(d => d && d.item.orderItemId === item.orderItemId && !d.teamId ? { ...d, teamId: first } : d)
  }

  const submitReturn = async () => {
    if (!returnDialog) return
    const d = returnDialog
    setSaving(true)
    const { data, error: e } = await api.post<{ qty: number; firstDate: string | null; lastDate: string | null; teamId: string | null; cascade: Cascade }>(
      `/order-items/${d.item.orderItemId}/return`,
      { mode: d.mode, teamId: d.teamId, ...(d.mode === 'date' ? { date: new Date(d.date).toISOString() } : {}) },
    )
    setSaving(false)
    if (e) { setError(e); return }
    setReturnDialog(null)
    const teamName = teams.find(t => t.id === (data?.teamId ?? d.teamId))?.name ?? ''
    const first = data?.firstDate, last = data?.lastDate
    const when = first ? (first === last || !last ? formatDateShort(first) : `${formatDateShort(first)}–${formatDateShort(last)}`) : ''
    setMoveResult({
      heading: 'Позиция возвращена в график',
      title: `${d.item.orderNumber} · ${data?.qty ?? d.item.gap} шт${when ? ` — ${when}` : ''}${teamName ? `, ${teamName}` : ''}`,
      shifted: data?.cascade?.shifted ?? [], pulled: [], overload: null, mergedIntoOwn: false, filled: true,
      freedDate: first ?? d.date, targetDate: first ?? d.date,
    })
    setUndoAction(null)
    loadPlan()
  }

  // Снять закрепление: задача снова в руках автопланирования («Перепланировать очередь» её пересоберёт)
  const handleUnpin = async () => {
    if (!popup?.cell) return
    const taskId = popup.cell.taskId
    setSaving(true)
    await api.put(`/daily-tasks/${taskId}`, { manuallyPlaced: false })
    setUndoAction({ label: 'Закрепить обратно', fn: async () => { await api.put(`/daily-tasks/${taskId}`, { manuallyPlaced: true }) } })
    setSaving(false)
    closePopup()
    loadPlan()
  }

  // «Перенести» в окне задачи — открывает окно переноса с текущей датой и бригадой
  const startMove = async () => {
    if (!popup?.cell) return
    const c = popup.cell
    const rowId = popup.rowId
    setMoveDialog({ taskId: c.taskId, rowId, fromDate: popup.date, fromTeamId: c.teamId, qty: c.plannedQuantity, manual: c.manual, date: popup.date, teamId: c.teamId ?? '', fill: loadMoveFill(), whole: false, wholeDays: planSummary?.days ?? 1, wholeQty: planSummary?.qty ?? c.plannedQuantity })
    setMoveTargetLoad(null)
    setPopup(null)
    const [{ data }, { data: sum }] = await Promise.all([
      api.get<{ teamId: string; teamName: string; perDay: number }[]>(`/order-items/${rowId}/teams`),
      api.get<{ days: number; qty: number }>(`/order-items/${rowId}/plan-summary`),
    ])
    setMoveTeams(data ?? [])
    if (sum) setMoveDialog(d => d && d.taskId === c.taskId ? { ...d, wholeDays: sum.days, wholeQty: sum.qty } : d)
  }

  // Загрузка выбранной бригады в выбранный день — чтобы было видно, хватит ли места
  useEffect(() => {
    if (!moveDialog?.teamId || !moveDialog.date) { setMoveTargetLoad(null); return }
    let cancelled = false
    api.get<TeamLoad>(`/teams/${moveDialog.teamId}/load?date=${moveDialog.date}`).then(({ data }) => { if (!cancelled) setMoveTargetLoad(data ?? null) })
    return () => { cancelled = true }
  }, [moveDialog?.teamId, moveDialog?.date])

  const showCascade = (title: string, cascade: Cascade | null | undefined, freedDate: string, targetDate: string) => {
    setMoveResult({ title, shifted: cascade?.shifted ?? [], pulled: cascade?.pulled ?? [], overload: cascade?.overload ?? null, mergedIntoOwn: cascade?.mergedIntoOwn ?? false, filled: cascade?.filled ?? true, freedDate, targetDate })
  }

  const submitMove = async () => {
    if (!moveDialog) return
    const d = moveDialog
    if (d.date === d.fromDate && (d.teamId || null) === d.fromTeamId) { setMoveDialog(null); return }
    setSaving(true)
    saveMoveFill(d.fill)
    const whole = d.whole && d.wholeDays > 1
    const body: Record<string, unknown> = { fill: d.fill, ...(whole ? { wholeItem: true } : {}) }
    if (d.date !== d.fromDate) body.date = new Date(d.date).toISOString()
    if ((d.teamId || null) !== d.fromTeamId) body.teamId = d.teamId || null
    const { data, error: e } = await api.put<{ id: string; cascade: Cascade | null }>(`/daily-tasks/${d.taskId}`, body)
    setSaving(false)
    if (e) { setError(e); return }
    setMoveDialog(null)
    const teamName = (id: string | null) => teams.find(t => t.id === id)?.name ?? 'без бригады'
    const row = rows.find(r => r.orderItemId === d.rowId)
    const where = [d.date !== d.fromDate ? `на ${formatDateShort(d.date)}` : '', (d.teamId || null) !== d.fromTeamId ? `в ${teamName(d.teamId || null)}` : ''].filter(Boolean).join(' ')
    showCascade(`${row?.orderNumber ?? ''} · ${whole ? `вся позиция, ${d.wholeQty} шт,` : `${d.qty} шт`} перенесены ${where}`, data?.cascade, d.fromDate, d.date)
    // Позицию целиком назад одной кнопкой не вернуть (её дни могли быть в разных бригадах) — без «Отменить»
    if (whole) { setUndoAction(null); loadPlan(); return }
    const movedId = data?.id ?? d.taskId
    setUndoAction({
      label: `Вернуть на ${formatDateShort(d.fromDate)}`,
      // Возврат — в том же режиме: если место не заполняли, обратно тоже ничего не подтягиваем
      fn: async () => { await api.put(`/daily-tasks/${movedId}`, { date: new Date(d.fromDate).toISOString(), teamId: d.fromTeamId, manuallyPlaced: d.manual, fill: d.fill }) },
    })
    loadPlan()
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

  const handleRollover = async () => {
    setRollingOver(true)
    const { data, error: e } = await api.post<RolloverResult>('/planning/rollover-shortfall', {})
    setRollingOver(false)
    if (e) { setError(e); return }
    setRolloverResult(data ?? null)
    loadPlan()
  }

  const handleClearSchedule = async () => {
    if (!confirm('Очистить весь график? Все запланированные задачи будут удалены. Факт-записи останутся.')) return
    setSaving(true)
    await api.delete('/daily-tasks')
    setSaving(false)
    loadPlan()
  }

  const handleUndo = async () => {
    if (!undoAction) return
    setSaving(true)
    await undoAction.fn()
    setSaving(false)
    setUndoAction(null)
    loadPlan()
  }

  const loadBarColor = (load: DateLoad | undefined) => {
    if (!load || load.capacity === 0) return 'var(--text-muted)'
    const pct = load.planned / load.capacity
    if (pct >= 1) return 'var(--danger)'
    if (pct >= 0.75) return 'var(--warning)'
    return 'var(--success)'
  }

  const loadBarWidth = (load: DateLoad | undefined) => {
    if (!load || load.capacity === 0) return 0
    return Math.min(100, Math.round((load.planned / load.capacity) * 100))
  }


  return (
    <div className="schedule-page">
      <div className="page-heading schedule-heading">
        <div>
          <h1 className="page-title">График производства</h1>
          <p className="planning-description">Задачи, сроки и загрузка бригад в едином плане.</p>
        </div>
        <div className="page-heading-actions">
          <button type="button" className="btn btn-secondary" onClick={() => setShowExport(v => !v)}>
            {showExport ? 'Скрыть экспорт' : 'Скачать Excel'}
          </button>
          <button type="button" className="btn btn-primary" onClick={planUnplanned} disabled={planningUnplanned || replanning || saving}>
            {planningUnplanned ? 'Планирую...' : 'Запланировать незапланированные'}
          </button>
        </div>
      </div>
      <div className="schedule-toolbar">
        <button type="button" className="btn btn-secondary btn-sm schedule-actions-toggle" aria-expanded={showActions} onClick={() => setShowActions(v => !v)}>
          Действия <CaretDown size={12} weight="bold" aria-hidden="true" style={{ transform: showActions ? 'rotate(180deg)' : undefined }} />
        </button>
        <div className={showActions ? 'schedule-actions open' : 'schedule-actions'}>
          <div className="schedule-action-group">
            <button className="btn btn-secondary btn-sm" onClick={handleRollover} disabled={rollingOver || saving}>
              {rollingOver ? 'Переношу...' : 'Перенести недодел со вчера'}
            </button>
            <button type="button" className="btn btn-secondary btn-sm" onClick={replanQueue} disabled={replanning || planningUnplanned || saving}>
              {replanning ? 'Перепланирую...' : 'Перепланировать очередь'}
            </button>
            <button type="button" className="btn btn-secondary btn-sm" onClick={fetchNoTeamCategories} disabled={loadingNoTeam}>
              {loadingNoTeam ? 'Загрузка...' : noTeamCategories !== null ? 'Скрыть список' : 'Категории без бригад'}
            </button>
            <button type="button" className="btn btn-secondary btn-sm" aria-expanded={showOff} onClick={() => setShowOff(v => !v)}>
              {showOff ? 'Скрыть «Не в графике»' : 'Не в графике'}
              {!showOff && offItems.length > 0 && <span className="badge badge-warning" style={{ marginLeft: 6 }}>{offItems.length}</span>}
            </button>
          </div>
          <button type="button" className="btn btn-danger btn-sm schedule-clear" onClick={handleClearSchedule} disabled={saving || planningUnplanned || replanning}>
            Очистить график
          </button>
        </div>
      </div>
      {undoAction && (
        <div className="schedule-undo">
          <button className="btn btn-secondary btn-sm" onClick={handleUndo} disabled={saving}
            style={{ borderColor: 'var(--warning)', color: 'var(--warning)' }}>
            <ArrowCounterClockwise size={14} aria-hidden="true" /> Отменить: {undoAction.label}
          </button>
        </div>
      )}

      {showExport && (
        <div style={{ marginBottom: 10, padding: '10px 14px', borderRadius: 8, fontSize: '0.875rem',
          background: 'var(--surface)', border: '1px solid var(--border)',
          display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
          <span style={{ fontWeight: 600 }}>Период:</span>
          <input type="date" value={exportFrom} onChange={e => setExportFrom(e.target.value)}
            style={{ padding: '3px 8px', border: '1px solid var(--border)', borderRadius: 4 }} />
          <span>—</span>
          <input type="date" value={exportTo} onChange={e => setExportTo(e.target.value)}
            style={{ padding: '3px 8px', border: '1px solid var(--border)', borderRadius: 4 }} />
          <button className="btn btn-primary btn-sm" onClick={downloadExcel} disabled={exporting}>
            {exporting ? 'Формирую...' : 'Скачать .xlsx'}
          </button>
        </div>
      )}

      {planResult && (
        <div style={{ marginBottom: 10, padding: '8px 14px', borderRadius: 8, fontSize: '0.83rem',
          background: 'var(--success-light)', border: '1px solid var(--plan-success-border)', color: 'var(--success)',
          display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          <span>{planResult}</span>
          <button type="button" className="icon-btn" aria-label="Закрыть"
            onClick={() => setPlanResult(null)}><X size={14} weight="bold" aria-hidden="true" /></button>
        </div>
      )}

      {showOff && (
        <div className="card off-schedule">
          <div className="off-schedule-head">
            <h2 className="card-title" style={{ margin: 0 }}>Не в графике {offItems.length > 0 && <span className="off-schedule-count">{offItems.length}</span>}</h2>
            <p>Позиции активных заказов, у которых часть количества не стоит в плане. Снятое вручную автоматика обратно не ставит — только «Вернуть в график».</p>
          </div>
          {offItems.length === 0 ? (
            <div className="empty">Всё количество стоит в графике.</div>
          ) : (
            <table className="stack">
              <thead>
                <tr>
                  <th>Заказ</th>
                  <th>Товар</th>
                  <th>Дата передачи</th>
                  <th style={{ textAlign: 'right' }}>Не в графике</th>
                  <th>Причина</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {offItems.map(it => (
                  <tr key={it.orderItemId}>
                    <td className="stack-title">
                      <strong>{it.orderNumber}</strong>
                      <span className="off-sub">{it.customer}</span>
                    </td>
                    <td data-label="Товар">
                      <span className="off-cell">
                        {it.productName || it.productCode}
                        <span className="off-sub">{it.productCode}</span>
                      </span>
                    </td>
                    <td data-label="Дата передачи">{it.transferDate ? it.transferDate.split('-').reverse().join('.') : '—'}</td>
                    <td data-label="Не в графике" style={{ textAlign: 'right', whiteSpace: 'nowrap' }}>
                      <span className="off-cell"><strong>{it.gap}</strong> из {it.quantity} шт</span>
                    </td>
                    <td data-label="Причина">
                      {it.reason === 'manual' ? (
                        <span className="off-reason">
                          <span className="badge badge-warning">Снято вручную{it.manualQty < it.gap ? ` · ${it.manualQty} шт` : ''}</span>
                          <span className="off-sub">{[it.offPlanBy, it.offPlanAt ? new Date(it.offPlanAt).toLocaleString('ru-RU', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }) : null, it.offPlanTeamName].filter(Boolean).join(' · ')}</span>
                        </span>
                      ) : it.reason === 'noTeam' ? (
                        <span className="badge badge-danger">Нет бригады с нормой</span>
                      ) : (
                        <span className="badge badge-neutral">Не запланировано</span>
                      )}
                    </td>
                    <td className="stack-actions" style={{ textAlign: 'right' }}>
                      <button type="button" className="btn btn-primary btn-sm" onClick={() => openReturn(it)} disabled={it.reason === 'noTeam'}>
                        Вернуть в график
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      )}

      {noTeamCategories !== null && (
        <div className="card" style={{ marginBottom: 10, padding: '12px 16px' }}>
          <div style={{ fontWeight: 600, marginBottom: 8 }}>
            Категории без бригад {noTeamCategories.length === 0 ? '— все назначены' : `(${noTeamCategories.length})`}
          </div>
          {noTeamCategories.length > 0 && (
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 14 }}>
              <thead>
                <tr style={{ background: 'var(--plan-header)', color: 'var(--text-secondary)' }}>
                  <th style={{ padding: '6px 12px', textAlign: 'left' }}>Категория</th>
                  <th style={{ padding: '6px 12px', textAlign: 'left' }}>Участок</th>
                  <th style={{ padding: '6px 12px' }}></th>
                </tr>
              </thead>
              <tbody>
                {noTeamCategories.map((c) => (
                  <>
                    <tr key={c.id} style={{ borderBottom: assigningCategory === c.id ? 'none' : '1px solid var(--border)' }}>
                      <td style={{ padding: '6px 12px' }}>{c.name}</td>
                      <td style={{ padding: '6px 12px', color: 'var(--text-secondary)' }}>{c.workshopName}</td>
                      <td style={{ padding: '6px 12px', textAlign: 'right' }}>
                        <button
                          type="button" className="btn btn-primary btn-sm"
                          onClick={() => { setAssigningCategory(assigningCategory === c.id ? null : c.id); setAssignTeamId('') }}
                        >
                          {assigningCategory === c.id ? 'Отмена' : 'Назначить бригаду'}
                        </button>
                      </td>
                    </tr>
                    {assigningCategory === c.id && (
                      <tr key={c.id + '_assign'} style={{ borderBottom: '1px solid var(--border)', background: 'var(--bg-subtle, var(--plan-surface-muted))' }}>
                        <td colSpan={3} style={{ padding: '8px 12px' }}>
                          <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                            <select value={assignTeamId} onChange={e => setAssignTeamId(e.target.value)} style={{ flex: 1 }}>
                              <option value="">— выберите бригаду —</option>
                              {allTeamsList.map(t => <option key={t.id} value={t.id}>{t.name}</option>)}
                            </select>
                            <button
                              type="button" className="btn btn-primary btn-sm"
                              onClick={() => assignTeam(c.id)}
                              disabled={!assignTeamId || assignSaving}
                            >
                              {assignSaving ? 'Сохраняю...' : 'Сохранить'}
                            </button>
                          </div>
                        </td>
                      </tr>
                    )}
                  </>
                ))}
              </tbody>
            </table>
          )}
        </div>
      )}

      {error && (
        <div className="error error-dismiss" onClick={() => setError(null)} title="Скрыть">
          {error} <X size={12} weight="bold" aria-hidden="true" />
        </div>
      )}

      {/* Rollover result */}
      {rolloverResult && (
        <div style={{ marginBottom: 10, padding: '8px 14px', borderRadius: 8, fontSize: '0.83rem',
          background: rolloverResult.rolled === 0 ? 'var(--success-light)' : 'var(--warning-light)',
          border: `1px solid ${rolloverResult.rolled === 0 ? 'var(--plan-success-border)' : 'var(--plan-warning-border)'}`,
          color: rolloverResult.rolled === 0 ? 'var(--success)' : 'var(--warning)',
          display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          <span>
            {rolloverResult.rolled === 0
              ? 'Недодела нет — все задачи вчера выполнены.'
              : `Перенесено ${rolloverResult.rolled} позиций.${rolloverResult.overloadedTeams.length > 0 ? ' Часть бригад перегружена — проверьте план.' : ''}`}
          </span>
          <button type="button" className="icon-btn" aria-label="Закрыть"
            onClick={() => setRolloverResult(null)}><X size={14} weight="bold" aria-hidden="true" /></button>
        </div>
      )}

      <div className="card schedule-card">
        <div className="schedule-filters">
          <div className="schedule-date-filters">
            <label>
              С: <input type="date" value={dateFrom} onChange={e => setDateFrom(e.target.value)} />
            </label>
            <label>
              По: <input type="date" value={dateTo} onChange={e => setDateTo(e.target.value)} />
            </label>
          </div>
          <div className="schedule-entity-filters">
            <label>
              Участок:
              <select value={workshopId} onChange={e => setWorkshopId(e.target.value)}>
                <option value="">— все —</option>
                {workshops.map(w => <option key={w.id} value={w.id}>{w.name}</option>)}
              </select>
            </label>
            <label>
              Бригада:
              <select value={teamId} onChange={e => setTeamId(e.target.value)}>
                <option value="">— все —</option>
                {teams.map(t => <option key={t.id} value={t.id}>{t.name}</option>)}
              </select>
            </label>
            <label>
              Заказ:
              <select value={orderId} onChange={e => setOrderId(e.target.value)}>
                <option value="">— все —</option>
                {orders.map(o => <option key={o.id} value={o.id}>{o.orderNumber}</option>)}
              </select>
            </label>
          </div>
        </div>

        {isMobile && (
          <div className="view-switch" role="tablist">
            <button type="button" role="tab" aria-selected={mobileView === 'day'} className={mobileView === 'day' ? 'active' : ''} onClick={() => setMobileView('day')}>День</button>
            <button type="button" role="tab" aria-selected={mobileView === 'grid'} className={mobileView === 'grid' ? 'active' : ''} onClick={() => setMobileView('grid')}>Таблица</button>
          </div>
        )}

        {loading ? (
          <div className="empty">Загрузка...</div>
        ) : rows.length === 0 ? (
          <div className="empty">Нет задач за выбранный период.</div>
        ) : isMobile && mobileView === 'day' ? (
          <>
            <div className="day-chips">
              {dates.map(d => {
                const count = rows.filter(r => (r.cells[d]?.plannedQuantity ?? 0) > 0).length
                return (
                  <button key={d} type="button"
                    className={['day-chip', d === mobileDate ? 'active' : '', isOffDay(d) ? 'weekend' : '', d === today ? 'today' : ''].filter(Boolean).join(' ')}
                    onClick={() => setMobileDate(d)}>
                    <span>{formatDayOfWeek(d)}</span>
                    <strong>{formatDateShort(d)}</strong>
                    <small>{count > 0 ? `${count} поз.` : '—'}</small>
                  </button>
                )
              })}
            </div>
            {(() => {
              const dayRows = rows.filter(r => (r.cells[mobileDate]?.plannedQuantity ?? 0) > 0)
              if (dayRows.length === 0) return <div className="empty">На {formatDateShort(mobileDate)} задач нет.</div>
              const groups: { workshop: string; teams: { team: string; rows: RowData[] }[] }[] = []
              for (const row of dayRows) {
                let ws = groups[groups.length - 1]
                if (!ws || ws.workshop !== row.workshopName) { ws = { workshop: row.workshopName, teams: [] }; groups.push(ws) }
                let tm = ws.teams[ws.teams.length - 1]
                if (!tm || tm.team !== row.teamName) { tm = { team: row.teamName, rows: [] }; ws.teams.push(tm) }
                tm.rows.push(row)
              }
              return groups.map(ws => (
                <div key={ws.workshop} className="day-group">
                  <div className="day-group-title">{ws.workshop}</div>
                  {ws.teams.map(tm => {
                    const plan = tm.rows.reduce((s, r) => s + (r.cells[mobileDate]?.plannedQuantity ?? 0), 0)
                    const fact = tm.rows.reduce((s, r) => s + (r.cells[mobileDate]?.actualQuantity ?? 0), 0)
                    return (
                      <div key={tm.team}>
                        <div className="day-team-title">
                          <span>{tm.team}</span>
                          <span>план {plan} · факт {fact}</span>
                        </div>
                        {tm.rows.map(row => {
                          const cell = row.cells[mobileDate]!
                          return (
                            <button key={row.orderItemId} type="button" className="day-task"
                              style={{ borderLeftColor: STATUS_BORDER[cellBg(cell, mobileDate)] ?? 'var(--border)' }}
                              onClick={e => openPopup(e, row, mobileDate, cell)}>
                              <span className="day-task-main">
                                <strong>{row.orderNumber}</strong>
                                <span>{row.productName || row.productCode}</span>
                              </span>
                              <span className="day-task-qty">
                                <strong>{cell.manual && <PushPin className="pin-mark" size={12} weight="fill" aria-label={manualInfo(cell)} />}{cell.plannedQuantity}</strong>
                                {cell.actualQuantity !== null && <span>✓{cell.actualQuantity}</span>}
                              </span>
                            </button>
                          )
                        })}
                      </div>
                    )
                  })}
                </div>
              ))
            })()}
          </>
        ) : (
          <div className="schedule-grid-scroll" onScroll={() => setTip(null)}>
            <table style={{ borderCollapse: 'separate', borderSpacing: 0, fontSize: '0.8rem', tableLayout: 'fixed' }}>
              <colgroup>
                <col style={{ width: stickyW[0] }} />
                <col style={{ width: stickyW[1] }} />
                {dates.map(d => <col key={d} style={{ width: 70 }} />)}
              </colgroup>
              <thead>
                <tr>
                  {(['Бригада', 'Заказ / Товар'] as const).map((label, i) => (
                    <th key={label} style={{
                      position: 'sticky', left: stickyLeft(i), top: 0, zIndex: 5,
                      background: HEADER_BG, color: HEADER_COLOR,
                      padding: '6px 8px', textAlign: 'left',
                      borderRight: i === 1 ? '2px solid var(--border-strong)' : '1px solid var(--border)',
                      whiteSpace: 'nowrap', fontWeight: 600, fontSize: '0.75rem', textTransform: 'none', letterSpacing: '0'
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
                          position: 'sticky', top: 0, zIndex: 3,
                          background: d === today ? 'var(--primary-light)' : isOffDay(d) ? 'var(--plan-weekend)' : HEADER_BG,
                          color: d === today ? 'var(--primary)' : isOffDay(d) ? 'var(--text-muted)' : HEADER_COLOR,
                          padding: '4px 2px', textAlign: 'center',
                          borderRight: '1px solid var(--border)',
                          fontWeight: d === today ? 600 : 400,
                        }}>
                        <div style={{ fontSize: '0.75rem', opacity: 0.75 }}>{formatDayOfWeek(d)}</div>
                        <div style={{ fontSize: '0.78rem' }}>{formatDateShort(d)}</div>
                        {barW > 0 && (
                          <div style={{ margin: '2px 4px 0', height: 3, borderRadius: 2, background: 'var(--border)' }}>
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
                            position: 'sticky', left: 0, zIndex: 2,
                            background: 'var(--plan-section)', color: 'var(--text-secondary)',
                            padding: '8px 10px',
                            fontWeight: 600, fontSize: '0.75rem',
                            borderTop: i > 0 ? '2px solid var(--border-strong)' : undefined,
                          }}>
                            {row.workshopName}
                          </td>
                        </tr>
                      )
                    }

                    const rowBg = i % 2 === 0 ? '#fff' : 'var(--plan-surface-muted)'
                    const teamSpan = teamSpans[i]!

                    result.push(
                      <tr key={row.orderItemId} style={{ height: 46 }}>
                        {/* Team cell — only on first row of each span group */}
                        {teamSpan > 0 && (
                          <td rowSpan={teamSpan} style={{
                            position: 'sticky', left: stickyLeft(0), zIndex: 1, background: 'var(--plan-header)',
                            padding: '4px 8px', borderRight: '1px solid var(--border)',
                            overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                            color: 'var(--text-muted)', fontSize: '0.78rem',
                            verticalAlign: 'middle', borderBottom: '1px solid var(--border)',
                          }} {...tipProps(row.teamName)}>{row.teamName}</td>
                        )}
                        {/* Product cell */}
                        <td style={{
                          position: 'sticky', left: stickyLeft(1), zIndex: 1, background: rowBg,
                          padding: '4px 8px', borderRight: '2px solid var(--border-strong)',
                          overflow: 'hidden',
                        }} {...tipProps(`${row.orderNumber}\n${row.productCode} — ${row.productName}`)}>
                          <div style={{ fontWeight: 600, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                            {row.orderNumber}
                          </div>
                          <div style={{ fontSize: '0.75rem', color: 'var(--text-muted)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                            {row.productName || row.productCode}
                          </div>
                        </td>
                        {/* Date cells */}
                        {dates.map(d => {
                          const cell = row.cells[d]
                          const bg = cellBg(cell, d)
                          const emptySlot = (!cell || (cell.plannedQuantity === 0 && cell.actualQuantity === null)) ? emptySlotMap.get(`${row.orderItemId}|${d}`) : undefined
                          return (
                            <td
                              key={d}
                              onClick={e => openPopup(e, row, d, cell ?? null)}
                              style={{
                                textAlign: 'center', padding: '3px 2px',
                                borderRight: '1px solid var(--border)',
                                // Нерабочий день — серый на всю высоту (задача в нём, если есть, остаётся своего цвета)
                                background: bg !== 'transparent' ? bg : isOffDay(d) ? 'var(--plan-weekend)' : bg,
                                transition: 'background 0.15s',
                                cursor: 'pointer',
                              }}
                              {...(cell
                                ? tipProps(`${row.productName || row.productCode}\nПлан: ${cell.plannedQuantity}${cell.actualQuantity !== null ? `, факт: ${cell.actualQuantity}` : ''}${cell.manual ? `\nРучная правка — перепланирование не трогает\n${manualInfo(cell)}` : ''}${cell.comment ? `\n${cell.comment}` : ''}`)
                                : emptySlot
                                  ? tipProps(`Оставлено пустым при переносе позиции${emptySlot.teamName ? `\n${emptySlot.teamName}` : ''}\n${[emptySlot.createdBy, new Date(emptySlot.createdAt).toLocaleString('ru-RU', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })].filter(Boolean).join(' · ')}`)
                                  : {})}
                            >
                              {emptySlot && <div className="empty-slot">оставлено пустым</div>}
                              {cell && cell.plannedQuantity > 0 && (
                                <>
                                  <div style={{ fontWeight: 600, lineHeight: 1.4 }}>{cell.manual && <PushPin className="pin-mark" size={12} weight="fill" aria-label="Ручная правка" />}{cell.plannedQuantity}</div>
                                  {cell.actualQuantity !== null && (
                                    <div style={{ fontSize: '0.75rem', color: 'var(--text-secondary)', lineHeight: 1.4 }}>✓{cell.actualQuantity}</div>
                                  )}
                                </>
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

        <div className="schedule-legend">
          {[
            { bg: 'var(--plan-scheduled)', border: 'var(--plan-scheduled-border)', label: 'Запланировано' },
            { bg: 'var(--success-light)', border: 'var(--plan-success-border)', label: 'Выполнено' },
            { bg: 'var(--warning-light)', border: 'var(--plan-warning-border)', label: 'Частично' },
            { bg: 'var(--danger-light)', border: 'var(--plan-danger-border)', label: 'Просрочено' },
          ].map(({ bg, border, label }) => (
            <span key={label} style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
              <span style={{ display: 'inline-block', width: 12, height: 12, background: bg, border: `1px solid ${border}`, borderRadius: 2 }} />
              {label}
            </span>
          ))}
          <span className="schedule-help desktop-only">Кликните ячейку для редактирования</span>
        </div>

        {!loading && rows.length > 0 && (
          <div className="schedule-summary">
            {rows.length} позиций · {dates.length} дней
          </div>
        )}
      </div>

      {/* Header load tooltip */}
      {/* Перенос задачи: дата и бригада */}
      {moveDialog && (() => {
        const d = moveDialog
        const row = rows.find(r => r.orderItemId === d.rowId)
        const norm = moveTeams.find(t => t.teamId === d.teamId)
        const moveQty = d.whole && d.wholeDays > 1 ? d.wholeQty : d.qty
        const share = norm && norm.perDay > 0 ? moveQty / norm.perDay : null
        // Если бригада и день не меняются, задача сама занимает место в этом дне — не считаем её дважды
        const sameSlot = d.date === d.fromDate && (d.teamId || null) === d.fromTeamId
        const free = moveTargetLoad ? moveTargetLoad.effectiveCapacity - moveTargetLoad.load : null
        const otherTeams = teams.filter(t => !moveTeams.some(m => m.teamId === t.id))
        return (
          <div className="modal-backdrop" onClick={e => { if (e.target === e.currentTarget) setMoveDialog(null) }}>
            <div className="modal-card" role="dialog" aria-modal="true" aria-labelledby="move-title">
              <h3 id="move-title" className="form-panel-title">Перенос задачи</h3>
              <div className="move-summary">
                <strong>{row?.orderNumber}</strong> · {row?.productName || row?.productCode}
                <div>{d.qty} шт · сейчас {formatDateShort(d.fromDate)}, {teams.find(t => t.id === d.fromTeamId)?.name ?? 'без бригады'}</div>
              </div>
              {d.wholeDays > 1 && (
                <label className="check-line">
                  <input type="checkbox" checked={d.whole} onChange={e => setMoveDialog({ ...d, whole: e.target.checked })} />
                  <span>Перенести позицию целиком — все дни ({d.wholeDays} дн., {d.wholeQty} шт)
                    <small>Встанет с выбранной даты одним куском</small></span>
                </label>
              )}
              <div className="form-panel" style={{ maxWidth: 'none', margin: 0, padding: 0, border: 'none', background: 'none' }}>
                <label>Дата</label>
                <input type="date" value={d.date} onChange={e => e.target.value && setMoveDialog({ ...d, date: e.target.value })} autoFocus={!isMobile} />
                <label>Бригада</label>
                <select value={d.teamId} onChange={e => setMoveDialog({ ...d, teamId: e.target.value })}>
                  {moveTeams.length > 0 && (
                    <optgroup label="С нормой на этот товар">
                      {moveTeams.map(t => <option key={t.teamId} value={t.teamId}>{t.teamName} — {t.perDay} шт/день</option>)}
                    </optgroup>
                  )}
                  <optgroup label={moveTeams.length > 0 ? 'Без нормы на этот товар' : 'Бригады'}>
                    {otherTeams.map(t => <option key={t.id} value={t.id}>{t.name}</option>)}
                  </optgroup>
                </select>
              </div>
              <fieldset className="choice-group">
                <legend>Освободившееся место {formatDateShort(d.fromDate)}</legend>
                <label className={d.fill ? 'choice active' : 'choice'}>
                  <input type="radio" name="move-fill" checked={d.fill} onChange={() => setMoveDialog({ ...d, fill: true })} />
                  <span>
                    <strong>Заполнить</strong>
                    <small>Следующие задачи бригады сдвинутся раньше и займут место</small>
                  </span>
                </label>
                <label className={!d.fill ? 'choice active' : 'choice'}>
                  <input type="radio" name="move-fill" checked={!d.fill} onChange={() => setMoveDialog({ ...d, fill: false })} />
                  <span>
                    <strong>Оставить пустым</strong>
                    <small>Остальные задачи останутся на своих днях — например, не готовы полуфабрикаты или бригада нужна под брак</small>
                  </span>
                </label>
              </fieldset>
              {isOffDay(d.date) && <div className="move-note move-note-warn">Это нерабочий день — планировщик в него не планирует.</div>}
              {moveTargetLoad && !sameSlot && free !== null && (
                <div className={share !== null && share > free + 0.005 ? 'move-note move-note-warn' : 'move-note'}>
                  У бригады в этот день занято {Math.round(moveTargetLoad.load * 100)}% из {Math.round(moveTargetLoad.effectiveCapacity * 100)}%
                  {share !== null && <> · задача займёт {Math.round(share * 100)}%</>}.
                  {share !== null && share > free + 0.005 && <> Не поместившееся сдвинется на следующие дни этой бригады.</>}
                  {!norm && d.teamId && <> У бригады нет нормы на этот товар.</>}
                </div>
              )}
              <div className="form-actions">
                <button type="button" className="btn btn-primary" onClick={submitMove} disabled={saving || !d.date}>{saving ? 'Переносим…' : 'Перенести'}</button>
                <button type="button" className="btn btn-secondary" onClick={() => setMoveDialog(null)}>Отмена</button>
              </div>
            </div>
          </div>
        )
      })()}

      {/* Вернуть в график: в очередь (FIFO) или с даты */}
      {returnDialog && (() => {
        const d = returnDialog
        const teamOptions = returnTeams.length > 0
          ? returnTeams.map(t => ({ id: t.teamId, label: `${t.teamName} — ${t.perDay} шт/день` }))
          : teams.map(t => ({ id: t.id, label: t.name }))
        return (
          <div className="modal-backdrop" onClick={e => { if (e.target === e.currentTarget) setReturnDialog(null) }}>
            <div className="modal-card" role="dialog" aria-modal="true" aria-labelledby="return-title">
              <h3 id="return-title" className="form-panel-title">Вернуть в график</h3>
              <div className="move-summary">
                <strong>{d.item.orderNumber}</strong> · {d.item.productName || d.item.productCode}
                <div>Не в графике {d.item.gap} из {d.item.quantity} шт{d.item.transferDate ? ` · дата передачи ${d.item.transferDate.split('-').reverse().join('.')}` : ''}</div>
              </div>
              <fieldset className="choice-group">
                <legend>Куда поставить</legend>
                <label className={d.mode === 'fifo' ? 'choice active' : 'choice'}>
                  <input type="radio" name="return-mode" checked={d.mode === 'fifo'} onChange={() => setReturnDialog({ ...d, mode: 'fifo' })} />
                  <span>
                    <strong>В очередь (FIFO)</strong>
                    <small>Встанет на своё место по дате передачи; задачи позже по очереди сдвинутся вправо</small>
                  </span>
                </label>
                <label className={d.mode === 'date' ? 'choice active' : 'choice'}>
                  <input type="radio" name="return-mode" checked={d.mode === 'date'} onChange={() => setReturnDialog({ ...d, mode: 'date' })} />
                  <span>
                    <strong>На дату</strong>
                    <small>Встанет с выбранного дня и закрепится; остальные задачи бригады сдвинутся вправо</small>
                  </span>
                </label>
              </fieldset>
              <div className="form-panel" style={{ maxWidth: 'none', margin: 0, padding: 0, border: 'none', background: 'none' }}>
                {d.mode === 'date' && (
                  <>
                    <label>Дата</label>
                    <input type="date" value={d.date} min={todayISO()} onChange={e => e.target.value && setReturnDialog({ ...d, date: e.target.value })} />
                  </>
                )}
                <label>Бригада</label>
                <select value={d.teamId} onChange={e => setReturnDialog({ ...d, teamId: e.target.value })}>
                  {!d.teamId && <option value="">— выберите —</option>}
                  {teamOptions.map(t => <option key={t.id} value={t.id}>{t.label}</option>)}
                </select>
              </div>
              {d.mode === 'date' && isOffDay(d.date) && <div className="move-note move-note-warn">Это нерабочий день — позиция встанет с ближайшего рабочего.</div>}
              <div className="form-actions">
                <button type="button" className="btn btn-primary" onClick={submitReturn} disabled={saving || !d.teamId || (d.mode === 'date' && !d.date)}>
                  {saving ? 'Ставим…' : 'Вернуть в график'}
                </button>
                <button type="button" className="btn btn-secondary" onClick={() => setReturnDialog(null)}>Отмена</button>
              </div>
            </div>
          </div>
        )
      })()}

      {/* Итог переноса */}
      {moveResult && (
        <div className="modal-backdrop" onClick={e => { if (e.target === e.currentTarget) setMoveResult(null) }}>
          <div className="modal-card" role="dialog" aria-modal="true" aria-labelledby="move-result-title">
            <h3 id="move-result-title" className="form-panel-title">{moveResult.heading ?? 'Задача перенесена'}</h3>
            <p style={{ margin: '0 0 12px' }}>{moveResult.title}.</p>
            {moveResult.pulled.length > 0 && (
              <div className="move-block">
                <div className="move-block-title">На освободившееся место {formatDateShort(moveResult.freedDate)} встали</div>
                <ul>{moveResult.pulled.map((p, i) => <li key={i}><strong>{p.orderNumber}</strong> · {p.product} — {p.qty} шт</li>)}</ul>
              </div>
            )}
            {moveResult.shifted.length > 0 && (
              <div className="move-block">
                <div className="move-block-title">Сдвинулось окончание</div>
                <ul>{moveResult.shifted.slice(0, 8).map((p, i) => <li key={i}><strong>{p.orderNumber}</strong> · {p.product} — до {formatDateShort(p.date)} вместо {formatDateShort(p.prevDate)}</li>)}</ul>
                {moveResult.shifted.length > 8 && <div style={{ fontSize: '0.8rem', color: 'var(--text-muted)' }}>и ещё {moveResult.shifted.length - 8}</div>}
              </div>
            )}
            {moveResult.overload && (
              <div className="move-note move-note-warn" style={{ marginBottom: 12 }}>
                {formatDateShort(moveResult.targetDate)} бригада всё ещё загружена на {moveResult.overload.load}% из {moveResult.overload.capacity}%:
                в этот день стоят ручные задачи, их автоматика не сдвигает. Перенесите лишнее вручную.
              </div>
            )}
            {moveResult.mergedIntoOwn && (
              <div className="move-note" style={{ marginBottom: 12 }}>
                {formatDateShort(moveResult.targetDate)} эта позиция и так в работе: перенесённое количество добавилось к ней, и план позиции пересчитан по очереди бригады.
              </div>
            )}
            {!moveResult.filled && (
              <div className="move-note" style={{ marginBottom: 12 }}>
                Освободившееся место {formatDateShort(moveResult.freedDate)} оставлено пустым — остальные задачи бригады не подтягивались.
              </div>
            )}
            {moveResult.filled && moveResult.shifted.length === 0 && moveResult.pulled.length === 0 && !moveResult.overload && !moveResult.mergedIntoOwn && (
              <p style={{ margin: '0 0 12px', color: 'var(--text-secondary)' }}>Места хватило — другие задачи не сдвигались.</p>
            )}
            <div className="form-actions">
              <button type="button" className="btn btn-primary" onClick={() => setMoveResult(null)} autoFocus>Понятно</button>
            </div>
          </div>
        </div>
      )}

      {tip && (
        <div className="grid-tip" style={{
          left: Math.min(tip.x + 14, window.innerWidth - 380),
          top: tip.y + 16 > window.innerHeight - 90 ? tip.y - 70 : tip.y + 16,
        }}>{tip.text}</div>
      )}

      {headerTooltip && (dateTeamLoads[headerTooltip.date] ?? []).length > 0 && (
        <div style={{
          position: 'fixed',
          left: headerTooltip.x + 12,
          top: headerTooltip.y + 12,
          zIndex: 1000,
          background: 'var(--surface)',
          color: 'var(--text)',
          border: '1px solid var(--border)',
          borderRadius: 8,
          padding: '0.5rem 0.75rem',
          fontSize: '0.78rem',
          pointerEvents: 'none',
          boxShadow: '0 6px 24px rgba(25,40,32,0.12)',
          minWidth: 180,
        }}>
          {(dateTeamLoads[headerTooltip.date] ?? []).map(t => {
            const over = t.loadPct >= 100
            const warn = t.loadPct >= 75
            return (
              <div key={t.teamName} style={{ display: 'flex', justifyContent: 'space-between', gap: 16, padding: '2px 0' }}>
                <span style={{ opacity: 0.8 }}>{t.teamName}</span>
                <span style={{ fontWeight: 600, color: over ? 'var(--danger)' : warn ? 'var(--warning)' : 'var(--success)' }}>
                  {t.loadPct}%
                </span>
              </div>
            )
          })}
        </div>
      )}

      {/* Cell popup (на телефоне — шторка снизу) */}
      {popup && isMobile && <div className="sheet-backdrop" />}
      {popup && (
        <div
          ref={popupRef}
          className="cell-popup schedule-cell-popup"
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
              <div style={{ fontWeight: 600 }}>
                {rows.find(r => r.orderItemId === popup.rowId)?.productCode ?? ''}
              </div>
              <div style={{ color: 'var(--text-muted)', fontSize: '0.75rem' }}>
                {rows.find(r => r.orderItemId === popup.rowId)?.orderNumber ?? ''} · {popup.date.split('-').reverse().join('.')}
              </div>
            </div>
            <button type="button" className="icon-btn" aria-label="Закрыть" onClick={closePopup}><X size={14} weight="bold" aria-hidden="true" /></button>
          </div>
          {isMobile && error && (
            <div className="error error-dismiss" onClick={() => setError(null)} title="Скрыть">{error} <X size={12} weight="bold" aria-hidden="true" /></div>
          )}

          {popup.cell ? (
            <>
              {/* Existing task */}
              <div style={{ display: 'flex', gap: '0.5rem', marginBottom: '0.5rem', alignItems: 'center' }}>
                <label style={{ fontSize: '0.78rem', color: 'var(--text-muted)', whiteSpace: 'nowrap' }}>Кол-во</label>
                <input
                  type="number" inputMode="numeric" min={0} value={editQty}
                  onChange={e => setEditQty(Number(e.target.value))}
                  style={{ width: 70 }}
                  autoFocus={!isMobile}
                />
                {popup.cell.actualQuantity !== null && (
                  <span style={{ fontSize: '0.75rem', color: 'var(--success)' }}>✓{popup.cell.actualQuantity}</span>
                )}
              </div>
              {/* Бригада меняется через «Перенести…» — там же видно её загрузку и что сдвинется */}
              <div style={{ marginBottom: '0.75rem', fontSize: '0.8rem', color: 'var(--text-secondary)' }}>
                Бригада: <strong style={{ color: 'var(--text)' }}>{popup.cell.teamName ?? 'не назначена'}</strong>
              </div>
              {!showSplitForm ? (
                <div style={{ display: 'flex', flexDirection: 'column', gap: '0.35rem' }}>
                  <button className="btn btn-primary" style={{ width: '100%' }} onClick={handleCreateOrUpdate} disabled={saving}>
                    Сохранить
                  </button>
                  <div style={{ display: 'flex', gap: '0.35rem' }}>
                    <button className="btn btn-secondary" style={{ flex: 1 }} onClick={startMove}>
                      Перенести…
                    </button>
                    <button className="btn btn-secondary" style={{ flex: 1 }} onClick={() => setShowSplitForm(true)}>
                      Разбить
                    </button>
                  </div>
                  {popup.cell.manual && (
                    <div className="pin-note">
                      <span className="pin-note-title"><PushPin size={14} weight="fill" aria-hidden="true" /> Ручная правка — перепланирование её не трогает</span>
                      <span style={{ fontSize: '0.75rem' }}>{manualInfo(popup.cell)}</span>
                      <button type="button" className="btn btn-secondary" onClick={handleUnpin} disabled={saving}>Снять закрепление</button>
                    </div>
                  )}
                  {(planSummary?.days ?? 0) > 1 && (
                    <label className="check-line">
                      <input type="checkbox" checked={deleteWhole} onChange={e => setDeleteWhole(e.target.checked)} />
                      <span>Удалить позицию целиком — все дни ({planSummary!.days} дн., {planSummary!.qty} шт)</span>
                    </label>
                  )}
                  <button className="btn btn-danger" style={{ width: '100%' }} onClick={handleDelete} disabled={saving}>
                    {deleteWhole && (planSummary?.days ?? 0) > 1 ? 'Снять позицию с графика' : 'Удалить'}
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
                      type="number" inputMode="numeric" min={1} max={popup.cell.plannedQuantity - 1}
                      value={splitQty2}
                      onChange={e => {
                        const v = Math.min(popup.cell!.plannedQuantity - 1, Math.max(1, Number(e.target.value)))
                        setSplitQty2(v)
                        setSplitLoad(null)
                      }}
                      style={{ width: '100%' }}
                      autoFocus={!isMobile}
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
                        background: fits ? 'var(--success-light)' : 'var(--danger-light)',
                        border: `1px solid ${fits ? 'var(--plan-success-border)' : 'var(--plan-danger-border)'}`,
                        color: fits ? 'var(--success)' : 'var(--danger)',
                      }}>
                        {fits ? (
                          <>Бригада может выполнить. Свободно: <strong>{availableQty}</strong> шт</>
                        ) : (
                          <>Бригада перегружена. Свободно: <strong>{availableQty ?? '?'}</strong> шт, нужно: <strong>{splitQty2}</strong></>
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
                  type="number" inputMode="numeric" min={0} value={editQty}
                  onChange={e => setEditQty(Number(e.target.value))}
                  style={{ width: 70 }}
                  autoFocus={!isMobile}
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
    </div>
  )
}
