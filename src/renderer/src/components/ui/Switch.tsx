import { useState, type ReactNode } from 'react'
import { cn } from '@/lib/cn'

export interface SwitchProps {
  checked: boolean
  onChange: (next: boolean) => void
  disabled?: boolean
  /** Accessible name when there is no adjacent <label>. */
  label?: string
  className?: string
  id?: string
}

const TRAVEL_PX = 16

/**
 * Toggle built on the transitions.dev toggle snippet.
 *
 * `is-init` is added only after the first interaction: the snippet animates on
 * every `data-on` change while it is present, and adding it at mount would fire
 * a bounce for a switch the user never touched.
 */
export function Switch({
  checked,
  onChange,
  disabled,
  label,
  className,
  id
}: SwitchProps): ReactNode {
  const [interacted, setInteracted] = useState(false)

  return (
    <button
      type="button"
      id={id}
      role="switch"
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      data-on={checked ? 'true' : 'false'}
      onClick={() => {
        setInteracted(true)
        onChange(!checked)
      }}
      style={{
        ['--toggle-travel' as string]: `${TRAVEL_PX}px`,
        ['--toggle-track' as string]: 'var(--duration-fast)'
      }}
      className={cn(
        't-toggle relative inline-flex h-[22px] w-[38px] shrink-0 items-center rounded-[2px] p-[3px]',
        'disabled:cursor-not-allowed disabled:opacity-45',
        checked ? 'bg-accent' : 'bg-surface-3',
        interacted && 'is-init',
        className
      )}
    >
      <span
        className={cn(
          't-toggle-thumb size-4 rounded-[1px]',
          checked ? 'bg-accent-fg' : 'bg-fg-subtle'
        )}
      />
    </button>
  )
}

export interface SwitchRowProps extends Omit<SwitchProps, 'className'> {
  title: string
  description?: string
  className?: string
}

/** Labelled switch used throughout Settings. */
export function SwitchRow({
  title,
  description,
  className,
  ...switchProps
}: SwitchRowProps): ReactNode {
  return (
    <div className={cn('flex items-start justify-between gap-6 py-3', className)}>
      <div className="min-w-0">
        <div className="text-[13.5px] font-medium text-fg">{title}</div>
        {description ? (
          <p className="mt-0.5 text-[12px] leading-relaxed text-fg-muted">{description}</p>
        ) : null}
      </div>
      <Switch {...switchProps} label={title} className="mt-0.5" />
    </div>
  )
}
