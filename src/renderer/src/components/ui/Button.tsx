import { cva, type VariantProps } from 'class-variance-authority'
import { forwardRef, type ButtonHTMLAttributes, type ReactNode } from 'react'
import { cn } from '@/lib/cn'

const button = cva(
  [
    'relative inline-flex select-none items-center justify-center gap-2 whitespace-nowrap font-semibold',
    'no-drag disabled:pointer-events-none disabled:opacity-40',
    'active:translate-y-px focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent',
    'transition-[background-color,border-color,color,box-shadow,transform,opacity]',
    'duration-[var(--duration-fast)] ease-[var(--ease-smooth-out)]'
  ],
  {
    variants: {
      variant: {
        primary: 'border border-transparent bg-primary text-primary-fg hover:bg-[var(--sonic-primary-hover)]',
        secondary:
          'border border-line-strong bg-transparent text-fg hover:border-fg-subtle hover:bg-surface-2',
        outline: 'border border-line-strong text-fg hover:bg-surface-2',
        ghost: 'text-fg-muted hover:bg-surface-2 hover:text-fg',
        danger: 'border border-danger bg-transparent text-danger hover:bg-danger/12',
        quiet: 'border border-transparent bg-surface-2 text-fg hover:bg-surface-3'
      },
      size: {
        xs: 'h-7 rounded-[2px] px-2.5 text-[12px]',
        sm: 'h-8 rounded-[2px] px-3 text-[13.5px]',
        md: 'h-8 rounded-[2px] px-3 text-[13.5px]',
        lg: 'h-11 rounded-[2px] px-5 text-[13.5px]',
        icon: 'h-8 w-8 rounded-[2px]',
        'icon-sm': 'h-8 w-8 rounded-[2px]',
        'icon-xs': 'h-6.5 w-6.5 rounded-[2px]'
      }
    },
    defaultVariants: { variant: 'secondary', size: 'md' }
  }
)

export interface ButtonProps
  extends ButtonHTMLAttributes<HTMLButtonElement>,
    VariantProps<typeof button> {
  leading?: ReactNode
  trailing?: ReactNode
  /** Renders a shimmering label while an action is in flight. */
  busy?: boolean
}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { className, variant, size, leading, trailing, busy, disabled, children, ...props },
  ref
) {
  return (
    <button
      ref={ref}
      type={props.type ?? 'button'}
      className={cn(button({ variant, size }), className)}
      disabled={disabled || busy}
      aria-busy={busy || undefined}
      {...props}
    >
      {leading ? <span className="shrink-0 [&>svg]:size-4">{leading}</span> : null}
      <span className="truncate">{children}</span>
      {trailing ? <span className="shrink-0 [&>svg]:size-4">{trailing}</span> : null}
    </button>
  )
})

/** Square icon-only button with an accessible label. */
export interface IconButtonProps extends Omit<ButtonProps, 'children' | 'leading' | 'trailing'> {
  label: string
  children: ReactNode
}

export const IconButton = forwardRef<HTMLButtonElement, IconButtonProps>(function IconButton(
  { label, children, variant = 'ghost', size = 'icon', className, ...props },
  ref
) {
  return (
    <Button
      ref={ref}
      variant={variant}
      size={size}
      aria-label={label}
      title={label}
      className={cn('px-0', className)}
      {...props}
    >
      <span className="grid place-items-center [&>svg]:size-4">{children}</span>
    </Button>
  )
})
