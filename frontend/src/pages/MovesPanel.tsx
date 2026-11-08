import { useEffect, useMemo, useState } from 'react'
import './list-pages.css'
import { Link } from 'react-router-dom'
import { api } from '../api'
import type { PlanMove, PlanMoveKind } from '../types'

type Tab = 'all' | 'move' | 'remove' | 'return'

const TAB_KINDS: Record<Exclude<Tab, 'all'>, PlanMoveKind[]> = {
  move: ['move', 'moveWhole', 'split'],
  remove: ['remove', 'removeWhole'],
  return: ['return'],
}

const KIND: Record<PlanMoveKind, { label: string; badge: string }> = {
  move: { label: 'Перенос', badge: 'badge-primary' },
  moveWhole: { label: 'Перенос позиции целиком', badge: 'badge-primary' },
  split: { label: 'Разбивка', badge: 'badge-primary' },
  remove: { label: 'Снято с графика', badge: 'badge-warning' },
  removeWhole: { label: 'Снята вся позиция', badge: 'badge-warning' },
  return: { label: 'Возврат в график', badge: 'badge-success' },
}

const isoDay = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
const daysAgo = (n: number) => { const d = new Date(); d.setDate(d.getDate() - n); return isoDay(d) }
// Дата плана хранится как полночь UTC — показываем её как есть, без сдвига часового пояса
const planDay = (iso: string) => `${iso.slice(8, 10)}.${iso.slice(5, 7)}.${iso.slice(2, 4)}`
const planSpan = (a: string | null, b: string | null) => (a ? (b ? `${planDay(a)}–${planDay(b)}` : planDay(a)) : '')
const when = (iso: string) => new Date(iso).toLocaleString('ru-RU', { day: '2-digit', month: '2-digit', year: '2-digit', hour: '2-digit', minute: '2-digit' })
const whenDay = (iso: string) => new Date(iso).toLocaleDateString('ru-RU', { day: '2-digit', month: '2-digit', year: '2-digit' })
const whenTime = (iso: string) => new Date(iso).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' })

