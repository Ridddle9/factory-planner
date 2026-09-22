import { useEffect, useState } from 'react'
import { api } from '../api'
import type { Team, TeamDayCapacity } from '../types'

function todayISO() {
  return new Date().toISOString().slice(0, 10)
}

function addDays(iso: string, days: number) {
  const d = new Date(iso)
  d.setDate(d.getDate() + days)
  return d.toISOString().slice(0, 10)
}

function formatDate(iso: string) {
  return new Date(iso + 'T00:00:00').toLocaleDateString('ru-RU', { day: '2-digit', month: '2-digit', weekday: 'short' })
}

export default function Teams() {
  const [tab, setTab] = useState<'teams' | 'capacity'>('teams')
  const [list, setList] = useState<Team[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [showForm, setShowForm] = useState(false)
  const [editing, setEditing] = useState<Team | null>(null)
  const [formName, setFormName] = useState('')
  const [formHeadcount, setFormHeadcount] = useState(1)
  const [saving, setSaving] = useState(false)

  // Capacity section
  const [capacities, setCapacities] = useState<TeamDayCapacity[]>([])
  const [capDateFrom, setCapDateFrom] = useState(todayISO())
  const [capDateTo, setCapDateTo] = useState(addDays(todayISO(), 13))
  const [capLoading, setCapLoading] = useState(false)
  // inline edit: key = `${teamId}_${date}`
  const [capEditing, setCapEditing] = useState<string | null>(null)
  const [capFactor, setCapFactor] = useState(100)
  const [capNote, setCapNote] = useState('')

  const load = async () => {
    setLoading(true)
    const { data, error: e } = await api.get<Team[]>('/teams')
    setLoading(false)
    if (e) { setError(e); return }
    setList(data ?? [])
    setError(null)
  }

  const loadCapacities = async () => {
    setCapLoading(true)
    const { data } = await api.get<TeamDayCapacity[]>(`/team-day-capacity`)
    setCapLoading(false)
    setCapacities(data ?? [])
  }

  useEffect(() => { load(); loadCapacities() }, [])

  const openCreate = () => { setShowForm(true); setEditing(null); setFormName(''); setFormHeadcount(1) }
  const openEdit = (t: Team) => { setEditing(t); setFormName(t.name); setFormHeadcount(t.headcount) }

  const save = async () => {
    if (!formName.trim()) return
    setSaving(true)
    if (editing) {
      const { error: e } = await api.put(`/teams/${editing.id}`, { name: formName.trim(), headcount: formHeadcount })
      if (e) setError(e)
      else { setEditing(null); setShowForm(false); load() }
    } else {
      const { error: e } = await api.post('/teams', { name: formName.trim(), headcount: formHeadcount })
      if (e) setError(e)
      else { setFormName(''); setFormHeadcount(1); setShowForm(false); load() }
    }
    setSaving(false)
  }

  const remove = async (id: string) => {
    if (!confirm('Удалить бригаду?')) return
    const { error: e } = await api.delete(`/teams/${id}`)
    if (e) setError(e)
    else load()
  }

  // Overload warning state
  type OverloadInfo = { teamId: string; teamName: string; date: string; load: number; effectiveCapacity: number; excess: number; nextDay: string }
  const [overloadWarning, setOverloadWarning] = useState<OverloadInfo | null>(null)
  const [rebalancing, setRebalancing] = useState(false)

  // Capacity helpers
  const getCapacity = (teamId: string, date: string) =>
    capacities.find(c => c.teamId === teamId && c.date.slice(0, 10) === date)

  const openCapEdit = (teamId: string, date: string) => {
    const key = `${teamId}_${date}`
    const existing = getCapacity(teamId, date)
    setCapEditing(key)
    setCapFactor(existing ? Math.round(existing.factor * 100) : 100)
    setCapNote(existing?.note ?? '')
  }

  const saveCapacity = async (teamId: string, date: string) => {
    const factor = capFactor / 100
    const existing = getCapacity(teamId, date)
    if (factor === 1 && !capNote) {
      if (existing) await api.delete(`/team-day-capacity/${existing.id}`)
      setCapEditing(null)
      loadCapacities()
      return
    }
    await api.post('/team-day-capacity', {
      teamId,
      date: new Date(date).toISOString(),
      factor,
      note: capNote.trim() || null,
    })
    setCapEditing(null)
    loadCapacities()

    // Проверяем перегрузку после сохранения
    if (factor < 1) {
      const { data } = await api.get<{ load: number; effectiveCapacity: number | null }>(`/teams/${teamId}/load?date=${date}`)
      if (data && data.effectiveCapacity !== null && data.load > data.effectiveCapacity) {
        const team = list.find(t => t.id === teamId)
        const nextDay = new Date(date)
        nextDay.setDate(nextDay.getDate() + 1)
        setOverloadWarning({
          teamId,
          teamName: team?.name ?? teamId,
          date,
          load: data.load,
          effectiveCapacity: data.effectiveCapacity,
          excess: data.load - data.effectiveCapacity,
          nextDay: nextDay.toISOString().slice(0, 10),
        })
      }
    }
  }

  const confirmRebalance = async () => {
    if (!overloadWarning) return
    setRebalancing(true)
    await api.post(`/teams/${overloadWarning.teamId}/rebalance-day`, { date: new Date(overloadWarning.date).toISOString() })
    setRebalancing(false)
    setOverloadWarning(null)
  }

  const deleteCapacity = async (id: string) => {
    await api.delete(`/team-day-capacity/${id}`)
    loadCapacities()
  }

  // Build date range for capacity grid
  const dates: string[] = []
  {
    const cur = new Date(capDateFrom)
    const end = new Date(capDateTo)
    while (cur <= end) {
      dates.push(cur.toISOString().slice(0, 10))
      cur.setDate(cur.getDate() + 1)
    }
  }

  // Only overridden dates (capacities that exist)
  const overrides = capacities.filter(c => {
    const d = c.date.slice(0, 10)
    return d >= capDateFrom && d <= capDateTo
  })

  if (loading) return <div className="card">Загрузка...</div>

  const tabStyle = (active: boolean): React.CSSProperties => ({
    padding: '0.5rem 1.25rem',
    fontWeight: 600,
    fontSize: '0.85rem',
    cursor: 'pointer',
    border: 'none',
    borderBottom: active ? '2px solid var(--primary)' : '2px solid transparent',
    background: 'none',
    color: active ? 'var(--primary)' : 'var(--text-muted)',
    transition: 'color 0.15s',
  })

  return (
    <>
      <div className="page-header">
        <h1 className="page-title">Бригады</h1>
      </div>
      {error && <div className="error" onClick={() => setError(null)} style={{ cursor: 'pointer' }}>{error} ✕</div>}

      <div style={{ display: 'flex', borderBottom: '1px solid var(--border)', marginBottom: '1rem' }}>
        <button style={tabStyle(tab === 'teams')} onClick={() => setTab('teams')}>Список бригад</button>
        <button style={tabStyle(tab === 'capacity')} onClick={() => setTab('capacity')}>Мощности по дням</button>
      </div>

      {/* Teams list */}
      {tab === 'teams' && <div className="card">
        <div className="toolbar">
          <button type="button" className="btn btn-primary" onClick={openCreate}>Добавить бригаду</button>
        </div>
        {(showForm || editing !== null) && (
          <div style={{ marginBottom: '1rem', paddingBottom: '1rem', borderBottom: '1px solid #eee' }}>
            <label>Название</label>
            <input value={formName} onChange={e => setFormName(e.target.value)} placeholder="Бригада №..." />
            <label>Количество людей</label>
            <input type="number" min={1} value={formHeadcount} onChange={e => setFormHeadcount(Math.max(1, Number(e.target.value) || 1))} />
            <div className="form-actions">
              <button type="button" className="btn btn-primary" onClick={save} disabled={saving}>{editing ? 'Сохранить' : 'Создать'}</button>
              <button type="button" className="btn btn-secondary" onClick={() => { setShowForm(false); setEditing(null); setFormName(''); setFormHeadcount(1) }}>Отмена</button>
            </div>
          </div>
        )}
        {list.length === 0 ? (
          <div className="empty">Нет бригад. Добавьте первую.</div>
        ) : (
          <table>
            <thead>
              <tr>
                <th>Название</th>
                <th style={{ width: 80, textAlign: 'center' }}>Людей</th>
                <th style={{ width: 140 }}></th>
              </tr>
            </thead>
            <tbody>
              {list.map(t => (
                <tr key={t.id}>
                  <td>{t.name}</td>
                  <td style={{ textAlign: 'center', fontVariantNumeric: 'tabular-nums' }}>{t.headcount}</td>
                  <td>
                    <button type="button" className="btn btn-secondary btn-sm" onClick={() => openEdit(t)}>Изменить</button>
                    {' '}
                    <button type="button" className="btn btn-danger btn-sm" onClick={() => remove(t.id)}>Удалить</button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>}

      {tab === 'capacity' && <div className="card">
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '0.75rem' }}>
          <h2 style={{ margin: 0, fontSize: '1rem', fontWeight: 700 }}>Мощности бригад по дням</h2>
          <div style={{ fontSize: '0.78rem', color: 'var(--text-muted)' }}>
            Задайте пониженную мощность, если вышло меньше людей
          </div>
        </div>

        <div className="toolbar" style={{ marginBottom: '0.75rem' }}>
          <label style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
            С: <input type="date" value={capDateFrom} onChange={e => setCapDateFrom(e.target.value)} />
          </label>
          <label style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
            По: <input type="date" value={capDateTo} onChange={e => setCapDateTo(e.target.value)} />
          </label>
        </div>

        {capLoading ? (
          <div className="empty">Загрузка...</div>
        ) : list.length === 0 ? (
          <div className="empty">Добавьте бригады.</div>
        ) : (
          <>
            {/* Overrides table */}
            {overrides.length > 0 && (
              <div style={{ marginBottom: '1rem' }}>
                <div style={{ fontSize: '0.78rem', fontWeight: 600, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.04em', marginBottom: '0.4rem' }}>
                  Активные корректировки
                </div>
                <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '0.82rem' }}>
                  <thead>
                    <tr style={{ background: '#f8fafc', fontSize: '0.75rem', textTransform: 'uppercase', letterSpacing: '0.04em', color: 'var(--text-muted)' }}>
                      <th style={{ textAlign: 'left', padding: '4px 8px' }}>Бригада</th>
                      <th style={{ textAlign: 'left', padding: '4px 8px' }}>Дата</th>
                      <th style={{ textAlign: 'center', padding: '4px 8px', width: 80 }}>Мощность</th>
                      <th style={{ textAlign: 'left', padding: '4px 8px' }}>Причина</th>
                      <th style={{ width: 60 }}></th>
                    </tr>
                  </thead>
                  <tbody>
                    {overrides.sort((a, b) => a.date.localeCompare(b.date)).map(cap => (
                      <tr key={cap.id} style={{ borderBottom: '1px solid var(--border)' }}>
                        <td style={{ padding: '6px 8px', fontWeight: 600 }}>{cap.team?.name ?? cap.teamId}</td>
                        <td style={{ padding: '6px 8px', color: 'var(--text-muted)' }}>{formatDate(cap.date.slice(0, 10))}</td>
                        <td style={{ padding: '6px 8px', textAlign: 'center' }}>
                          <span style={{
                            fontWeight: 700, color: cap.factor < 0.5 ? '#dc2626' : cap.factor < 1 ? '#d97706' : '#16a34a',
                            background: cap.factor < 0.5 ? '#fef2f2' : cap.factor < 1 ? '#fffbeb' : '#f0fdf4',
                            padding: '2px 8px', borderRadius: 4,
                          }}>
                            {Math.round(cap.factor * 100)}%
                          </span>
                        </td>
                        <td style={{ padding: '6px 8px', color: 'var(--text-muted)', fontSize: '0.78rem' }}>
                          {cap.note ?? '—'}
                        </td>
                        <td style={{ padding: '6px 8px', textAlign: 'right' }}>
                          <button className="btn btn-danger btn-sm" onClick={() => deleteCapacity(cap.id)}>✕</button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}

            {/* Grid: add new overrides */}
            <div style={{ fontSize: '0.78rem', fontWeight: 600, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.04em', marginBottom: '0.4rem' }}>
              Добавить / изменить
            </div>
            <div style={{ overflowX: 'auto' }}>
              <table style={{ borderCollapse: 'collapse', fontSize: '0.8rem' }}>
                <colgroup>
                  <col style={{ width: 200 }} />
                  {dates.map(d => <col key={d} style={{ width: 78 }} />)}
                </colgroup>
                <thead>
                  <tr>
                    <th style={{ background: 'var(--sidebar-bg)', color: '#e2e8f0', padding: '5px 8px', textAlign: 'left', fontWeight: 600, fontSize: '0.75rem', textTransform: 'uppercase' }}>
                      Бригада
                    </th>
                    {dates.map(d => {
                      const isWe = new Date(d + 'T00:00:00').getDay() === 0 || new Date(d + 'T00:00:00').getDay() === 6
                      return (
                        <th key={d} style={{
                          background: isWe ? '#1e2d3d' : 'var(--sidebar-bg)',
                          color: isWe ? '#64748b' : '#e2e8f0',
                          padding: '4px 2px', textAlign: 'center', fontSize: '0.72rem',
                          borderRight: '1px solid rgba(255,255,255,0.07)',
                        }}>
                          <div style={{ opacity: 0.7 }}>{new Date(d + 'T00:00:00').toLocaleDateString('ru-RU', { weekday: 'short' })}</div>
                          <div>{new Date(d + 'T00:00:00').toLocaleDateString('ru-RU', { day: '2-digit', month: '2-digit' })}</div>
                        </th>
                      )
                    })}
                  </tr>
                </thead>
                <tbody>
                  {list.map((team, ri) => (
                    <tr key={team.id} style={{ background: ri % 2 === 0 ? '#fff' : '#f8fafc' }}>
                      <td style={{ padding: '6px 8px', fontWeight: 600, borderRight: '2px solid var(--primary)', fontSize: '0.82rem' }}>
                        {team.name}
                      </td>
                      {dates.map(d => {
                        const key = `${team.id}_${d}`
                        const cap = getCapacity(team.id, d)
                        const pct = cap ? Math.round(cap.factor * 100) : 100
                        const isEditing = capEditing === key

                        return (
                          <td key={d} style={{
                            padding: '3px 2px', textAlign: 'center',
                            borderRight: '1px solid #e2e8f0',
                            background: cap ? (pct < 50 ? '#fef2f2' : pct < 100 ? '#fffbeb' : undefined) : undefined,
                          }}>
                            {isEditing ? (
                              <div style={{ display: 'flex', flexDirection: 'column', gap: 2, padding: '2px 4px', minWidth: 70 }}>
                                <div style={{ display: 'flex', alignItems: 'center', gap: 2 }}>
                                  <input
                                    type="number" min={0} max={100} value={capFactor}
                                    onChange={e => setCapFactor(Number(e.target.value))}
                                    style={{ width: 42, fontSize: '0.75rem', padding: '1px 3px' }}
                                    autoFocus
                                  />
                                  <span style={{ fontSize: '0.7rem' }}>%</span>
                                </div>
                                <input
                                  type="text" placeholder="Причина" value={capNote}
                                  onChange={e => setCapNote(e.target.value)}
                                  style={{ width: '100%', fontSize: '0.68rem', padding: '1px 3px' }}
                                />
                                <div style={{ display: 'flex', gap: 2 }}>
                                  <button className="btn btn-primary btn-sm" style={{ flex: 1, padding: '1px 4px', fontSize: '0.68rem' }} onClick={() => saveCapacity(team.id, d)}>OK</button>
                                  <button className="btn btn-secondary btn-sm" style={{ flex: 1, padding: '1px 4px', fontSize: '0.68rem' }} onClick={() => setCapEditing(null)}>✕</button>
                                </div>
                              </div>
                            ) : (
                              <div
                                onClick={() => openCapEdit(team.id, d)}
                                style={{
                                  cursor: 'pointer', minHeight: 30, display: 'flex', alignItems: 'center', justifyContent: 'center',
                                  borderRadius: 3,
                                }}
                                title={cap ? `${pct}%${cap.note ? ' — ' + cap.note : ''} · Кликните для изменения` : 'Кликните для изменения'}
                              >
                                {cap ? (
                                  <span style={{ fontWeight: 700, fontSize: '0.75rem', color: pct < 50 ? '#dc2626' : '#d97706' }}>
                                    {pct}%
                                  </span>
                                ) : (
                                  <span style={{ fontSize: '0.65rem', color: '#cbd5e1' }}>—</span>
                                )}
                              </div>
                            )}
                          </td>
                        )
                      })}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </>
        )}
      </div>}

      {/* Overload warning modal */}
      {overloadWarning && (
        <div style={{
          position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.4)', zIndex: 200,
          display: 'flex', alignItems: 'center', justifyContent: 'center',
        }}>
          <div style={{
            background: '#fff', borderRadius: 12, padding: '1.5rem', maxWidth: 420, width: '100%',
            boxShadow: '0 16px 48px rgba(0,0,0,0.18)',
          }}>
            <div style={{ fontSize: '1.1rem', fontWeight: 700, marginBottom: '0.75rem' }}>
              Бригада перегружена
            </div>
            <div style={{ fontSize: '0.85rem', color: 'var(--text-muted)', marginBottom: '1rem', lineHeight: 1.6 }}>
              <strong>{overloadWarning.teamName}</strong> на <strong>{overloadWarning.date}</strong> загружена
              на <strong>{(overloadWarning.load * 100).toFixed(0)}%</strong> бригадо-дня, но при сниженной мощности
              доступно только <strong>{(overloadWarning.effectiveCapacity * 100).toFixed(0)}%</strong>.
              <br />
              Перегруз: <strong style={{ color: '#dc2626' }}>{(overloadWarning.excess * 100).toFixed(0)}%</strong> бригадо-дня
            </div>
            <div style={{ background: '#fef9c3', border: '1px solid #fde047', borderRadius: 8, padding: '0.6rem 0.75rem', fontSize: '0.8rem', marginBottom: '1.25rem' }}>
              Перенести излишек на следующий день (<strong>{overloadWarning.nextDay}</strong>)?
            </div>
            <div style={{ display: 'flex', gap: '0.5rem' }}>
              <button className="btn btn-primary" style={{ flex: 1 }} onClick={confirmRebalance} disabled={rebalancing}>
                {rebalancing ? 'Переносим...' : `Перенести на ${overloadWarning.nextDay}`}
              </button>
              <button className="btn btn-secondary" style={{ flex: 1 }} onClick={() => setOverloadWarning(null)}>
                Оставить как есть
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  )
}
