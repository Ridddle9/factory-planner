import { useEffect, useMemo, useState } from 'react'
import { api } from '../api'
import type { Team } from '../types'

// Загрузка бригад: доля дня, которую занимают задачи (как в планировщике: штуки / норма бригады × численность).
// capacity — мощность дня с учётом корректировок (0 — выходной или праздник).

type MatrixDay = { date: string; load: number; capacity: number; planned: number; actual: number; tasks: number }
type MatrixTeam = { teamId: string; teamName: string; headcount: number; avgLoad: number; days: MatrixDay[] }
type Matrix = { days: { date: string; working: boolean }[]; teams: MatrixTeam[] }

type TeamRow = {
  orderItemId: string; orderNumber: string; customer: string; productCode: string; productName: string; capPerDay: number
  cells: Record<string, { planned: number; actual: number | null; share: number; manual: boolean }>
}
type TeamDetail = { teamName: string; headcount: number; days: { date: string; capacity: number; load: number }[]; rows: TeamRow[] }

type Mode = 'all' | 'brigade' | 'overload' | 'underload'

const EPS = 0.005

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
const fmtDay = (iso: string) => new Date(iso + 'T00:00:00Z').toLocaleDateString('ru-RU', { day: '2-digit', month: '2-digit', timeZone: 'UTC' })
const fmtWeekday = (iso: string) => new Date(iso + 'T00:00:00Z').toLocaleDateString('ru-RU', { weekday: 'short', timeZone: 'UTC' })
const fmtFull = (iso: string) => new Date(iso + 'T00:00:00Z').toLocaleDateString('ru-RU', { timeZone: 'UTC' })
const pct = (v: number) => `${Math.round(v * 100)}%`

// Цвет ячейки загрузки: перегруз — красный, полная — зелёный, частичная — жёлтый, пусто — серый
function loadStyle(load: number, capacity: number): { background: string; color: string } {
  if (capacity <= 0) return load > EPS ? { background: 'var(--plan-danger-border)', color: 'var(--danger)' } : { background: 'var(--table-header-bg)', color: 'var(--text-muted)' }
  const r = load / capacity
  if (r > 1 + EPS) return { background: 'var(--plan-danger-border)', color: 'var(--danger)' }
  if (r >= 0.95) return { background: 'var(--success-light)', color: 'var(--success)' }
  if (r > EPS) return { background: 'var(--warning-light)', color: 'var(--warning)' }
  return { background: 'var(--danger-light)', color: 'var(--danger)' }
}

const HEAD = { background: 'var(--plan-header)', color: 'var(--text-secondary)' }

