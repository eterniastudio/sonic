import { AnimatePresence, motion } from 'motion/react'
import { useState, type ReactNode } from 'react'
import { CircleCheck } from 'lucide-react'
import { cn } from '@/lib/cn'
import { Spinner } from '../ui/Progress'

/**
 * Ported from Aceternity UI's *Stateful Button*.
 *
 * A button that owns its own interaction states: idle → loading → success, with
 * the label cross-fading inside a reserved width so the layout never jumps and
 * the pointer never falls off the control mid-action.
 */

type Phase = 'idle' | 'loading' | 'success'

export interface StatefulButtonProps {
  children: ReactNode
  /** Awaited before the success state shows. */
  onAction?: () => void | Promise<unknown>
  disabled?: boolean
  className?: string
  size?: 'sm' | 'md' | 'lg'
  variant?: 'primary' | 'secondary'
  loadingLabel?: string
  successLabel?: string
  icon?: ReactNode
  /** How long the success state holds before returning to idle. */
  successHoldMs?: number
  title?: string
}

const SIZES = {
  sm: 'h-8 rounded-[2px] px-3 text-[13.5px]',
  md: 'h-9.5 rounded-[2px] px-4 text-[13.5px]',
  lg: 'h-11 rounded-[2px] px-5 text-[13.5px]'
} as const

export function StatefulButton({
  children,
  onAction,
  disabled,
  className,
  size = 'md',
  variant = 'primary',
  loadingLabel = 'Working…',
  successLabel = 'Done',
  icon,
  successHoldMs = 1600,
  title
}: StatefulButtonProps): ReactNode {
  const [phase, setPhase] = useState<Phase>('idle')

  const run = async (): Promise<void> => {
    if (phase !== 'idle' || disabled) return
    if (!onAction) {
      setPhase('idle')
      return
    }

    setPhase('loading')
    try {
      await onAction()
      setPhase('success')
      window.setTimeout(() => setPhase('idle'), successHoldMs)
    } catch {
      // The caller surfaces failures through the toast layer.
      setPhase('idle')
    }
  }

  const label = phase === 'loading' ? loadingLabel : phase === 'success' ? successLabel : children

  return (
    <button
      type="button"
      title={title}
      onClick={() => void run()}
      disabled={disabled || phase === 'loading'}
      aria-busy={phase === 'loading' || undefined}
      className={cn(
        'relative inline-flex select-none items-center justify-center gap-2 overflow-hidden font-medium',
        'no-drag transition-[background-color,box-shadow,opacity,transform]',
        'duration-[var(--duration-fast)] ease-[var(--ease-smooth-out)]',
        'active:scale-[0.985] disabled:pointer-events-none disabled:opacity-45',
        SIZES[size],
        variant === 'primary'
          ? 'bg-primary text-primary-fg hover:bg-[var(--sonic-primary-hover)]'
          : 'border border-line bg-surface-2 text-fg hover:border-line-strong hover:bg-surface-3',
        phase === 'success' && 'bg-success text-white shadow-none',
        className
      )}
    >
      {/* Reserved slot keeps the width stable across every phase. */}
      <span className="relative grid place-items-center">
        <AnimatePresence mode="popLayout" initial={false}>
          <motion.span
            key={phase}
            initial={{ opacity: 0, y: 8, filter: 'blur(3px)' }}
            animate={{ opacity: 1, y: 0, filter: 'blur(0px)' }}
            exit={{ opacity: 0, y: -8, filter: 'blur(3px)' }}
            transition={{ duration: 0.22, ease: [0.22, 1, 0.36, 1] }}
            className="flex items-center gap-2 whitespace-nowrap"
          >
            {phase === 'loading' ? (
              <Spinner size={14} className="[&>span]:hidden" />
            ) : phase === 'success' ? (
              <CircleCheck className="size-4" />
            ) : (
              icon
            )}
            <span>{label}</span>
          </motion.span>
        </AnimatePresence>
      </span>
    </button>
  )
}
