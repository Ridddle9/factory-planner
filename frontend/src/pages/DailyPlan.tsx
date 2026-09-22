import { useEffect, useState, useMemo } from 'react'
import { api } from '../api'
import type { DailyTask, OrderItem, Team, TeamDayCapacity, Workshop } from '../types'

function todayISO() {
  return new Date().toISOString().slice(0, 10)
}

type MoveSuggestion = OrderItem & {
  remainingQuantity: number
  order?: { orderNumber: string }
  product?: { code: string; name: string }
}

export default function DailyPlan() {
  const [date, setDate] = useState(todayISO())
  const [tasks, setTasks] = useState<DailyTask[]>([])
  const [orderItems, setOrderItems] = useState<OrderItem[]>([])
  const [teams, setTeams] = useState<Team[]>([])
  const [workshops, setWorkshops] = useState<Workshop[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [filterWorkshopId, setFilterWorkshopId] = useState('')
  const [filterTeamId, setFilterTeamId] = useState('')
  const [selectedTaskIds, setSelectedTaskIds] = useState<Set<string>>(new Set())
  const [assignTeamId, setAssignTeamId] = useState('')
  const [saving, setSaving] = useState(false)
  const [showAdd, setShowAdd] = useState(false)
  const [addForm, setAddForm] = useState({ orderItemId: '', plannedQuantity: 0, teamId: '' })

  // Inline plan editing
  const [editingPlan, setEditingPlan] = useState<string | null>(null)
  const [editPlanVal, setEditPlanVal] = useState(0)
  const [editPlanTeam, setEditPlanTeam] = useState('')

  // Inline fact editing
  const [editingFact, setEditingFact] = useState<string | null>(null)
  const [editFactVal, setEditFactVal] = useState<number | ''>('')
  const [editFactComment, setEditFactComment] = useState('')

  // --- Move task ---
  const [movingTask, setMovingTask] = useState<DailyTask | null>(null)
  const [moveTargetDate, setMoveTargetDate] = useState('')
  const [moveSuggestions, setMoveSuggestions] = useState<MoveSuggestion[]>([])
  const [moveFreedDate, setMoveFreedDate] = useState('')
  const [showSuggestions, setShowSuggestions] = useState(false)

  // --- Split task ---
  const [splittingTask, setSplittingTask] = useState<DailyTask | null>(null)
  const [splitQty1, setSplitQty1] = useState(0)
  const [splitDate2, setSplitDate2] = useState('')
  const [splitQty2, setSplitQty2] = useState(0)

  // --- Team capacity ---
  const [capacities, setCapacities] = useState<TeamDayCapacity[]>([])
  const [showCapacity, setShowCapacity] = useState(false)
  const [editingCapacity, setEditingCapacity] = useState<string | null>(null) // teamId
  const [capFactor, setCapFactor] = useState(100)
  const [capNote, setCapNote] = useState('')

  const loadPlan = async () => {
    setLoading(true)
    const params = new URLSearchParams({ date })
    if (filterWorkshopId) params.set('workshopId', filterWorkshopId)
    if (filterTeamId) params.set('teamId', filterTeamId)
    const { data, error: e } = await api.get<DailyTask[]>(`/daily-tasks/plan?${params}`)
    setLoading(false)
    if (e) { setError(e); return }
    setTasks(data ?? [])
    setError(null)
  }

  const loadOptions = async () => {
    const [itemsRes, teamsRes, workshopsRes] = await Promise.all([
      api.get<OrderItem[]>('/order-items'),
      api.get<Team[]>('/teams'),
      api.get<Workshop[]>('/workshops'),
    ])
    if (itemsRes.data) setOrderItems(itemsRes.data)
    if (teamsRes.data) setTeams(teamsRes.data)
    if (workshopsRes.data) setWorkshops(workshopsRes.data)
  }

  const loadCapacities = async () => {
    const { data } = await api.get<TeamDayCapacity[]>(`/team-day-capacity?date=${date}`)
    setCapacities(data ?? [])
  }

  useEffect(() => { loadPlan(); loadCapacities() }, [date, filterWorkshopId, filterTeamId])
  useEffect(() => { loadOptions() }, [])

  const grouped = useMemo(() => {
    const map = new Map<string, Map<string, DailyTask[]>>()
    for (const t of tasks) {
      const ws = t.orderItem?.product?.category?.workshop?.name ?? '—'
      const team = t.team?.name ?? '(бригада не назначена)'
      if (!map.has(ws)) map.set(ws, new Map())
      const wsMap = map.get(ws)!
      if (!wsMap.has(team)) wsMap.set(team, [])
      wsMap.get(team)!.push(t)
    }
    return map
  }, [tasks])

  const totalPlan = tasks.reduce((s, t) => s + t.plannedQuantity, 0)
  const totalFact = tasks.reduce((s, t) => s + (t.actualQuantity ?? 0), 0)

  const toggleTask = (id: string) => {
    setSelectedTaskIds(prev => {
      const next = new Set(prev)
      next.has(id) ? next.delete(id) : next.add(id)
      return next
    })
  }

  const assignTeam = async () => {
    if (selectedTaskIds.size === 0) return
    setSaving(true)
    const { error: e } = await api.post('/daily-tasks/assign-team', {
      taskIds: Array.from(selectedTaskIds),
      teamId: assignTeamId || null,
    })
    setSaving(false)
    if (e) setError(e)
    else { setSelectedTaskIds(new Set()); loadPlan() }
  }

  const createTask = async () => {
    if (!addForm.orderItemId) return
    setSaving(true)
    const { error: e } = await api.post('/daily-tasks', {
      orderItemId: addForm.orderItemId,
      date: new Date(date).toISOString(),
      plannedQuantity: Math.max(0, Math.floor(Number(addForm.plannedQuantity))) || 0,
      teamId: addForm.teamId || undefined,
    })
    setSaving(false)
    if (e) setError(e)
    else { setShowAdd(false); loadPlan() }
  }

  const openEditPlan = (t: DailyTask) => {
    setEditingFact(null); setMovingTask(null); setSplittingTask(null)
    setEditingPlan(t.id); setEditPlanVal(t.plannedQuantity); setEditPlanTeam(t.teamId ?? '')
  }

  const savePlan = async (taskId: string) => {
    setSaving(true)
    const { error: e } = await api.put(`/daily-tasks/${taskId}`, {
      plannedQuantity: Math.max(0, Math.floor(Number(editPlanVal))) || 0,
      teamId: editPlanTeam || null,
    })
    setSaving(false)
    if (e) setError(e)
    else { setEditingPlan(null); loadPlan() }
  }

  const openEditFact = (t: DailyTask) => {
    setEditingPlan(null); setMovingTask(null); setSplittingTask(null)
    setEditingFact(t.id); setEditFactVal(t.actualQuantity ?? ''); setEditFactComment(t.comment ?? '')
  }

  const saveFact = async (taskId: string) => {
    setSaving(true)
    const payload: { actualQuantity?: number | null; comment?: string | null } = {
      actualQuantity: editFactVal === '' ? null : Math.max(0, Math.floor(Number(editFactVal))),
      comment: editFactComment.trim() || null,
    }
    const { error: e } = await api.put(`/daily-tasks/${taskId}/actual`, payload)
    setSaving(false)
    if (e) setError(e)
    else { setEditingFact(null); loadPlan() }
  }

  const removeTask = async (id: string) => {
    if (!confirm('Удалить задачу?')) return
    const { error: e } = await api.delete(`/daily-tasks/${id}`)
    if (e) setError(e)
    else loadPlan()
  }

  // --- Move ---
  const openMove = (t: DailyTask) => {
    setEditingPlan(null); setEditingFact(null); setSplittingTask(null)
    setShowSuggestions(false); setMoveSuggestions([])
    setMovingTask(t)
    setMoveTargetDate(todayISO())
  }

  const confirmMove = async () => {
    if (!movingTask || !moveTargetDate) return
    const fromDate = movingTask.date.slice(0, 10)
    setSaving(true)
    const { error: e } = await api.put(`/daily-tasks/${movingTask.id}`, {
      date: new Date(moveTargetDate).toISOString(),
    })
    setSaving(false)
    if (e) { setError(e); return }

    // Загружаем предложения для освободившегося места
    const { data: suggData } = await api.get<{ suggestions: MoveSuggestion[] }>(
      `/daily-tasks/${movingTask.id}/move-suggestions?freedDate=${fromDate}`
    )
    setMoveFreedDate(fromDate)
    setMoveSuggestions(suggData?.suggestions ?? [])
    setShowSuggestions(true)
    setMovingTask(null)
    loadPlan()
  }

  const createFromSuggestion = async (s: MoveSuggestion) => {
    if (!moveFreedDate) return
    setSaving(true)
    const qty = Math.min(s.remainingQuantity, s.product?.name ? 999 : 999)
    await api.post('/daily-tasks', {
      orderItemId: s.id,
      date: new Date(moveFreedDate).toISOString(),
      plannedQuantity: qty,
    })
    setSaving(false)
    setMoveSuggestions(prev => prev.filter(x => x.id !== s.id))
    loadPlan()
  }

  // --- Split ---
  const openSplit = (t: DailyTask) => {
    setEditingPlan(null); setEditingFact(null); setMovingTask(null)
    const half = Math.floor(t.plannedQuantity / 2)
    setSplittingTask(t)
    setSplitQty1(half)
    setSplitDate2(todayISO())
    setSplitQty2(t.plannedQuantity - half)
  }

  const confirmSplit = async () => {
    if (!splittingTask) return
    if (splitQty1 + splitQty2 !== splittingTask.plannedQuantity) {
      setError(`Сумма ${splitQty1} + ${splitQty2} должна равняться ${splittingTask.plannedQuantity}`)
      return
    }
    setSaving(true)
    const { error: e } = await api.post(`/daily-tasks/${splittingTask.id}/split`, {
      qty1: splitQty1, date2: new Date(splitDate2).toISOString(), qty2: splitQty2,
    })
    setSaving(false)
    if (e) { setError(e); return }
    setSplittingTask(null)
    loadPlan()
  }

  // --- Capacity ---
  const getCapacity = (teamId: string) => capacities.find(c => c.teamId === teamId)

  const openCapacityEdit = (teamId: string) => {
    const existing = getCapacity(teamId)
    setEditingCapacity(teamId)
    setCapFactor(existing ? Math.round(existing.factor * 100) : 100)
    setCapNote(existing?.note ?? '')
  }

  const saveCapacity = async (teamId: string) => {
    const factor = capFactor / 100
    if (factor === 1 && !capNote) {
      // Удаляем override если он был
      const existing = getCapacity(teamId)
      if (existing) {
        await api.delete(`/team-day-capacity/${existing.id}`)
      }
    } else {
      await api.post('/team-day-capacity', { teamId, date: new Date(date).toISOString(), factor, note: capNote || null })
    }
    setEditingCapacity(null)
    loadCapacities()
  }

  const rowBg = (t: DailyTask) => {
    if (t.actualQuantity !== null && t.actualQuantity >= t.plannedQuantity) return '#f0fdf4'
    if (t.actualQuantity !== null && t.actualQuantity > 0) return '#fefce8'
    return ''
  }

  // Уникальные команды в текущем плане (для панели мощностей)
  const planTeamIds = useMemo(() => {
    const ids = new Set<string>()
    for (const t of tasks) { if (t.teamId) ids.add(t.teamId) }
    return ids
  }, [tasks])

  return (
    <>
      <div className="page-header">
        <h1 className="page-title">План на день</h1>
        {!loading && tasks.length > 0 && (
          <span style={{ fontSize: '0.85rem', color: 'var(--text-muted)' }}>
            Итого план: <strong>{totalPlan}</strong> / факт: <strong>{totalFact}</strong>
          </span>
        )}
      </div>
      {error && <div className="error" onClick={() => setError(null)} style={{ cursor: 'pointer' }}>{error} ✕</div>}

      {/* Suggestions panel after move */}
      {showSuggestions && moveSuggestions.length > 0 && (
        <div style={{ background: '#eff6ff', border: '1px solid #93c5fd', borderRadius: 8, padding: '0.75rem 1rem', marginBottom: '0.75rem' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '0.5rem' }}>
            <strong style={{ fontSize: '0.85rem' }}>
              Освободилось место {moveFreedDate} — что поставить вместо?
            </strong>
            <button className="btn btn-secondary btn-sm" onClick={() => setShowSuggestions(false)}>✕</button>
          </div>
          <div style={{ display: 'flex', gap: '0.5rem', flexWrap: 'wrap' }}>
            {moveSuggestions.map(s => (
              <div key={s.id} style={{ background: '#fff', border: '1px solid #bfdbfe', borderRadius: 6, padding: '0.4rem 0.75rem', fontSize: '0.8rem', display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                <span>
                  <strong>{s.product?.code}</strong> · {s.order?.orderNumber} · осталось: <strong>{s.remainingQuantity}</strong>
                </span>
                <button className="btn btn-primary btn-sm" onClick={() => createFromSuggestion(s)} disabled={saving}>
                  Поставить
                </button>
              </div>
            ))}
          </div>
        </div>
      )}

      <div className="card">
        <div className="toolbar">
          <label style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
            Дата:
            <input type="date" value={date} onChange={e => setDate(e.target.value)} />
          </label>
          <label style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
            Участок:
            <select value={filterWorkshopId} onChange={e => setFilterWorkshopId(e.target.value)}>
              <option value="">— все —</option>
              {workshops.map(w => <option key={w.id} value={w.id}>{w.name}</option>)}
            </select>
          </label>
          <label style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
            Бригада:
            <select value={filterTeamId} onChange={e => setFilterTeamId(e.target.value)}>
              <option value="">— все —</option>
              {teams.map(t => <option key={t.id} value={t.id}>{t.name}</option>)}
            </select>
          </label>
          <button type="button" className="btn btn-secondary" onClick={() => setShowCapacity(p => !p)}>
            {showCapacity ? 'Скрыть мощности' : 'Мощности бригад'}
          </button>
          <button type="button" className="btn btn-primary" onClick={() => { setShowAdd(true); setAddForm({ orderItemId: orderItems[0]?.id ?? '', plannedQuantity: 0, teamId: '' }) }} disabled={orderItems.length === 0}>
            + Добавить задачу
          </button>
        </div>

        {/* Capacity panel */}
        {showCapacity && planTeamIds.size > 0 && (
          <div style={{ background: '#f8fafc', border: '1px solid var(--border)', borderRadius: 6, padding: '0.75rem 1rem', marginBottom: '0.75rem' }}>
            <div style={{ fontSize: '0.8rem', fontWeight: 700, marginBottom: '0.5rem', color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.04em' }}>
              Мощности бригад на {date}
            </div>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0.5rem' }}>
              {teams.filter(t => planTeamIds.has(t.id)).map(t => {
                const cap = getCapacity(t.id)
                const pct = cap ? Math.round(cap.factor * 100) : 100
                const isEditing = editingCapacity === t.id
                return (
                  <div key={t.id} style={{ background: '#fff', border: `1px solid ${pct < 100 ? '#fbbf24' : 'var(--border)'}`, borderRadius: 6, padding: '0.4rem 0.75rem', fontSize: '0.82rem', minWidth: 220 }}>
                    {isEditing ? (
                      <div style={{ display: 'flex', flexDirection: 'column', gap: '0.4rem' }}>
                        <strong style={{ fontSize: '0.78rem' }}>{t.name}</strong>
                        <div style={{ display: 'flex', alignItems: 'center', gap: '0.4rem' }}>
                          <input type="number" min={0} max={100} value={capFactor} onChange={e => setCapFactor(Number(e.target.value))} style={{ width: 60 }} />
                          <span>%</span>
                        </div>
                        <input type="text" placeholder="Причина (необязательно)" value={capNote} onChange={e => setCapNote(e.target.value)} style={{ fontSize: '0.78rem' }} />
                        <div style={{ display: 'flex', gap: '0.3rem' }}>
                          <button className="btn btn-primary btn-sm" onClick={() => saveCapacity(t.id)}>OK</button>
                          <button className="btn btn-secondary btn-sm" onClick={() => setEditingCapacity(null)}>Отмена</button>
                        </div>
                      </div>
                    ) : (
                      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: '1rem' }}>
                        <div>
                          <div style={{ fontWeight: 600 }}>{t.name}</div>
                          <div style={{ color: pct < 100 ? '#d97706' : 'var(--text-muted)', fontWeight: pct < 100 ? 700 : 400 }}>
                            {pct}% мощности
                            {cap?.note && <span style={{ fontWeight: 400, marginLeft: 4 }}>— {cap.note}</span>}
                          </div>
                        </div>
                        <button className="btn btn-secondary btn-sm" onClick={() => openCapacityEdit(t.id)}>Изменить</button>
                      </div>
                    )}
                  </div>
                )
              })}
            </div>
          </div>
        )}

        {selectedTaskIds.size > 0 && (
          <div className="toolbar" style={{ background: '#eff6ff', padding: '0.5rem 0.75rem', borderRadius: 6, marginBottom: '0.5rem' }}>
            <span style={{ fontSize: '0.85rem' }}>Выбрано: <strong>{selectedTaskIds.size}</strong></span>
            <select value={assignTeamId} onChange={e => setAssignTeamId(e.target.value)} style={{ width: 200 }}>
              <option value="">— снять назначение —</option>
              {teams.map(t => <option key={t.id} value={t.id}>{t.name}</option>)}
            </select>
            <button type="button" className="btn btn-secondary" onClick={assignTeam} disabled={saving}>
              Назначить бригаду
            </button>
            <button type="button" className="btn btn-secondary" onClick={() => setSelectedTaskIds(new Set())}>
              Снять выделение
            </button>
          </div>
        )}

        {showAdd && (
          <div style={{ padding: '0.75rem', background: '#f8fafc', borderRadius: 6, marginBottom: '0.75rem', border: '1px solid var(--border)' }}>
            <div style={{ display: 'flex', gap: '0.75rem', flexWrap: 'wrap', alignItems: 'flex-end' }}>
              <label style={{ flex: '1 1 260px' }}>
                <span style={{ display: 'block', fontSize: '0.78rem', fontWeight: 600, marginBottom: 3 }}>Позиция заказа</span>
                <select value={addForm.orderItemId} onChange={e => setAddForm(f => ({ ...f, orderItemId: e.target.value }))} style={{ width: '100%' }}>
                  <option value="">— выберите —</option>
                  {orderItems.map(oi => (
                    <option key={oi.id} value={oi.id}>
                      {oi.order?.orderNumber ?? oi.orderId} — {oi.product?.code ?? oi.productId} × {oi.quantity}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                <span style={{ display: 'block', fontSize: '0.78rem', fontWeight: 600, marginBottom: 3 }}>План (шт)</span>
                <input type="number" min={0} value={addForm.plannedQuantity} onChange={e => setAddForm(f => ({ ...f, plannedQuantity: Number(e.target.value) || 0 }))} style={{ width: 90 }} />
              </label>
              <label>
                <span style={{ display: 'block', fontSize: '0.78rem', fontWeight: 600, marginBottom: 3 }}>Бригада</span>
                <select value={addForm.teamId} onChange={e => setAddForm(f => ({ ...f, teamId: e.target.value }))}>
                  <option value="">— не назначена —</option>
                  {teams.map(t => <option key={t.id} value={t.id}>{t.name}</option>)}
                </select>
              </label>
              <div style={{ display: 'flex', gap: '0.5rem' }}>
                <button type="button" className="btn btn-primary" onClick={createTask} disabled={saving}>Создать</button>
                <button type="button" className="btn btn-secondary" onClick={() => setShowAdd(false)}>Отмена</button>
              </div>
            </div>
          </div>
        )}

        {loading ? (
          <div className="empty">Загрузка...</div>
        ) : tasks.length === 0 ? (
          <div className="empty">На эту дату задач нет.</div>
        ) : (
          <>
            {Array.from(grouped.entries()).map(([wsName, teamMap]) => {
              const wsTasks = Array.from(teamMap.values()).flat()
              const wsPlan = wsTasks.reduce((s, t) => s + t.plannedQuantity, 0)
              const wsFact = wsTasks.reduce((s, t) => s + (t.actualQuantity ?? 0), 0)
              return (
                <div key={wsName} style={{ marginBottom: '1.5rem' }}>
                  <div style={{
                    display: 'flex', justifyContent: 'space-between', alignItems: 'center',
                    background: 'var(--sidebar-bg)', color: '#e2e8f0',
                    padding: '6px 12px', borderRadius: '6px 6px 0 0', fontWeight: 700, fontSize: '0.85rem',
                  }}>
                    <span>{wsName}</span>
                    <span style={{ fontSize: '0.78rem', fontWeight: 400, opacity: 0.8 }}>
                      план: {wsPlan} / факт: {wsFact}
                    </span>
                  </div>

                  {Array.from(teamMap.entries()).map(([teamName, teamTasks]) => {
                    const tPlan = teamTasks.reduce((s, t) => s + t.plannedQuantity, 0)
                    const tFact = teamTasks.reduce((s, t) => s + (t.actualQuantity ?? 0), 0)
                    const teamId = teamTasks[0]?.teamId
                    const cap = teamId ? getCapacity(teamId) : undefined
                    const capPct = cap ? Math.round(cap.factor * 100) : 100

                    return (
                      <div key={teamName} style={{ marginBottom: '0.25rem' }}>
                        <div style={{
                          display: 'flex', justifyContent: 'space-between', alignItems: 'center',
                          background: '#e2e8f0', padding: '4px 12px', fontSize: '0.8rem', fontWeight: 600,
                        }}>
                          <span>
                            {teamName}
                            {capPct < 100 && (
                              <span style={{ marginLeft: 8, color: '#d97706', fontWeight: 700, fontSize: '0.75rem' }}>
                                ⚠ {capPct}% мощности{cap?.note ? ` — ${cap.note}` : ''}
                              </span>
                            )}
                          </span>
                          <span style={{ color: 'var(--text-muted)' }}>план: {tPlan} / факт: {tFact}</span>
                        </div>
                        <table style={{ width: '100%', borderCollapse: 'collapse' }}>
                          <thead>
                            <tr style={{ background: '#f8fafc', fontSize: '0.75rem', textTransform: 'uppercase', letterSpacing: '0.04em', color: 'var(--text-muted)' }}>
                              <th style={{ width: 36, padding: '4px 8px' }}>
                                <input type="checkbox"
                                  checked={teamTasks.every(t => selectedTaskIds.has(t.id))}
                                  onChange={() => {
                                    const allSelected = teamTasks.every(t => selectedTaskIds.has(t.id))
                                    setSelectedTaskIds(prev => {
                                      const next = new Set(prev)
                                      teamTasks.forEach(t => allSelected ? next.delete(t.id) : next.add(t.id))
                                      return next
                                    })
                                  }}
                                />
                              </th>
                              <th style={{ textAlign: 'left', padding: '4px 8px' }}>Товар</th>
                              <th style={{ textAlign: 'left', padding: '4px 8px' }}>Заказ</th>
                              <th style={{ textAlign: 'right', padding: '4px 8px', width: 70 }}>План</th>
                              <th style={{ textAlign: 'right', padding: '4px 8px', width: 70 }}>Факт</th>
                              <th style={{ padding: '4px 8px', width: 220 }}>Комментарий</th>
                              <th style={{ width: 260 }}></th>
                            </tr>
                          </thead>
                          <tbody>
                            {teamTasks.map(t => (
                              <>
                                <tr key={t.id} style={{ borderBottom: splittingTask?.id === t.id || movingTask?.id === t.id ? 'none' : '1px solid var(--border)', background: rowBg(t) }}>
                                  <td style={{ padding: '6px 8px', textAlign: 'center' }}>
                                    <input type="checkbox" checked={selectedTaskIds.has(t.id)} onChange={() => toggleTask(t.id)} />
                                  </td>
                                  <td style={{ padding: '6px 8px', fontSize: '0.85rem' }}>
                                    <span style={{ fontWeight: 600 }}>{t.orderItem?.product?.code ?? '—'}</span>
                                    <span style={{ color: 'var(--text-muted)', marginLeft: 6, fontSize: '0.78rem' }}>{t.orderItem?.product?.name ?? ''}</span>
                                  </td>
                                  <td style={{ padding: '6px 8px', fontSize: '0.82rem', color: 'var(--text-muted)' }}>
                                    {t.orderItem?.order?.orderNumber ?? '—'}
                                  </td>
                                  <td style={{ padding: '6px 8px', textAlign: 'right', fontWeight: 600 }}>
                                    {editingPlan === t.id ? (
                                      <input type="number" min={0} value={editPlanVal} onChange={e => setEditPlanVal(Number(e.target.value))} style={{ width: 60, textAlign: 'right' }} autoFocus />
                                    ) : t.plannedQuantity}
                                  </td>
                                  <td style={{ padding: '6px 8px', textAlign: 'right', color: t.actualQuantity !== null ? (t.actualQuantity >= t.plannedQuantity ? '#16a34a' : '#d97706') : 'var(--text-muted)' }}>
                                    {editingFact === t.id ? (
                                      <input type="number" min={0} value={editFactVal} onChange={e => setEditFactVal(e.target.value === '' ? '' : Number(e.target.value))} style={{ width: 60, textAlign: 'right' }} autoFocus />
                                    ) : (t.actualQuantity ?? '—')}
                                  </td>
                                  <td style={{ padding: '6px 8px', fontSize: '0.8rem', color: 'var(--text-muted)' }}>
                                    {editingFact === t.id ? (
                                      <input type="text" placeholder="Комментарий" value={editFactComment} onChange={e => setEditFactComment(e.target.value)} style={{ width: '100%' }} />
                                    ) : (
                                      <span title={t.comment ?? ''}>{t.comment ? (t.comment.length > 40 ? t.comment.slice(0, 40) + '…' : t.comment) : '—'}</span>
                                    )}
                                  </td>
                                  <td style={{ padding: '6px 8px', textAlign: 'right', whiteSpace: 'nowrap' }}>
                                    {editingPlan === t.id ? (
                                      <>
                                        <select value={editPlanTeam} onChange={e => setEditPlanTeam(e.target.value)} style={{ width: 110, marginRight: 4 }}>
                                          <option value="">— бригада —</option>
                                          {teams.map(team => <option key={team.id} value={team.id}>{team.name}</option>)}
                                        </select>
                                        <button className="btn btn-primary btn-sm" onClick={() => savePlan(t.id)} disabled={saving}>OK</button>
                                        {' '}
                                        <button className="btn btn-secondary btn-sm" onClick={() => setEditingPlan(null)}>✕</button>
                                      </>
                                    ) : editingFact === t.id ? (
                                      <>
                                        <button className="btn btn-primary btn-sm" onClick={() => saveFact(t.id)} disabled={saving}>OK</button>
                                        {' '}
                                        <button className="btn btn-secondary btn-sm" onClick={() => setEditingFact(null)}>✕</button>
                                      </>
                                    ) : movingTask?.id === t.id ? (
                                      <>
                                        <input type="date" value={moveTargetDate} onChange={e => setMoveTargetDate(e.target.value)} style={{ width: 130, marginRight: 4 }} autoFocus />
                                        <button className="btn btn-primary btn-sm" onClick={confirmMove} disabled={saving}>Перенести</button>
                                        {' '}
                                        <button className="btn btn-secondary btn-sm" onClick={() => setMovingTask(null)}>✕</button>
                                      </>
                                    ) : splittingTask?.id === t.id ? (
                                      <button className="btn btn-secondary btn-sm" onClick={() => setSplittingTask(null)}>✕</button>
                                    ) : (
                                      <>
                                        <button className="btn btn-secondary btn-sm" onClick={() => openEditPlan(t)} title="Редактировать план">План</button>
                                        {' '}
                                        <button className="btn btn-primary btn-sm" onClick={() => openEditFact(t)} title="Ввести факт">Факт</button>
                                        {' '}
                                        <button className="btn btn-secondary btn-sm" onClick={() => openMove(t)} title="Перенести на другую дату">→</button>
                                        {' '}
                                        <button className="btn btn-secondary btn-sm" onClick={() => openSplit(t)} title="Разбить на части">÷</button>
                                        {' '}
                                        <button className="btn btn-danger btn-sm" onClick={() => removeTask(t.id)}>✕</button>
                                      </>
                                    )}
                                  </td>
                                </tr>
                                {/* Split inline row */}
                                {splittingTask?.id === t.id && (
                                  <tr style={{ background: '#f0fdf4', borderBottom: '1px solid var(--border)' }}>
                                    <td colSpan={7} style={{ padding: '8px 12px' }}>
                                      <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', fontSize: '0.82rem', flexWrap: 'wrap' }}>
                                        <span style={{ fontWeight: 600, color: 'var(--text-muted)' }}>Разбить {t.plannedQuantity} шт:</span>
                                        <input
                                          type="number" min={1} max={t.plannedQuantity - 1}
                                          value={splitQty1}
                                          onChange={e => { const v = Number(e.target.value); setSplitQty1(v); setSplitQty2(t.plannedQuantity - v) }}
                                          style={{ width: 70 }}
                                        />
                                        <span>сегодня ({t.date.slice(0, 10)}) +</span>
                                        <input
                                          type="number" min={1} max={t.plannedQuantity - 1}
                                          value={splitQty2}
                                          onChange={e => { const v = Number(e.target.value); setSplitQty2(v); setSplitQty1(t.plannedQuantity - v) }}
                                          style={{ width: 70 }}
                                        />
                                        <span>на</span>
                                        <input type="date" value={splitDate2} onChange={e => setSplitDate2(e.target.value)} style={{ width: 140 }} />
                                        {splitQty1 + splitQty2 !== t.plannedQuantity && (
                                          <span style={{ color: '#dc2626', fontSize: '0.75rem' }}>
                                            ({splitQty1} + {splitQty2} ≠ {t.plannedQuantity})
                                          </span>
                                        )}
                                        <button className="btn btn-primary btn-sm" onClick={confirmSplit} disabled={saving || splitQty1 + splitQty2 !== t.plannedQuantity}>
                                          Разбить
                                        </button>
                                        <button className="btn btn-secondary btn-sm" onClick={() => setSplittingTask(null)}>Отмена</button>
                                      </div>
                                    </td>
                                  </tr>
                                )}
                              </>
                            ))}
                          </tbody>
                        </table>
                      </div>
                    )
                  })}
                </div>
              )
            })}

            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '1.5rem', padding: '0.5rem 0', borderTop: '2px solid var(--border)', fontSize: '0.9rem' }}>
              <span>Всего позиций: <strong>{tasks.length}</strong></span>
              <span>План: <strong>{totalPlan}</strong></span>
              <span>Факт: <strong style={{ color: totalFact >= totalPlan ? '#16a34a' : '#d97706' }}>{totalFact}</strong></span>
            </div>
          </>
        )}
      </div>
    </>
  )
}
