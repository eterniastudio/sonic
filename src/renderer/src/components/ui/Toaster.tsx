import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import { CircleAlert, Info, X } from 'lucide-react'
import { cn } from '@/lib/cn'
import { readMs } from '../motion/usePresence'
import { SuccessCheck } from './SuccessCheck'

export type ToastKind = 'info' | 'success' | 'error'

export interface ToastRecord {
  id: string
  kind: ToastKind
  title: string
  description?: string
  duration: number
}

/**
 * Minimal toast queue.
 *
 * Deliberately not React context: the main process pushes notices from anywhere
 * in the app (IPC listeners, async service callbacks), so the queue lives at
 * module scope and React simply subscribes to it.
 */
let items: ToastRecord[] = []
const listeners = new Set<(next: ToastRecord[]) => void>()
let counter = 0

function emit(): void {
  const snapshot = [...items]
  for (const listener of listeners) listener(snapshot)
}

export function toast(input: {
  kind?: ToastKind
  title: string
  description?: string
  duration?: number
}): string {
  const kind = input.kind ?? 'info'
  counter += 1
  const id = `toast-${counter}`

  // Keep the stack shallow enough to stay readable.
  items = [
    ...items.slice(-2),
    {
      id,
      kind,
      title: input.title,
      description: input.description,
      duration: input.duration ?? (kind === 'error' ? 8_000 : 4_200)
    }
  ]
  emit()
  return id
}

export function dismissToast(id: string): void {
  items = items.filter((item) => item.id !== id)
  emit()
}

function ToastCard({ record }: { record: ToastRecord }): ReactNode {
  const ref = useRef<HTMLDivElement | null>(null)
  const [open, setOpen] = useState(false)
  const closingRef = useRef(false)

  // Enter on the next frame so `is-open` actually transitions.
  useEffect(() => {
    const frame = requestAnimationFrame(() => setOpen(true))
    return () => cancelAnimationFrame(frame)
  }, [])

  const close = useCallback(() => {
    if (closingRef.current) return
    closingRef.current = true
    setOpen(false)
    const ms = readMs(ref.current, '--toast-close', 250)
    window.setTimeout(() => dismissToast(record.id), ms)
  }, [record.id])

  useEffect(() => {
    const timer = window.setTimeout(close, record.duration)
    return () => window.clearTimeout(timer)
  }, [close, record.duration])

  const accent =
    record.kind === 'error'
      ? 'text-danger'
      : record.kind === 'success'
        ? 'text-success'
        : 'text-accent'

  return (
    <div
      ref={ref}
      role="status"
      aria-live={record.kind === 'error' ? 'assertive' : 'polite'}
      className={cn(
        't-toast pointer-events-auto flex items-start gap-2.5 rounded-[2px] border border-line bg-surface p-3 shadow-pop',
        open && 'is-open'
      )}
    >
      <span className={cn('mt-0.5 grid size-4 shrink-0 place-items-center', accent)}>
        {record.kind === 'success' ? (
          <SuccessCheck size={16} />
        ) : record.kind === 'error' ? (
          <CircleAlert className="size-4" />
        ) : (
          <Info className="size-4" />
        )}
      </span>

      <div className="min-w-0 flex-1">
        <div className="text-[13.5px] font-medium text-fg">{record.title}</div>
        {record.description ? (
          <p className="mt-0.5 text-[12px] leading-relaxed break-words text-fg-muted">
            {record.description}
          </p>
        ) : null}
      </div>

      <button
        type="button"
        onClick={close}
        aria-label="Dismiss"
        className="-mt-0.5 -mr-0.5 grid size-5 shrink-0 place-items-center rounded-[2px] text-fg-subtle transition-colors duration-[var(--duration-quick)] hover:bg-surface-2 hover:text-fg"
      >
        <X className="size-3.5" />
      </button>
    </div>
  )
}

/** Renders the toast stack. Mount once, near the app root. */
export function Toaster(): ReactNode {
  const [list, setList] = useState<ToastRecord[]>(items)

  useEffect(() => {
    const listener = (next: ToastRecord[]): void => setList(next)
    listeners.add(listener)
    listener([...items])
    return () => {
      listeners.delete(listener)
    }
  }, [])

  return (
    <div className="pointer-events-none fixed right-4 bottom-4 z-[200] flex w-[336px] flex-col-reverse gap-2">
      {list.map((record) => (
        <ToastCard key={record.id} record={record} />
      ))}
    </div>
  )
}
