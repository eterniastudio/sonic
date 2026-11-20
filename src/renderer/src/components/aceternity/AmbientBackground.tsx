import { useCallback, useRef, type ReactNode } from 'react'
import { cn } from '@/lib/cn'

/**
 * Ported from Aceternity UI's background set (*Aurora Background*, *Sparkles*,
 * *Grid and Dot Backgrounds*), composed into one ambient layer.
 *
 * Kept low-contrast on purpose: it sits behind real content, so it should read
 * as depth rather than decoration.
 */

export function AuroraBackground({
  className,
  intensity = 1
}: {
  className?: string
  intensity?: number
}): ReactNode {
  return (
    <div className={cn('pointer-events-none absolute inset-0 overflow-hidden', className)} aria-hidden>
      <div
        className="absolute -top-1/3 left-[8%] size-[42rem] rounded-full blur-[110px]"
        style={{
          background: `radial-gradient(circle, color-mix(in oklab, var(--sonic-accent) ${34 * intensity}%, transparent), transparent 68%)`,
          animation: 'sonic-drift 18s var(--ease-in-out) infinite'
        }}
      />
      <div
        className="absolute -right-[10%] -bottom-1/4 size-[36rem] rounded-full blur-[120px]"
        style={{
          background: `radial-gradient(circle, color-mix(in oklab, var(--sonic-cyan) ${24 * intensity}%, transparent), transparent 70%)`,
          animation: 'sonic-drift 24s var(--ease-in-out) infinite reverse'
        }}
      />
      <div
        className="absolute top-1/4 right-1/3 size-[26rem] rounded-full blur-[100px]"
        style={{
          background: `radial-gradient(circle, color-mix(in oklab, var(--sonic-accent) ${16 * intensity}%, transparent), transparent 72%)`,
          animation: 'sonic-drift 30s var(--ease-in-out) infinite'
        }}
      />
    </div>
  )
}

/** Deterministic pseudo-random sparkles — stable across renders, no state. */
export function Sparkles({ count = 26, className }: { count?: number; className?: string }): ReactNode {
  const dots = Array.from({ length: count }, (_, index) => {
    // A cheap hash keeps positions stable between renders without useMemo.
    const a = (index * 9301 + 49297) % 233280
    const b = (index * 4523 + 12345) % 199999
    return {
      left: `${(a / 233280) * 100}%`,
      top: `${(b / 199999) * 100}%`,
      delay: `${(index % 9) * 0.4}s`,
      size: index % 5 === 0 ? 2.5 : 1.5,
      duration: `${2.6 + (index % 5) * 0.5}s`
    }
  })

  return (
    <div className={cn('pointer-events-none absolute inset-0 overflow-hidden', className)} aria-hidden>
      <style>{`
        @keyframes sonic-sparkle {
          0%, 100% { opacity: 0; transform: scale(0.6); }
          45%      { opacity: 0.9; transform: scale(1); }
        }
      `}</style>
      {dots.map((dot, index) => (
        <span
          key={index}
          className="absolute rounded-full bg-accent"
          style={{
            left: dot.left,
            top: dot.top,
            width: dot.size,
            height: dot.size,
            animation: `sonic-sparkle ${dot.duration} var(--ease-in-out) ${dot.delay} infinite`
          }}
        />
      ))}
    </div>
  )
}

export interface AmbientBackgroundProps {
  variant?: 'none' | 'aurora' | 'dots' | 'grid' | 'full'
  intensity?: number
  className?: string
}

export function AmbientBackground({
  variant = 'full',
  intensity = 1,
  className
}: AmbientBackgroundProps): ReactNode {
  if (variant === 'none') return null

  return (
    <div className={cn('pointer-events-none absolute inset-0 overflow-hidden', className)} aria-hidden>
      {variant === 'grid' || variant === 'full' ? (
        <div className="grid-bg absolute inset-0 opacity-70" />
      ) : null}
      {variant === 'dots' || variant === 'full' ? (
        <div className="dot-bg absolute inset-0 opacity-60" />
      ) : null}
      {variant === 'aurora' || variant === 'full' ? (
        <AuroraBackground intensity={intensity} />
      ) : null}
      {variant === 'full' ? <Sparkles /> : null}
      {/* Vignette so the ambient layer never washes out foreground text. */}
      <div
        className="absolute inset-0"
        style={{
          background:
            'radial-gradient(120% 90% at 50% 0%, transparent 40%, color-mix(in oklab, var(--sonic-bg) 88%, transparent) 100%)'
        }}
      />
    </div>
  )
}

/**
 * Ported from Aceternity UI's *Card Spotlight*.
 *
 * A radial highlight tracks the pointer across the card surface. The gradient is
 * painted once and repositioned through custom properties, so the pointer never
 * triggers layout or a repaint of the whole surface.
 */
export function CardSpotlight({
  children,
  className,
  radius = 260,
  disabled
}: {
  children: ReactNode
  className?: string
  radius?: number
  disabled?: boolean
}): ReactNode {
  const ref = useRef<HTMLDivElement | null>(null)

  const onPointerMove = useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      if (disabled) return
      const element = ref.current
      if (!element) return
      const bounds = element.getBoundingClientRect()
      element.style.setProperty('--spot-x', `${event.clientX - bounds.left}px`)
      element.style.setProperty('--spot-y', `${event.clientY - bounds.top}px`)
    },
    [disabled]
  )

  return (
    <div
      ref={ref}
      onPointerMove={onPointerMove}
      className={cn('group/spotlight relative overflow-hidden', className)}
    >
      {!disabled ? (
        <span
          aria-hidden
          className="pointer-events-none absolute inset-0 opacity-0 transition-opacity duration-[var(--duration-medium)] ease-[var(--ease-smooth-out)] group-hover/spotlight:opacity-100"
          style={{
            background: `radial-gradient(${radius}px circle at var(--spot-x, 50%) var(--spot-y, 50%), color-mix(in oklab, var(--sonic-accent) 14%, transparent), transparent 72%)`
          }}
        />
      ) : null}
      <div className="relative">{children}</div>
    </div>
  )
}
