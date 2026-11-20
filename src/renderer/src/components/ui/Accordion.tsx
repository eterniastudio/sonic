import { useState, type ReactNode } from 'react'
import { ChevronDown } from 'lucide-react'
import { cn } from '@/lib/cn'

export interface AccordionProps {
  title: string
  /** Short right-aligned summary shown while collapsed. */
  summary?: ReactNode
  children: ReactNode
  defaultOpen?: boolean
  icon?: ReactNode
  className?: string
  /** Removes the outer card chrome when nesting inside another surface. */
  bare?: boolean
}

/**
 * Disclosure built on the transitions.dev accordion snippet.
 *
 * The snippet animates `grid-template-rows: 0fr → 1fr`, so padding must live on
 * the inner element — padding on the collapsing track would leave a residual
 * strip and the panel would never fully close.
 */
export function Accordion({
  title,
  summary,
  children,
  defaultOpen = false,
  icon,
  className,
  bare
}: AccordionProps): ReactNode {
  const [open, setOpen] = useState(defaultOpen)

  return (
    <div
      className={cn(
        't-acc',
        !bare && 'overflow-hidden rounded-[2px] border border-line bg-surface',
        className
      )}
      data-open={open ? 'true' : 'false'}
    >
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
        className={cn(
          'flex w-full items-center gap-2.5 px-3.5 py-3 text-left',
          'transition-colors duration-[var(--duration-quick)] ease-[var(--ease-smooth-out)]',
          'hover:bg-surface-2'
        )}
      >
        {icon ? <span className="shrink-0 text-fg-subtle [&>svg]:size-4">{icon}</span> : null}
        <span className="flex-1 truncate text-[13.5px] font-medium text-fg">{title}</span>
        {summary ? <span className="shrink-0 text-[12px] text-fg-subtle nums">{summary}</span> : null}
        <span className="t-acc-chevron shrink-0 text-fg-subtle">
          <ChevronDown className="size-4" strokeWidth={2} />
        </span>
      </button>

      <div className="t-acc-panel">
        <div className="t-acc-panel-inner">
          <div className="border-t border-line px-3.5 py-3">{children}</div>
        </div>
      </div>
    </div>
  )
}
