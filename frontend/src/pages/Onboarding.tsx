import { useState, useEffect, type ReactNode } from 'react'
import { Factory } from '@phosphor-icons/react/dist/csr/Factory'
import { Package } from '@phosphor-icons/react/dist/csr/Package'
import { UsersThree } from '@phosphor-icons/react/dist/csr/UsersThree'
import { ClipboardText } from '@phosphor-icons/react/dist/csr/ClipboardText'
import { Lightning } from '@phosphor-icons/react/dist/csr/Lightning'
import { SlidersHorizontal } from '@phosphor-icons/react/dist/csr/SlidersHorizontal'
import { useNavigate } from 'react-router-dom'

function getWorkingDays(n: number): Date[] {
  const result: Date[] = []
  const d = new Date()
  d.setDate(d.getDate() + 1)
  while (result.length < n) {
    if (d.getDay() !== 0 && d.getDay() !== 6) result.push(new Date(d))
    d.setDate(d.getDate() + 1)
  }
  return result
}

function fmtShort(d: Date) {
  return d.toLocaleDateString('ru-RU', { weekday: 'short', day: '2-digit', month: '2-digit' })
}

function fmtDate(d: Date) {
  return d.toLocaleDateString('ru-RU', { day: 'numeric', month: 'long' })
}

const DAYS = getWorkingDays(5)
const DUE1 = fmtDate(new Date(Date.now() + 10 * 86400000))
const DUE2 = fmtDate(new Date(Date.now() + 17 * 86400000))

// qty[i] = planned quantity on DAYS[i]; -1 = skip
const DEMO_ROWS = [
  { order: 'ЗК-001', client: 'ООО «Ромашка»', product: 'FLORA-01', qty: [150, 150, 150, 0, 0] },
  { order: 'ЗК-002', client: 'ООО «Орион»',   product: 'FLORA-02', qty: [0, 0, 0, 150, 150] },
]

const PROGRESS_LABELS = ['Структура', 'Категория', 'Бригада', 'Заказы', 'План']

const STEP_CTA = [
  { btn: 'Добавить категорию →', hint: 'Категория — тип продукции с дневной мощностью. Например: «СВЕТИЛЬНИКИ FLORA · 150 шт/день».' },
  { btn: 'Добавить бригаду →',  hint: 'Бригада выполняет заказы по этой категории.' },
  { btn: 'Добавить заказы →',   hint: 'Внесите заказы клиентов — что нужно произвести и в каком количестве.' },
  { btn: 'Построить план →',    hint: 'Система распределит заказы по дням, исходя из мощности бригады.' },
]

interface BlockProps {
  icon: ReactNode
  text: string
  sub?: string
  level: number
  fresh?: boolean
}

function Block({ icon, text, sub, level, fresh }: BlockProps) {
  return (
    <div style={{
      marginLeft: level * 24,
      display: 'flex',
      alignItems: 'flex-start',
      gap: 10,
      padding: '9px 14px',
      borderRadius: 8,
      background: fresh ? 'var(--primary-light)' : 'var(--bg)',
      border: `1px solid ${fresh ? 'var(--border-strong)' : 'var(--border)'}`,
      animation: 'fadeSlideIn 0.35s ease',
    }}>
      <span style={{ display: 'flex', alignItems: 'center', height: 22, flexShrink: 0, color: 'var(--text-secondary)' }}>{icon}</span>
      <div>
        <div style={{ fontWeight: 600, fontSize: 14, color: fresh ? 'var(--primary)' : 'var(--text)' }}>{text}</div>
        {sub && <div style={{ fontSize: 12, color: 'var(--text-secondary)', marginTop: 2 }}>{sub}</div>}
      </div>
    </div>
  )
}

