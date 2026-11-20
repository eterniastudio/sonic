import { useEffect, useRef, type ReactNode } from 'react'
import { cn } from '@/lib/cn'

/**
 * Ported from ObsidianUI's *Draggable Marquee*.
 *
 * An infinite horizontal marquee you can grab and scrub. The transform is
 * written straight to the node inside a rAF loop rather than through state, so
 * a continuous animation costs no React renders.
 */
export interface DraggableMarqueeProps {
  children: ReactNode
  /** Pixels per second. Negative scrolls the other way. */
  speed?: number
  className?: string
  reverse?: boolean
}

export function DraggableMarquee({
  children,
  speed = 34,
  className,
  reverse
}: DraggableMarqueeProps): ReactNode {
  const viewportRef = useRef<HTMLDivElement | null>(null)
  const trackRef = useRef<HTMLDivElement | null>(null)
  const offsetRef = useRef(0)
  const halfRef = useRef(0)
  const draggingRef = useRef(false)
  const lastXRef = useRef(0)

  useEffect(() => {
    const track = trackRef.current
    if (!track) return

    const measure = (): void => {
      // The track holds two identical copies; one copy is the loop length.
      halfRef.current = track.scrollWidth / 2
    }
    measure()

    const direction = reverse ? -1 : 1
    let frame = 0
    let last = performance.now()

    const step = (now: number): void => {
      const delta = Math.min(0.05, (now - last) / 1000)
      last = now

      if (!draggingRef.current) offsetRef.current -= speed * direction * delta

      const half = halfRef.current
      let offset = offsetRef.current
      if (half > 0) offset = (((offset % half) + half) % half) - half
      track.style.transform = `translate3d(${offset}px,0,0)`

      frame = requestAnimationFrame(step)
    }

    frame = requestAnimationFrame(step)

    const observer = new ResizeObserver(measure)
    observer.observe(track)

    return () => {
      cancelAnimationFrame(frame)
      observer.disconnect()
    }
  }, [speed, reverse])

  return (
    <div
      ref={viewportRef}
      className={cn('group relative overflow-hidden', className)}
      style={{
        maskImage: 'linear-gradient(90deg, transparent, #000 8%, #000 92%, transparent)',
        WebkitMaskImage: 'linear-gradient(90deg, transparent, #000 8%, #000 92%, transparent)'
      }}
    >
      <div
        ref={trackRef}
        role="presentation"
        onPointerDown={(event) => {
          draggingRef.current = true
          lastXRef.current = event.clientX
          event.currentTarget.setPointerCapture(event.pointerId)
        }}
        onPointerMove={(event) => {
          if (!draggingRef.current) return
          offsetRef.current += event.clientX - lastXRef.current
          lastXRef.current = event.clientX
        }}
        onPointerUp={() => {
          draggingRef.current = false
        }}
        onPointerCancel={() => {
          draggingRef.current = false
        }}
        className="flex w-max cursor-grab items-center active:cursor-grabbing"
      >
        {/* Two copies make the wrap seamless. */}
        <div className="flex shrink-0 items-center">{children}</div>
        <div className="flex shrink-0 items-center" aria-hidden>
          {children}
        </div>
      </div>
    </div>
  )
}
