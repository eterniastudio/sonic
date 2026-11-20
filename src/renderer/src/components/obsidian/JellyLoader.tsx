import type { ReactNode } from 'react'
import { cn } from '@/lib/cn'

/**
 * Ported from ObsidianUI's *Jelly Loader*.
 *
 * Three blobs that squash, stretch and drift past each other. Pure CSS, so it
 * costs nothing and stays smooth while the main thread is busy with a download.
 */
export function JellyLoader({
  size = 40,
  className,
  label
}: {
  size?: number
  className?: string
  label?: string
}): ReactNode {
  return (
    <div
      className={cn('flex flex-col items-center gap-2.5', className)}
      role="status"
      aria-label={label ?? 'Loading'}
    >
      <div className="relative" style={{ width: size, height: size }}>
        <style>{`
          @keyframes sonic-jelly-1 {
            0%, 100% { transform: translate(0, 0) scale(1, 1); }
            25%      { transform: translate(0, -22%) scale(1.12, 0.86); }
            50%      { transform: translate(18%, 0) scale(0.88, 1.14); }
            75%      { transform: translate(0, 12%) scale(1.06, 0.94); }
          }
          @keyframes sonic-jelly-2 {
            0%, 100% { transform: translate(0, 0) scale(1, 1); }
            25%      { transform: translate(-16%, 10%) scale(0.9, 1.1); }
            50%      { transform: translate(0, -18%) scale(1.14, 0.86); }
            75%      { transform: translate(14%, 4%) scale(0.94, 1.06); }
          }
        `}</style>

        <span
          className="absolute inset-0 rounded-[42%] bg-accent opacity-90"
          style={{ animation: 'sonic-jelly-1 1.6s var(--ease-in-out) infinite' }}
        />
        <span
          className="absolute inset-[18%] rounded-[46%] bg-[color-mix(in_oklab,var(--sonic-accent)_55%,var(--sonic-cyan))] opacity-80"
          style={{ animation: 'sonic-jelly-2 1.6s var(--ease-in-out) infinite' }}
        />
      </div>

      {label ? <span className="text-[12px] text-fg-muted">{label}</span> : null}
    </div>
  )
}
