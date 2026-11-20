import { AnimatePresence, motion } from 'motion/react'
import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { CornerDownLeft, Search } from 'lucide-react'
import { createPortal } from 'react-dom'
import { overlayRoot, useOverlay } from '../motion/overlay'
import { useReducedMotion } from '@/lib/theme'
import { cn } from '@/lib/cn'
import { indexCommands, searchCommands } from './spotlightSearch'

/**
 * Ported from ObsidianUI's *Apple Spotlight*.
 *
 * A centred, blurred-glass command palette: rotating through navigation, engine
 * actions and export presets from one keystroke. Keyboard-first — the pointer is
 * optional here.
 */

export interface SpotlightItem {
  id: string
  label: string
  group: string
  hint?: string
  icon?: ReactNode
  /** Extra text folded into the search index. */
  keywords?: string
  disabled?: boolean
  onSelect: () => void
}

export interface AppleSpotlightProps {
  open: boolean
  onClose: () => void
  items: SpotlightItem[]
  placeholder?: string
  emptyLabel?: string
}

export function AppleSpotlight({
  open,
  onClose,
  items,
  placeholder = 'Search beats, commands and settings…',
  emptyLabel = 'Nothing matches that.'
}: AppleSpotlightProps): ReactNode {
  const reduced = useReducedMotion()
  const overlayRef = useRef<HTMLDivElement | null>(null)
  const panelRef = useRef<HTMLDivElement | null>(null)
  useOverlay([panelRef], onClose, open, true)
  const [query, setQuery] = useState('')
  const [activeIndex, setActiveIndex] = useState(0)
  const inputRef = useRef<HTMLInputElement | null>(null)
  const listRef = useRef<HTMLDivElement | null>(null)
  const listId = useId()

  const catalog = useMemo(() => open ? indexCommands(items) : [], [items, open])
  const matches = useMemo(() => searchCommands(catalog, query), [catalog, query])
  const results = matches.items
  const active = Math.min(activeIndex, Math.max(0, results.length - 1))

  // Reset before paint so the first keystroke after reopening cannot be
  // overwritten by a delayed passive effect from the opening render.
  useLayoutEffect(() => {
    // AnimatePresence keeps the removed child's last props during exit. Update
    // its actual wrapper immediately so a fading palette cannot capture focus
    // or intercept another click after it has logically closed.
    const overlay = overlayRef.current
    if (overlay) {
      overlay.inert = !open
      overlay.style.pointerEvents = open ? 'auto' : 'none'
      overlay.setAttribute('aria-hidden', String(!open))
    }
    if (open) {
      setQuery('')
      setActiveIndex(0)
      const frame = requestAnimationFrame(() => inputRef.current?.focus())
      return () => cancelAnimationFrame(frame)
    }
    return undefined
  }, [open])

  // Keep the highlighted row in view during keyboard navigation.
  useEffect(() => {
    const element = listRef.current?.querySelector<HTMLElement>(`[data-index="${active}"]`)
    element?.scrollIntoView({ block: 'nearest' })
  }, [active, results])

  const commit = (item: SpotlightItem | undefined): void => {
    if (!item) return
    onClose()
    item.onSelect()
  }

  const onKeyDown = (event: React.KeyboardEvent): void => {
    if (event.nativeEvent.isComposing) return
    if (event.key === 'ArrowDown') {
      event.preventDefault()
      setActiveIndex((index) => (results.length === 0 ? 0 : (index + 1) % results.length))
    } else if (event.key === 'ArrowUp') {
      event.preventDefault()
      setActiveIndex((index) =>
        results.length === 0 ? 0 : (index - 1 + results.length) % results.length
      )
    } else if (event.key === 'Enter') {
      event.preventDefault()
      commit(results[active])
    } else if ((event.key === 'Home' || event.key === 'End') && event.ctrlKey) {
      event.preventDefault()
      setActiveIndex(event.key === 'Home' ? 0 : Math.max(0, results.length - 1))
    }
  }

  let lastGroup = ''

  return createPortal(
    <AnimatePresence>
      {open ? (
        <div ref={overlayRef} data-command-palette-overlay inert={!open} style={{ pointerEvents: open ? 'auto' : 'none' }} className="fixed inset-0 z-[400] flex items-start justify-center pt-[14vh]">
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: reduced ? 0 : 0.18, ease: [0.22, 1, 0.36, 1] }}

            className="absolute inset-0 bg-overlay"
          />

          <motion.div
            initial={{ opacity: 0, scale: 0.965, y: -8, filter: 'blur(6px)' }}
            animate={{ opacity: 1, scale: 1, y: 0, filter: 'blur(0px)' }}
            exit={{ opacity: 0, scale: 0.98, y: -4, filter: 'blur(4px)' }}
            transition={{ duration: reduced ? 0 : 0.24, ease: [0.22, 1, 0.36, 1] }}
            ref={panelRef}
            tabIndex={-1}
            onKeyDown={onKeyDown}
            role="dialog"
            aria-modal="true"
            aria-label="Command palette"
            className="glass-strong relative w-full max-w-[620px] overflow-hidden rounded-[2px] border border-line shadow-pop"
          >
            <div className="flex items-center gap-3 border-b border-line px-4">
              <Search className="size-4 shrink-0 text-fg-subtle" />
              <input
                ref={inputRef}
                role="combobox"
                aria-label="Search beats, commands and settings"
                aria-autocomplete="list"
                aria-expanded={open}
                aria-controls={listId}
                aria-activedescendant={results.length ? `${listId}-${active}` : undefined}
                aria-describedby={`${listId}-help`}
                value={query}
                onChange={(event) => { setQuery(event.target.value); setActiveIndex(0) }}
                placeholder={placeholder}
                spellCheck={false}
                className="h-13 w-full bg-transparent text-[13.5px] text-fg outline-none placeholder:text-fg-subtle"
              />
              <kbd className="shrink-0 rounded-[2px] border border-line bg-surface-2 px-1.5 py-0.5 text-[12px] font-medium text-fg-subtle">
                ESC
              </kbd>
            </div>

            <p id={`${listId}-help`} className="sr-only">Use Up and Down to choose a result, Enter to open it, and Escape to close. Control Home and Control End jump to the first and last result.</p>
            <div id={listId} role="listbox" aria-label="Search results" ref={listRef} className="max-h-[46vh] overflow-y-auto p-2">
              {results.length === 0 ? (
                <div className="px-3 py-10 text-center text-[13.5px] text-fg-subtle">{emptyLabel}</div>
              ) : (
                results.map((item, index) => {
                  const showHeader = item.group !== lastGroup
                  lastGroup = item.group
                  const selected = index === active

                  return (
                    <div key={item.id} role="presentation">
                      {showHeader ? (
                        <div aria-hidden="true" className="px-2.5 pt-2.5 pb-1 text-[12px] font-bold text-fg-subtle">
                          {item.group}
                        </div>
                      ) : null}

                      <button
                        type="button"
                        id={`${listId}-${index}`}
                        role="option"
                        aria-label={item.label}
                        aria-describedby={item.hint ? `${listId}-${index}-hint` : undefined}
                        aria-selected={selected}
                        tabIndex={-1}
                        data-index={index}
                        onMouseMove={() => setActiveIndex(index)}
                        onMouseDown={event => event.preventDefault()}
                        onClick={() => commit(item)}
                        className={cn(
                          'flex w-full items-center gap-3 rounded-[2px] px-2.5 py-2 text-left',
                          'transition-colors duration-[var(--duration-quick)] ease-[var(--ease-smooth-out)]',
                          selected ? 'bg-accent-soft' : 'hover:bg-surface-2'
                        )}
                      >
                        {item.icon ? (
                          <span
                            className={cn(
                              'grid size-4 shrink-0 place-items-center [&>svg]:size-4 [&>svg]:stroke-[1.75]',
                              selected ? 'text-accent' : 'text-fg-subtle'
                            )}
                          >
                            {item.icon}
                          </span>
                        ) : null}

                        <span
                          className={cn(
                            'flex-1 truncate text-[13.5px]',
                            selected ? 'text-fg' : 'text-fg-muted'
                          )}
                        >
                          {item.label}
                        </span>

                        {item.hint ? (
                          <span id={`${listId}-${index}-hint`} className="shrink-0 text-[12px] text-fg-subtle nums">{item.hint}</span>
                        ) : null}

                        {selected ? (
                          <CornerDownLeft className="size-3.5 shrink-0 text-accent" />
                        ) : null}
                      </button>
                    </div>
                  )
                })
              )}
            </div>
            <p role="status" aria-live="polite" aria-atomic="true" className="border-t border-line px-4 py-2 text-[12px] text-fg-subtle">
              {matches.total > results.length ? `Showing ${results.length} of ${matches.total} matches. Keep typing to narrow your search.` : `${matches.total} result${matches.total === 1 ? '' : 's'}`}
            </p>
          </motion.div>
        </div>
      ) : null}
    </AnimatePresence>, overlayRoot()
  )
}
