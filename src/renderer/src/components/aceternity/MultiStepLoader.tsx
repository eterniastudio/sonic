import { motion } from 'motion/react'
import type { ReactNode } from 'react'
import { Check } from 'lucide-react'
import { cn } from '@/lib/cn'
import { Spinner } from '../ui/Progress'

/**
 * Ported from Aceternity UI's *Multi Step Loader*, split into two shapes:
 *
 *  - `StepPipeline` — a compact horizontal rail for dense job rows.
 *  - `MultiStepLoader` — the vertical overlay used during engine setup, where
 *    each stage deserves a sentence of explanation.
 */

export interface LoaderStep {
  label: string
  description?: string
}

export interface StepPipelineProps {
  steps: string[]
  /** Index of the stage in flight; everything before it reads as complete. */
  currentIndex: number
  failed?: boolean
  className?: string
}

export function StepPipeline({
  steps,
  currentIndex,
  failed,
  className
}: StepPipelineProps): ReactNode {
  return (
    <div className={cn('flex items-center gap-1', className)}>
      {steps.map((step, index) => {
        const done = index < currentIndex
        const active = index === currentIndex
        return (
          <div key={step} className="flex items-center gap-1">
            <div
              className={cn(
                'flex items-center gap-1.5 rounded-full px-2 py-1 text-[12px] font-medium transition-colors',
                'duration-[var(--duration-fast)] ease-[var(--ease-smooth-out)]',
                done && 'text-success',
                active && !failed && 'bg-accent-soft text-accent',
                active && failed && 'bg-danger/12 text-danger',
                !done && !active && 'text-fg-subtle'
              )}
            >
              <span className="grid size-3 place-items-center">
                {done ? (
                  <Check className="size-3" strokeWidth={3} />
                ) : active ? (
                  failed ? (
                    <span className="size-1.5 rounded-full bg-danger" />
                  ) : (
                    <Spinner size={10} />
                  )
                ) : (
                  <span className="size-1 rounded-full bg-current opacity-50" />
                )}
              </span>
              <span className="hidden sm:inline">{step}</span>
            </div>
            {index < steps.length - 1 ? (
              <span
                className={cn(
                  'h-px w-2.5 transition-colors duration-[var(--duration-fast)]',
                  done ? 'bg-success/40' : 'bg-line'
                )}
              />
            ) : null}
          </div>
        )
      })}
    </div>
  )
}

export interface MultiStepLoaderProps {
  steps: LoaderStep[]
  currentIndex: number
  loading: boolean
  title?: string
  error?: string | null
}

export function MultiStepLoader({
  steps,
  currentIndex,
  loading,
  title,
  error
}: MultiStepLoaderProps): ReactNode {
  return (
    <div className="w-full">
      {title ? (
        <div className="mb-4 text-[13.5px] font-medium tracking-tight text-fg">{title}</div>
      ) : null}

      <ol className="space-y-1">
        {steps.map((step, index) => {
          const done = index < currentIndex
          const active = index === currentIndex && loading
          const failed = Boolean(error) && index === currentIndex

          return (
            <li key={step.label}>
              <motion.div
                initial={false}
                animate={{
                  backgroundColor: active ? 'var(--sonic-accent-softer)' : 'rgba(0,0,0,0)',
                  opacity: done || active ? 1 : 0.45
                }}
                transition={{ duration: 0.25, ease: [0.22, 1, 0.36, 1] }}
                className={cn(
                  'flex items-start gap-3 rounded-[2px] px-3 py-2.5',
                  failed && 'bg-danger/10'
                )}
              >
                <span
                  className={cn(
                    'mt-0.5 grid size-4 shrink-0 place-items-center rounded-full border',
                    done && 'border-success bg-success text-white',
                    active && !failed && 'border-accent text-accent',
                    failed && 'border-danger text-danger',
                    !done && !active && !failed && 'border-line-strong text-transparent'
                  )}
                >
                  {done ? (
                    <Check className="size-2.5" strokeWidth={3.5} />
                  ) : active && !failed ? (
                    <Spinner size={11} />
                  ) : failed ? (
                    <span className="size-1.5 rounded-full bg-danger" />
                  ) : null}
                </span>

                <span className="min-w-0">
                  <span
                    className={cn(
                      'block text-[13.5px] font-medium',
                      failed ? 'text-danger' : done || active ? 'text-fg' : 'text-fg-muted'
                    )}
                  >
                    {step.label}
                  </span>
                  {step.description ? (
                    <span className="mt-0.5 block text-[12px] leading-relaxed text-fg-subtle">
                      {step.description}
                    </span>
                  ) : null}
                </span>
              </motion.div>
            </li>
          )
        })}
      </ol>
    </div>
  )
}
