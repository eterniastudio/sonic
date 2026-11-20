import { cva, type VariantProps } from 'class-variance-authority'
import type { ReactNode } from 'react'
import { cn } from '@/lib/cn'

const badge = cva(
  'inline-flex items-center gap-1 rounded-[2px] border font-medium whitespace-nowrap nums',
  {
    variants: {
      tone: {
        neutral: 'border-line bg-surface-2 text-fg-muted',
        accent: 'border-[var(--sonic-accent-line)] bg-accent-softer text-accent',
        success: 'border-success/20 bg-success/8 text-success',
        warning: 'border-warning/20 bg-warning/8 text-warning',
        danger: 'border-danger/20 bg-danger/8 text-danger',
        outline: 'border-line-strong bg-transparent text-fg-muted'
      },
      size: {
        sm: 'h-5 px-1.5 text-[12px]',
        md: 'h-6 px-2 text-[12px]'
      }
    },
    defaultVariants: { tone: 'neutral', size: 'md' }
  }
)

export interface BadgeProps extends VariantProps<typeof badge> {
  children: ReactNode
  className?: string
  icon?: ReactNode
}

export function Badge({ children, className, tone, size, icon }: BadgeProps): ReactNode {
  return (
    <span className={cn(badge({ tone, size }), className)}>
      {icon ? <span className="[&>svg]:size-3">{icon}</span> : null}
      {children}
    </span>
  )
}

/** Small status dot used in dense lists. */
export function StatusDot({
  tone = 'neutral',
  pulse = false,
  className
}: {
  tone?: 'neutral' | 'accent' | 'success' | 'warning' | 'danger'
  pulse?: boolean
  className?: string
}): ReactNode {
  const colors: Record<string, string> = {
    neutral: 'bg-fg-subtle',
    accent: 'bg-accent',
    success: 'bg-success',
    warning: 'bg-warning',
    danger: 'bg-danger'
  }

  return (
    <span className={cn('relative grid size-2 place-items-center', className)}>
      {pulse ? (
        <span
          className={cn('absolute inset-0 animate-ping rounded-full opacity-60', colors[tone])}
        />
      ) : null}
      <span className={cn('size-2 rounded-full', colors[tone])} />
    </span>
  )
}
