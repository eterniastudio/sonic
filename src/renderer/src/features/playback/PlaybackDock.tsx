import type { ReactNode } from 'react'
import { Pause, Play, Repeat, SkipBack, SkipForward, Volume2, X } from 'lucide-react'
import { formatBpm, formatDuration } from '@shared/format'
import type { FieldOrigin } from '@shared/metadata'
import { cn } from '@/lib/cn'
import { TrackArtwork } from '@/components/audio/TrackArtwork'
import { ORIGIN_MARKS, ProvenanceValue, useBeatOrigins } from '@/components/audio/Provenance'
import { IconButton } from '@/components/ui/Button'
import { usePlayback } from './playbackSession'

function TrackValue({ value, unknown, origin, confidence = null }: { value: string | null; unknown: string; origin: FieldOrigin; confidence?: number | null }): ReactNode {
  return (
    <span className="flex min-w-0 items-baseline gap-1">
      <ProvenanceValue value={value} origin={origin} confidence={confidence} unknown={unknown} className="shrink-0" />
      {value ? <span className="truncate text-[12px] text-fg-subtle">{ORIGIN_MARKS[origin].label}</span> : null}
    </span>
  )
}

/**
 * The record on the platter: the source artwork as the centre label of a black
 * disc that turns at 33 1/3 while audio plays and settles when it stops.
 */
function Platter({ beat, spinning }: { beat: { thumbnail?: string | null; sourceUrl?: string | null; title: string } | null; spinning: boolean }): ReactNode {
  return (
    <span className="relative grid size-[56px] shrink-0 place-items-center rounded-full bg-vinyl shadow-[inset_0_0_0_1px_var(--sonic-border-strong)]">
      <span aria-hidden="true" className="absolute inset-[3px] rounded-full border border-white/[0.06]" />
      <span aria-hidden="true" className="absolute inset-[8px] rounded-full border border-white/[0.05]" />
      <span aria-hidden="true" className="absolute inset-[13px] rounded-full border border-white/[0.04]" />
      <span
        className="relative size-[26px] overflow-hidden rounded-full"
        style={{ animation: 'sonic-spin 1.8s linear infinite', animationPlayState: spinning ? 'running' : 'paused' }}
      >
        <TrackArtwork thumbnail={beat?.thumbnail} sourceUrl={beat?.sourceUrl} title={beat?.title ?? 'No track selected'} className="size-full" placeholder="label" />
        <span aria-hidden="true" className="absolute top-1/2 left-1/2 size-[4px] -translate-1/2 rounded-full bg-vinyl" />
      </span>
    </span>
  )
}

