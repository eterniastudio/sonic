import type { ReactNode } from 'react'
import { cn } from '@/lib/cn'

/** Conic sweep spinner built from the transitions.dev linear easing token. */
export function Spinner({ className, size = 16 }: { className?: string; size?: number }): ReactNode {
  return (
    <span
      role="status"
      aria-label="Loading"
      className={cn('inline-block shrink-0 animate-spin rounded-full', className)}
      style={{
        width: size,
        height: size,
        background:
          'conic-gradient(from 90deg, transparent 0deg, var(--sonic-accent) 300deg, transparent 360deg)',
        mask: 'radial-gradient(farthest-side, transparent calc(100% - 2px), #000 calc(100% - 2px))',
        WebkitMask: 'radial-gradient(farthest-side, transparent calc(100% - 2px), #000 calc(100% - 2px))',
        animationDuration: '700ms',
        animationTimingFunction: 'var(--ease-linear)'
      }}
    />
  )
}

export interface ProgressBarProps {
  /** 0..1, or null for an indeterminate sweep. */
  value: number | null
  className?: string
  /** Kept for callers; White Label draws no glow, so it has no visual effect. */
  active?: boolean
}

export function ProgressBar({ value, className }: ProgressBarProps): ReactNode {
  const indeterminate = value == null

  return (
    <div
      role="progressbar"
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={indeterminate ? undefined : Math.round((value ?? 0) * 100)}
      className={cn('relative h-1 w-full overflow-hidden bg-surface-3', className)}
    >
      {indeterminate ? (
        <span
          className="absolute inset-y-0 w-1/3 bg-accent"
          style={{
            animation: 'sonic-indeterminate 1.1s var(--ease-smooth-out) infinite'
          }}
        />
      ) : (
        <span
          className="absolute inset-y-0 left-0 bg-accent transition-[width] duration-[var(--duration-fast)] ease-[var(--ease-smooth-out)]"
          style={{
            width: `${Math.max(0, Math.min(1, value ?? 0)) * 100}%`
          }}
        />
      )}
    </div>
  )
}
