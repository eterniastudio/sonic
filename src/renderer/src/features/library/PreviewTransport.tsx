import { useEffect, useId, useRef, useState, type ReactNode } from 'react'
import {
  Copy,
  MoreHorizontal,
  ExternalLink,
  FileJson,
  FolderOpen,
  Play,
  Timer,
  Trash2,
  TriangleAlert,
  X
} from 'lucide-react'
import type { LibraryBeat } from '@shared/domain'
import type { StorageStatus } from '@shared/ipc'
import { analyzedValuesFrom, describeAnalysisStatus, needsAnalysisRefresh } from '@shared/analysis'
import { decideMetadataField, publishedTagStatus, BPM_MIN as MIN_BPM, BPM_MAX as MAX_BPM, type FieldOrigin } from '@shared/metadata'
import { parseKeyString } from '@shared/music'
import { formatBitrate, formatBpm, formatBytes, formatChannelCount, formatDuration, formatRelativeTime, formatSampleRate } from '@shared/format'
import { ipc } from '@/lib/ipc'
import { useIpcEvent, useNow } from '@/lib/hooks'
import { useApp } from '@/store/app'
import { ProvenanceValue } from '@/components/audio/Provenance'
import { LabelDisc } from '@/components/audio/LabelDisc'
import { Badge } from '@/components/ui/Badge'
import { Dropdown, DropdownItem, DropdownSeparator } from '@/components/ui/Dropdown'
import { Button, IconButton } from '@/components/ui/Button'
import { Tooltip } from '@/components/ui/Tooltip'
import { toast } from '@/components/ui/Toaster'
import { usePlaybackActions } from '@/features/playback/playbackSession'