/** Stable shell surface: its waveform node never belongs to a routed view. */
export function PlaybackDock(): ReactNode {
  const playback = usePlayback()
  const {
    beat, beatId, closing, status, current, duration, volume, repeat, queueContext,
    error, saveError, attachWaveform, previous, next, toggle, stop, seek, checkpointNow,
    setVolume, setRepeat, retrySave
  } = playback
  const hasTrack = beatId != null
  const playing = status === 'playing'
  const seekingAllowed = hasTrack && ['ready', 'playing', 'paused', 'ended'].includes(status)
  const elapsed = Math.max(0, Number.isFinite(current) ? current : 0)
  const length = Math.max(0, Number.isFinite(duration) && duration > 0 ? duration : beat?.durationSec ?? 0)
  const artist = beat?.producer || beat?.sourceChannel || (beat?.sourceKind === 'local' ? 'Local audio' : 'Unknown channel')
  const queueLabel = queueContext ? `${queueContext.label} · ${queueContext.index} of ${queueContext.count}` : null
  const provenance = useBeatOrigins(beat)
  const statusLabel = playing
    ? 'Now playing'
    : status === 'loading'
      ? 'Loading audio'
      : status === 'paused'
        ? 'Paused'
        : status === 'ended'
          ? 'Finished'
          : status === 'error'
            ? 'Could not play'
            : hasTrack ? 'Ready to play' : 'Player'

  return (
    <section
      aria-label="Audition player"
      data-playback-dock
      data-playback-state={status}
      data-playback-beat-id={beatId ?? ''}
      aria-busy={closing && !saveError}
      className="relative z-10 shrink-0 border-t border-line bg-[var(--sonic-transport)] px-5 py-3"
    >
      <div className="grid min-w-0 grid-cols-[minmax(260px,1.1fr)_112px_minmax(180px,1.15fr)_auto] items-center gap-x-4">
        <div className="flex min-w-0 items-center gap-3">
          <Platter beat={beat ?? null} spinning={playing} />
          <div className="min-w-0 flex-1">
            <span className="sr-only" role="status">{statusLabel}</span>
            <p className="truncate text-[13.5px] leading-[18px] font-bold text-fg" title={beat?.title}>
              {beat?.title ?? 'Choose a beat to audition'}
            </p>
            <p className="truncate text-[12px] leading-4 text-fg-muted" title={beat ? [artist, queueLabel].filter(Boolean).join(' · ') : undefined}>
              {beat ? artist : 'Select a track from your Library'}
              {queueLabel ? <><span aria-hidden="true"> · </span><span>{queueLabel}</span></> : null}
            </p>
            {beat && provenance ? <div role="group" aria-label="Track metadata" className="mt-1 flex min-w-0 items-center gap-2.5 text-[13.5px] leading-[17px]">
              <TrackValue value={beat.bpm != null ? `${formatBpm(beat.bpm)} BPM` : null} unknown="BPM unknown" origin={provenance.bpm} confidence={provenance.bpmConfidence} />
              <TrackValue value={beat.key || beat.camelot || null} unknown="Key unknown" origin={provenance.key} confidence={provenance.keyConfidence} />
            </div> : null}
          </div>
        </div>

        <div className="flex items-center justify-center gap-1">
          <IconButton label="Previous track" size="icon-sm" disabled={closing || !hasTrack} onClick={previous}>
            <SkipBack />
          </IconButton>
          <button
            type="button"
            aria-label={playing ? 'Pause audition' : 'Play audition'}
            disabled={closing || !hasTrack}
            onClick={toggle}
            className={cn(
              'grid size-10 shrink-0 place-items-center rounded-full bg-accent text-accent-fg',
              'transition-[background-color,transform] duration-[var(--duration-fast)] active:scale-95',
              'hover:bg-[var(--sonic-accent-hover)] disabled:cursor-not-allowed disabled:bg-surface-2 disabled:text-fg-subtle'
            )}
          >
            {playing ? <Pause className="size-4 fill-current" /> : <Play className="size-4 translate-x-px fill-current" />}
          </button>
          <IconButton label="Next track" size="icon-sm" disabled={closing || !hasTrack} onClick={next}>
            <SkipForward />
          </IconButton>
        </div>

        <div className="min-w-0">
          <div className="relative h-[25px] overflow-hidden">
            {!hasTrack ? <span aria-hidden="true" className="absolute inset-x-0 top-1/2 h-px bg-line" /> : null}
            <div className="h-[25px]" data-waveform ref={attachWaveform} />
          </div>
          <div className="flex min-w-0 items-center gap-2 text-[12px] text-fg-subtle nums">
            <span className="w-8 shrink-0">{formatDuration(elapsed)}</span>
            <input
              aria-label="Seek preview"
              type="range"
              className="h-6 min-w-0 flex-1 cursor-pointer disabled:cursor-default"
              min="0"
              max={Math.max(1, length)}
              step="0.1"
              value={Math.min(elapsed, Math.max(1, length))}
              disabled={closing || !seekingAllowed}
              onChange={event => seek(Number(event.target.value))}
              onPointerUp={checkpointNow}
              onKeyUp={checkpointNow}
              onBlur={checkpointNow}
            />
            <span className="w-8 shrink-0 text-right">{formatDuration(length)}</span>
          </div>
        </div>

        <div className="flex shrink-0 items-center gap-1">
          <div className="mr-2 flex items-center gap-2">
            <Volume2 aria-hidden="true" className="size-3.5 text-fg-subtle" />
            <input aria-label="Preview volume" type="range" min="0" max="1" step="0.05" value={volume} disabled={closing}
              onChange={event => setVolume(Number(event.target.value))} className="h-6 w-14 cursor-pointer disabled:cursor-default" />
          </div>
          <IconButton label="Repeat track" size="icon-sm" aria-pressed={repeat} className={repeat ? 'text-accent' : undefined}
            disabled={closing || !hasTrack} onClick={() => setRepeat(!repeat)}><Repeat /></IconButton>
          <IconButton label="Stop playback" size="icon-sm" disabled={closing || (!hasTrack && status !== 'error')} onClick={stop}><X /></IconButton>
        </div>
      </div>
      {closing && !saveError ? <p role="status" className="mt-1 text-[12px] text-fg-muted">Finishing listening save…</p> : null}
      {error ? <p role="alert" className="mt-1 text-[12px] text-danger">{error}</p> : null}
      {saveError ? <div className="mt-1 flex items-center gap-2 text-[12px] text-warning">
        <span>Listening state was not saved: {saveError}</span>
        <button type="button" onClick={() => { void retrySave().catch(() => undefined) }} className="underline underline-offset-2">Retry save</button>
      </div> : null}
    </section>
  )
}
