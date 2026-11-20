import { AnimatePresence, motion } from 'motion/react'
import { useRef, useState, type ReactNode } from 'react'
import { cn } from '@/lib/cn'

/**
 * Ported from Aceternity UI's *Animated Tooltip*.
 *
 * Rather than Aceternity's fixed avatar row, this is the general form: any
 * trigger with a rich card that follows the pointer. Used on compact library
 * rows where a single line of text is not enough to identify a beat.
 */
export interface AnimatedTooltipProps {
  trigger: ReactNode
  content: ReactNode
  /** Horizontal offset from the pointer, clamped to the viewport. */
  offset?: number
  className?: string
  contentClassName?: string
}

export function AnimatedTooltip({
  trigger,
  content,
  offset = 18,
  className,
  contentClassName
}: AnimatedTooltipProps): ReactNode {
  const [visible, setVisible] = useState(false)
  const [position, setPosition] = useState({ x: 0, y: 0 })
  const lastPointer = useRef({ x: 0, y: 0 })

  const onPointerMove = (event: React.PointerEvent<HTMLDivElement>): void => {
    lastPointer.current = { x: event.clientX, y: event.clientY }
    // Flip to the left of the pointer when there is not enough room on the right.
    const cardWidth = 268
    const x =
      event.clientX + offset + cardWidth > window.innerWidth
        ? event.clientX - offset - cardWidth
        : event.clientX + offset
    setPosition({ x, y: event.clientY + offset })
  }

  return (
    <div
      className={cn('relative', className)}
      onPointerEnter={() => setVisible(true)}
      onPointerLeave={() => setVisible(false)}
      onPointerMove={onPointerMove}
    >
      {trigger}

      <AnimatePresence>
        {visible ? (
          <motion.div
            initial={{ opacity: 0, scale: 0.95, filter: 'blur(4px)' }}
            animate={{ opacity: 1, scale: 1, filter: 'blur(0px)' }}
            exit={{ opacity: 0, scale: 0.97, filter: 'blur(3px)' }}
            transition={{ duration: 0.2, ease: [0.22, 1, 0.36, 1] }}
            style={{
              position: 'fixed',
              left: position.x,
              top: position.y,
              pointerEvents: 'none'
            }}
            className={cn(
              'z-[150] w-[268px] overflow-hidden rounded-[2px] border border-line bg-surface shadow-pop',
              contentClassName
            )}
          >
            {content}
          </motion.div>
        ) : null}
      </AnimatePresence>
    </div>
  )
}
