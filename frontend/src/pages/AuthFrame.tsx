import type { ReactNode } from 'react'
import './auth.css'

/** Shared presentation only; authentication stays in the page components. */
export default function AuthFrame({ children }: { children: ReactNode }) {
  return (
    <div className="auth-page">
      <aside className="auth-intro">
        <div className="auth-wordmark">Factory Planner<span>Планирование производства</span></div>
        <div className="auth-intro-body">
          <p className="auth-eyebrow">Рабочее пространство производства</p>
          <h2>План на день.<br />Общая картина.</h2>
          <p className="auth-intro-description">Заказы, загрузка бригад и производственный график — в одном месте.</p>
          <div className="auth-schedule-art" aria-hidden="true">
            <div className="auth-schedule-axis"><span>ПН</span><span>ВТ</span><span>СР</span><span>ЧТ</span><span>ПТ</span></div>
            <div className="auth-schedule-track"><i /><i /><i /><i /><i /><b className="auth-schedule-bar auth-schedule-bar-one" /></div>
            <div className="auth-schedule-track"><i /><i /><i /><i /><i /><b className="auth-schedule-bar auth-schedule-bar-two" /></div>
            <div className="auth-schedule-track"><i /><i /><i /><i /><i /><b className="auth-schedule-bar auth-schedule-bar-three" /></div>
            <div className="auth-schedule-track"><i /><i /><i /><i /><i /><b className="auth-schedule-bar auth-schedule-bar-four" /></div>
          </div>
        </div>
        <div className="auth-intro-footer">От заказа к производственному плану</div>
      </aside>
      <main className="auth-main">
        <div className="auth-mobile-wordmark">Factory Planner</div>
        <div className="auth-panel">{children}</div>
      </main>
    </div>
  )
}
