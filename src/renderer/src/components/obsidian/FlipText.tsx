import { AnimatePresence, motion } from 'motion/react'
import { useEffect, useState, type ReactNode } from 'react'
import { cn } from '@/lib/cn'

/**
 * Ported from ObsidianUI's *Flip Text*.
 *
 * Rotates a word list through a 3D flip on an interval. Pauses automatically
 * when the user prefers reduced motion, showing only the first word.
 */
export function FlipText({
  words,
  intervalMs = 2600,
  className
}: {
  words: string[]
  intervalMs?: number
  className?: string
}): ReactNode {
  const [index, setIndex] = useState(0)
  const reduced =
    typeof window !== 'undefined' &&
    window.matchMedia('(prefers-reduced-motion: reduce)').matches

  useEffect(() => {
    if (reduced || words.length < 2) return
    const timer = window.setInterval(() => {
      setIndex((current) => (current + 1) % words.length)
    }, intervalMs)
    return () => window.clearInterval(timer)
  }, [reduced, words.length, intervalMs])

  if (words.length === 0) return null

  return (
    <span
      className={cn('relative inline-grid overflow-hidden align-bottom', className)}
      style={{ perspective: '420px' }}
    >
      <AnimatePresence mode="wait" initial={false}>
        <motion.span
          key={words[reduced ? 0 : index]}
          initial={{ rotateX: -82, opacity: 0, y: '-0.2em' }}
          animate={{ rotateX: 0, opacity: 1, y: 0 }}
          exit={{ rotateX: 82, opacity: 0, y: '0.2em' }}
          transition={{ duration: 0.48, ease: [0.22, 1, 0.36, 1] }}
          className="col-start-1 row-start-1 inline-block will-change-transform"
          style={{ transformStyle: 'preserve-3d', backfaceVisibility: 'hidden' }}
        >
          {words[reduced ? 0 : index]}
        </motion.span>
      </AnimatePresence>
    </span>
  )
}