export default function Onboarding() {
  const navigate = useNavigate()
  const [step, setStep] = useState(0)
  const [showChoice, setShowChoice] = useState(false)
  const [seeding, setSeeding] = useState(false)
  const [gridVisible, setGridVisible] = useState(false)

  useEffect(() => {
    if (localStorage.getItem('onboarding_done')) { navigate('/', { replace: true }); return }
    fetch('/api/workshops')
      .then(r => r.json())
      .then((data: unknown) => {
        if (Array.isArray(data) && data.length > 0) navigate('/', { replace: true })
      })
      .catch(() => {})
  }, [])

  useEffect(() => {
    if (step === 5) {
      const t = setTimeout(() => setGridVisible(true), 400)
      return () => clearTimeout(t)
    }
  }, [step])

  async function handleQuickStart() {
    setSeeding(true)
    try {
      await fetch('/api/onboarding/seed', { method: 'POST' })
      localStorage.setItem('onboarding_done', '1')
      navigate('/planning')
    } catch {
      setSeeding(false)
    }
  }

  function handleManual() {
    localStorage.setItem('onboarding_done', '1')
    navigate('/workshops')
  }

  // ── Hero ───────────────────────────────────────────────────────────────────
  if (step === 0) {
    return (
      <div style={{
        minHeight: '100vh',
        display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center',
        background: 'var(--bg)',
        padding: 24,
      }}>
        <div style={{ color: 'var(--text-secondary)', fontSize: 14, letterSpacing: '-.02em', fontWeight: 600, marginBottom: 20 }}>
          Factory Planner
        </div>
        <h1 style={{
          color: 'var(--text)', fontWeight: 600, textAlign: 'center',
          fontSize: 'clamp(26px, 4vw, 40px)', letterSpacing: '-.035em', margin: '0 0 16px', lineHeight: 1.2,
        }}>
          Планируйте производство<br />без Excel и совещаний
        </h1>
        <p style={{ color: 'var(--text-secondary)', fontSize: 16, textAlign: 'center', maxWidth: 420, margin: '0 0 40px', lineHeight: 1.7 }}>
          Посмотрите, как это работает — займёт меньше минуты
        </p>
        <button
          className="btn"
          style={{ fontSize: 14, padding: '11px 28px', borderRadius: 6, background: 'var(--primary)' }}
          onClick={() => setStep(1)}
        >
          Запланировать →
        </button>
        <button
          onClick={() => { localStorage.setItem('onboarding_done', '1'); navigate('/') }}
          style={{ marginTop: 20, background: 'none', border: 'none', color: 'var(--text-secondary)', cursor: 'pointer', fontSize: 13 }}
        >
          У меня уже есть данные
        </button>
      </div>
    )
  }

  // ── Demo steps ─────────────────────────────────────────────────────────────
  const progressIdx = step - 1

  return (
    <div style={{ minHeight: '100vh', background: 'var(--bg)', padding: '32px 16px' }}>
      <div style={{ maxWidth: 660, margin: '0 auto' }}>

        {/* Progress bar */}
        <div style={{ display: 'flex', alignItems: 'flex-start', marginBottom: 36 }}>
          {PROGRESS_LABELS.map((label, i) => (
            <div key={i} style={{ flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', position: 'relative' }}>
              {i > 0 && (
                <div style={{
                  position: 'absolute', top: 13, right: '50%', left: '-50%',
                  height: 2,
                  background: i <= progressIdx ? 'var(--primary)' : 'var(--border)',
                  transition: 'background 0.4s',
                }} />
              )}
              <div style={{
                width: 28, height: 28, borderRadius: '50%', zIndex: 1,
                background: i <= progressIdx ? 'var(--primary)' : 'var(--border)',
                color: i <= progressIdx ? '#fff' : 'var(--text-secondary)',
                display: 'flex', alignItems: 'center', justifyContent: 'center',
                fontSize: 12, fontWeight: 700,
                transition: 'background 0.4s',
              }}>
                {i < progressIdx ? '✓' : i + 1}
              </div>
              <div style={{ fontSize: 11, marginTop: 5, color: i <= progressIdx ? 'var(--primary)' : 'var(--text-secondary)', fontWeight: i === progressIdx ? 600 : 400 }}>
                {label}
              </div>
            </div>
          ))}
        </div>

        {/* Building blocks */}
        <div className="card" style={{ padding: '16px 20px', marginBottom: 16, display: 'flex', flexDirection: 'column', gap: 8 }}>
          <Block icon={<Factory size={18} aria-hidden="true" />} text="Цех сборки" level={0} fresh={step === 1} />
          {step >= 2 && (
            <Block icon={<Package size={18} aria-hidden="true" />} text="СВЕТИЛЬНИКИ FLORA" sub="мощность: 150 шт / день" level={1} fresh={step === 2} />
          )}
          {step >= 3 && (
            <Block icon={<UsersThree size={18} aria-hidden="true" />} text="Бригада № 1" sub="выполняет: СВЕТИЛЬНИКИ FLORA" level={2} fresh={step === 3} />
          )}
          {step >= 4 && (
            <>
              <Block icon={<ClipboardText size={18} aria-hidden="true" />} text="ЗК-001 · ООО «Ромашка»" sub={`450 шт · срок ${DUE1}`} level={2} fresh={step === 4} />
              <Block icon={<ClipboardText size={18} aria-hidden="true" />} text="ЗК-002 · ООО «Орион»"   sub={`300 шт · срок ${DUE2}`} level={2} fresh={step === 4} />
            </>
          )}
        </div>

        {/* Step CTA */}
        {step <= 4 && (
          <div className="card" style={{ padding: '20px 24px', textAlign: 'center' }}>
            <p style={{ color: 'var(--text-secondary)', margin: '0 0 16px', fontSize: 14, lineHeight: 1.6 }}>
              {STEP_CTA[step - 1].hint}
            </p>
            <button className="btn" style={{ fontSize: 15, padding: '10px 28px' }} onClick={() => setStep(s => s + 1)}>
              {STEP_CTA[step - 1].btn}
            </button>
          </div>
        )}

        {/* Planning grid */}
        {step === 5 && (
          <>
            <div className="card" style={{ overflow: 'hidden', marginBottom: 20 }}>
              <div style={{
                padding: '12px 16px', fontWeight: 700, fontSize: 14,
                borderBottom: '1px solid var(--border)',
                display: 'flex', alignItems: 'center', gap: 10,
              }}>
                <span>Производственный план</span>
                <span style={{ fontWeight: 400, color: 'var(--text-secondary)', fontSize: 13 }}>Бригада № 1 · 150 шт/день</span>
              </div>
              <div style={{ overflowX: 'auto' }}>
                <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
                  <thead>
                    <tr style={{ background: 'var(--bg)' }}>
                      <th style={{ padding: '8px 14px', textAlign: 'left', color: 'var(--text-secondary)', fontWeight: 500, minWidth: 110 }}>Заказ</th>
                      <th style={{ padding: '8px 10px', textAlign: 'left', color: 'var(--text-secondary)', fontWeight: 500, minWidth: 110 }}>Клиент</th>
                      {DAYS.map(d => (
                        <th key={d.toISOString()} style={{
                          padding: '8px 6px', textAlign: 'center', color: 'var(--text-secondary)',
                          fontWeight: 600, minWidth: 72, fontSize: 12,
                        }}>
                          {fmtShort(d)}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {DEMO_ROWS.map((row, ri) => (
                      <tr key={row.order} style={{ borderBottom: '1px solid var(--bg)', background: ri % 2 === 0 ? '#fff' : 'var(--bg)' }}>
                        <td style={{ padding: '8px 14px', fontWeight: 700 }}>{row.order}</td>
                        <td style={{ padding: '8px 10px', color: 'var(--text-secondary)', fontSize: 12 }}>{row.client}</td>
                        {row.qty.map((q, ci) => (
                          <td key={ci} style={{ padding: '6px 4px', textAlign: 'center' }}>
                            {q > 0 && gridVisible && (
                              <div style={{
                                background: 'var(--success-light)', color: 'var(--success)',
                                borderRadius: 6, padding: '5px 0',
                                fontWeight: 700, fontSize: 14,
                                animation: `fadeSlideIn 0.3s ease ${(ri * 5 + ci) * 70}ms both`,
                              }}>
                                {q}
                              </div>
                            )}
                          </td>
                        ))}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>

            <div style={{ textAlign: 'center', marginBottom: 32 }}>
              <p style={{ color: 'var(--text-secondary)', fontSize: 14, marginBottom: 18 }}>
                Система распределила 750 шт по 5 дням с учётом мощности бригады
              </p>
              <button
                className="btn"
                style={{ fontSize: 16, padding: '12px 36px' }}
                onClick={() => setShowChoice(true)}
              >
                Попробуем на ваших данных →
              </button>
            </div>
          </>
        )}
      </div>

      {/* Choice modal */}
      {showChoice && (
        <div style={{
          position: 'fixed', inset: 0, background: 'rgba(30,40,35,0.45)',
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          padding: 16, zIndex: 1000,
        }}>
          <div className="card" style={{ maxWidth: 540, width: '100%', padding: '32px 28px' }}>
            <h2 style={{ margin: '0 0 8px', fontSize: 21 }}>Как хотите начать?</h2>
            <p style={{ color: 'var(--text-secondary)', margin: '0 0 24px', fontSize: 14, lineHeight: 1.6 }}>
              Потом можно подключить 1С — тогда данные будут загружаться автоматически.
            </p>

            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 14 }}>
              <button
                onClick={handleQuickStart}
                disabled={seeding}
                style={{
                  padding: '20px 16px', textAlign: 'left', cursor: 'pointer',
                  border: '1px solid var(--primary)', borderRadius: 8, background: 'var(--primary-light)',
                  display: 'flex', flexDirection: 'column', gap: 8,
                }}
              >
                <Lightning size={24} aria-hidden="true" style={{ color: 'var(--primary)' }} />
                <span style={{ fontWeight: 700, color: 'var(--primary)', fontSize: 15 }}>Быстрый старт</span>
                <span style={{ fontSize: 13, color: 'var(--text-secondary)', lineHeight: 1.5 }}>
                  Создадим демо-данные из примера выше — сразу увидите систему в действии
                </span>
                {seeding && <span style={{ color: 'var(--primary)', fontSize: 12 }}>Создаём данные…</span>}
              </button>

              <button
                onClick={handleManual}
                style={{
                  padding: '20px 16px', textAlign: 'left', cursor: 'pointer',
                  border: '1px solid var(--border)', borderRadius: 8, background: '#fff',
                  display: 'flex', flexDirection: 'column', gap: 8,
                }}
              >
                <SlidersHorizontal size={24} aria-hidden="true" style={{ color: 'var(--text-secondary)' }} />
                <span style={{ fontWeight: 700, fontSize: 15 }}>Настроить самому</span>
                <span style={{ fontSize: 13, color: 'var(--text-secondary)', lineHeight: 1.5 }}>
                  Введите свои цеха, категории и бригады вручную
                </span>
              </button>
            </div>

            <button
              onClick={() => setShowChoice(false)}
              style={{ display: 'block', margin: '20px auto 0', background: 'none', border: 'none', color: 'var(--text-secondary)', cursor: 'pointer', fontSize: 13 }}
            >
              ← Вернуться к демо
            </button>
          </div>
        </div>
      )}
    </div>
  )
}
