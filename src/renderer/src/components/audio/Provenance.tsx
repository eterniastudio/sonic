import { useMemo, type ReactNode } from 'react'
import type { LibraryBeat } from '@shared/domain'
import { analyzedValuesFrom } from '@shared/analysis'
import { decideMetadataField, type FieldOrigin } from '@shared/metadata'
import { cn } from '@/lib/cn'

/** How each origin is marked and named. One vocabulary for rows, dock and inspector. */
export const ORIGIN_MARKS: Record<FieldOrigin, { mark: string; label: string; description: string }> = {
  manual: { mark: 'mark-marker', label: 'manual', description: 'Set manually' },
  title: { mark: 'mark-printed', label: 'title', description: 'From the source title' },
  description: { mark: 'mark-printed', label: 'description', description: 'From the source description' },
  filename: { mark: 'mark-printed', label: 'filename', description: 'From the audio filename' },
  embedded: { mark: 'mark-stamped', label: 'tag', description: 'From embedded audio tags' },
  audio: { mark: 'mark-measured', label: 'audio', description: 'Measured from the audio' },
  legacy: { mark: 'mark-printed', label: 'source unknown', description: 'Origin was not recorded for this value' },
  none: { mark: 'mark-printed', label: 'source unknown', description: 'No source is recorded for this value' }
}

export interface BeatOrigins {
  bpm: FieldOrigin
  key: FieldOrigin
  /** Analyzer confidence (0..1) behind measured values; null when not measured. */
  bpmConfidence: number | null
  keyConfidence: number | null
}

export function beatOrigins(beat: LibraryBeat): BeatOrigins {
  const evidence = {
    current: beat,
    // Older or partial records may lack evidence layers; they then read as unknown origin.
    overrides: beat.overrides ?? [],
    sources: beat.sources ?? { title: {}, description: {}, filename: {} },
    embedded: beat.embedded ?? {},
    analyzed: beat.analysis ? analyzedValuesFrom(beat.analysis) : {}
  }
  const bpm = decideMetadataField('bpm', evidence).origin
  const key = decideMetadataField(beat.key ? 'key' : 'camelot', evidence).origin
  return {
    bpm,
    key,
    bpmConfidence: bpm === 'audio' && beat.analysis ? beat.analysis.tempo.confidence : null,
    keyConfidence: key === 'audio' && beat.analysis ? beat.analysis.key.confidence : null
  }
}

export function useBeatOrigins(beat: LibraryBeat | null | undefined): BeatOrigins | null {
  return useMemo(() => (beat ? beatOrigins(beat) : null), [beat])
}

/**
 * A tempo or key value drawn in the mark of where it came from: printed from
 * the source, stamped from the file's tag, dotted when measured, or in marker
 * when the producer set it.
 */
export function ProvenanceValue({ value, origin, confidence = null, unknown = '—', className }: {
  value: string | null
  origin: FieldOrigin
  /** Shown as three ink dots on measured values only. */
  confidence?: number | null
  unknown?: string
  className?: string
}): ReactNode {
  if (value == null) return <span className={cn('mark-none', className)}>{unknown}</span>
  const entry = ORIGIN_MARKS[origin]
  const dots = origin === 'audio' && confidence != null ? confidenceDots(confidence) : null
  const level = dots == null ? '' : ` · ${['low', 'medium', 'high'][dots - 1]} confidence`
  return <span className={cn('whitespace-nowrap', className)} title={`${value} · ${entry.description}${level}`}>
    <span className={entry.mark}>{value}</span>
    {dots != null ? <ConfidenceDots filled={dots} /> : null}
  </span>
}

function confidenceDots(confidence: number): 1 | 2 | 3 {
  return confidence >= 0.66 ? 3 : confidence >= 0.33 ? 2 : 1
}

function ConfidenceDots({ filled }: { filled: number }): ReactNode {
  return <span aria-hidden="true" className="confidence-dots">
    {[1, 2, 3].map(index => <i key={index} data-on={index <= filled ? '' : undefined} />)}
  </span>
}

/** The mark vocabulary, spelled out once where the values are read. */
export function ProvenanceLegend({ className }: { className?: string }): ReactNode {
  return (
    <span role="note" aria-label="How tempo and key values are marked" className={cn('flex flex-wrap items-center gap-x-3 gap-y-1 text-[12px] text-fg-subtle', className)}>
      <span><span className="mark-printed">128</span> from source</span>
      <span><span className="mark-stamped">128</span> file tag</span>
      <span><span className="mark-measured">128</span><ConfidenceDots filled={2} /> measured</span>
      <span><span className="mark-marker">128</span> your correction</span>
    </span>
  )
}