/** Metadata inspector. Audio belongs to the persistent shell player. */
export function PreviewTransport({
  beat,
  onClose,
  onRequestDelete,
  onRequestExport,
  onLocateFile
}: {
  beat: LibraryBeat
  onClose: () => void
  onRequestDelete: () => void
  onRequestExport: () => void
  onLocateFile?: () => void
}): ReactNode {
  const { playOne } = usePlaybackActions()
  const updateBeatMetadata = useApp((state) => state.updateBeatMetadata)
  const now = useNow(30_000)
  const [storage, setStorage] = useState<StorageStatus[]>([])
  useIpcEvent('storage:changed', setStorage)
  useEffect(() => { void ipc.invoke('storage:status').then(setStorage).catch(() => undefined) }, [])
  const libraryStorage = storage.find(item => /[\\/]library\.json$/i.test(item.file))
  const librarySaved = libraryStorage != null && !libraryStorage.error && libraryStorage.persisted >= libraryStorage.revision
  const evidenceInput = { current: beat, overrides: beat.overrides, sources: beat.sources,
    embedded: beat.embedded, analyzed: beat.analysis ? analyzedValuesFrom(beat.analysis) : {} }
  const bpmDecision = decideMetadataField('bpm', evidenceInput)
  const keyDecision = decideMetadataField('key', evidenceInput)
  const tags = publishedTagStatus(beat, beat.publishedTags)

  const tapTimes = useRef<number[]>([])

  const [tapBpm, setTapBpm] = useState<number | null>(null)

  const applyBpm = (next: number | null): void => {
    if (next == null) return
    const clamped = Math.min(MAX_BPM, Math.max(MIN_BPM, Math.round(next * 10) / 10))
    void updateBeatMetadata(beat.id, { bpm: clamped }).catch(error => toast({ kind: 'error', title: 'Tempo was not fully saved', description: String(error) }))
  }

  const tap = (): void => {
    const now = performance.now()
    const recent = tapTimes.current.filter((time) => now - time < 2600)
    recent.push(now)
    tapTimes.current = recent

    if (recent.length < 2) {
      setTapBpm(null)
      return
    }

    const intervals: number[] = []
    for (let index = 1; index < recent.length; index += 1) {
      intervals.push(recent[index] - recent[index - 1])
    }
    const average = intervals.reduce((total, value) => total + value, 0) / intervals.length
    const bpm = Math.round(60000 / average)
    setTapBpm(bpm >= MIN_BPM && bpm <= MAX_BPM ? bpm : null)
  }

  return (
    <div data-preview-state="inspecting" className="p-4 [@media(max-height:760px)]:p-3">
      <div className="mb-3 flex items-center justify-between gap-2 [@media(max-height:760px)]:mb-2">
        <span className="section-label">Details</span>
        <IconButton label="Close preview" size="icon-xs" onClick={onClose}><X /></IconButton>
      </div>
      <div className="[@media(max-height:760px)]:flex [@media(max-height:760px)]:items-start [@media(max-height:760px)]:gap-3">
        <LabelDisc beat={beat} origins={{ bpm: bpmDecision.origin, key: keyDecision.origin }} className="mx-auto mb-4 w-[176px] [@media(max-height:760px)]:mx-0 [@media(max-height:760px)]:mb-0 [@media(max-height:760px)]:w-[76px] [@media(max-height:760px)]:shrink-0" />
        <div className="min-w-0">
          <h2 title={beat.title} className="text-[20px] leading-[1.2] font-bold [font-stretch:85%] break-words text-fg [@media(max-height:760px)]:line-clamp-3 [@media(max-height:760px)]:text-[16px] [@media(max-height:760px)]:leading-[1.3]">{beat.title}</h2>
          <p className="mt-1.5 text-[13.5px] leading-snug text-fg-muted [@media(max-height:760px)]:mt-1 [@media(max-height:760px)]:truncate [@media(max-height:760px)]:text-[12px]">{beat.producer || beat.sourceChannel || (beat.sourceKind === 'local' ? 'Local audio' : 'Unknown channel')}</p>
        </div>
      </div>
      <div className="mt-2 flex flex-wrap items-center gap-1.5 text-[12px] text-fg-subtle nums">
        <span>{beat.format.toUpperCase()}</span><span>·</span><span>{formatDuration(beat.durationSec)}</span><span>·</span><span>{formatBytes(beat.sizeBytes)}</span>
      </div>
      {beat.missing || beat.fileAccessError ? <div className="mt-3 space-y-2">
        <p className="text-[12px] leading-relaxed text-warning">{beat.fileAccessError ? `Audio file is unavailable: ${beat.fileAccessError}` : 'Audio file is missing. Locate the same file to keep this library entry and its metadata.'}</p>
        <p className="select-text break-all font-mono text-[12px] text-fg-subtle" title={beat.filePath}>{beat.filePath}</p>
        {onLocateFile ? <Button size="sm" variant="secondary" onClick={onLocateFile}>Locate file…</Button> : null}
      </div> : null}
      {beat.recoveryInfo ? <div className="mt-3 space-y-1 text-[12px] text-fg-muted">
        <p>{beat.recoveryInfo.sidecar === 'unresolved' ? 'Audio reconnected; sidecar unresolved.' : 'Audio reconnected.'}</p>
        <p className="select-text break-all font-mono text-[12px]" title={beat.filePath}>{beat.filePath}</p>
        {beat.recoveryInfo.ownership === 'read-only' ? <p>This file remains read-only. Metadata changes stay in your library; export a prepared copy when needed.</p> : null}
      </div> : null}

      <dl className="my-4 grid grid-cols-[minmax(0,0.85fr)_minmax(0,1.15fr)] gap-x-5 border-y border-line py-3.5 [@media(max-height:760px)]:my-2 [@media(max-height:760px)]:gap-x-4 [@media(max-height:760px)]:py-2">
        <div className="min-w-0 [@media(max-height:760px)]:grid [@media(max-height:760px)]:grid-cols-[auto_minmax(0,1fr)]">
          <dt className="text-[12px] text-fg-subtle">Tempo</dt>
          <dd className="mt-1 text-[28px] leading-tight text-fg [@media(max-height:760px)]:col-span-2"><ProvenanceValue value={beat.bpm != null ? formatBpm(beat.bpm) : null} origin={bpmDecision.origin} confidence={bpmDecision.origin === 'audio' ? beat.analysis?.tempo.confidence : null} /><span className="ml-1.5 text-[12px] font-normal tracking-normal text-fg-muted">BPM</span></dd>
          {beat.bpm != null ? <dd className="mt-1 [@media(max-height:760px)]:col-start-2 [@media(max-height:760px)]:row-start-1 [@media(max-height:760px)]:mt-0 [@media(max-height:760px)]:justify-self-end"><OriginMark origin={bpmDecision.origin} /></dd> : null}
        </div>
        <div className="min-w-0 [@media(max-height:760px)]:grid [@media(max-height:760px)]:grid-cols-[auto_minmax(0,1fr)]">
          <dt className="text-[12px] text-fg-subtle">Key</dt>
          <dd className="mt-2.5 flex flex-wrap items-baseline gap-x-2 gap-y-1 text-[20px] leading-tight text-fg [@media(max-height:760px)]:col-span-2 [@media(max-height:760px)]:mt-1"><ProvenanceValue value={beat.key || null} origin={keyDecision.origin} confidence={keyDecision.origin === 'audio' ? beat.analysis?.key.confidence : null} />{beat.camelot ? <span className="text-[12px] font-normal tracking-normal text-fg-muted">{beat.camelot}</span> : null}</dd>
          {beat.key ? <dd className="mt-1.5 [@media(max-height:760px)]:col-start-2 [@media(max-height:760px)]:row-start-1 [@media(max-height:760px)]:mt-0 [@media(max-height:760px)]:justify-self-end"><OriginMark origin={keyDecision.origin} /></dd> : null}
        </div>
      </dl>

      <div className="flex items-center gap-2">
        <Button variant="secondary" className="flex-1" leading={<Play className="fill-current" />} disabled={beat.missing || !!beat.fileAccessError} onClick={() => playOne(beat.id)}>Play this beat</Button>
        <Dropdown align="end" trigger={({ toggle }) => <IconButton label="Beat actions" variant="secondary" onClick={toggle}><MoreHorizontal /></IconButton>}>
          {close => <>
            <DropdownItem icon={<FolderOpen />} onSelect={async () => { await ipc.invoke('library:revealFile', beat.id); close() }}>Reveal in folder</DropdownItem>
            <DropdownItem icon={<ExternalLink />} onSelect={async () => { await ipc.invoke('library:openFile', beat.id); close() }}>Open in default player</DropdownItem>
            <DropdownItem icon={<FileJson />} disabled={beat.sidecarPath == null} onSelect={async () => {
              const opened = await ipc.invoke('library:openSidecarFile', beat.id)
              if (!opened) toast({ kind: 'error', title: 'No sidecar is recorded for this beat.' })
              close()
            }}>Show sidecar JSON</DropdownItem>
            {beat.fileOwnership === 'external' ? <DropdownItem icon={<Copy />} disabled={beat.missing} onSelect={() => { onRequestExport(); close() }}>Export prepared copy</DropdownItem> : null}
            <DropdownSeparator />
            <DropdownItem icon={<Trash2 />} tone="danger" onSelect={() => { onRequestDelete(); close() }}>{beat.fileOwnership === 'external' ? 'Remove from library' : 'Delete this beat'}</DropdownItem>
          </>}
        </Dropdown>
      </div>
      <div className="mt-2 flex flex-wrap items-center gap-1">
        <Tooltip label="Tap along to set the tempo"><button type="button" onClick={tap} className="flex h-8 items-center gap-1.5 rounded-[2px] px-2 text-[12px] text-fg-muted transition-colors hover:bg-surface-2 hover:text-fg"><Timer className="size-3.5" />Tap tempo</button></Tooltip>
        {tapBpm != null ? <button type="button" onClick={() => applyBpm(tapBpm)} className="h-7 rounded-[2px] bg-accent-soft px-2 text-[12px] font-medium text-accent" title="Apply the tapped tempo to this beat">Use {tapBpm}</button> : null}
        <span className="flex-1" />
        <Tooltip label="Halve the tempo"><IconButton label="Halve the tempo" size="icon-sm" disabled={beat.bpm == null || beat.bpm / 2 < MIN_BPM} onClick={() => applyBpm((beat.bpm ?? 0) / 2)}><span className="text-[12px] font-medium">½</span></IconButton></Tooltip>
        <Tooltip label="Double the tempo"><IconButton label="Double the tempo" size="icon-sm" disabled={beat.bpm == null || beat.bpm * 2 > MAX_BPM} onClick={() => applyBpm((beat.bpm ?? 0) * 2)}><span className="text-[12px] font-medium">2×</span></IconButton></Tooltip>
      </div>

      <div className="mt-3 flex flex-wrap items-center gap-2 border-t border-line pt-3">
        <AnalysisStatusBadge beat={beat} />
        <span className="flex-1" />
        <AnalyzeButton beat={beat} />
      </div>
      <MetadataCorrection key={beat.id} beat={beat} />
      {libraryStorage?.error ? <p role="alert" className="mt-3 text-[12px] leading-relaxed text-danger">Library changes could not be saved. {libraryStorage.error}</p> : null}
      <details className="mt-3 border-t border-line pt-3 text-[12px] text-fg-muted">
        <summary className="cursor-pointer font-medium text-fg-muted marker:text-fg-subtle">File &amp; metadata</summary>
        <dl className="mt-3 grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-2 text-[12px]">
          <dt className="text-fg-subtle">Added</dt><dd className="text-right">{formatRelativeTime(beat.addedAt, now)}</dd>
          {beat.sampleRate ? <><dt className="text-fg-subtle">Sample rate</dt><dd className="text-right nums">{formatSampleRate(beat.sampleRate)}</dd></> : null}
          {beat.bitrateKbps ? <><dt className="text-fg-subtle">Bitrate</dt><dd className="text-right nums">{formatBitrate(beat.bitrateKbps)}</dd></> : null}
          {beat.channels ? <><dt className="text-fg-subtle">Channels</dt><dd className="text-right">{formatChannelCount(beat.channels)}</dd></> : null}
          <dt className="text-fg-subtle">Preset</dt><dd className="text-right break-words">{beat.presetId}</dd>
          {beat.detune != null && beat.detune !== 0 ? <><dt className="text-fg-subtle">Detune</dt><dd className="text-right nums">{beat.detune > 0 ? '+' : ''}{beat.detune} ¢</dd></> : null}
        </dl>
        <p className="mt-3 break-all font-mono text-[12px] text-fg-subtle">{beat.fileName}</p>
        <div className="mt-3 flex flex-wrap gap-1.5">
          {beat.fileOwnership === 'external' ? <Badge size="sm" tone="outline">{beat.recoveryInfo ? 'read-only file' : 'local original'}</Badge> : null}
          {beat.overrides.length > 0 ? <Badge size="sm" tone="accent">{beat.overrides.length} manual</Badge> : null}
          <Badge size="sm" tone={librarySaved ? 'success' : 'warning'}>{librarySaved ? 'library saved' : libraryStorage ? 'library save pending' : 'library status checking'}</Badge>
          {beat.sidecarPath ? <Badge size="sm" tone={beat.sidecarSync?.status === 'error' ? 'danger' : beat.sidecarSync?.status === 'synced' ? 'success' : 'warning'}>sidecar {beat.sidecarSync?.status ?? 'pending'}</Badge> : null}
          <Badge size="sm" tone={tags === 'current' ? 'success' : tags === 'unknown' ? 'neutral' : 'warning'}>{tags === 'current' ? 'audio tags match' : tags === 'absent' ? 'audio tags absent' : tags === 'out-of-sync' ? 'audio tags need re-export' : 'audio tags unverified'}</Badge>
        </div>
      </details>
      {beat.analysis && beat.analysis.warnings.length > 0 ? <ul className="mt-3 space-y-1">{beat.analysis.warnings.map(warning => <li key={warning} className="flex gap-1.5 text-[12px] leading-relaxed text-warning"><TriangleAlert className="mt-0.5 size-3 shrink-0" /><span className="min-w-0">{warning}</span></li>)}</ul> : null}
    </div>
  )
}
/** Show the decision's real origin, including legacy values with no evidence. */
function OriginMark({ origin }: { origin: FieldOrigin }): ReactNode {
  const label = origin === 'embedded' ? 'tag' : origin === 'description' ? 'description' : origin === 'filename' ? 'filename' : origin === 'title' ? 'title' : origin === 'legacy' ? 'unknown' : origin
  return (
    <span
      title={origin === 'legacy' ? 'Origin was not saved for this older record' : `Source: ${label}`}
      className="inline-block text-[12px] leading-none text-fg-subtle capitalize"
    >
      {label}
    </span>
  )
}

