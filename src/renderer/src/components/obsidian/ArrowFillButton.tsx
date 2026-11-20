import type { ButtonHTMLAttributes, ReactNode } from 'react'
import { cn } from '@/lib/cn'

/**
 * Ported from ObsidianUI's *Arrow Fill Button*.
 *
 * The background sweeps in from the leading edge on hover while the arrow
 * travels right and the trailing arrow fades in behind it.
 */
export interface ArrowFillButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  children: ReactNode
  /** Colour of the incoming fill. Defaults to the accent. */
  fillClassName?: string
}

export function ArrowFillButton({
  children,
  className,
  fillClassName = 'bg-accent',
  ...props
}: ArrowFillButtonProps): ReactNode {
  return (
    <button
      type="button"
      {...props}
      className={cn(
        'group relative inline-flex h-9.5 select-none items-center gap-2 overflow-hidden rounded-[2px]',
        'border border-line bg-surface-2 px-4 text-[13.5px] font-medium text-fg',
        'no-drag transition-colors duration-[var(--duration-fast)] ease-[var(--ease-smooth-out)]',
        'hover:border-transparent hover:text-accent-fg active:scale-[0.985]',
        'disabled:pointer-events-none disabled:opacity-45',
        className
      )}
    >
      {/* Fill sweeps left → right behind the label. */}
      <span
        aria-hidden
        className={cn(
          'absolute inset-0 -translate-x-full transition-transform duration-[var(--duration-fast)] ease-[var(--ease-smooth-out)]',
          'group-hover:translate-x-0',
          fillClassName
        )}
      />

      <span className="relative flex items-center gap-2">
        {children}
        <span className="relative grid size-4 place-items-center overflow-hidden">
          <svg
            viewBox="0 0 16 16"
            fill="none"
            className="size-4 transition-transform duration-[var(--duration-fast)] ease-[var(--ease-smooth-out)] group-hover:translate-x-3 group-hover:opacity-0"
          >
            <path
              d="M3 8h10M9 4l4 4-4 4"
              stroke="currentColor"
              strokeWidth="1.6"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
          <svg
            viewBox="0 0 16 16"
            fill="none"
            className="absolute size-4 -translate-x-3 opacity-0 transition-transform duration-[var(--duration-fast)] ease-[var(--ease-smooth-out)] group-hover:translate-x-0 group-hover:opacity-100"
          >
            <path
              d="M3 8h10M9 4l4 4-4 4"
              stroke="currentColor"
              strokeWidth="1.6"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
        </span>
      </span>
    </button>
  )
}