// «Реестр переносов» — панель в «Графике» рядом с «Не в графике». reloadKey — план графика:
// после переноса, снятия или возврата список перечитывается
export default function MovesPanel({ reloadKey }: { reloadKey: unknown }) {
  const [list, setList] = useState<PlanMove[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [tab, setTab] = useState<Tab>('all')
  const [from, setFrom] = useState(daysAgo(30))
  const [to, setTo] = useState(isoDay(new Date()))
  const [search, setSearch] = useState('')
  const [user, setUser] = useState('')

  useEffect(() => {
    if (!from || !to) return
    let cancelled = false
    // Границы дней — в часовом поясе браузера: «по» включительно
    const start = new Date(`${from}T00:00:00`)
    const end = new Date(`${to}T00:00:00`)
    end.setDate(end.getDate() + 1)
    api.get<PlanMove[]>(`/plan-moves?from=${start.toISOString()}&to=${end.toISOString()}`).then(({ data, error: e }) => {
      if (cancelled) return
      setLoading(false)
      if (e) { setError(e); return }
      setError(null)
      setList(data ?? [])
    })
    return () => { cancelled = true }
  }, [from, to, reloadKey])

  const users = useMemo(() => [...new Set(list.map(m => m.createdBy).filter((u): u is string => !!u))].sort(), [list])

  const norm = (v: string | null | undefined) => (v ?? '').toLowerCase().replace(/ё/g, 'е')
  const q = norm(search.trim())
  const filtered = list.filter(m =>
    (!user || m.createdBy === user) &&
    (!q || norm(m.orderNumber).includes(q) || norm(m.customer).includes(q) || norm(m.productCode).includes(q) || norm(m.productName).includes(q)))
  const count = (t: Tab) => (t === 'all' ? filtered : filtered.filter(m => TAB_KINDS[t].includes(m.kind))).length
  const shown = tab === 'all' ? filtered : filtered.filter(m => TAB_KINDS[tab].includes(m.kind))

  const tabStyle = (t: Tab): React.CSSProperties => ({
    padding: '16px 0',
    fontWeight: tab === t ? 600 : 400,
    color: tab === t ? 'var(--primary)' : 'var(--text-muted)',
    background: 'none',
    border: 'none',
    borderBottom: tab === t ? '2px solid var(--primary)' : '2px solid transparent',
    cursor: 'pointer',
    fontSize: '0.9rem',
  })
  const tabs: { t: Tab; label: string }[] = [
    { t: 'all', label: 'Все' },
    { t: 'move', label: 'Переносы' },
    { t: 'remove', label: 'Снято с графика' },
    { t: 'return', label: 'Возвраты' },
  ]

  // Откуда / куда: даты строкой, бригада под ними; «Не в графике» — для снятия и возврата
  const place = (off: boolean, a: string | null, b: string | null, team: string | null) => off
    ? <span className="moves-off">Не в графике</span>
    : <><span className="moves-date">{planSpan(a, b) || '—'}</span>{team && <span className="moves-team">{team}</span>}</>
  const source = (m: PlanMove) => place(m.kind === 'return', m.fromDate, m.fromDateEnd, m.fromTeamName)
  const target = (m: PlanMove) => place(m.kind === 'remove' || m.kind === 'removeWhole', m.toDate, m.toDateEnd, m.toTeamName)
  const detail = (m: PlanMove) => {
    if (m.kind === 'return') return m.returnMode === 'fifo' ? 'в очередь бригады' : 'с выбранной даты'
    if (m.filled === false) return 'место оставлено пустым'
    if (m.filled === true && (m.kind === 'move' || m.kind === 'moveWhole')) return 'место заполнено очередью'
    return null
  }

  return (
    <div className="list-page moves-page">
      <div className="card list-card off-schedule">
        <div className="off-schedule-head">
          <h2 className="card-title" style={{ margin: 0 }}>Реестр переносов</h2>
          <p>Что, откуда, куда и кем перенесено в графике: переносы, разбивки, снятия с графика и возвраты. Отменённые действия остаются в списке с пометкой «отменено».</p>
        </div>
        {error && <div className="error" style={{ margin: '16px 24px 0' }}>{error}</div>}
        <div className="list-tabs list-tabs-inset">
          {tabs.map(({ t, label }) => (
            <button key={t} style={tabStyle(t)} onClick={() => setTab(t)}>
              {label} <span style={{ marginLeft: 4, fontSize: '0.78rem', opacity: 0.7 }}>({count(t)})</span>
            </button>
          ))}
        </div>

        <div className="list-toolbar moves-toolbar">
          <label className="moves-period">
            <span>С</span>
            <input type="date" value={from} max={to} onChange={e => setFrom(e.target.value)} aria-label="Период с" />
          </label>
          <label className="moves-period">
            <span>по</span>
            <input type="date" value={to} min={from} onChange={e => setTo(e.target.value)} aria-label="Период по" />
          </label>
          <input
            className="list-search"
            type="search"
            aria-label="Поиск по реестру"
            placeholder="Поиск: заказ, клиент, товар"
            value={search}
            onChange={e => setSearch(e.target.value)}
          />
          <select className="list-select moves-user" value={user} onChange={e => setUser(e.target.value)} aria-label="Кто переносил">
            <option value="">Все сотрудники</option>
            {users.map(u => <option key={u} value={u}>{u}</option>)}
          </select>
          {(search || user) && <button type="button" className="btn btn-secondary" onClick={() => { setSearch(''); setUser('') }}>Сбросить</button>}
        </div>

        {loading ? (
          <div className="empty">Загрузка...</div>
        ) : shown.length === 0 ? (
          <div className="empty">
            {list.length === 0 ? 'За этот период в графике ничего не переносили.' : 'Ничего не найдено.'}
          </div>
        ) : (
          <table className="stack sticky-head moves-table">
            <thead>
              <tr>
                <th>Когда</th>
                <th>Заказ</th>
                <th>Товар</th>
                <th className="num">Кол-во</th>
                <th>Откуда</th>
                <th>Куда</th>
                <th>Действие</th>
                <th>Кто</th>
              </tr>
            </thead>
            <tbody>
              {shown.map(m => {
                const k = KIND[m.kind] ?? { label: m.kind, badge: 'badge-neutral' }
                const note = detail(m)
                return (
                  <tr key={m.id} className={m.undoneAt ? 'is-undone' : undefined}>
                    <td data-label="Когда" className="moves-when"><span><span className="moves-day">{whenDay(m.createdAt)}</span> <span className="moves-time">{whenTime(m.createdAt)}</span></span></td>
                    <td className="stack-title">
                      <Link to={`/orders/${m.orderId}`}>{m.orderNumber}</Link>
                      <span className="moves-sub">{m.customer}</span>
                    </td>
                    <td data-label="Товар" className="moves-product">
                      <span>{m.productName}</span>
                      <span className="moves-sub">{m.productCode}</span>
                    </td>
                    <td data-label="Кол-во" className="num"><span>{m.qty} шт{m.days > 1 ? <span className="moves-sub">{m.days} дн.</span> : null}</span></td>
                    <td data-label="Откуда" className="moves-place">{source(m)}</td>
                    <td data-label="Куда" className="moves-place">{target(m)}</td>
                    <td data-label="Действие" className="moves-kind">
                      <span className={`badge ${m.undoneAt ? 'badge-neutral' : k.badge}`}>{k.label}</span>
                      {m.undoneAt
                        ? <span className="moves-sub" title={m.undoneBy ? `Отменил ${m.undoneBy}` : undefined}>отменено {when(m.undoneAt)}</span>
                        : note && <span className="moves-sub">{note}</span>}
                    </td>
                    <td data-label="Кто" className="moves-who" title={m.createdBy ?? undefined}>{m.createdBy?.split('@')[0] ?? '—'}</td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        )}
      </div>
    </div>
  )
}
