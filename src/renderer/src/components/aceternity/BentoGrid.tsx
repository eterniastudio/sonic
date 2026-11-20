import type { ReactNode } from 'react'
import { cn } from '@/lib/cn'

/**
 * Ported from Aceternity UI's *Bento Grid*.
 *
 * A stat strip where the first card is wider than the rest, so the most
 * important number reads first without a separate hero block.
 */
export function BentoGrid({ children, className }: { children: ReactNode; className?: string }): ReactNode {
  return (
    <div
      className={cn(
        'grid grid-cols-2 gap-2 sm:grid-cols-4 [&>*:first-child]:col-span-2',
        className
      )}
    >
      {children}
    </div>
  )
}

export interface BentoCardProps {
  label: string
  value: ReactNode
  hint?: ReactNode
  icon?: ReactNode
  /** Renders the value in the accent colour with a soft glow. */
  accent?: boolean
  className?: string
}

export function BentoCard({
  label,
  value,
  hint,
  icon,
  accent,
  className
}: BentoCardProps): ReactNode {
  return (
    <div
      className={cn(
        'group relative overflow-hidden rounded-[2px] border border-line bg-surface px-3.5 py-3',
        'transition-[border-color] duration-[var(--duration-quick)] ease-[var(--ease-smooth-out)]',
        'hover:border-line-strong',
        className
      )}
    >
      {/* Corner glow that warms up on hover. */}
      <span
        aria-hidden
        className="pointer-events-none absolute -top-8 -right-8 size-24 rounded-full bg-accent opacity-0 blur-2xl transition-opacity duration-[var(--duration-medium)] group-hover:opacity-[0.18]"
      />
      <div className="relative flex items-center gap-1.5">
        {icon ? <span className="text-fg-subtle [&>svg]:size-3.5">{icon}</span> : null}
        <span className="text-[12px] font-bold text-fg-subtle">
          {label}
        </span>
      </div>
      <div
        className={cn(
          'relative mt-1.5 text-[20px] font-semibold tracking-tight nums',
          accent ? 'text-accent' : 'text-fg'
        )}
      >
        {value}
      </div>
      {hint ? <div className="relative mt-0.5 text-[12px] text-fg-subtle">{hint}</div> : null}
    </div>
  )
}
