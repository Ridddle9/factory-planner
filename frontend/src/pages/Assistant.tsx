import { useEffect, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import { api } from '../api'

type ToolUse = { name: string; args: Record<string, unknown> }
type Message = { role: 'user' | 'assistant'; content: string; tools?: ToolUse[]; error?: boolean }

const STORAGE_KEY = 'assistant-chat'

const SUGGESTIONS = [
  'Когда будет готов заказ 00ЦБ-009874?',
  'Что делает бригада 8 на этой неделе?',
  'Какие бригады свободны на следующей неделе?',
  'Какие заказы заканчиваются на этой неделе?',
  'Какие позиции не запланированы и почему?',
]

const TOOL_LABELS: Record<string, string> = {
  find_orders: 'Поиск заказов',
  get_order: 'Заказ',
  team_schedule: 'План бригад',
  team_load: 'Загрузка бригад',
  find_products: 'Товары и нормы',
  unplanned_items: 'Незапланированные позиции',
  orders_by_finish_date: 'Заказы по дате окончания',
  list_teams: 'Список бригад',
}

// 2026-11-09 → 09.11
const shortDate = (v: unknown) => typeof v === 'string' && /^\d{4}-\d{2}-\d{2}/.test(v) ? `${v.slice(8, 10)}.${v.slice(5, 7)}` : ''

// Источник ответа — что помощник посмотрел в базе, одной подписью для чипа
function toolLabel(t: ToolUse) {
  const label = TOOL_LABELS[t.name] ?? t.name
  const detail = [t.args.query, t.args.order_number, t.args.team].find(v => typeof v === 'string' && v)
  const from = shortDate(t.args.date_from)
  const to = shortDate(t.args.date_to)
  const range = from ? (to && to !== from ? `${from}–${to}` : from) : ''
  return [label, detail, range].filter(Boolean).join(' · ')
}

function loadHistory(): Message[] {
  try {
    const raw = sessionStorage.getItem(STORAGE_KEY)
    return raw ? JSON.parse(raw) as Message[] : []
  } catch {
    return []
  }
}

// **жирный** внутри строки
function inline(text: string): ReactNode[] {
  return text.split(/(\*\*[^*]+\*\*)/g).map((part, i) =>
    part.startsWith('**') && part.endsWith('**') && part.length > 4
      ? <strong key={i}>{part.slice(2, -2)}</strong>
      : part
  )
}

// Минимальный markdown из ответа модели: абзацы, маркированные и нумерованные списки, жирный
function renderReply(text: string): ReactNode[] {
  const out: ReactNode[] = []
  let list: { ordered: boolean; items: string[] } | null = null
  const flush = () => {
    if (!list) return
    const items = list.items.map((it, i) => <li key={i}>{inline(it)}</li>)
    out.push(list.ordered ? <ol key={out.length}>{items}</ol> : <ul key={out.length}>{items}</ul>)
    list = null
  }
  for (const line of text.split('\n')) {
    const bullet = line.match(/^\s*[-*•]\s+(.*)$/)
    const numbered = line.match(/^\s*\d+[.)]\s+(.*)$/)
    if (bullet || numbered) {
      const ordered = !!numbered
      if (!list || list.ordered !== ordered) { flush(); list = { ordered, items: [] } }
      list.items.push((bullet ?? numbered)![1]!)
      continue
    }
    flush()
    const heading = line.match(/^#{1,4}\s+(.*)$/)
    if (heading) out.push(<p key={out.length}><strong>{inline(heading[1]!)}</strong></p>)
    else if (line.trim()) out.push(<p key={out.length}>{inline(line)}</p>)
  }
  flush()
  return out
}

export default function Assistant() {
  const [messages, setMessages] = useState<Message[]>(loadHistory)
  const [input, setInput] = useState('')
  const [sending, setSending] = useState(false)
  const endRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLTextAreaElement>(null)

  // Поле ввода растёт вместе с текстом (до max-height в CSS), без ручки растягивания
  useEffect(() => {
    const el = inputRef.current
    if (!el) return
    el.style.height = 'auto'
    el.style.height = `${el.scrollHeight}px`
  }, [input])

  useEffect(() => {
    try { sessionStorage.setItem(STORAGE_KEY, JSON.stringify(messages)) } catch { /* приватный режим */ }
    endRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' })
  }, [messages, sending])

  async function send(text: string) {
    const question = text.trim()
    if (!question || sending) return
    const next: Message[] = [...messages, { role: 'user', content: question }]
    setMessages(next)
    setInput('')
    setSending(true)
    // В истории для модели — только удачные ответы, без сообщений об ошибках
    const history = next.filter(m => !m.error).map(m => ({ role: m.role, content: m.content }))
    const { data, error } = await api.post<{ reply: string; tools: ToolUse[] }>('/assistant/chat', { messages: history })
    setSending(false)
    setMessages(prev => [...prev, data
      ? { role: 'assistant', content: data.reply || 'Пустой ответ', tools: data.tools }
      : { role: 'assistant', content: error ?? 'Ошибка запроса', error: true }])
  }

  function onKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault()
      send(input)
    }
  }

  function reset() {
    setMessages([])
    inputRef.current?.focus()
  }

  return (
    <div className={messages.length === 0 && !sending ? 'chat chat-is-empty' : 'chat'}>
      <div className="page-header">
        <div>
          <h1 className="page-title">Помощник</h1>
          <p className="page-description">Ответы на вопросы о заказах, графике и загрузке — по данным из базы.</p>
        </div>
        {messages.length > 0 && (
          <button type="button" className="btn btn-secondary" onClick={reset} disabled={sending}>Новый чат</button>
        )}
      </div>

      <div className="chat-log">
        {messages.length === 0 && (
          <div className="chat-empty">
            <p>Спросите о заказах, плане бригад, загрузке или нормах — помощник посмотрит в базу и ответит.</p>
            <div className="chat-suggestions">
              {SUGGESTIONS.map(s => (
                <button key={s} type="button" onClick={() => send(s)}>{s}</button>
              ))}
            </div>
          </div>
        )}

        {messages.map((m, i) => (
          <div key={i} className={`chat-msg chat-msg-${m.role}${m.error ? ' chat-msg-error' : ''}`}>
            <div className="chat-bubble">
              {m.role === 'assistant' && !m.error ? renderReply(m.content) : m.content}
            </div>
            {m.tools && m.tools.length > 0 && (
              <div className="chat-sources" aria-label="Что помощник посмотрел в базе">
                {m.tools.map((t, j) => <span key={j} className="chat-source">{toolLabel(t)}</span>)}
              </div>
            )}
          </div>
        ))}

        {sending && (
          <div className="chat-msg chat-msg-assistant">
            <div className="chat-thinking" role="status">Смотрю в базе…</div>
          </div>
        )}
        <div ref={endRef} />
      </div>

      <form className="chat-input" onSubmit={e => { e.preventDefault(); send(input) }}>
        <div className="chat-composer">
        <textarea
          ref={inputRef}
          value={input}
          onChange={e => setInput(e.target.value)}
          onKeyDown={onKeyDown}
          placeholder="Задайте вопрос…"
          aria-label="Вопрос помощнику"
          rows={1}
          maxLength={2000}
        />
        <button type="submit" className="btn btn-primary btn-sm" disabled={sending || !input.trim()}>Спросить</button>
        </div>
      </form>
    </div>
  )
}
