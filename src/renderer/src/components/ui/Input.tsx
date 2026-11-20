import { forwardRef, type InputHTMLAttributes, type ReactNode, type TextareaHTMLAttributes } from 'react'
import { cn } from '@/lib/cn'

const fieldSurface = [
  'w-full bg-transparent text-fg placeholder:text-fg-subtle',
  'border border-line-strong/60 rounded-[2px]',
  'transition-[border-color,background-color,box-shadow]',
  'duration-[var(--duration-quick)] ease-[var(--ease-smooth-out)]',
  'hover:border-line-strong',
  'focus:border-accent focus:bg-surface',
  'focus:shadow-[0_0_0_3px_var(--sonic-accent-softer)]',
  'disabled:cursor-not-allowed disabled:opacity-50'
].join(' ')

export interface InputProps extends InputHTMLAttributes<HTMLInputElement> {
  leading?: ReactNode
  trailing?: ReactNode
  invalid?: boolean
  /** Shakes the field to reject a value; pair with a fresh key to replay. */
  shake?: boolean
}

export const Input = forwardRef<HTMLInputElement, InputProps>(function Input(
  { className, leading, trailing, invalid, shake, ...props },
  ref
) {
  return (
    <div
      className={cn(
        'relative flex items-center',
        // transitions.dev · error state shake
        shake && 't-shake is-shaking',
        invalid && 'is-error'
      )}
    >
      {leading ? (
        <span className="pointer-events-none absolute left-3 grid place-items-center text-fg-subtle [&>svg]:size-4">
          {leading}
        </span>
      ) : null}
      <input
        ref={ref}
        aria-invalid={invalid || undefined}
        className={cn(
          fieldSurface,
          'h-8 px-2.5 text-[12px]',
          leading && 'pl-9.5',
          trailing && 'pr-9.5',
          invalid && 'border-danger/50',
          className
        )}
        {...props}
      />
      {trailing ? <span className="absolute right-2 flex items-center">{trailing}</span> : null}
    </div>
  )
})

export interface TextareaProps extends TextareaHTMLAttributes<HTMLTextAreaElement> {
  invalid?: boolean
}

export const Textarea = forwardRef<HTMLTextAreaElement, TextareaProps>(function Textarea(
  { className, invalid, ...props },
  ref
) {
  return (
    <textarea
      ref={ref}
      aria-invalid={invalid || undefined}
      className={cn(
        fieldSurface,
        'resize-none px-3 py-2.5 text-[13.5px] leading-relaxed',
        invalid && 'border-danger/50',
        className
      )}
      {...props}
    />
  )
})

export interface FieldProps {
  label: string
  hint?: string
  /** Rendered under the control; use for validation or provenance notes. */
  note?: ReactNode
  htmlFor?: string
  children: ReactNode
  className?: string
}

export function Field({ label, hint, note, htmlFor, children, className }: FieldProps): ReactNode {
  return (
    <div className={cn('space-y-1.5', className)}>
      <div className="flex items-baseline justify-between gap-3">
        <label htmlFor={htmlFor} className="text-[12px] font-medium text-fg-muted">
          {label}
        </label>
        {hint ? <span className="text-[12px] text-fg-subtle">{hint}</span> : null}
      </div>
      {children}
      {note ? <div className="text-[12px] leading-relaxed text-fg-subtle">{note}</div> : null}
    </div>
  )
}
