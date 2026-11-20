import { useLayoutEffect, useState, type RefObject } from 'react'

/** Rows of fixed pitch [start, end) that intersect the viewport, plus overscan. */
export function visibleRowRange(input: {
  /** The scroller's scrollTop. */
  scrollTop: number
  viewportHeight: number
  /** Where row 0 starts inside the scroller's content. */
  offset: number
  rowHeight: number
  count: number
  overscan: number
}): { start: number; end: number } {
  const { scrollTop, viewportHeight, offset, rowHeight, count, overscan } = input
  if (count <= 0 || rowHeight <= 0) return { start: 0, end: 0 }
  const top = scrollTop - offset
  const first = Math.floor(top / rowHeight) - overscan
  const last = Math.ceil((top + Math.max(0, viewportHeight)) / rowHeight) + overscan
  const start = Math.min(count, Math.max(0, first))
  return { start, end: Math.min(count, Math.max(start, last)) }
}

/** Grid columns produced by `repeat(auto-fill, minmax(min, 1fr))` with `gap`. */
export function autoFillColumns(width: number, min: number, gap: number): number {
  return Math.max(1, Math.floor((width + gap) / (min + gap)))
}

/** The rows of `range` plus any pinned rows outside it (a focused or requested row), ascending. */
export function withPinned(range: { start: number; end: number }, pinned: readonly number[], count: number): number[] {
  const start = Math.min(range.start, count), end = Math.min(range.end, count)
  const rows: number[] = []
  for (let index = start; index < end; index++) rows.push(index)
  for (const index of new Set(pinned)) if (index >= 0 && index < count && (index < start || index >= end)) rows.push(index)
  return rows.sort((a, b) => a - b)
}

const INITIAL_ROWS = 24

/**
 * Windowed rendering for fixed-pitch rows inside a scroller. Items fill rows of
 * `columns` (one, or as many as `repeat(auto-fill, minmax(minColumnWidth, 1fr))`
 * fits). Only the rows intersecting the viewport, plus `overscan`, are reported;
 * the caller sizes the content to `rows * rowHeight` and positions each row.
 */
export function useVirtualRows({ scrollRef, contentRef, items, rowHeight, minColumnWidth = 0, gap = 0, initialWidth = 0, overscan = 6, enabled = true }: {
  scrollRef: RefObject<HTMLElement | null>
  contentRef: RefObject<HTMLElement | null>
  items: number
  /** Row pitch in pixels, including any gap below the row. */
  rowHeight: number
  minColumnWidth?: number
  gap?: number
  /** Width assumed before the first measurement, e.g. the last measured one. */
  initialWidth?: number
  overscan?: number
  enabled?: boolean
}): { start: number; end: number; columns: number; rows: number; width: number } {
  const columnsAt = (width: number): number => minColumnWidth > 0 ? autoFillColumns(width, minColumnWidth, gap) : 1
  const [state, setState] = useState(() => ({ start: 0, end: INITIAL_ROWS, width: initialWidth }))
  // A parent's ref attaches after its children's layout effects run, so a
  // scroller mounted in the same commit is not available yet: measure again
  // in a synchronous follow-up render, still before paint.
  const [attempt, setAttempt] = useState(0)
  useLayoutEffect(() => {
    if (!enabled) return
    const scroller = scrollRef.current, content = contentRef.current
    if (!scroller || !content) {
      if (attempt < 2) setAttempt(attempt + 1)
      return
    }
    const measure = (): void => {
      const width = content.clientWidth
      const count = Math.ceil(items / (minColumnWidth > 0 ? autoFillColumns(width, minColumnWidth, gap) : 1))
      const offset = content.getBoundingClientRect().top - scroller.getBoundingClientRect().top + scroller.scrollTop
      const next = { ...visibleRowRange({ scrollTop: scroller.scrollTop, viewportHeight: scroller.clientHeight, offset, rowHeight, count, overscan }), width }
      setState(previous => previous.start === next.start && previous.end === next.end && previous.width === next.width ? previous : next)
    }
    // Scroll events are already dispatched at most once per frame.
    measure()
    scroller.addEventListener('scroll', measure, { passive: true })
    const observer = new ResizeObserver(measure)
    observer.observe(scroller)
    observer.observe(content)
    return () => {
      scroller.removeEventListener('scroll', measure)
      observer.disconnect()
    }
  }, [enabled, scrollRef, contentRef, items, rowHeight, minColumnWidth, gap, overscan, attempt])
  const columns = columnsAt(state.width)
  const rows = Math.ceil(items / columns)
  return { start: Math.min(state.start, rows), end: Math.min(state.end, rows), columns, rows, width: state.width }
}
