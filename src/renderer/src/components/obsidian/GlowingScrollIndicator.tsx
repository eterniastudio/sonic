import { useEffect, useState, type ReactNode, type RefObject } from 'react'
import { cn } from '@/lib/cn'

/**
 * Ported from ObsidianUI's *Glowing Scroll Indicator*.
 *
 * A slim progress rail pinned to the right edge of a scroll container. It
 * appears only when there is something to scroll, so short lists stay clean.
 */
export function GlowingScrollIndicator({
  scrollRef,
  className
}: {
  scrollRef: RefObject<HTMLElement | null>
  className?: string
}): ReactNode {
  const [progress, setProgress] = useState(0)
  const [ratio, setRatio] = useState(1)
  const [needed, setNeeded] = useState(false)

  useEffect(() => {
    const element = scrollRef.current
    if (!element) return

    const update = (): void => {
      const max = element.scrollHeight - element.clientHeight
      setNeeded(max > 32)
      setProgress(max > 0 ? Math.min(1, Math.max(0, element.scrollTop / max)) : 0)
      setRatio(max > 0 ? element.clientHeight / element.scrollHeight : 1)
    }

    update()
    element.addEventListener('scroll', update, { passive: true })
    const observer = new ResizeObserver(update)
    observer.observe(element)
    for (const child of Array.from(element.children)) observer.observe(child)

    return () => {
      element.removeEventListener('scroll', update)
      observer.disconnect()
    }
  }, [scrollRef])

  if (!needed) return null

  const thumbPercent = Math.max(8, Math.min(100, ratio * 100))

  return (
    <div
      aria-hidden
      className={cn('pointer-events-none absolute inset-y-2 right-0.5 w-1', className)}
    >
      <div className="absolute inset-0 rounded-full bg-line/70" />
      <div
        className="absolute inset-x-0 rounded-full bg-accent transition-[top] duration-150 ease-[var(--ease-smooth-out)]"
        style={{
          height: `${thumbPercent}%`,
          top: `${progress * (100 - thumbPercent)}%`,
          boxShadow: '0 0 10px var(--sonic-accent-ring)'
        }}
      />
    </div>
  )
}
