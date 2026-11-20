import type { ReactNode } from 'react'
import { cn } from '@/lib/cn'

/**
 * Sonic's monochrome level-meter mark.
 */
export function Logo({ size = 28, className }: { size?: number; className?: string }): ReactNode {
  const bars = [
    { x: 6, h: 6 },
    { x: 9.5, h: 11 },
    { x: 13, h: 16 },
    { x: 16.5, h: 10 },
    { x: 20, h: 5 }
  ]
  const centre = 14

  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 28 28"
      fill="none"
      aria-hidden="true"
      className={cn('shrink-0', className)}
    >
      {bars.map((bar, index) => (
        <rect
          key={index}
          x={bar.x}
          y={centre - bar.h / 2}
          width="2"
          height={bar.h}
          rx="1"
          fill="var(--sonic-fg)"
        />
      ))}
    </svg>
  )
}

/** Logo plus wordmark, used in the title bar. */
export function Wordmark({ className }: { className?: string }): ReactNode {
  return (
    <span className={cn('flex items-center gap-1.5', className)}>
      <Logo size={23} />
      <span className="label-type text-[17px] leading-none text-fg">
        Sonic
      </span>
    </span>
  )
}