function AnalysisStatusBadge({ beat }: { beat: LibraryBeat }): ReactNode {
  const tone: Record<string, 'neutral' | 'accent' | 'success' | 'warning' | 'danger'> = {
    'not-analyzed': 'neutral',
    queued: 'neutral',
    analyzing: 'accent',
    estimated: 'success',
    partial: 'accent',
    inconclusive: 'warning',
    failed: 'danger',
    cancelled: 'neutral'
  }
  const mismatch = beat.verification?.summary.mismatch ?? 0

  return (
    <>
      <Badge size="sm" tone={tone[beat.analysisStatus] ?? 'neutral'}>
        {describeAnalysisStatus(beat.analysisStatus).toLowerCase()}
      </Badge>
      {beat.analysis && needsAnalysisRefresh(beat) ? <Badge size="sm" tone="warning">analysis update available</Badge> : null}
      {mismatch > 0 ? (
        <Badge size="sm" tone="warning" icon={<TriangleAlert />}>
          source disagrees with audio
        </Badge>
      ) : null}
    </>
  )
}

/** Analyze / re-analyze / cancel, driven entirely by real state. */
function AnalyzeButton({ beat }: { beat: LibraryBeat }): ReactNode {
  const analyzeBeat = useApp((state) => state.analyzeBeat)
  const cancelAnalysis = useApp((state) => state.cancelAnalysis)

  if (beat.analysisStatus === 'analyzing' || beat.analysisStatus === 'queued') {
    return (
      <button
        type="button"
        onClick={() => void cancelAnalysis(beat.id)}
        className="h-7 rounded-[2px] border border-line bg-surface-2 px-2.5 text-[12px] text-fg-muted transition-colors duration-[var(--duration-quick)] hover:border-line-strong hover:text-fg"
      >
        Cancel analysis
      </button>
    )
  }

  const reanalyze = beat.analysis != null

  return (
    <button
      type="button"
      disabled={beat.missing || !!beat.fileAccessError}
      title={reanalyze && needsAnalysisRefresh(beat) ? 'Run the latest analysis. Your manual BPM and key corrections are preserved.' : undefined}
      onClick={() => {
        void analyzeBeat(beat.id, reanalyze).then((result) => {
          if (!result.ok && result.error) {
            toast({ kind: 'error', title: 'Analysis failed', description: result.error })
          } else if (result.ok) {
            toast({ kind: 'success', title: `Analyzed ${beat.title}` })
          }
        }).catch(error => toast({ kind: 'error', title: 'Analysis could not start', description: String(error) }))
      }}
      className="h-7 rounded-[2px] px-2 text-[12px] font-medium text-fg-muted transition-colors duration-[var(--duration-quick)] hover:bg-surface-2 hover:text-fg disabled:pointer-events-none disabled:opacity-40"
    >
      {reanalyze ? 'Re-analyze' : 'Analyze audio'}
    </button>
  )
}