export default function TeamLoad({ teams }: { teams: Team[] }) {
  const [mode, setMode] = useState<Mode>('all')
  const [dateFrom, setDateFrom] = useState(todayISO())
  const [dateTo, setDateTo] = useState(addDays(todayISO(), 13))
  const [teamId, setTeamId] = useState('')
  const [matrix, setMatrix] = useState<Matrix | null>(null)
  const [detail, setDetail] = useState<TeamDetail | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (mode === 'brigade') return
    setLoading(true); setError(null)
    api.get<Matrix>(`/planning/load-matrix?dateFrom=${dateFrom}&dateTo=${dateTo}`).then(({ data, error: e }) => {
      setLoading(false)
      if (e) setError(e); else setMatrix(data ?? null)
    })
  }, [mode, dateFrom, dateTo])

  useEffect(() => {
    if (mode !== 'brigade' || !teamId) return
    setLoading(true); setError(null)
    api.get<TeamDetail>(`/planning/team-load?teamId=${teamId}&dateFrom=${dateFrom}&dateTo=${dateTo}`).then(({ data, error: e }) => {
      setLoading(false)
      if (e) setError(e); else setDetail(data ?? null)
    })
  }, [mode, teamId, dateFrom, dateTo])

  const overload = useMemo(() => (matrix?.teams ?? [])
    .flatMap(t => t.days.filter(d => d.load > d.capacity + EPS).map(d => ({ ...d, teamId: t.teamId, teamName: t.teamName })))
    .sort((a, b) => a.date.localeCompare(b.date) || a.teamName.localeCompare(b.teamName, 'ru', { numeric: true })), [matrix])

  const underload = useMemo(() => (matrix?.teams ?? [])
    .map(t => {
      const days = t.days.filter(d => d.capacity > 0 && d.load < d.capacity - EPS)
      return { ...t, days, free: days.reduce((s, d) => s + (d.capacity - d.load), 0) }
    })
    .filter(t => t.days.length > 0)
    .sort((a, b) => b.free - a.free), [matrix])

  // В бригаду проваливаются кликом по ней; «Назад» возвращает в тот вид, откуда пришли
  const [backTo, setBackTo] = useState<Exclude<Mode, 'brigade'>>('all')
  const openTeam = (id: string) => {
    if (mode !== 'brigade') setBackTo(mode)
    setTeamId(id)
    setMode('brigade')
  }
  const backLabel = { all: 'Все бригады', overload: 'Перегрузка', underload: 'Недогрузка' }[backTo]

  const modes: [Exclude<Mode, 'brigade'>, string, number?][] = [
    ['all', 'Все бригады'],
    ['overload', 'Перегрузка', overload.length],
    ['underload', 'Недогрузка'],
  ]

  return (
    <>
      {mode !== 'brigade' && (
        <div className="planning-submodes">
          {modes.map(([m, label, count]) => (
            <button key={m} type="button" className={`btn btn-sm ${mode === m ? 'btn-primary' : 'btn-secondary'}`} onClick={() => setMode(m)}>
              {label}
              {!!count && mode !== m && <span className="badge badge-danger" style={{ marginLeft: 5 }}>{count}</span>}
            </button>
          ))}
        </div>
      )}
      <div className="toolbar planning-filters">
        {mode === 'brigade' && (
          <>
            <button type="button" className="btn btn-secondary" onClick={() => setMode(backTo)}>← {backLabel}</button>
            <label style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
              Бригада:
              <select value={teamId} onChange={e => setTeamId(e.target.value)} style={{ width: 220 }}>
                {teams.map(t => <option key={t.id} value={t.id}>{t.name}</option>)}
              </select>
            </label>
          </>
        )}
        <label style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
          С: <input type="date" value={dateFrom} onChange={e => e.target.value && setDateFrom(e.target.value)} />
        </label>
        <label style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
          По: <input type="date" value={dateTo} onChange={e => e.target.value && setDateTo(e.target.value)} />
        </label>
        {loading && <span style={{ color: 'var(--text-muted)', fontSize: '0.85rem' }}>Загрузка…</span>}
      </div>

      {error && <div className="error">{error}</div>}

      {mode === 'all' && matrix && (
        matrix.teams.length === 0 ? <div className="empty">Нет бригад с нормами.</div> : (
          <>
            <div style={{ fontSize: '0.8rem', color: 'var(--text-muted)', marginBottom: 8 }}>
              Доля рабочего дня, занятая планом. Нажмите на бригаду, чтобы увидеть её позиции.
            </div>
            <div style={{ overflowX: 'auto' }}>
              <table style={{ borderCollapse: 'collapse', fontSize: '0.8rem', tableLayout: 'fixed' }}>
                <colgroup>
                  <col className="sticky-col-width" style={{ width: 210 }} />
                  <col style={{ width: 58 }} />
                  {matrix.days.map(d => <col key={d.date} style={{ width: 56 }} />)}
                </colgroup>
                <thead>
                  <tr>
                    <th className="sticky-col" style={{ ...HEAD, position: 'sticky', left: 0, zIndex: 2, padding: '6px 10px', textAlign: 'left', fontSize: '0.75rem' }}>Бригада</th>
                    <th style={{ ...HEAD, padding: '4px 2px', fontSize: '0.72rem' }} title="Средняя загрузка за рабочие дни периода">Ср.</th>
                    {matrix.days.map(d => (
                      <th key={d.date} style={{ ...HEAD, background: d.working ? HEAD.background : 'var(--plan-weekend)', color: d.working ? HEAD.color : 'var(--text-secondary)', padding: '4px 2px', textAlign: 'center' }}>
                        <div style={{ fontSize: '0.62rem', opacity: 0.7 }}>{fmtWeekday(d.date)}</div>
                        <div style={{ fontSize: '0.72rem' }}>{fmtDay(d.date)}</div>
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {matrix.teams.map(t => {
                    const avg = loadStyle(t.avgLoad, 1)
                    return (
                      <tr key={t.teamId} style={{ borderBottom: '1px solid var(--border)' }}>
                        <td className="sticky-col" style={{ position: 'sticky', left: 0, zIndex: 1, background: 'var(--surface)', padding: '5px 10px', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                          <button type="button" onClick={() => openTeam(t.teamId)} title={`${t.teamName} · ${t.headcount} чел.`}
                            style={{ background: 'none', border: 'none', padding: 0, font: 'inherit', fontWeight: 600, color: 'var(--primary)', cursor: 'pointer', maxWidth: '100%', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                            {t.teamName}
                          </button>
                        </td>
                        <td style={{ textAlign: 'center', fontWeight: 700, ...avg }}>{pct(t.avgLoad)}</td>
                        {t.days.map(d => {
                          const st = loadStyle(d.load, d.capacity)
                          const off = d.capacity <= 0
                          return (
                            <td key={d.date} style={{ textAlign: 'center', padding: '4px 2px', borderLeft: '1px solid #fff', ...st, fontWeight: d.load > EPS ? 600 : 400 }}
                              title={`${t.teamName}, ${fmtFull(d.date)}: ${pct(d.load)}${d.capacity > 0 && d.capacity !== 1 ? ` из ${pct(d.capacity)}` : ''} · ${d.planned} шт, позиций ${d.tasks}${d.actual ? ` · факт ${d.actual}` : ''}`}>
                              {off && d.load <= EPS ? '' : pct(d.load)}
                            </td>
                          )
                        })}
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>
          </>
        )
      )}

      {mode === 'brigade' && (
        detail && (
          <>
            <h3 style={{ margin: '0 0 0.75rem', fontWeight: 700 }}>{detail.teamName} <span style={{ fontWeight: 400, color: 'var(--text-muted)', fontSize: '0.85rem' }}>· {detail.headcount} чел.</span></h3>
            {detail.rows.length === 0 ? <div className="empty">Нет задач за период.</div> : (
              <div style={{ overflowX: 'auto' }}>
                <table style={{ borderCollapse: 'collapse', fontSize: '0.8rem', tableLayout: 'fixed' }}>
                  <colgroup>
                    <col className="sticky-col-width" style={{ width: 240 }} />
                    {detail.days.map(d => <col key={d.date} style={{ width: 60 }} />)}
                  </colgroup>
                  <thead>
                    <tr>
                      <th className="sticky-col" style={{ ...HEAD, position: 'sticky', left: 0, zIndex: 2, padding: '6px 10px', textAlign: 'left', fontSize: '0.75rem' }}>Заказ / товар</th>
                      {detail.days.map(d => (
                        <th key={d.date} style={{ ...HEAD, background: d.capacity > 0 ? HEAD.background : 'var(--plan-weekend)', color: d.capacity > 0 ? HEAD.color : 'var(--text-secondary)', padding: '4px 2px', textAlign: 'center' }}>
                          <div style={{ fontSize: '0.62rem', opacity: 0.7 }}>{fmtWeekday(d.date)}</div>
                          <div style={{ fontSize: '0.72rem' }}>{fmtDay(d.date)}</div>
                        </th>
                      ))}
                    </tr>
                    <tr>
                      <td className="sticky-col" style={{ position: 'sticky', left: 0, zIndex: 1, background: 'var(--surface)', padding: '5px 10px', fontWeight: 700, borderBottom: '2px solid var(--border-strong)' }}>Загрузка дня</td>
                      {detail.days.map(d => (
                        <td key={d.date} style={{ textAlign: 'center', fontWeight: 700, borderBottom: '2px solid var(--border-strong)', borderLeft: '1px solid #fff', ...loadStyle(d.load, d.capacity) }}>
                          {d.capacity <= 0 && d.load <= EPS ? '' : pct(d.load)}
                        </td>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {detail.rows.map(r => (
                      <tr key={r.orderItemId} style={{ borderBottom: '1px solid var(--border)' }}>
                        <td className="sticky-col" style={{ position: 'sticky', left: 0, zIndex: 1, background: 'var(--surface)', padding: '4px 10px', overflow: 'hidden' }}
                          title={`${r.orderNumber} · ${r.customer}\n${r.productCode} ${r.productName}\nНорма бригады: ${r.capPerDay} шт/день`}>
                          <div style={{ fontWeight: 600, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{r.orderNumber}</div>
                          <div style={{ fontSize: '0.72rem', color: 'var(--text-muted)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{r.productName || r.productCode}</div>
                        </td>
                        {detail.days.map(d => {
                          const c = r.cells[d.date]
                          return (
                            <td key={d.date} style={{ textAlign: 'center', padding: '3px 2px', borderLeft: '1px solid var(--border)', background: c ? 'var(--primary-light)' : undefined }}
                              title={c ? `${c.planned} шт · ${pct(c.share)} дня${c.actual !== null ? ` · факт ${c.actual}` : ''}${c.manual ? ' · ручная правка' : ''}` : undefined}>
                              {c && (
                                <>
                                  <div style={{ fontWeight: 600 }}>{c.manual && <span className="pin-mark">📌</span>}{c.planned || '—'}</div>
                                  <div style={{ fontSize: '0.65rem', color: 'var(--text-muted)' }}>{pct(c.share)}</div>
                                </>
                              )}
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
        )
      )}

      {mode === 'overload' && matrix && (
        overload.length === 0 ? <div className="empty" style={{ color: 'var(--success)' }}>Перегруженных дней за период нет.</div> : (
          <>
            <div style={{ fontSize: '0.8rem', color: 'var(--text-muted)', marginBottom: 8 }}>
              Дни, где плана больше, чем бригада успевает (обычно из-за ручных правок или сниженной мощности дня).
            </div>
            <table className="stack" style={{ width: '100%', borderCollapse: 'collapse' }}>
              <thead>
                <tr style={{ background: 'var(--bg)', fontSize: '0.75rem', color: 'var(--text-muted)' }}>
                  <th style={{ padding: '6px 12px', textAlign: 'left' }}>Дата</th>
                  <th style={{ padding: '6px 12px', textAlign: 'left' }}>Бригада</th>
                  <th style={{ padding: '6px 12px', textAlign: 'right' }}>Загрузка</th>
                  <th style={{ padding: '6px 12px', textAlign: 'right' }}>Сверх мощности</th>
                </tr>
              </thead>
              <tbody>
                {overload.map(o => (
                  <tr key={`${o.teamId}-${o.date}`} style={{ borderBottom: '1px solid var(--border)' }}>
                    <td className="stack-title" style={{ padding: '6px 12px', fontWeight: 600 }}>{fmtFull(o.date)}{o.capacity <= 0 && <span className="badge badge-neutral" style={{ marginLeft: 6 }}>выходной</span>}</td>
                    <td data-label="Бригада" style={{ padding: '6px 12px' }}>
                      <button type="button" onClick={() => openTeam(o.teamId)} style={{ background: 'none', border: 'none', padding: 0, font: 'inherit', color: 'var(--primary)', cursor: 'pointer' }}>{o.teamName}</button>
                    </td>
                    <td data-label="Загрузка" style={{ padding: '6px 12px', textAlign: 'right', fontWeight: 700, color: 'var(--danger)' }}>{pct(o.load)}</td>
                    <td data-label="Сверх мощности" style={{ padding: '6px 12px', textAlign: 'right' }}>{pct(o.load - o.capacity)} дня</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </>
        )
      )}

      {mode === 'underload' && matrix && (
        underload.length === 0 ? <div className="empty">Недогруженных рабочих дней за период нет.</div> : (
          <>
            <div style={{ fontSize: '0.8rem', color: 'var(--text-muted)', marginBottom: 8 }}>
              Рабочие дни, где у бригады остаётся свободное время. Бригады — по убыванию свободного времени.
            </div>
            {underload.map(t => (
              <div key={t.teamId} style={{ marginBottom: '1.1rem' }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap', ...HEAD, borderRadius: '6px 6px 0 0', padding: '6px 12px' }}>
                  <button type="button" onClick={() => openTeam(t.teamId)} style={{ background: 'none', border: 'none', padding: 0, font: 'inherit', fontWeight: 700, color: '#fff', cursor: 'pointer' }}>{t.teamName}</button>
                  <span style={{ fontSize: '0.78rem', opacity: 0.8 }}>
                    свободно {t.free.toFixed(1)} бригадо-дн. · {t.days.length} дн. · ср. загрузка {pct(t.avgLoad)}
                  </span>
                </div>
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4, padding: 8, border: '1px solid var(--border)', borderTop: 'none', borderRadius: '0 0 6px 6px' }}>
                  {t.days.map(d => (
                    <span key={d.date} title={`${fmtFull(d.date)}: занято ${pct(d.load)}, свободно ${pct(d.capacity - d.load)}`}
                      style={{ padding: '3px 7px', borderRadius: 4, fontSize: '0.75rem', ...loadStyle(d.load, d.capacity) }}>
                      {fmtDay(d.date)} · {pct(d.load)}
                    </span>
                  ))}
                </div>
              </div>
            ))}
          </>
        )
      )}
    </>
  )
}
