import { useEffect, useRef, useState } from 'react'
import type { IpcEventChannel, IpcEvents } from '@shared/ipc'
import { ipc } from './ipc'

/** Subscribes to a main-process push channel for the lifetime of the component. */
export function useIpcEvent<K extends IpcEventChannel>(
  channel: K,
  handler: (payload: IpcEvents[K]) => void
): void {
  const ref = useRef(handler)
  ref.current = handler

  useEffect(() => {
    return ipc.on(channel, (payload) => ref.current(payload))
  }, [channel])
}

/** Returns a debounced copy of a rapidly changing value. */
export function useDebounced<T>(value: T, delay = 250): T {
  const [debounced, setDebounced] = useState(value)

  useEffect(() => {
    const timer = setTimeout(() => setDebounced(value), delay)
    return () => clearTimeout(timer)
  }, [value, delay])

  return debounced
}

export function useMediaQuery(query: string): boolean {
  const [matches, setMatches] = useState(() => window.matchMedia(query).matches)

  useEffect(() => {
    const list = window.matchMedia(query)
    const onChange = (): void => setMatches(list.matches)
    list.addEventListener('change', onChange)
    setMatches(list.matches)
    return () => list.removeEventListener('change', onChange)
  }, [query])

  return matches
}

export interface HotkeySpec {
  key: string
  /** Require Ctrl on Windows/Linux or Cmd on macOS. */
  mod?: boolean
  shift?: boolean
  alt?: boolean
}

/** Binds a keyboard shortcut while the component is mounted. */
export function useHotkey(spec: HotkeySpec, handler: (event: KeyboardEvent) => void): void {
  const ref = useRef(handler)
  ref.current = handler

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      const modPressed = event.ctrlKey || event.metaKey
      if (spec.mod && !modPressed) return
      if (!spec.mod && modPressed) return
      if (Boolean(spec.shift) !== event.shiftKey) return
      if (Boolean(spec.alt) !== event.altKey) return
      if (event.key.toLowerCase() !== spec.key.toLowerCase()) return
      ref.current(event)
    }

    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [spec.key, spec.mod, spec.shift, spec.alt])
}

/** A ticking clock, used for live "x ago" labels. */
export function useNow(intervalMs = 30_000): number {
  const [now, setNow] = useState(() => Date.now())

  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), intervalMs)
    return () => clearInterval(timer)
  }, [intervalMs])

  return now
}
