import { motion } from 'motion/react'
import { useCallback, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import { useReducedMotion } from '@/lib/theme'
import { cn } from '@/lib/cn'

/**
 * Ported from ObsidianUI's *Magnet Tabs*.
 *
 * Tab navigation whose indicator stretches toward whichever tab the pointer is
 * near, rather than jumping between fixed positions. The tabs themselves nudge
 * slightly in the pointer's direction, so the row feels physically connected to
 * the cursor.
 *
 * The indicator is measured from the DOM rather than computed from index maths,
 * so it stays correct with variable-width labels, icons and font scaling.
 */

export interface MagnetTab {
  value: string
  label: string
  icon?: ReactNode
}

export interface MagnetTabsProps {
  value: string
  onChange: (next: string) => void
  tabs: MagnetTab[]
  ariaLabel?: string
  panelPrefix?: string
  className?: string
  /** Compact, pill-shaped presentation for settings choices. */
  variant?: 'standard' | 'segmented'
  /** Choices use radio semantics; navigation tabs control panels. */
  mode?: 'tabs' | 'choices'
}

interface Rect {
  left: number
  width: number
}

export function MagnetTabs({
  value,
  onChange,
  tabs,
  ariaLabel,
  className,
  panelPrefix = 'settings',
  variant = 'standard',
  mode = 'tabs'
}: MagnetTabsProps): ReactNode {
  const reduced = useReducedMotion()
  const listRef = useRef<HTMLDivElement | null>(null)
  const tabRefs = useRef(new Map<string, HTMLButtonElement>())
  const [active, setActive] = useState<Rect>({ left: 0, width: 0 })
  const [hovered, setHovered] = useState<Rect | null>(null)

  const measure = useCallback((key: string): Rect | null => {
    const list = listRef.current
    const node = tabRefs.current.get(key)
    if (!list || !node) return null
    return { left: node.offsetLeft, width: node.offsetWidth }
  }, [])

  const syncActive = useCallback(() => {
    const rect = measure(value)
    if (rect) setActive(rect)
  }, [measure, value])

  // Measure without transitions on first paint and on resize, so the indicator
  // never animates in from a zero-width position.
  useLayoutEffect(() => {
    syncActive()
  }, [syncActive, tabs])

  useEffect(() => {
    const onResize = (): void => syncActive()
    window.addEventListener('resize', onResize)
    const observer = new ResizeObserver(onResize)
    if (listRef.current) observer.observe(listRef.current)
    tabRefs.current.forEach(node => observer.observe(node))
    document.fonts.addEventListener('loadingdone', onResize)
    return () => {
      window.removeEventListener('resize', onResize)
      observer.disconnect()
      document.fonts.removeEventListener('loadingdone', onResize)
    }
  }, [syncActive])

  // While hovering, the indicator spans from the active tab to the hovered one —
  // that stretch is what reads as "magnetic".
  const indicator = hovered && !reduced
    ? {
        left: Math.min(active.left, hovered.left),
        width:
          Math.abs(active.left + active.width / 2 - (hovered.left + hovered.width / 2)) +
          (active.width + hovered.width) / 2
      }
    : active

  return (
    <div
      ref={listRef}
      role={mode === 'choices' ? 'radiogroup' : 'tablist'}
      aria-label={ariaLabel}
      onPointerLeave={() => setHovered(null)}
      className={cn(
        variant === 'segmented'
          ? 't-tabs'
          : 'relative inline-flex items-center gap-1 rounded-[2px] border border-line bg-surface-2 p-1',
        className
      )}
    >
      <motion.span
        aria-hidden
        className={variant === 'segmented'
          ? 't-tabs-pill !transition-none'
          : 'pointer-events-none absolute top-1 bottom-1 rounded-[2px] bg-surface shadow-panel'}
        animate={{ left: indicator.left, width: indicator.width }}
        transition={reduced ? { duration: 0 } : { type: 'spring', stiffness: 520, damping: 38, mass: 0.7 }}
      />

      {tabs.map((tab) => {
        const selected = tab.value === value
        return (
          <button
            key={tab.value}
            ref={(node) => {
              if (node) tabRefs.current.set(tab.value, node)
              else tabRefs.current.delete(tab.value)
            }}
            type="button"
            role={mode === 'choices' ? 'radio' : 'tab'}
            aria-checked={mode === 'choices' ? selected : undefined}
            aria-selected={mode === 'tabs' ? selected : undefined}
            id={mode === 'tabs' ? `${panelPrefix}-tab-${tab.value}` : undefined}
            aria-controls={mode === 'tabs' ? `${panelPrefix}-panel-${tab.value}` : undefined}
            tabIndex={selected ? 0 : -1}
            onKeyDown={event => {
              if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return
              event.preventDefault()
              const i = tabs.findIndex(entry => entry.value === tab.value)
              const next = event.key === 'Home' ? 0 : event.key === 'End' ? tabs.length - 1 : (i + (event.key === 'ArrowRight' ? 1 : -1) + tabs.length) % tabs.length
              onChange(tabs[next].value); tabRefs.current.get(tabs[next].value)?.focus()
            }}
            onClick={() => onChange(tab.value)}
            onPointerEnter={() => setHovered(measure(tab.value))}
            onFocus={() => setHovered(measure(tab.value))}
            onBlur={() => setHovered(null)}
            className={cn(
              variant === 'segmented'
                ? 't-tab inline-flex items-center justify-center gap-1.5 text-[13.5px] font-medium'
                : 'relative z-10 inline-flex items-center gap-1.5 rounded-[2px] px-3 py-1.5 text-[13.5px] font-medium',
              variant === 'standard' && 'transition-colors duration-[var(--duration-quick)] ease-[var(--ease-smooth-out)]',
              variant === 'standard' && (selected ? 'text-fg' : 'text-fg-muted hover:text-fg')
            )}
          >
            {tab.icon ? (
              <span className={cn('shrink-0 [&>svg]:size-3.5', selected ? 'text-accent' : '')}>
                {tab.icon}
              </span>
            ) : null}
            <span className="whitespace-nowrap">{tab.label}</span>
          </button>
        )
      })}
    </div>
  )
}
