import type { KeyboardEvent, MouseEvent, ReactNode } from 'react'
import { cn } from '@/lib/cn'
import { useTilt } from '../motion/usePresence'

export interface TiltCardProps {
  children: ReactNode
  className?: string
  /** Cursor-tracked glare overlay. */
  glare?: boolean
  disabled?: boolean
  onClick?: (event: MouseEvent | KeyboardEvent) => void
  onContextMenu?: (event: MouseEvent) => void
}

/**
 * 3D pointer tilt built on the transitions.dev card-tilt snippet.
 *
 * Pointer tracking is bound to the flat outer wrapper, not the rotating card —
 * binding to the card lets its edges slip out from under the cursor and makes
 * the hover flicker.
 */
export function TiltCard({
  children,
  className,
  glare = true,
  disabled,
  onClick,
  onContextMenu
}: TiltCardProps): ReactNode {
  const { wrapRef, cardRef, tiltProps } = useTilt(!disabled)

  return (
    <div ref={wrapRef} className={cn('t-tilt', className)} onContextMenu={onContextMenu} {...tiltProps}>
      <div
        ref={cardRef}
        className="t-tilt-card h-full w-full"
        onClick={onClick}
        role={onClick ? 'button' : undefined}
        tabIndex={onClick ? 0 : undefined}
        onKeyDown={
          onClick
            ? (event) => {
                if (event.key === 'Enter' || event.key === ' ') {
                  event.preventDefault()
                  onClick(event)
                }
              }
            : undefined
        }
      >
        {children}
        {glare ? <span className="t-tilt-glare" aria-hidden /> : null}
      </div>
    </div>
  )
}
