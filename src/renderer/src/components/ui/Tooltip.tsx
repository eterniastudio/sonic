import { useEffect, useId, useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { overlayRoot } from '../motion/overlay'
import { cn } from '@/lib/cn'
import { readMs } from '../motion/usePresence'

export interface TooltipProps {
  label: string
  children: ReactNode
  side?: 'top' | 'bottom'
  className?: string
  /** Extra classes for the bubble, e.g. to widen long text. */
  bubbleClassName?: string
}

/** Noninteractive tooltip positioned outside clipped artwork and scrolling rows. */
export function Tooltip({
  label,
  children,
  side = 'top',
  className,
  bubbleClassName
}: TooltipProps): ReactNode {
  const id = useId()
  const ref = useRef<HTMLSpanElement | null>(null)
  const bubble = useRef<HTMLSpanElement | null>(null)
  const [open, setOpen] = useState(false)
  const [point, setPoint] = useState({ x: 0, y: 0 })
  useLayoutEffect(() => {
    if (!open) return
    const position = (): void => {
      const r = ref.current?.getBoundingClientRect(), tip = bubble.current
      if (!r || !tip) return
      const width = tip.offsetWidth, height = tip.offsetHeight
      const above = side === 'top' && r.top > height + 12 || r.bottom + height + 12 > innerHeight
      setPoint({ x: Math.max(6, Math.min(r.x + (r.width - width) / 2, innerWidth - width - 6)), y: above ? Math.max(6, r.top - height - 8) : r.bottom + 8 })
    }
    position()
    const button = ref.current?.querySelector('button')
    button?.setAttribute('aria-describedby', id)
    window.addEventListener('resize', position); document.addEventListener('scroll', position, true)
    return () => { button?.removeAttribute('aria-describedby'); window.removeEventListener('resize', position); document.removeEventListener('scroll', position, true) }
  }, [open, side, id])
  return <span ref={ref} className={cn('inline-flex', className)} onPointerEnter={() => setOpen(true)} onPointerLeave={() => setOpen(false)} onFocus={() => setOpen(true)} onBlur={() => setOpen(false)} onPointerDown={() => setOpen(false)}>
    {children}
    {open ? createPortal(<span ref={bubble} id={id} role="tooltip" className={cn('pointer-events-none fixed z-[900] max-w-64 rounded-md border border-line bg-surface px-2 py-1 text-[12px] font-medium text-fg shadow-pop', bubbleClassName)} style={{ left: point.x, top: point.y }}>{label}</span>, overlayRoot()) : null}
  </span>
}

export interface IconSwapProps {
  /** `true` shows the second icon. */
  swapped: boolean
  first: ReactNode
  second: ReactNode
  className?: string
}

/** Cross-fades two icons in a single slot with blur and scale. */
export function IconSwap({ swapped, first, second, className }: IconSwapProps): ReactNode {
  return (
    <span
      className={cn('t-icon-swap [&>span>svg]:size-full', className)}
      data-state={swapped ? 'b' : 'a'}
    >
      <span className="t-icon grid place-items-center" data-icon="a">
        {first}
      </span>
      <span className="t-icon grid place-items-center" data-icon="b">
        {second}
      </span>
    </span>
  )
}

export interface TextSwapProps {
  /** Changing this value replays the swap. */
  value: string
  className?: string
}

/**
 * Swaps inline text with a blurred up-and-down transition.
 *
 * The snippet has three states — resting, `is-exit` and `is-enter-start` — so
 * the swap is a real sequence: exit the old text, swap the content in the DOM,
 * snap to the enter-start position with transitions off, force a reflow, then
 * release. Replacing the node with a React `key` instead would simply remount
 * it at rest and animate nothing.
 */
export function TextSwap({ value, className }: TextSwapProps): ReactNode {
  const ref = useRef<HTMLSpanElement | null>(null)
  const [display, setDisplay] = useState(value)
  const current = useRef(value)

  useEffect(() => {
    if (current.current === value) return
    current.current = value

    const element = ref.current
    if (!element) {
      setDisplay(value)
      return
    }

    const duration = readMs(element, '--text-swap-dur', 150)
    element.classList.add('is-exit')

    const timer = window.setTimeout(() => {
      setDisplay(value)
      element.classList.remove('is-exit')
      element.classList.add('is-enter-start')
      // Commit the start state before releasing it, or the enter is skipped.
      void element.offsetWidth
      element.classList.remove('is-enter-start')
    }, duration)

    return () => window.clearTimeout(timer)
  }, [value])

  return (
    <span ref={ref} className={cn('t-text-swap', className)}>
      {display}
    </span>
  )
}
