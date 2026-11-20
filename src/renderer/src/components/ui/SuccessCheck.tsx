import { useLayoutEffect, useRef, type ReactNode } from 'react'
import { cn } from '@/lib/cn'

/**
 * Animated confirmation mark built on the transitions.dev success-check snippet.
 *
 * The snippet ships `stroke-dasharray: 20` as a placeholder; the real value has
 * to come from `path.getTotalLength()` or the stroke either pre-reveals or
 * over-draws. It is measured and written here on mount.
 */
export function SuccessCheck({
  size = 44,
  className
}: {
  size?: number
  className?: string
}): ReactNode {
  const pathRef = useRef<SVGPathElement | null>(null)

  useLayoutEffect(() => {
    const path = pathRef.current
    if (!path) return
    const length = Math.ceil(path.getTotalLength()) + 1
    path.style.strokeDasharray = String(length)
    path.style.strokeDashoffset = String(length)
  }, [])

  return (
    <span className={cn('t-success-check', className)} data-state="in" role="img" aria-label="Done">
      <svg width={size} height={size} viewBox="0 0 24 24" fill="none">
        <circle cx="12" cy="12" r="10.25" stroke="var(--sonic-success)" strokeWidth="1.5" opacity="0.28" />
        <path
          ref={pathRef}
          d="M7.4 12.4l3.1 3.1 6.1-6.6"
          stroke="var(--sonic-success)"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </svg>
    </span>
  )
}

export interface SkeletonProps {
  /** When false, the real content cross-fades in over the skeleton. */
  loading: boolean
  children: ReactNode
  /** Placeholder layer. Give the wrapper an explicit height. */
  placeholder: ReactNode
  className?: string
}

/**
 * Skeleton → content cross-fade built on the transitions.dev skeleton-reveal
 * snippet. Both layers are absolutely positioned, so the wrapper must establish
 * a height (e.g. `h-40`, or an aspect-ratio utility).
 */
export function Skeleton({ loading, children, placeholder, className }: SkeletonProps): ReactNode {
  return (
    <div className={cn('t-skel', !loading && 'is-revealed', className)}>
      <div className="t-skel-skeleton is-pulsing">{placeholder}</div>
      <div className="t-skel-content">{children}</div>
    </div>
  )
}

/** A single shimmering block used to compose skeleton placeholders. */
export function SkeletonBar({ className }: { className?: string }): ReactNode {
  return (
    <div
      className={cn(
        'h-full w-full rounded-[2px] bg-surface-2',
        className
      )}
    />
  )
}
