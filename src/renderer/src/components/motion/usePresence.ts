import { useCallback, useEffect, useRef, useState, type RefObject } from 'react'
import { useOverlay } from './overlay'

/** Reads a `--duration-*` custom property off an element, in milliseconds. */
export function readMs(
  element: HTMLElement | null,
  property: string,
  fallback: number
): number {
  if (!element) return fallback
  if (document.documentElement.dataset.reduceMotion === 'true') return 0
  const raw = getComputedStyle(element).getPropertyValue(property).trim()
  if (raw.length === 0) return fallback
  const value = Number.parseFloat(raw)
  if (!Number.isFinite(value)) return fallback
  return raw.endsWith('ms') ? value : value * 1000
}

export type PresencePhase = 'closed' | 'open' | 'closing'

/**
 * Drives transitions.dev's open/close state machine.
 *
 * Those snippets expect two independent classes: one for the open state and a
 * separate `is-closing` state that has to be cleared once the exit transition
 * finishes. Skipping the cleanup is the documented way to break them — the next
 * open would animate from the closing scale instead of the resting scale — so
 * the timeout here is derived from the real `--…-close-dur` token rather than
 * hardcoded.
 */
export function usePresence(
  open: boolean,
  ref: RefObject<HTMLElement | null>,
  options: {
    openDurationVar: string
    closeDurationVar: string
    fallbackOpenMs?: number
    fallbackCloseMs?: number
  }
): PresencePhase {
  const [phase, setPhase] = useState<PresencePhase>(open ? 'open' : 'closed')
  const openedOnce = useRef(false)

  useEffect(() => {
    if (open) {
      openedOnce.current = true
      setPhase('open')
      return
    }
    // Only play an exit if we actually entered; otherwise the very first paint
    // would animate a panel that was never visible.
    setPhase((current) => (current === 'open' || openedOnce.current ? 'closing' : 'closed'))
  }, [open])

  useEffect(() => {
    if (phase !== 'closing') return
    const element = ref.current
    const closeMs = readMs(element, options.closeDurationVar, options.fallbackCloseMs ?? 150)
    const timer = setTimeout(() => setPhase('closed'), closeMs)
    return () => clearTimeout(timer)
  }, [phase, ref, options.openDurationVar, options.closeDurationVar, options.fallbackOpenMs, options.fallbackCloseMs])

  return open ? 'open' : phase
}

/** Calls `onDismiss` on outside pointer-down or Escape while `active`. */
export function useDismiss(
  ref: RefObject<HTMLElement | null>,
  onDismiss: () => void,
  active: boolean
): void {
  useOverlay([ref], onDismiss, active)
}

/** Tracks hover + pointer position for the card-tilt transition. */
export function useTilt(enabled = true): {
  wrapRef: RefObject<HTMLDivElement | null>
  cardRef: RefObject<HTMLDivElement | null>
  tiltProps: {
    onPointerMove: (event: React.PointerEvent<HTMLDivElement>) => void
    onPointerEnter: () => void
    onPointerLeave: () => void
  }
} {
  const wrapRef = useRef<HTMLDivElement | null>(null)
  const cardRef = useRef<HTMLDivElement | null>(null)

  // Pointer tracking is bound to the flat outer wrapper: the rotating inner
  // card would otherwise slide out from under the cursor and flicker.
  const onPointerMove = useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      if (!enabled) return
      const wrap = wrapRef.current
      const card = cardRef.current
      if (!wrap || !card) return

      const bounds = wrap.getBoundingClientRect()
      const px = (event.clientX - bounds.left) / bounds.width
      const py = (event.clientY - bounds.top) / bounds.height

      card.classList.add('is-tilting')
      card.style.setProperty('--tilt-ry', `${(px - 0.5) * 12}deg`)
      card.style.setProperty('--tilt-rx', `${(0.5 - py) * 12}deg`)
      card.style.setProperty('--tilt-gx', `${px * 100}%`)
      card.style.setProperty('--tilt-gy', `${py * 100}%`)
    },
    [enabled]
  )

  const onPointerEnter = useCallback(() => {
    wrapRef.current?.classList.add('is-hover')
  }, [])

  const onPointerLeave = useCallback(() => {
    const wrap = wrapRef.current
    const card = cardRef.current
    wrap?.classList.remove('is-hover')
    if (!card) return
    card.classList.remove('is-tilting')
    card.style.setProperty('--tilt-rx', '0deg')
    card.style.setProperty('--tilt-ry', '0deg')
  }, [])

  return { wrapRef, cardRef, tiltProps: { onPointerMove, onPointerEnter, onPointerLeave } }
}
