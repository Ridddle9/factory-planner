import { useEffect, useState } from 'react'
import { api } from '../api'
import { useScrollToForm } from '../useScrollToForm'
import type { Team, TeamDayCapacity } from '../types'

// Сегодня по местному времени (toISOString дал бы дату по UTC — ночью по Москве это ещё вчера)
function todayISO() {
  const d = new Date()
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

function addDays(iso: string, days: number) {
  const d = new Date(iso + 'T00:00:00Z')
  d.setUTCDate(d.getUTCDate() + days)
  return d.toISOString().slice(0, 10)
}

function formatDate(iso: string) {
  return new Date(iso + 'T00:00:00').toLocaleDateString('ru-RU', { day: '2-digit', month: '2-digit', weekday: 'short' })
}

const fmtShort = (iso: string) => new Date(iso + 'T00:00:00').toLocaleDateString('ru-RU', { day: '2-digit', month: '2-digit', year: 'numeric' })

// Те же праздники, что у планировщика (RUSSIAN_HOLIDAYS в src/index.ts)
const HOLIDAYS = ['01-01', '01-02', '01-03', '01-04', '01-05', '01-06', '01-07', '01-08', '02-23', '03-08', '05-01', '05-09', '06-12', '11-04']
function isWorkingDay(iso: string) {
  const dow = new Date(iso + 'T00:00:00').getDay()
  return dow !== 0 && dow !== 6 && !HOLIDAYS.includes(iso.slice(5))
}
function nextWorkingDay(iso: string) {
  let d = iso
  do { d = addDays(d, 1) } while (!isWorkingDay(d))
  return d
}

// Цвет мощности: выше 100% — зелёный, ниже — жёлтый, меньше половины — красный
function capColor(pct: number) {
  if (pct > 100) return { color: 'var(--success)', background: 'var(--success-light)' }
  if (pct < 50) return { color: 'var(--danger)', background: 'var(--danger-light)' }
  if (pct < 100) return { color: 'var(--warning)', background: 'var(--warning-light)' }
  return { color: 'var(--text-muted)', background: undefined }
}

type CapForm = { teamId: string; from: string; to: string; pct: number; note: string }
type CapPeriod = { teamId: string; teamName: string; from: string; to: string; factor: number; note: string | null; ids: string[] }

export default function Teams() {
  const [tab, setTab] = useState<'teams' | 'capacity'>('teams')
  const [list, setList] = useState<Team[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [showForm, setShowForm] = useState(false)
  const [editing, setEditing] = useState<Team | null>(null)
  const formRef = useScrollToForm(editing?.id ?? (showForm ? 'new' : null))
  const [formName, setFormName] = useState('')
  const [formHeadcount, setFormHeadcount] = useState(1)
  const [saving, setSaving] = useState(false)

  // Capacity section
  const [capacities, setCapacities] = useState<TeamDayCapacity[]>([])
  const [capDateFrom, setCapDateFrom] = useState(todayISO())
  const [capDateTo, setCapDateTo] = useState(addDays(todayISO(), 13))
  const [capLoading, setCapLoading] = useState(false)
  // Форма корректировки мощности (над таблицей): бригада, период, процент, причина
  const [capForm, setCapForm] = useState<CapForm | null>(null)
  const capFormRef = useScrollToForm(capForm ? `${capForm.teamId}_${capForm.from}_${capForm.to}` : null)
  const [capSaving, setCapSaving] = useState(false)
  // Итог сохранения: что изменилось и на какие дни план теперь больше мощности
  const [capResult, setCapResult] = useState<{ text: string; overloaded: { date: string; load: number; capacity: number }[] } | null>(null)
  const [replanning, setReplanning] = useState(false)

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

  const getCapacity = (teamId: string, date: string) =>
    capacities.find(c => c.teamId === teamId && c.date.slice(0, 10) === date)

  // Клик по клетке — форма на этот день с текущей мощностью
  const openCapCell = (teamId: string, date: string) => {
    const existing = getCapacity(teamId, date)
    setCapResult(null)
    setCapForm({ teamId, from: date, to: date, pct: existing ? Math.round(existing.factor * 100) : 100, note: existing?.note ?? '' })
  }

  const openCapNew = () => {
    setCapResult(null)
    setCapForm({ teamId: list[0]?.id ?? '', from: todayISO(), to: todayISO(), pct: 100, note: '' })
  }

  const saveCapForm = async (reset = false) => {
    if (!capForm) return
    if (!capForm.teamId) { setError('Выберите бригаду'); return }
    if (capForm.to < capForm.from) { setError('Дата «по» раньше даты «с»'); return }
    if (!reset && (!(capForm.pct >= 0) || capForm.pct > 500)) { setError('Мощность — от 0 до 500%'); return }
    setCapSaving(true)
    const pct = reset ? 100 : capForm.pct
    const { data, error: e } = await api.post<{ saved: number; removed: number; days: number }>('/team-day-capacity/range', {
      teamId: capForm.teamId, dateFrom: capForm.from, dateTo: capForm.to,
      factor: pct / 100, note: reset ? '' : capForm.note,
    })
    if (e) { setCapSaving(false); setError(e); return }

    // Проверяем, не стало ли плана больше мощности в этом периоде
    const { data: m } = await api.get<{ teams: { teamId: string; days: { date: string; load: number; capacity: number }[] }[] }>(
      `/planning/load-matrix?dateFrom=${capForm.from}&dateTo=${capForm.to}`)
    const overloaded = (m?.teams.find(t => t.teamId === capForm.teamId)?.days ?? []).filter(d => d.load > d.capacity + 0.005)
    const team = list.find(t => t.id === capForm.teamId)?.name ?? ''
    const period = capForm.from === capForm.to ? fmtShort(capForm.from) : `${fmtShort(capForm.from)} – ${fmtShort(capForm.to)}`
    setCapResult({
      text: pct === 100 && (reset || !capForm.note.trim())
        ? `${team}: мощность 100% за ${period}${data?.removed ? ` (снято корректировок: ${data.removed})` : ''}.`
        : `${team}: ${pct}% за ${period} — рабочих дней: ${data?.saved ?? 0}.`,
      overloaded,
    })
    setCapSaving(false)
    setCapForm(null)
    loadCapacities()
  }

  const replanQueue = async () => {
    if (!confirm('Перепланировать очередь? План пересоберётся с завтрашнего дня с учётом новой мощности. Ручные правки и факт останутся.')) return
    setReplanning(true)
    const { error: e } = await api.post('/planning/replan-queue', {})
    setReplanning(false)
    if (e) setError(e)
    else setCapResult(r => r && { text: r.text + ' Очередь перепланирована.', overloaded: [] })
  }

  const deletePeriod = async (p: CapPeriod) => {
    if (!confirm(`Снять корректировку «${p.teamName}» ${Math.round(p.factor * 100)}% за ${p.from === p.to ? fmtShort(p.from) : `${fmtShort(p.from)} – ${fmtShort(p.to)}`}?`)) return
    for (const id of p.ids) await api.delete(`/team-day-capacity/${id}`)
    loadCapacities()
  }

  // Build date range for capacity grid
  const dates: string[] = []
  for (let d = capDateFrom; d <= capDateTo && dates.length < 120; d = addDays(d, 1)) dates.push(d)

  // Корректировки, пересекающие выбранные даты, — подряд идущие рабочие дни с одинаковой мощностью
  // и причиной собираются в один период
  const periods: CapPeriod[] = []
  for (const c of [...capacities].sort((a, b) => a.teamId.localeCompare(b.teamId) || a.date.localeCompare(b.date))) {
    const d = c.date.slice(0, 10)
    const last = periods[periods.length - 1]
    if (last && last.teamId === c.teamId && last.factor === c.factor && last.note === (c.note ?? null) && nextWorkingDay(last.to) === d) {
      last.to = d; last.ids.push(c.id)
    } else {
      periods.push({ teamId: c.teamId, teamName: c.team?.name ?? c.teamId, from: d, to: d, factor: c.factor, note: c.note ?? null, ids: [c.id] })
    }
  }
  const overrides = periods
    .filter(p => p.to >= capDateFrom && p.from <= capDateTo)
    .sort((a, b) => a.from.localeCompare(b.from) || a.teamName.localeCompare(b.teamName, 'ru', { numeric: true }))
  // Подсветка клеток, которые меняет форма (выходные и праздники в период не входят)
  const inCapForm = (teamId: string, date: string) => !!capForm && capForm.teamId === teamId && date >= capForm.from && date <= capForm.to && isWorkingDay(date)

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
        <div><h1 className="page-title">Бригады</h1>
      <p className="page-description">Состав производства, доступные мощности и рабочие дни.</p></div>
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
          <div className="form-panel" ref={formRef}>
            <h3 className="form-panel-title">{editing ? 'Изменение бригады' : 'Новая бригада'}</h3>
            <label>Название</label>
            <input value={formName} onChange={e => setFormName(e.target.value)} placeholder="Бригада №..." />
            <label>Количество людей</label>
            <input type="number" inputMode="numeric" min={1} value={formHeadcount} onChange={e => setFormHeadcount(Math.max(1, Number(e.target.value) || 1))} />
            <div className="form-actions">
              <button type="button" className="btn btn-primary" onClick={save} disabled={saving}>{editing ? 'Сохранить' : 'Создать'}</button>
              <button type="button" className="btn btn-secondary" onClick={() => { setShowForm(false); setEditing(null); setFormName(''); setFormHeadcount(1) }}>Отмена</button>
            </div>
          </div>
        )}
        {list.length === 0 ? (
          <div className="empty">Нет бригад. Добавьте первую.</div>
        ) : (
          <table className="stack sticky-head">
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
                  <td className="stack-title">{t.name}</td>
                  <td data-label="Людей" style={{ textAlign: 'center', fontVariantNumeric: 'tabular-nums' }}>{t.headcount}</td>
                  <td className="stack-actions">
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
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: '0.25rem 1rem', marginBottom: '0.75rem' }}>
          <h2 style={{ margin: 0, fontSize: '1rem', fontWeight: 700 }}>Мощности бригад по дням</h2>
          <div style={{ fontSize: '0.78rem', color: 'var(--text-muted)' }}>
            Меньше 100% — вышло меньше людей, больше 100% — сверхурочные или усиление
          </div>
        </div>

        <div className="toolbar" style={{ marginBottom: '0.75rem' }}>
          <button type="button" className="btn btn-primary" onClick={openCapNew} disabled={list.length === 0}>Добавить корректировку</button>
          <label style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
            С: <input type="date" value={capDateFrom} onChange={e => e.target.value && setCapDateFrom(e.target.value)} />
          </label>
          <label style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
            По: <input type="date" value={capDateTo} onChange={e => e.target.value && setCapDateTo(e.target.value)} />
          </label>
        </div>

        {capForm && (
          <div className="form-panel" ref={capFormRef}>
            <h3 className="form-panel-title">Мощность бригады</h3>
            <label>Бригада</label>
            <select value={capForm.teamId} onChange={e => setCapForm(f => f && { ...f, teamId: e.target.value })}>
              {list.map(t => <option key={t.id} value={t.id}>{t.name}</option>)}
            </select>
            <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap' }}>
              <div style={{ flex: '1 1 160px' }}>
                <label>С</label>
                <input type="date" value={capForm.from} onChange={e => e.target.value && setCapForm(f => f && { ...f, from: e.target.value, to: f.to < e.target.value ? e.target.value : f.to })} />
              </div>
              <div style={{ flex: '1 1 160px' }}>
                <label>По</label>
                <input type="date" value={capForm.to} min={capForm.from} onChange={e => e.target.value && setCapForm(f => f && { ...f, to: e.target.value })} />
              </div>
            </div>
            <label>
              Мощность, %
              <span className="form-hint">100% — обычная. Например, 120% — бригада успевает на пятую часть больше. Выходные и праздники в период не входят.</span>
            </label>
            <input type="number" inputMode="numeric" min={0} max={500} step={5} value={capForm.pct}
              onChange={e => setCapForm(f => f && { ...f, pct: Number(e.target.value) })} />
            <label>Причина</label>
            <input type="text" placeholder="Например: двое на больничном" value={capForm.note}
              onChange={e => setCapForm(f => f && { ...f, note: e.target.value })} />
            <div className="form-actions">
              <button type="button" className="btn btn-primary" onClick={() => saveCapForm()} disabled={capSaving}>{capSaving ? 'Сохраняем…' : 'Сохранить'}</button>
              <button type="button" className="btn btn-secondary" onClick={() => saveCapForm(true)} disabled={capSaving}>Сбросить до 100%</button>
              <button type="button" className="btn btn-secondary" onClick={() => setCapForm(null)}>Отмена</button>
            </div>
          </div>
        )}

        {capResult && (
          <div className={capResult.overloaded.length > 0 ? 'cap-result cap-result-warn' : 'cap-result'}>
            <div>{capResult.text}</div>
            {capResult.overloaded.length > 0 ? (
              <div style={{ marginTop: 4 }}>
                Плана больше новой мощности в {capResult.overloaded.length} дн.: {capResult.overloaded.slice(0, 6).map(d => `${fmtShort(d.date).slice(0, 5)} (${Math.round(d.load * 100)}% из ${Math.round(d.capacity * 100)}%)`).join(', ')}{capResult.overloaded.length > 6 ? '…' : ''}.
              </div>
            ) : null}
            <div style={{ marginTop: 4 }}>План учтёт изменение после перепланирования очереди.</div>
            <div style={{ display: 'flex', gap: 8, marginTop: 8, flexWrap: 'wrap' }}>
              <button type="button" className="btn btn-primary btn-sm" onClick={replanQueue} disabled={replanning}>{replanning ? 'Перепланируем…' : 'Перепланировать очередь'}</button>
              <button type="button" className="btn btn-secondary btn-sm" onClick={() => setCapResult(null)}>Закрыть</button>
            </div>
          </div>
        )}

        {capLoading ? (
          <div className="empty">Загрузка...</div>
        ) : list.length === 0 ? (
          <div className="empty">Добавьте бригады.</div>
        ) : (
          <>
            {/* Корректировки, сгруппированные в периоды */}
            {overrides.length > 0 && (
              <div style={{ marginBottom: '1rem' }}>
                <div style={{ fontSize: '0.78rem', fontWeight: 600, color: 'var(--text-muted)', marginBottom: '0.4rem' }}>
                  Активные корректировки
                </div>
                <table className="stack" style={{ width: '100%', borderCollapse: 'collapse', fontSize: '0.82rem' }}>
                  <thead>
                    <tr style={{ background: 'var(--bg)', fontSize: '0.75rem', color: 'var(--text-muted)' }}>
                      <th style={{ textAlign: 'left', padding: '4px 8px' }}>Бригада</th>
                      <th style={{ textAlign: 'left', padding: '4px 8px' }}>Период</th>
                      <th style={{ textAlign: 'center', padding: '4px 8px', width: 90 }}>Мощность</th>
                      <th style={{ textAlign: 'left', padding: '4px 8px' }}>Причина</th>
                      <th style={{ width: 140 }}></th>
                    </tr>
                  </thead>
                  <tbody>
                    {overrides.map(p => {
                      const pct = Math.round(p.factor * 100)
                      return (
                        <tr key={p.ids[0]} style={{ borderBottom: '1px solid var(--border)' }}>
                          <td className="stack-title" style={{ padding: '6px 8px', fontWeight: 600 }}>{p.teamName}</td>
                          <td data-label="Период" style={{ padding: '6px 8px', color: 'var(--text-muted)' }}>
                            {p.from === p.to ? formatDate(p.from) : `${fmtShort(p.from)} – ${fmtShort(p.to)}`}
                            {p.ids.length > 1 && <span style={{ marginLeft: 6, fontSize: '0.75rem' }}>({p.ids.length} раб. дн.)</span>}
                          </td>
                          <td data-label="Мощность" style={{ padding: '6px 8px', textAlign: 'center' }}>
                            <span style={{ fontWeight: 700, padding: '2px 8px', borderRadius: 4, ...capColor(pct) }}>{pct}%</span>
                          </td>
                          <td data-label="Причина" style={{ padding: '6px 8px', color: 'var(--text-muted)', fontSize: '0.78rem' }}>{p.note ?? '—'}</td>
                          <td className="stack-actions" style={{ padding: '6px 8px', textAlign: 'right', whiteSpace: 'nowrap' }}>
                            <button className="btn btn-secondary btn-sm" onClick={() => { setCapResult(null); setCapForm({ teamId: p.teamId, from: p.from, to: p.to, pct, note: p.note ?? '' }) }}>Изменить</button>
                            {' '}
                            <button className="btn btn-danger btn-sm" onClick={() => deletePeriod(p)} aria-label="Снять корректировку">✕</button>
                          </td>
                        </tr>
                      )
                    })}
                  </tbody>
                </table>
              </div>
            )}

            {/* Сетка: клик по клетке открывает форму на этот день */}
            <div style={{ fontSize: '0.78rem', fontWeight: 600, color: 'var(--text-muted)', marginBottom: '0.4rem' }}>
              По дням — нажмите на клетку, чтобы изменить
            </div>
            <div style={{ overflowX: 'auto' }}>
              <table style={{ borderCollapse: 'collapse', fontSize: '0.8rem' }}>
                <colgroup>
                  <col className="sticky-col-width" style={{ width: 200 }} />
                  {dates.map(d => <col key={d} style={{ width: 64 }} />)}
                </colgroup>
                <thead>
                  <tr>
                    <th className="sticky-col" style={{ background: 'var(--table-header-bg)', color: 'var(--table-header-text)', padding: '5px 8px', textAlign: 'left', fontWeight: 600, fontSize: '0.75rem', textTransform: 'none' }}>
                      Бригада
                    </th>
                    {dates.map(d => {
                      const off = !isWorkingDay(d)
                      return (
                        <th key={d} style={{
                          background: off ? 'var(--plan-weekend)' : 'var(--table-header-bg)',
                          color: off ? 'var(--text-muted)' : 'var(--table-header-text)',
                          padding: '4px 2px', textAlign: 'center', fontSize: '0.72rem',
                          borderRight: '1px solid var(--border)',
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
                    <tr key={team.id} style={{ background: ri % 2 === 0 ? '#fff' : 'var(--bg)' }}>
                      <td className="sticky-col" style={{ padding: '6px 8px', fontWeight: 600, borderRight: '2px solid var(--primary)', fontSize: '0.82rem', background: 'inherit' }}>
                        {team.name}
                      </td>
                      {dates.map(d => {
                        const cap = getCapacity(team.id, d)
                        const pct = cap ? Math.round(cap.factor * 100) : 100
                        const selected = inCapForm(team.id, d)
                        const off = !isWorkingDay(d)
                        return (
                          <td key={d}
                            className={selected ? 'cap-cell cap-cell-selected' : 'cap-cell'}
                            onClick={() => !off && openCapCell(team.id, d)}
                            title={off ? 'Выходной' : cap ? `${pct}%${cap.note ? ' — ' + cap.note : ''} · нажмите, чтобы изменить` : 'Нажмите, чтобы изменить'}
                            style={{ cursor: off ? 'default' : 'pointer', background: off ? 'var(--table-header-bg)' : cap ? capColor(pct).background : undefined }}>
                            {cap ? (
                              <span style={{ fontWeight: 700, fontSize: '0.75rem', color: capColor(pct).color }}>{pct}%</span>
                            ) : (
                              <span style={{ fontSize: '0.65rem', color: 'var(--border-strong)' }}>{off ? '' : '—'}</span>
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
    </>
  )
}
