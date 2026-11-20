import { useState, type ReactNode } from 'react'
import type { LibraryBeat } from '@shared/domain'
import { formatBpm } from '@shared/format'
import type { FieldOrigin } from '@shared/metadata'
import { coverArtFor } from '@shared/url'
import { cn } from '@/lib/cn'
import { ProvenanceValue } from './Provenance'

/**
 * The inspected track as a record: black vinyl, a few cut grooves, and a
 * centre label. Source artwork prints onto the label; without it the label is
 * blank promo stock with the tempo and key written on it in their own marks.
 */
export function LabelDisc({ beat, origins, className }: {
  beat: LibraryBeat
  origins: { bpm: FieldOrigin; key: FieldOrigin }
  className?: string
}): ReactNode {
  const artworkUrl = beat.thumbnail || coverArtFor(beat.sourceUrl)
  const [failedUrl, setFailedUrl] = useState<string | null>(null)
  const hasArtwork = artworkUrl != null && artworkUrl !== failedUrl

  return (
    <span className={cn('relative grid aspect-square place-items-center rounded-full bg-vinyl', className)}>
      <span aria-hidden="true" className="absolute inset-[4%] rounded-full border border-white/[0.07]" />
      <span aria-hidden="true" className="absolute inset-[11%] rounded-full border border-white/[0.05]" />
      <span aria-hidden="true" className="absolute inset-[18%] rounded-full border border-white/[0.06]" />
      <span className="relative grid size-[58%] place-items-center overflow-hidden rounded-full bg-label text-[var(--sonic-vinyl)] [container-type:inline-size]">
        {hasArtwork ? (
          <img key={artworkUrl} src={artworkUrl} alt={`Artwork for ${beat.title}`} loading="lazy" decoding="async"
            onError={() => setFailedUrl(artworkUrl)} className="absolute inset-0 size-full object-cover" />
        ) : (
          <span role="img" aria-label={`No artwork available for ${beat.title}`} className="absolute inset-0 flex flex-col items-center justify-center gap-[22cqi] [--sonic-accent:#2f3bbf] [--sonic-fg:var(--sonic-vinyl)] [--sonic-fg-muted:#3d3d38] [--sonic-fg-subtle:#5c5c55]">
            <span className="text-[17cqi] leading-none"><ProvenanceValue value={beat.bpm != null ? formatBpm(beat.bpm) : null} origin={origins.bpm} unknown="— BPM" /></span>
            <span className="text-[10cqi] leading-none"><ProvenanceValue value={beat.key || beat.camelot || null} origin={origins.key} unknown="Key unknown" /></span>
            <span aria-hidden="true" className="absolute top-[17%] left-[9%] -rotate-[14deg] [@media(max-height:760px)]:hidden border-[1.5px] border-[#c4232f] px-[2cqi] text-[7cqi] leading-tight font-extrabold tracking-[0.04em] text-[#c4232f] [font-stretch:72%]">PROMO</span>
          </span>
        )}
        <span aria-hidden="true" className="absolute top-1/2 left-1/2 size-[7%] min-w-[4px] -translate-1/2 rounded-full bg-vinyl ring-1 ring-black/10" />
      </span>
    </span>
  )
}