type CorrectionDraft = { bpm: string | null; key: string | null }

/** Validates a typed draft into the patch the library accepts. */
function correctionPatch(draft: CorrectionDraft): { patch: { bpm?: number | null; key?: string | null } } | { field: 'bpm' | 'key'; error: string } {
  const patch: { bpm?: number | null; key?: string | null } = {}
  if (draft.bpm !== null) {
    const value = draft.bpm.trim()
    if (value !== '' && (!Number.isFinite(Number(value)) || Number(value) < MIN_BPM || Number(value) > MAX_BPM)) {
      return { field: 'bpm', error: `Tempo must be ${MIN_BPM}–${MAX_BPM} BPM.` }
    }
    patch.bpm = value === '' ? null : Number(value)
  }
  if (draft.key !== null) {
    const value = draft.key.trim()
    const parsed = parseKeyString(value)
    if (value !== '' && !parsed) return { field: 'key', error: 'Enter a key with its mode (for example F# minor) or a Camelot code (11A).' }
    patch.key = parsed?.key ?? null
  }
  return { patch }
}

export function MetadataCorrection({ beat }: { beat: LibraryBeat }): ReactNode {
  const update = useApp(state => state.updateBeatMetadata)
  const editorId = useId()
  const bpmRef = useRef<HTMLInputElement>(null)
  const keyRef = useRef<HTMLInputElement>(null)
  const evidenceInput = { current: beat, overrides: beat.overrides, sources: beat.sources,
    embedded: beat.embedded, analyzed: beat.analysis ? analyzedValuesFrom(beat.analysis) : {} }
  const bpmDecision = decideMetadataField('bpm', evidenceInput)
  const keyDecision = decideMetadataField('key', evidenceInput)
  // null means untouched; an empty string is an intentional manual clearing.
  // Read untouched values directly from the latest record so an analysis update
  // cannot freeze the other field or accidentally turn it into an override.
  const [draft, setDraft] = useState<CorrectionDraft>({ bpm: null, key: null })
  const bpm = draft.bpm ?? (beat.bpm == null ? '' : String(beat.bpm))
  const key = draft.key ?? beat.key ?? ''
  const dirty = draft.bpm !== null || draft.key !== null
  const [pending, setPending] = useState(false)
  const pendingRef = useRef(false)
  const [error, setError] = useState('')
  const [invalidField, setInvalidField] = useState<'bpm' | 'key' | null>(null)
  const [feedback, setFeedback] = useState('')
  const analysis = beat.analysis?.key
  const candidates = [...new Set([analysis?.key, ...(analysis?.alternatives.map(candidate => candidate.key) ?? [])]
    .filter((candidate): candidate is string => Boolean(candidate)))].slice(0, 4)
  const mounted = useRef(true)
  const latest = useRef({ draft, update })
  useEffect(() => { latest.current = { draft, update } })
  useEffect(() => {
    mounted.current = true
    const beatId = beat.id
    // Selecting another track or closing the inspector saves a valid draft; an
    // in-flight save already carries it, and an invalid one is reported.
    return () => {
      mounted.current = false
      const { draft: unsaved, update: commit } = latest.current
      if (pendingRef.current || (unsaved.bpm === null && unsaved.key === null)) return
      latest.current = { ...latest.current, draft: { bpm: null, key: null } }
      const result = correctionPatch(unsaved)
      if ('error' in result) { toast({ kind: 'error', title: 'BPM / key correction was not saved', description: result.error }); return }
      void commit(beatId, result.patch).catch(failure => toast({ kind: 'error', title: 'BPM / key correction was not saved', description: String(failure) }))
    }
  }, [beat.id])
  const save = async (action?: { kind: 'reset' | 'measured'; field: 'bpm' | 'key' }, quiet = false): Promise<void> => {
    if (pendingRef.current) return
    setInvalidField(null); setFeedback('')
    let patch: { bpm?: number | null; key?: string | null } = {}
    if (!action) {
      const result = correctionPatch(draft)
      if ('error' in result) {
        setError(result.error); setInvalidField(result.field)
        if (!quiet) (result.field === 'bpm' ? bpmRef : keyRef).current?.focus()
        return
      }
      patch = result.patch
    }
    if (action?.kind === 'measured') {
      const measured = action.field === 'bpm' ? bpmDecision.measuredValue : keyDecision.measuredValue
      if (measured == null) { setError('No measured value is available for this field.'); return }
      if (action.field === 'bpm') patch.bpm = Number(measured)
      else patch.key = String(measured)
    }
    pendingRef.current = true
    setPending(true); setError('')
    try {
      await update(beat.id, patch, action?.kind === 'reset' ? action.field === 'key' ? ['key', 'camelot'] : ['bpm', 'altBpm'] : undefined)
      setDraft(current => action ? { ...current, [action.field]: null } : { bpm: null, key: null })
      setFeedback(action ? `${action.field === 'bpm' ? 'BPM' : 'Key'} correction saved.` : 'Corrections saved.')
    } catch (failure) {
      // A rejected operation can still have committed the library before an
      // optional output failed. Keep the submitted draft and explain the error;
      // do not infer success from a coincidentally matching incoming value.
      if (mounted.current) setError(String(failure))
      else toast({ kind: 'error', title: 'BPM / key correction was not saved', description: String(failure) })
    } finally { pendingRef.current = false; setPending(false) }
  }
  return <details className="mt-3 border-t border-line pt-3 text-[12px] text-fg-muted"><summary className="cursor-pointer font-medium marker:text-fg-subtle">Correct BPM / key</summary>
    <fieldset disabled={pending} aria-busy={pending || undefined} onBlur={event => {
      if (dirty && !event.currentTarget.contains(event.relatedTarget as Node | null)) void save(undefined, true)
    }} onKeyDown={event => {
      if ((event.ctrlKey || event.metaKey) && event.key === 'Enter' && dirty) { event.preventDefault(); void save() }
    }} className="mt-3 grid grid-cols-2 gap-2 [&_button]:rounded-[2px] [&_button]:px-2 [&_button]:py-1.5 [&_button]:text-[12px] [&_button]:transition-colors [&_button:disabled]:opacity-40">
      <label className="text-[12px] text-fg-subtle">BPM<input ref={bpmRef} inputMode="decimal" aria-label="Manual BPM" aria-invalid={invalidField === 'bpm' || undefined} aria-describedby={invalidField === 'bpm' ? `${editorId}-error` : undefined} className="mt-1 h-8 w-full rounded-[2px] border border-line bg-surface-2 px-2 text-[12px] text-fg" value={bpm} onChange={event => { setDraft(current => ({ ...current, bpm: event.target.value })); setFeedback(''); setInvalidField(null); setError('') }} /></label>
      <label className="text-[12px] text-fg-subtle">Key<input ref={keyRef} aria-label="Manual key" aria-invalid={invalidField === 'key' || undefined} aria-describedby={`${editorId}-key-help${invalidField === 'key' ? ` ${editorId}-error` : ''}`} className="mt-1 h-8 w-full rounded-[2px] border border-line bg-surface-2 px-2 text-[12px] text-fg" value={key} onChange={event => { setDraft(current => ({ ...current, key: event.target.value })); setFeedback(''); setInvalidField(null); setError('') }} /></label>
      <p id={`${editorId}-key-help`} className="col-span-2 text-[12px] leading-relaxed text-fg-subtle">Enter a key and mode (F# minor), or a Camelot code (11A). Ctrl+Enter saves; leaving this editor or the track also saves.</p>
      {candidates.length ? <section aria-label="Detected key candidates" className="col-span-2 space-y-2 rounded-[2px] border border-line p-2">
        <p className="text-[12px] text-fg">{analysis?.status === 'estimated' ? `Audio suggests ${analysis.key}` : 'Key needs a listening check'}</p>
        <p className="text-[12px] leading-relaxed text-fg-subtle">Choose a candidate to try, then save. Related keys can share notes; these are suggestions, not certainty.</p>
        <div className="flex flex-wrap gap-1">
          {candidates.map(candidate => {
            const parsed = parseKeyString(candidate)
            const selected = (parseKeyString(key)?.key ?? key) === candidate
            return <button key={candidate} type="button" aria-label={`Try ${candidate}${parsed?.camelot ? ` (${parsed.camelot})` : ''}`} aria-pressed={selected}
              className={selected ? 'bg-accent-soft text-accent' : 'border border-line hover:bg-surface-2'}
              onClick={() => { setDraft(current => ({ ...current, key: candidate })); setInvalidField(null); setError(''); setFeedback(`${candidate} selected. Save corrections to apply it.`) }}>
              {candidate}{parsed?.camelot ? <span className="ml-1 text-fg-subtle">{parsed.camelot}</span> : null}
            </button>
          })}
        </div>
      </section> : null}
      <button type="button" disabled={!dirty || pending} onClick={() => void save()} className="col-span-2 bg-accent-soft font-medium text-accent hover:bg-[var(--sonic-accent-line)]">{pending ? 'Saving…' : 'Save corrections'}</button>
      <button type="button" aria-label="Reset BPM to evidence priority" disabled={!beat.overrides.includes('bpm')} className="border border-line hover:bg-surface-2" onClick={() => void save({ kind: 'reset', field: 'bpm' })} title={`Evidence priority: ${bpmDecision.resetOrigin}`}>
        Reset BPM
      </button>
      <button type="button" aria-label="Reset key to evidence priority" disabled={!beat.overrides.includes('key')} className="border border-line hover:bg-surface-2" onClick={() => void save({ kind: 'reset', field: 'key' })} title={`Evidence priority: ${keyDecision.resetOrigin}`}>
        Reset key
      </button>
      <button type="button" disabled={bpmDecision.measuredValue == null} className="hover:bg-surface-2" onClick={() => void save({ kind: 'measured', field: 'bpm' })} title="Choose the audio estimate as a manual correction">Use measured BPM</button>
      <button type="button" disabled={keyDecision.measuredValue == null} className="hover:bg-surface-2" onClick={() => void save({ kind: 'measured', field: 'key' })} title="Choose the audio estimate as a manual correction">Use measured key</button>
    </fieldset>{error ? <p id={`${editorId}-error`} role="alert" className="mt-1 text-danger">{error}</p> : null}
    <p role="status" aria-live="polite" className="mt-1 text-[12px] text-fg-muted">{feedback}</p>
  </details>
}
