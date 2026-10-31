import { useEffect, useRef } from 'react'

// Форма добавления/изменения стоит над списком: при «Изменить» в конце длинного списка она открывается
// за экраном. Когда key меняется на непустой (открыли форму или выбрали другую строку) — плавно
// прокручиваем к форме и на компьютере ставим курсор в первое поле (на телефоне — нет, чтобы не
// выскакивала клавиатура).
export function useScrollToForm<T extends HTMLElement = HTMLDivElement>(key: string | null | false | undefined) {
  const ref = useRef<T>(null)
  useEffect(() => {
    if (!key || !ref.current) return
    // На следующем кадре: в тот же кадр браузер сам подстраивает прокрутку под появившуюся форму
    // (scroll anchoring удерживает нажатую строку на месте) и сбивает нашу
    const frame = requestAnimationFrame(() => {
      const el = ref.current
      if (!el) return
      el.scrollIntoView({ behavior: 'smooth', block: 'start' })
      if (window.matchMedia('(min-width: 769px)').matches) {
        el.querySelector<HTMLElement>('input:not([disabled]), select:not([disabled]), textarea:not([disabled])')
          ?.focus({ preventScroll: true })
      }
    })
    return () => cancelAnimationFrame(frame)
  }, [key])
  return ref
}
