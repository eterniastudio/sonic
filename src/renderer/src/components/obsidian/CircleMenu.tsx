import { AnimatePresence, motion } from 'motion/react'
import { useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import { Plus } from 'lucide-react'
import { createPortal } from 'react-dom'
import { useReducedMotion } from '@/lib/theme'
import { overlayRoot, useOverlay } from '../motion/overlay'
import { toast } from '../ui/Toaster'
import { cn } from '@/lib/cn'

/**
 * Ported from ObsidianUI's *Circle Menu*.
 *
 * A radial action menu that fans out from its trigger with a spring, then
 * collapses back into it. Used where a cluster of related actions would
 * otherwise crowd a toolbar — the trigger stays visible, so nothing becomes
 * hidden behind a hover.
 */

export interface CircleMenuItem {
  id: string
  label: string
  icon: ReactNode
  onSelect: () => void | Promise<unknown>
  tone?: 'default' | 'danger'
  disabled?: boolean
}

export interface CircleMenuProps {
  items: CircleMenuItem[]
  /** Accessible name for the trigger. */
  label: string
  /** Distance from the trigger to the item ring, in pixels. */
  radius?: number
  /** Total arc the items spread across, in degrees. */
  arc?: number
  /** Which way the fan opens. */
  direction?: 'up' | 'left' | 'right'
  className?: string
  itemClassName?: string
}

export function CircleMenu({
  items,
  label,
  radius = 76,
  arc = 150,
  direction = 'up',
  className,
  itemClassName
}: CircleMenuProps): ReactNode {
  const [open, setOpen] = useState(false)
  const rootRef = useRef<HTMLDivElement | null>(null)

  radius = Math.max(radius, 100)
  const reduced = useReducedMotion()
  const panelRef = useRef<HTMLDivElement | null>(null)
  const [anchor, setAnchor] = useState({ x: 0, y: 0 })
  const close = (): void => { setOpen(false); rootRef.current?.querySelector('button')?.focus() }
  useOverlay([panelRef, rootRef], close, open)
  useLayoutEffect(() => {
    if (!open) return
    const place = (): void => {
      const r = rootRef.current?.getBoundingClientRect()
      if (r) setAnchor({ x: Math.max(radius + 85, Math.min(r.x + r.width / 2, window.innerWidth - radius - 85)), y: Math.max(radius + 60, Math.min(r.y + r.height / 2, window.innerHeight - radius - 60)) })
    }
    place()
    window.addEventListener('resize', place); document.addEventListener('scroll', place, true)
    return () => { window.removeEventListener('resize', place); document.removeEventListener('scroll', place, true) }
  }, [open, radius])
  const centre = direction === 'up' ? 90 : direction === 'left' ? 180 : 0

  /** Screen-space offset for item `index`, fanning around `centre`. */
  const offsetFor = (index: number): { x: number; y: number } => {
    const count = items.length
    const angle =
      count === 1
        ? centre
        : centre + arc / 2 - (index * arc) / (count - 1)

    const radians = (angle * Math.PI) / 180
    return {
      x: Math.cos(radians) * radius,
      // Screen Y grows downward, so negate to fan "up" for a 90° centre.
      y: -Math.sin(radians) * radius
    }
  }

  return (
    <div ref={rootRef} onClick={event => event.stopPropagation()} className={cn('relative inline-flex', className)}>
      <button
        type="button"
        aria-label={label}
        aria-expanded={open}
        aria-haspopup="menu"
        title={label}
        onKeyDown={event => {
          if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
            event.preventDefault(); setOpen(true)
            requestAnimationFrame(() => panelRef.current?.querySelector<HTMLButtonElement>('button:not(:disabled)')?.focus())
          }
        }}
        onClick={() => setOpen((value) => !value)}
        className={cn(
          'relative z-10 grid size-8 place-items-center rounded-full border transition-colors',
          'duration-[var(--duration-quick)] ease-[var(--ease-smooth-out)]',
          open
            ? 'border-transparent bg-accent text-accent-fg'
            : 'border-line bg-surface-2 text-fg-muted hover:border-line-strong hover:text-fg'
        )}
      >
        <motion.span
          animate={{ rotate: open ? 45 : 0 }}
          transition={reduced ? { duration: 0 } : { type: 'spring', stiffness: 420, damping: 26 }}
          className="grid place-items-center"
        >
          <Plus className="size-4" />
        </motion.span>
      </button>

      {createPortal(<div ref={panelRef} role="menu" aria-label={label} inert={!open} aria-hidden={!open}
        style={{ position: 'fixed', left: anchor.x, top: anchor.y, zIndex: 410, pointerEvents: open ? 'auto' : 'none' }}
        onClick={event => event.stopPropagation()}
        onKeyDown={event => {
          if (!['ArrowDown', 'ArrowUp', 'ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return
          event.preventDefault()
          const nodes = [...(panelRef.current?.querySelectorAll<HTMLButtonElement>('button:not(:disabled)') ?? [])]
          const i = nodes.indexOf(document.activeElement as HTMLButtonElement)
          const n = event.key === 'Home' ? 0 : event.key === 'End' ? nodes.length - 1 : (i + (['ArrowDown', 'ArrowRight'].includes(event.key) ? 1 : -1) + nodes.length) % nodes.length
          nodes[n]?.focus()
        }}><AnimatePresence>
        {open
          ? items.map((item, index) => {
              const { x, y } = offsetFor(index)
              return (
                <motion.button
                  key={item.id}
                  type="button"
                  role="menuitem"
                  title={item.label}
                  aria-label={item.label}
                  disabled={item.disabled}
                  initial={{ opacity: 0, scale: 0.4, x: 0, y: 0 }}
                  animate={{ opacity: 1, scale: 1, x, y }}
                  exit={{ opacity: 0, scale: 0.4, x: 0, y: 0 }}
                  transition={reduced ? { duration: 0 } : {
                    type: 'spring',
                    stiffness: 460,
                    damping: 24,
                    // Stagger outward from the trigger.
                    delay: index * 0.03
                  }}
                  onClick={() => {
                    close()
                    Promise.resolve().then(item.onSelect).then(result => { if (result === false) throw new Error('The file could not be opened. It may have moved or have no associated application.') }).catch(error => toast({ kind: 'error', title: `${item.label} failed`, description: String(error) }))
                  }}
                  whileHover={reduced ? undefined : { scale: 1.08 }}
                  className={cn(
                    'absolute left-1/2 top-1/2 -ml-4 -mt-4 grid size-8 place-items-center rounded-full',
                    'border border-line bg-surface text-fg shadow-panel',
                    'transition-colors duration-[var(--duration-quick)]',
                    'disabled:pointer-events-none disabled:opacity-40',
                    item.tone === 'danger'
                      ? 'hover:border-danger/50 hover:text-danger'
                      : 'hover:border-[var(--sonic-accent-line)] hover:text-accent',
                    itemClassName
                  )}
                >
                  <span className="pointer-events-none absolute top-full mt-1 w-20 rounded bg-surface px-1 text-center text-[12px] text-fg">{item.label}</span>
                  <span className="grid place-items-center [&>svg]:size-3.5">{item.icon}</span>
                </motion.button>
              )
            })
          : null}
      </AnimatePresence></div>, overlayRoot())}
    </div>
  )
}
