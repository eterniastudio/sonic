import { useCallback, useEffect, useLayoutEffect, useRef, type ReactNode } from 'react'
import { cn } from '@/lib/cn'

export interface SegmentedOption<T extends string> {
  value: T
  label: string
  icon?: ReactNode
  /** Small count or badge shown after the label. */
  suffix?: ReactNode
}

export interface SegmentedProps<T extends string> {
  value: T
  onChange: (next: T) => void
  options: SegmentedOption<T>[]
  size?: 'sm' | 'md'
  className?: string
  /** Stretch tabs to fill the container. */
  fluid?: boolean
  ariaLabel?: string
}

/**
 * Segmented control built on the transitions.dev tabs-sliding snippet.
 *
 * The pill's width and transform are written by JavaScript because the snippet
 * tweens between measured positions. On first paint and on resize the values
 * are written with transitions disabled, otherwise the pill would animate in
 * from `translateX(0)` / `width: 0`.
 */
export function Segmented<T extends string>({
  value,
  onChange,
  options,
  size = 'md',
  className,
  fluid,
  ariaLabel
}: SegmentedProps<T>): ReactNode {
  const barRef = useRef<HTMLDivElement | null>(null)
  const pillRef = useRef<HTMLSpanElement | null>(null)

  const positionPill = useCallback((animate: boolean) => {
    const bar = barRef.current
    const pill = pillRef.current
    if (!bar || !pill) return

    const active = bar.querySelector<HTMLElement>('[aria-selected="true"]')
    if (!active) return

    const barRect = bar.getBoundingClientRect()
    const activeRect = active.getBoundingClientRect()

    if (!animate) pill.style.transition = 'none'
    pill.style.width = `${activeRect.width}px`
    pill.style.transform = `translateX(${activeRect.left - barRect.left}px)`

    if (!animate) {
      // Force a reflow so the un-transitioned values are committed before the
      // transition is restored for the next change.
      void pill.offsetWidth
      pill.style.transition = ''
    }
  }, [])

  useLayoutEffect(() => {
    positionPill(false)
  }, [value, options, positionPill])

  useEffect(() => {
    const onResize = (): void => positionPill(false)
    window.addEventListener('resize', onResize)
    const observer = new ResizeObserver(onResize)
    if (barRef.current) observer.observe(barRef.current)
    return () => {
      window.removeEventListener('resize', onResize)
      observer.disconnect()
    }
  }, [positionPill])

  return (
    <div
      ref={barRef}
      role="tablist"
      aria-label={ariaLabel}
      className={cn('t-tabs', size === 'sm' && 't-tabs-sm', fluid && 'flex w-full', className)}
    >
      <span ref={pillRef} className="t-tabs-pill" aria-hidden />
      {options.map((option) => (
        <button
          key={option.value}
          type="button"
          role="tab"
          aria-label={option.label || option.value}
          aria-selected={option.value === value}
          onClick={() => onChange(option.value)}
          className={cn(
            't-tab inline-flex items-center justify-center gap-1.5 font-medium',
            size === 'sm' ? 'text-[12px]' : 'text-[13.5px]',
            fluid && 'flex-1'
          )}
        >
          {option.icon ? <span className="[&>svg]:size-3.5">{option.icon}</span> : null}
          <span>{option.label}</span>
          {option.suffix ? <span className="text-[12px] opacity-70 nums">{option.suffix}</span> : null}
        </button>
      ))}
    </div>
  )
}
