import { useId, useRef, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { overlayRoot, useOverlay } from '../motion/overlay'
import { X } from 'lucide-react'
import { cn } from '@/lib/cn'
import { IconButton } from './Button'
import { usePresence } from '../motion/usePresence'

export interface ModalProps {
  open: boolean
  onClose: () => void
  title: string
  description?: string
  children?: ReactNode
  footer?: ReactNode
  /** Tailwind max-width class for the dialog surface. */
  size?: 'sm' | 'md' | 'lg'
  /** Prevents dismissal via backdrop click and Escape. */
  blocking?: boolean
}

const SIZES = {
  sm: 'max-w-sm',
  md: 'max-w-lg',
  lg: 'max-w-2xl'
} as const

/** Centred dialog built on the transitions.dev modal snippet. */
export function Modal({
  open,
  onClose,
  title,
  description,
  children,
  footer,
  size = 'md',
  blocking
}: ModalProps): ReactNode {
  const panelRef = useRef<HTMLDivElement | null>(null)
  const titleId = useId()

  const phase = usePresence(open, panelRef, {
    openDurationVar: '--modal-open-dur',
    closeDurationVar: '--modal-close-dur',
    fallbackOpenMs: 250,
    fallbackCloseMs: 150
  })

  useOverlay([panelRef], () => !blocking && onClose(), open, true)

  if (phase === 'closed') return null

  return createPortal(
    <div inert={!open} style={{ pointerEvents: open ? 'auto' : 'none' }} className="fixed inset-0 z-[400] flex items-center justify-center p-6">
      <div
        aria-hidden

        className={cn(
          'absolute inset-0 bg-overlay',
          'transition-opacity duration-[var(--duration-quick)] ease-[var(--ease-smooth-out)]',
          phase === 'open' ? 'opacity-100' : 'opacity-0'
        )}
      />

      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={description ? `${titleId}-description` : undefined}
        tabIndex={-1}
        className={cn(
          't-modal relative max-h-[calc(100dvh-48px)] w-full overflow-y-auto rounded-[2px] border border-line-strong bg-surface shadow-pop outline-none',
          SIZES[size],
          phase === 'open' && 'is-open',
          phase === 'closing' && 'is-closing'
        )}
      >
        <div className="flex items-start justify-between gap-4 px-6 pt-5 pb-4">
          <div className="min-w-0">
            <h2 id={titleId} className="label-type text-[20px] leading-tight text-fg">{title}</h2>
            {description ? (
              <p id={`${titleId}-description`} className="mt-1 text-[13.5px] leading-relaxed text-fg-muted">{description}</p>
            ) : null}
          </div>
          <IconButton disabled={blocking} label="Close" size="icon-sm" onClick={onClose} className="-mt-0.5 -mr-1">
            <X />
          </IconButton>
        </div>

        {children ? <div className="px-6 pb-5">{children}</div> : null}

        {footer ? (
          <div className="flex items-center justify-end gap-2 border-t border-line bg-surface-2/50 px-6 py-4">
            {footer}
          </div>
        ) : null}
      </div>
    </div>, overlayRoot()
  )
}

export interface ConfirmDialogProps {
  open: boolean
  title: string
  description?: string
  confirmLabel: string
  cancelLabel?: string
  tone?: 'default' | 'danger'
  /** Optional body content between the description and the actions. */
  children?: ReactNode
  onConfirm: () => void | Promise<void>
  onCancel: () => void
}

/** Two-action confirmation, used for destructive actions. */
export function ConfirmDialog({
  open,
  title,
  description,
  confirmLabel,
  cancelLabel = 'Cancel',
  tone = 'default',
  children,
  onConfirm,
  onCancel
}: ConfirmDialogProps): ReactNode {
  const [pending, setPending] = useState(false)
  const [error, setError] = useState('')
  const lock = useRef(false)
  const submit = async (): Promise<void> => {
    if (lock.current) return
    lock.current = true; setPending(true); setError('')
    try { await onConfirm() } catch (failure) { setError(failure instanceof Error ? failure.message : String(failure)) }
    finally { lock.current = false; setPending(false) }
  }
  return (
    <Modal
      open={open}
      onClose={() => { setError(''); onCancel() }}
      blocking={pending}
      title={title}
      description={description}
      size="sm"
      footer={
        <>
          <button
            type="button"
            disabled={pending}
            data-autofocus
            onClick={() => { setError(''); onCancel() }}
            className="h-9 rounded-[2px] border border-line px-4 text-[13.5px] text-fg transition-colors duration-[var(--duration-quick)] hover:bg-surface-2"
          >
            {cancelLabel}
          </button>
          <button
            type="button"
            disabled={pending}
            onClick={() => void submit()}
            className={cn(
              'h-9 rounded-[2px] px-4 text-[13.5px] font-medium text-white transition-colors duration-[var(--duration-quick)]',
              tone === 'danger' ? 'bg-danger hover:opacity-90' : 'bg-accent text-accent-fg hover:bg-[var(--sonic-accent-hover)]'
            )}
          >
            {pending ? 'Working…' : confirmLabel}
          </button>
        </>
      }
    >
      <fieldset disabled={pending}>{children}</fieldset>
      {error ? <p role="alert" className="mt-3 text-sm text-danger">{error}</p> : null}
    </Modal>
  )
}
