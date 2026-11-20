import { useId, useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { overlayRoot, useOverlay } from '../motion/overlay'
import { cn } from '@/lib/cn'
import { usePresence } from '../motion/usePresence'

type Align = 'start' | 'center' | 'end'
type Side = 'bottom' | 'top'

/** Maps placement onto the transform-origin tokens the snippet understands. */
function originFor(side: Side, align: Align): string {
  const vertical = side === 'bottom' ? 'top' : 'bottom'
  return `${vertical}-${align === 'start' ? 'left' : align === 'end' ? 'right' : 'center'}`
}

export interface DropdownProps {
  /** Rendered inside the clickable trigger. */
  trigger: (state: { open: boolean; toggle: () => void; id: string }) => ReactNode
  /** Panel body. Receives a `close` callback for menu items. */
  children: ReactNode | ((close: () => void) => ReactNode)
  align?: Align
  side?: Side
  /** Panel width behaviour. */
  width?: 'trigger' | 'auto' | number
  className?: string
  panelClassName?: string
  disabled?: boolean
}

/**
 * Origin-aware dropdown built on the transitions.dev menu-dropdown snippet.
 * Grows from the corner nearest its trigger and eases back into it on close.
 */
export function Dropdown({
  trigger,
  children,
  align = 'start',
  side = 'bottom',
  width = 'auto',
  className,
  panelClassName,
  disabled
}: DropdownProps): ReactNode {
  const [open, setOpen] = useState(false)
  const panelRef = useRef<HTMLDivElement | null>(null)
  const wrapperRef = useRef<HTMLDivElement | null>(null)
  const id = useId()
  const typeahead = useRef({ value: '', at: 0 })

  const phase = usePresence(open, panelRef, {
    openDurationVar: '--dropdown-open-dur',
    closeDurationVar: '--dropdown-close-dur',
    fallbackOpenMs: 250,
    fallbackCloseMs: 150
  })

  // The panel exists only while open or playing its exit, so a closed menu (one
  // per queue row) costs no portal subtree. A freshly mounted panel paints its
  // resting state once before `is-open`, which keeps the entrance transition.
  const mounted = open || phase !== 'closed'
  const [entered, setEntered] = useState(false)
  useLayoutEffect(() => {
    if (!open) { setEntered(false); return }
    void panelRef.current?.getBoundingClientRect()
    setEntered(true)
  }, [open])
  const [position, setPosition] = useState({ left: 0, top: 0, width: 176, maxHeight: 400, side })
  const close = (): void => { setOpen(false); wrapperRef.current?.querySelector<HTMLButtonElement>('button')?.focus() }
  useOverlay([panelRef, wrapperRef], () => setOpen(false), open)
  useLayoutEffect(() => {
    if (!open) return
    const place = (): void => {
      const trigger = wrapperRef.current?.getBoundingClientRect()
      const panel = panelRef.current
      if (!trigger || !panel) return
      const gap = 6, edge = 8
      const w = Math.min(typeof width === 'number' ? width : width === 'trigger' ? trigger.width : Math.max(176, panel.scrollWidth), window.innerWidth - edge * 2)
      const below = window.innerHeight - trigger.bottom - gap - edge
      const above = trigger.top - gap - edge
      const wanted = panel.scrollHeight + 2
      const placedSide = side === 'bottom' ? (below < wanted && above > below ? 'top' : 'bottom') : (above < wanted && below > above ? 'bottom' : 'top')
      const maxHeight = Math.max(40, placedSide === 'bottom' ? below : above)
      const h = Math.min(wanted, maxHeight)
      const x = align === 'start' ? trigger.left : align === 'end' ? trigger.right - w : trigger.left + (trigger.width - w) / 2
      setPosition({ left: Math.max(edge, Math.min(x, window.innerWidth - w - edge)), top: placedSide === 'bottom' ? trigger.bottom + gap : Math.max(edge, trigger.top - gap - h), width: w, maxHeight, side: placedSide })
    }
    place()
    const observer = new ResizeObserver(place)
    if (wrapperRef.current) observer.observe(wrapperRef.current)
    window.addEventListener('resize', place)
    document.addEventListener('scroll', place, true)
    return () => { observer.disconnect(); window.removeEventListener('resize', place); document.removeEventListener('scroll', place, true) }
  }, [open, side, align, width])
  useLayoutEffect(() => {
    const button = wrapperRef.current?.querySelector('button')
    button?.setAttribute('aria-haspopup', 'menu')
    button?.setAttribute('aria-expanded', String(open))
    if (open) button?.setAttribute('aria-controls', `${id}-panel`)
    else button?.removeAttribute('aria-controls')
    if (button) {
      button.disabled = Boolean(disabled)
      if (!button.id) button.id = `${id}-trigger`
      panelRef.current?.setAttribute('aria-labelledby', button.id)
    }
  }, [open, id, disabled])
  const focusItem = (last = false): void => {
    const items = panelRef.current?.querySelectorAll<HTMLButtonElement>('button:not(:disabled)')
    if (items?.length) (last ? items[items.length - 1] : panelRef.current?.querySelector<HTMLButtonElement>('[aria-checked="true"]') ?? items[0]).focus()
  }
  return (
    <div ref={wrapperRef} className={cn('relative inline-flex', className)} onClick={event => event.stopPropagation()}
      onKeyDown={event => {
        if (event.key === 'ArrowDown' || event.key === 'ArrowUp' || (!open && (event.key === 'Enter' || event.key === ' '))) {
          event.preventDefault(); if (disabled) return
          setOpen(true); requestAnimationFrame(() => focusItem(event.key === 'ArrowUp'))
        }
      }}>
      {trigger({ open, toggle: () => !disabled && setOpen(value => !value), id })}
      {mounted ? createPortal(<div ref={panelRef} id={`${id}-panel`} role="menu" data-origin={originFor(position.side, align)}
        inert={!open} aria-hidden={!open}
        onClick={event => event.stopPropagation()}
        onKeyDown={event => {
          event.stopPropagation()
          const items = [...(panelRef.current?.querySelectorAll<HTMLButtonElement>('button:not(:disabled)') ?? [])]
          const index = items.indexOf(document.activeElement as HTMLButtonElement)
          if (['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) {
            event.preventDefault()
            const next = event.key === 'Home' ? 0 : event.key === 'End' ? items.length - 1 : (index + (event.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length
            items[next]?.focus()
          } else if (event.key === 'Tab') close()
          else if (event.key.length === 1 && !event.ctrlKey && !event.metaKey && !event.altKey && event.key !== ' ') {
            event.preventDefault()
            const now = performance.now()
            const value = `${now - typeahead.current.at < 700 ? typeahead.current.value : ''}${event.key.toLocaleLowerCase()}`
            typeahead.current = { value, at: now }
            const prefix = [...value].every(char => char === value[0]) ? value[0] : value
            const ordered = [...items.slice(index + 1), ...items.slice(0, index + 1)]
            ordered.find(item => item.textContent?.trim().toLocaleLowerCase().startsWith(prefix))?.focus()
          }
        }}
        className={cn('t-dropdown fixed z-[410] rounded-[2px] border border-line bg-surface p-1 shadow-pop', open && entered && 'is-open', !open && phase === 'closing' && 'is-closing', panelClassName)}
        style={{ left: position.left, top: position.top, width: position.width, maxHeight: position.maxHeight, overflowY: 'auto', pointerEvents: open ? 'auto' : 'none' }}>
        {typeof children === 'function' ? children(close) : children}
      </div>, overlayRoot()) : null}
    </div>
  )
}

export interface DropdownItemProps {
  children: ReactNode
  onSelect?: () => void | Promise<void>
  icon?: ReactNode
  /** Right-aligned hint, e.g. a shortcut or current value. */
  hint?: ReactNode
  selected?: boolean
  tone?: 'default' | 'danger'
  disabled?: boolean
}

export function DropdownItem({
  children,
  onSelect,
  icon,
  hint,
  selected,
  tone = 'default',
  disabled
}: DropdownItemProps): ReactNode {
  const pending = useRef(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  return (
    <button
      type="button"
      role={selected === undefined ? "menuitem" : "menuitemradio"}
      aria-checked={selected}
      disabled={disabled || busy}
      onClick={() => { if (pending.current) return; pending.current = true; setBusy(true); Promise.resolve().then(onSelect).catch(error => setError(String(error instanceof Error ? error.message : error))).finally(() => { pending.current = false; setBusy(false) }) }}
      className={cn(
        'flex w-full items-center gap-2.5 rounded-[2px] px-2.5 py-2 text-left text-[13.5px]',
        'transition-colors duration-[var(--duration-quick)] ease-[var(--ease-smooth-out)]',
        'disabled:pointer-events-none disabled:opacity-40',
        tone === 'danger' ? 'text-danger hover:bg-danger/12' : 'text-fg hover:bg-surface-2',
        selected && 'bg-accent-soft text-accent'
      )}
    >
      {icon ? <span className="shrink-0 text-fg-subtle [&>svg]:size-3.5">{icon}</span> : null}
      <span className="flex-1">{children}{error ? <span role="alert" className="block text-danger">{error}</span> : null}</span>
      {hint ? <span className="shrink-0 text-[12px] text-fg-subtle nums">{hint}</span> : null}
    </button>
  )
}

export function DropdownLabel({ children }: { children: ReactNode }): ReactNode {
  return (
    <div className="px-2.5 pt-2 pb-1 text-[12px] font-bold text-fg-subtle">
      {children}
    </div>
  )
}

export function DropdownSeparator(): ReactNode {
  return <div className="my-1 h-px bg-line" />
}
