import { useState, useRef } from 'react'
import { api } from '../api'

interface ImportSummary {
  categories: { created: number; updated: number }
  products: { created: number; updated: number }
  orders: { created: number; updated: number }
  orderItems: { created: number; updated: number }
  dailyTasks: { created: number; updated: number }
  factRecorded: number
  skipped: number
}

interface ImportConflict {
  orderItemId: string
  orderNumber: string
  productCode: string
  taskId: string
  existingFact: number
  calculatedFact: number
}

interface FactDetail {
  orderNumber: string
  productCode: string
  fact: number
}

interface UnplannedItem {
  orderItemId: string
  orderNumber: string
  productCode: string
  remaining: number
  planned: number
  gap: number
}

type ConflictResolution = 'keep' | 'replace' | null

export default function Import() {
  const [file, setFile] = useState<File | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [summary, setSummary] = useState<ImportSummary | null>(null)
  const [conflicts, setConflicts] = useState<ImportConflict[]>([])
  const [resolutions, setResolutions] = useState<Record<string, ConflictResolution>>({})
  const [savingConflicts, setSavingConflicts] = useState(false)
  const [conflictsSaved, setConflictsSaved] = useState(false)
  const [factDetails, setFactDetails] = useState<FactDetail[]>([])
  const [showFactDetails, setShowFactDetails] = useState(false)
  const [unplanned, setUnplanned] = useState<UnplannedItem[]>([])
  const inputRef = useRef<HTMLInputElement>(null)

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const f = e.target.files?.[0] ?? null
    setFile(f)
    setError(null)
    setSummary(null)
    setConflicts([])
    setResolutions({})
    setConflictsSaved(false)
    setFactDetails([])
    setShowFactDetails(false)
    setUnplanned([])
  }

  const handleImport = async () => {
    if (!file) return
    setLoading(true)
    setError(null)
    setSummary(null)
    setConflicts([])
    setResolutions({})
    setConflictsSaved(false)
    setFactDetails([])
    setShowFactDetails(false)
    setUnplanned([])

    const formData = new FormData()
    formData.append('file', file)

    const { data, error: e } = await api.postFile<{ summary: ImportSummary; conflicts: ImportConflict[]; factDetails: FactDetail[]; unplanned: UnplannedItem[] }>('/import/excel', formData)
    setLoading(false)

    if (e) {
      setError(e)
    } else if (data) {
      setSummary(data.summary)
      if (data.factDetails?.length > 0) setFactDetails(data.factDetails)
      if (data.unplanned?.length > 0) setUnplanned(data.unplanned)
      if (data.conflicts?.length > 0) {
        setConflicts(data.conflicts)
        // Pre-fill: default keep existing
        const initial: Record<string, ConflictResolution> = {}
        data.conflicts.forEach(c => { initial[c.taskId] = 'keep' })
        setResolutions(initial)
      }
    }
  }

  const resolveAll = async () => {
    setSavingConflicts(true)
    for (const conflict of conflicts) {
      const resolution = resolutions[conflict.taskId]
      if (!resolution) continue
      await api.post('/import/resolve-conflict', {
        taskId: conflict.taskId,
        useCalculated: resolution === 'replace',
        calculatedFact: conflict.calculatedFact,
      })
    }
    setSavingConflicts(false)
    setConflictsSaved(true)
    setConflicts([])
  }

  const allResolved = conflicts.length > 0 && conflicts.every(c => resolutions[c.taskId] !== null)

  return (
    <>
      <h1 className="page-title">Импорт Excel</h1>

      <div className="card" style={{ maxWidth: 600 }}>
        <p style={{ margin: '0 0 16px', color: 'var(--text-secondary)', fontSize: '0.875rem' }}>
          Загрузите файл <strong>«первичка new»</strong> из 1С. Система:
        </p>
        <ul style={{ margin: '0 0 16px', paddingLeft: 20, fontSize: '0.875rem', color: 'var(--text-secondary)', lineHeight: 1.7 }}>
          <li>Создаст / обновит категории, товары, заказы и позиции</li>
          <li>Запишет факт за вчера (разница «К обеспечению» с предыдущим импортом)</li>
          <li>Новые позиции — автоматически запланирует с учётом загрузки бригад</li>
          <li>Существующий план <strong>не трогает</strong> — ручные правки сохраняются</li>
        </ul>

        <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 16 }}>
          <button type="button" className="btn btn-secondary" onClick={() => inputRef.current?.click()}>
            Выбрать файл .xlsx
          </button>
          <span style={{ fontSize: '0.875rem', color: file ? 'var(--text)' : 'var(--text-muted)' }}>
            {file ? file.name : 'Файл не выбран'}
          </span>
          <input ref={inputRef} type="file" accept=".xlsx,.xls" style={{ display: 'none' }} onChange={handleFileChange} />
        </div>

        <button type="button" className="btn btn-primary" disabled={!file || loading} onClick={handleImport}>
          {loading ? 'Импортирую...' : 'Загрузить и импортировать'}
        </button>
      </div>

      {error && <div className="error">{error}</div>}

      {/* Конфликты факта */}
      {conflicts.length > 0 && (
        <div className="card" style={{ maxWidth: 700, border: '1px solid #fecaca', background: '#fff5f5' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 12 }}>
            <span style={{ fontSize: '1.1rem' }}>⚠️</span>
            <strong>Конфликты факта — {conflicts.length} позиций</strong>
          </div>
          <p style={{ fontSize: '0.82rem', color: 'var(--text-muted)', margin: '0 0 14px' }}>
            По этим позициям факт за вчера уже был введён вручную и отличается от рассчитанного.
            Выберите, какое значение оставить.
          </p>
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '0.85rem' }}>
            <thead>
              <tr style={{ background: '#fee2e2', fontSize: '0.75rem', textTransform: 'uppercase', letterSpacing: '0.04em', color: 'var(--text-muted)' }}>
                <th style={{ padding: '5px 10px', textAlign: 'left' }}>Заказ</th>
                <th style={{ padding: '5px 10px', textAlign: 'left' }}>Товар</th>
                <th style={{ padding: '5px 10px', textAlign: 'right' }}>Факт (ручной)</th>
                <th style={{ padding: '5px 10px', textAlign: 'right' }}>Факт (из Excel)</th>
                <th style={{ padding: '5px 10px', textAlign: 'center', minWidth: 200 }}>Оставить</th>
              </tr>
            </thead>
            <tbody>
              {conflicts.map(c => (
                <tr key={c.taskId} style={{ borderBottom: '1px solid #fecaca' }}>
                  <td style={{ padding: '7px 10px', fontWeight: 600 }}>{c.orderNumber}</td>
                  <td style={{ padding: '7px 10px', color: 'var(--text-muted)' }}>{c.productCode}</td>
                  <td style={{ padding: '7px 10px', textAlign: 'right', fontWeight: 600 }}>{c.existingFact}</td>
                  <td style={{ padding: '7px 10px', textAlign: 'right', fontWeight: 600, color: 'var(--primary)' }}>{c.calculatedFact}</td>
                  <td style={{ padding: '7px 10px', textAlign: 'center' }}>
                    <label style={{ marginRight: 16, cursor: 'pointer', fontSize: '0.82rem' }}>
                      <input
                        type="radio"
                        name={c.taskId}
                        value="keep"
                        checked={resolutions[c.taskId] === 'keep'}
                        onChange={() => setResolutions(r => ({ ...r, [c.taskId]: 'keep' }))}
                        style={{ marginRight: 4 }}
                      />
                      Ручной ({c.existingFact})
                    </label>
                    <label style={{ cursor: 'pointer', fontSize: '0.82rem' }}>
                      <input
                        type="radio"
                        name={c.taskId}
                        value="replace"
                        checked={resolutions[c.taskId] === 'replace'}
                        onChange={() => setResolutions(r => ({ ...r, [c.taskId]: 'replace' }))}
                        style={{ marginRight: 4 }}
                      />
                      Из Excel ({c.calculatedFact})
                    </label>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <div style={{ marginTop: 14, display: 'flex', gap: 10, alignItems: 'center' }}>
            <button
              type="button"
              className="btn btn-primary"
              disabled={!allResolved || savingConflicts}
              onClick={resolveAll}
            >
              {savingConflicts ? 'Сохраняю...' : 'Применить решения'}
            </button>
            <button
              type="button"
              className="btn btn-secondary"
              onClick={() => {
                const all: Record<string, ConflictResolution> = {}
                conflicts.forEach(c => { all[c.taskId] = 'keep' })
                setResolutions(all)
              }}
            >
              Все — ручной
            </button>
            <button
              type="button"
              className="btn btn-secondary"
              onClick={() => {
                const all: Record<string, ConflictResolution> = {}
                conflicts.forEach(c => { all[c.taskId] = 'replace' })
                setResolutions(all)
              }}
            >
              Все — из Excel
            </button>
          </div>
        </div>
      )}

      {/* Незапланированные позиции */}
      {unplanned.length > 0 && (
        <div className="card" style={{ maxWidth: 700, border: '1px solid #fed7aa', background: '#fff7ed' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 8 }}>
            <span style={{ fontSize: '1.1rem' }}>⚠</span>
            <strong style={{ color: '#c2410c' }}>Не запланировано — {unplanned.length} позиций</strong>
          </div>
          <p style={{ fontSize: '0.82rem', color: '#92400e', margin: '0 0 14px' }}>
            По этим позициям остаток («К обеспечению») больше суммы будущих задач.
            Их нужно распланировать вручную на странице <strong>Расписание</strong>.
          </p>
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '0.85rem' }}>
            <thead>
              <tr style={{ background: '#ffedd5', fontSize: '0.75rem', textTransform: 'uppercase', letterSpacing: '0.04em', color: '#92400e' }}>
                <th style={{ padding: '5px 10px', textAlign: 'left' }}>Заказ</th>
                <th style={{ padding: '5px 10px', textAlign: 'left' }}>Товар</th>
                <th style={{ padding: '5px 10px', textAlign: 'right' }}>Остаток K</th>
                <th style={{ padding: '5px 10px', textAlign: 'right' }}>Запланировано</th>
                <th style={{ padding: '5px 10px', textAlign: 'right' }}>Нехватка</th>
              </tr>
            </thead>
            <tbody>
              {unplanned.map(u => (
                <tr key={u.orderItemId} style={{ borderBottom: '1px solid #fed7aa' }}>
                  <td style={{ padding: '7px 10px', fontWeight: 600 }}>{u.orderNumber}</td>
                  <td style={{ padding: '7px 10px', color: '#92400e' }}>{u.productCode}</td>
                  <td style={{ padding: '7px 10px', textAlign: 'right' }}>{u.remaining}</td>
                  <td style={{ padding: '7px 10px', textAlign: 'right' }}>{u.planned}</td>
                  <td style={{ padding: '7px 10px', textAlign: 'right', fontWeight: 700, color: '#dc2626' }}>+{u.gap}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {conflictsSaved && (
        <div className="card" style={{ maxWidth: 600, background: 'var(--success-light)', border: '1px solid #BBF7D0', color: 'var(--success)', padding: '12px 16px' }}>
          ✓ Конфликты разрешены
        </div>
      )}

      {/* Результаты импорта */}
      {summary && (
        <div className="card" style={{ maxWidth: 600 }}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 16 }}>
            <strong>Результаты импорта</strong>
            <span className="badge badge-success">Готово</span>
          </div>
          <table>
            <thead>
              <tr>
                <th>Сущность</th>
                <th>Создано</th>
                <th>Обновлено</th>
              </tr>
            </thead>
            <tbody>
              {[
                ['Категории',        summary.categories],
                ['Товары',           summary.products],
                ['Заказы',           summary.orders],
                ['Позиции заказов',  summary.orderItems],
                ['Задачи (план)',     summary.dailyTasks],
              ].map(([label, s]) => {
                const stat = s as { created: number; updated: number }
                return (
                  <tr key={label as string}>
                    <td>{label as string}</td>
                    <td style={{ color: stat.created > 0 ? 'var(--success)' : undefined }}>
                      {stat.created > 0 ? `+${stat.created}` : '—'}
                    </td>
                    <td>{stat.updated || '—'}</td>
                  </tr>
                )
              })}
              <tr>
                <td>Факт за вчера</td>
                <td colSpan={2} style={{ color: summary.factRecorded > 0 ? 'var(--success)' : 'var(--text-muted)', fontWeight: summary.factRecorded > 0 ? 600 : undefined }}>
                  {summary.factRecorded > 0 ? (
                    <button
                      type="button"
                      onClick={() => setShowFactDetails(v => !v)}
                      style={{ background: 'none', border: 'none', padding: 0, cursor: 'pointer', color: 'var(--success)', fontWeight: 600, fontSize: 'inherit', textDecoration: 'underline dotted' }}
                    >
                      {summary.factRecorded} позиций {showFactDetails ? '▲' : '▼'}
                    </button>
                  ) : '—'}
                </td>
              </tr>
              {showFactDetails && factDetails.length > 0 && (
                <tr>
                  <td colSpan={3} style={{ padding: 0 }}>
                    <table style={{ width: '100%', fontSize: '0.8rem', borderCollapse: 'collapse', background: '#f0fdf4' }}>
                      <thead>
                        <tr style={{ color: 'var(--text-muted)', fontSize: '0.75rem' }}>
                          <th style={{ padding: '4px 10px', textAlign: 'left', fontWeight: 500 }}>Заказ</th>
                          <th style={{ padding: '4px 10px', textAlign: 'left', fontWeight: 500 }}>Товар</th>
                          <th style={{ padding: '4px 10px', textAlign: 'right', fontWeight: 500 }}>Факт</th>
                        </tr>
                      </thead>
                      <tbody>
                        {factDetails.map((fd, i) => (
                          <tr key={i} style={{ borderTop: '1px solid #bbf7d0' }}>
                            <td style={{ padding: '4px 10px', fontWeight: 600 }}>{fd.orderNumber}</td>
                            <td style={{ padding: '4px 10px', color: 'var(--text-muted)' }}>{fd.productCode}</td>
                            <td style={{ padding: '4px 10px', textAlign: 'right', color: 'var(--success)', fontWeight: 600 }}>{fd.fact}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </td>
                </tr>
              )}
              <tr>
                <td>Пропущено (К обеспечению = 0)</td>
                <td colSpan={2} style={{ color: 'var(--text-muted)' }}>{summary.skipped}</td>
              </tr>
            </tbody>
          </table>

          <p style={{ marginTop: 14, fontSize: '0.8rem', color: 'var(--text-secondary)' }}>
            Перейдите в <strong>Аналитику</strong> и нажмите «Перепланировать очередь», чтобы пересчитать план.
          </p>
        </div>
      )}
    </>
  )
}
