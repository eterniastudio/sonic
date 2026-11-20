import { useState, type ReactNode } from 'react'
import { coverArtFor } from '@shared/url'
import { cn } from '@/lib/cn'

export interface TrackArtworkProps {
  sourceUrl?: string | null
  thumbnail?: string | null
  title: string
  className?: string
  iconClassName?: string
  /** `record` draws a blank label on vinyl; `label` fills the slot with label stock. */
  placeholder?: 'record' | 'label'
}

/**
 * Real source artwork. Without it the slot shows a blank white label on black
 * vinyl, the way an unreleased promo arrives.
 */
export function TrackArtwork({ sourceUrl, thumbnail, title, className, placeholder = 'record' }: TrackArtworkProps): ReactNode {
  const artworkUrl = thumbnail || coverArtFor(sourceUrl)
  const [failedUrl, setFailedUrl] = useState<string | null>(null)
  const hasArtwork = artworkUrl != null && artworkUrl !== failedUrl

  return (
    <span className={cn('relative block shrink-0 overflow-hidden bg-[var(--sonic-artwork-bg)]', className)}>
      {hasArtwork ? (
        <img
          key={artworkUrl}
          src={artworkUrl}
          alt={`Artwork for ${title}`}
          loading="lazy"
          decoding="async"
          onError={() => setFailedUrl(artworkUrl)}
          className="block size-full object-cover"
        />
      ) : (
        <span role="img" aria-label={`No artwork available for ${title}`} className={cn('grid size-full place-items-center', placeholder === 'label' ? 'bg-label' : 'bg-vinyl')}>
          {placeholder === 'record' ? <span aria-hidden="true" className="grid aspect-square w-[42%] place-items-center rounded-full bg-label">
            <span className="aspect-square w-[14%] min-w-[2px] rounded-full bg-vinyl" />
          </span> : null}
        </span>
      )}
    </span>
  )
}
