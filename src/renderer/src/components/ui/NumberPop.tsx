import { useEffect, useRef, type ReactNode } from 'react'
import { cn } from '@/lib/cn'

export interface NumberPopProps {
  value: number | string
  className?: string
  /** Digits after the decimal point are rendered without stagger. */
  suffix?: string
}

/**
 * Digit pop-in built on the transitions.dev number-pop-in snippet.
 *
 * The class is removed, a reflow is forced, then it is re-added — that reflow is
 * what guarantees the animation replays on every change instead of only the
 * first one.
 */
export function NumberPop({ value, className, suffix }: NumberPopProps): ReactNode {
  const groupRef = useRef<HTMLSpanElement | null>(null)
  const text = String(value)
  const digits = text.split('')

  useEffect(() => {
    const group = groupRef.current
    if (!group) return
    group.classList.remove('is-animating')
    void group.offsetWidth
    group.classList.add('is-animating')
  }, [text])

  return (
    <span ref={groupRef} className={cn('t-digit-group nums', className)}>
      {digits.map((digit, index) => (
        <span
          key={`${index}-${digit}`}
          className="t-digit"
          // The snippet only defines stagger slots 0-2; larger indices share slot 2.
          data-stagger={Math.min(index % 3, 2)}
        >
          {digit}
        </span>
      ))}
      {suffix ? <span className="t-digit">{suffix}</span> : null}
    </span>
  )
}
