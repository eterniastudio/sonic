import { EventEmitter } from 'node:events'
import { isStopping } from '../lifecycle'
import path from 'node:path'
import type { Evidence, Job, JobStage, MetadataConflict, MetadataDraft, MetadataField, MetadataValues } from '@shared/domain'
import type { JobPatch } from '@shared/ipc'
import { applyFinalEdit, adoptAnalyzed, buildAudioEvidence, clearOverride, createDraft, emptyMetadata, parseDeclared, withAnalyzed, withEmbedded } from '@shared/metadata'
import { analyzedValuesFrom, type AudioAnalysis } from '@shared/analysis'
import { analysisService, type AnalysisProgress } from '../analysis/service'
import { extractVideoUrls, parseVideoUrl } from '@shared/url'
import { JsonStore, storageEvents } from '../lib/jsonStore'
import { createId } from '../lib/id'
import { sha256File } from '../lib/fsx'
import { acquireAudio, cleanStaging, sweepStaging } from './acquire'
import { fetchCover, forgetCover, pruneCovers } from './cover'
import { engineService } from './engine'
import { probeMediaFile, readEmbeddedMetadata, tagsToMetadata } from './ffprobe'
import { libraryService } from './library'
import { queueFile, stagingDir } from './paths'
import { probeUrl } from './probe'
import { buildTagContext, PendingPublicationError, publishExport } from './publish'
import { settingsService } from './settings'
import { sourceExtensionFor, transcode } from './transcode'

interface PersistedQueue {
  version: 1
  paused: boolean
  concurrency: number
  jobs: Job[]
}

const TERMINAL: JobStage[] = ['complete', 'failed', 'cancelled']
const NON_RESUMABLE: JobStage[] = ['downloading', 'analyzing', 'converting', 'tagging', 'publishing']
/** From conversion on, the reviewed metadata is already in the output being written. */
const METADATA_LOCKED: JobStage[] = ['converting', 'tagging', 'publishing', 'complete']
const PENDING_PUBLICATION = 'Export saved; its library record is waiting for Retry saving.'

/** Fields a metadata draft could carry before per-field overrides existed. */
const KNOWN_OVERRIDABLE = new Set<string>([
  'title',
  'producer',
  'bpm',
  'altBpm',
  'key',
  'camelot',
  'detune',
  'tuning',
  'genre'
])

/**
 * Brings a persisted draft forward to the current shape.
 *
 * Queue files written before audio analysis existed have no `analyzed`,
 * `sources`, `verification` or `overrides`, and carry a single global `dirty`
 * flag. That flag cannot say *which* field was edited, and inventing that would
 * risk overwriting a producer's correction — so it is translated into an
 * override only for fields that already hold a value. Empty fields stay open, so
 * an analysis can still fill them.
 */
function migrateDraft(raw: unknown): MetadataDraft {
  const draft = (raw ?? {}) as Partial<MetadataDraft> & { dirty?: boolean }

  const declared = draft.declared ?? {}
  const embedded = draft.embedded ?? {}
  const analyzed = draft.analyzed ?? {}
  const final = draft.final ?? { ...emptyMetadata(), title: String(declared.title ?? '') }

  const overrides: MetadataField[] =
    Array.isArray(draft.overrides)
      ? (draft.overrides.filter((field) => KNOWN_OVERRIDABLE.has(field)) as MetadataField[])
      : draft.dirty === true
        ? ([...KNOWN_OVERRIDABLE].filter((field) => {
            const value = (final as unknown as Record<string, unknown>)[field]
            return value != null && value !== ''
          }) as MetadataField[])
        : []

  const restored = createDraft({
    declared,
    embedded,
    analyzed,
    sources: draft.sources ?? { title: {}, description: {}, filename: {} },
    evidence: Array.isArray(draft.evidence) ? draft.evidence : [],
    audioEvidence: Array.isArray(draft.audioEvidence) ? draft.audioEvidence : [],
    overrides,
    analysis: draft.analysis ?? null
  })
  // createDraft builds evidence-derived values; it cannot restore manual values
  // from override names alone. Reconcile once with the persisted final layer as
  // previousFinal, including intentional manual nulls, and refresh verification.
  return withEmbedded({ ...restored, final: { ...emptyMetadata(), ...final } }, embedded)
}

function normalizeStage(value: unknown): JobStage {
  const stages: JobStage[] = [
    'probing',
    'ready',
    'queued',
    'downloading',
    'analyzing',
    'converting',
    'tagging',
    'publishing',
    'complete',
    'failed',
    'cancelled'
  ]
  return stages.includes(value as JobStage) ? (value as JobStage) : 'ready'
}

/**
 * Owns the export queue: intake, metadata inspection, the worker pool, and
 * crash recovery.
 *
 * Jobs live in memory for fast progress updates and are mirrored to disk on a
 * short debounce, so a hard exit loses at most a second of progress and every
 * interrupted job is recoverable on restart.
 */
class QueueService extends EventEmitter {
  private jobs: Job[] = []
  private readonly controllers = new Map<string, AbortController>()
  private readonly tasks = new Map<string, Promise<void>>()
  private readonly probeControllers = new Map<string, AbortController>()
  private readonly probing = new Set<string>()
  private readonly probeTasks = new Set<Promise<void>>()
  private shutdownTask: Promise<void> | null = null
  private paused = false
  private concurrency = 2
  private probeActive = 0
  private readonly probeConcurrency = 3
  private store: JsonStore<PersistedQueue>
  private emitTimer: NodeJS.Timeout | null = null
  private persistTimer: NodeJS.Timeout | null = null

  constructor() {
    super()
    this.store = new JsonStore<PersistedQueue>(
      queueFile(),
      { version: 1, paused: false, concurrency: 2, jobs: [] },
      (raw) => this.normalizePersisted(raw)
    )

    // Surface analysis progress on the owning job row.
    analysisService.on('progress', (progress: AnalysisProgress) => {
      const match = /^job:([^:]+):/.exec(progress.requestId)
      if (!match) return
      const id = match[1]
      if (!this.getJob(id)) return
      this.patch(id, { message: progress.message })
    })
  }

  // ---------------------------------------------------------------- lifecycle

  init(): void {
    const persisted = this.store.read()
    this.paused = persisted.paused
    this.concurrency = persisted.concurrency
    this.jobs = structuredClone(persisted.jobs)
    libraryService.scheduleRescan(settingsService.get().rescanIntervalMs)
    // A pending library record that is retried later completes its job in place.
    storageEvents.on('changed', () => this.reconcilePublished())
    libraryService.on('changed', () => this.reconcilePublished())
    this.reconcilePublished()
    void sweepStaging(id => this.getJob(id) !== null, id => this.controllers.has(id)).catch(() => undefined)
    void pruneCovers(this.jobs.map(job => job.id)).catch(() => undefined)
    // Anything that was mid-flight when the app closed goes back in the queue.
    this.pumpProbes()
    this.pump()
  }

  private normalizePersisted(raw: unknown): PersistedQueue {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('Invalid queue record')
    const source = (raw ?? {}) as Partial<PersistedQueue>
    if (!Array.isArray(source.jobs) || source.jobs.some(job => !job || typeof job !== 'object' || typeof job.id !== 'string')) {
      throw new Error('Invalid queue jobs; preserve the file and recover a validated backup')
    }
    const jobs = source.jobs

    const restored: Job[] = jobs
      .filter((job): job is Job => Boolean(job) && typeof job === 'object' && typeof job.id === 'string')
      .map((job) => {
        let stage = normalizeStage(job.stage)
        let message = job.message ?? null
        if (NON_RESUMABLE.includes(stage)) {
          stage = 'queued'
          message = 'Resuming after restart…'
        }
        if (stage === 'probing') message = 'Reading source metadata…'
        return {
          ...job,
          metadata: migrateDraft(job.metadata),
          stage,
          message,
          progress: stage === 'complete' ? 1 : 0,
          speed: null,
          eta: null,
          error: null
        }
      })

    return {
      version: 1,
      paused: source.paused === true,
      concurrency: Math.min(3, Math.max(1, Number(source.concurrency) || 2)),
      jobs: restored
    }
  }

  // ------------------------------------------------------------------ queries

  snapshot(): { jobs: Job[]; paused: boolean; concurrency: number } {
    return { jobs: this.jobs, paused: this.paused, concurrency: this.concurrency }
  }

  getJob(id: string): Job | null {
    return this.jobs.find((job) => job.id === id) ?? null
  }

  // ------------------------------------------------------------------- intake

  /** Creates jobs for every valid link and starts inspecting them immediately. */
  add(urls: string[]): { jobs: Job[]; paused: boolean; concurrency: number } {
    const settings = settingsService.get()
    const existing = new Set(this.jobs.filter((job) => !TERMINAL.includes(job.stage)).map((job) => job.url))

    for (const raw of urls) {
      const { accepted } = extractVideoUrls(raw, { allowOtherSites: settings.allowOtherSites === true })
      for (const parsed of accepted) {
        if (!parsed.normalized || !parsed.provider) continue
        if (existing.has(parsed.normalized)) continue
        existing.add(parsed.normalized)

        this.jobs.unshift({
          id: createId('job'),
          url: parsed.normalized,
          videoId: parsed.videoId,
          sourceKind: parsed.provider,
          sourceTitle: null,
          sourceDescription: null,
          uploader: null,
          thumbnail: null,
          durationSec: null,
          stage: 'probing',
          progress: 0,
          speed: null,
          eta: null,
          message: 'Reading source metadata…',
          error: null,
          presetId: settings.defaultPresetId,
          metadata: createDraft(),
          outputPath: null,
          libraryId: null,
          revision: 0,
          createdAt: Date.now(),
          updatedAt: Date.now()
        })
      }
    }

    this.markChanged(true)
    this.markPersist()
    this.pumpProbes()
    return this.snapshot()
  }

  async remove(id: string): Promise<{ jobs: Job[]; paused: boolean; concurrency: number }> {
    this.cancelActive(id)
    const target = this.getJob(id)
    if (target && target.stage !== 'complete') this.setStage(id, 'cancelled')
    await this.tasks.get(id)
    await cleanStaging(id, true)
    await forgetCover(id).catch(() => undefined)
    this.jobs = this.jobs.filter((job) => job.id !== id)
    this.markChanged(true)
    this.markPersist()
    return this.snapshot()
  }

  /** Starts every `ready` job, or just the named ones. */
  start(ids: string[] | null): { jobs: Job[]; paused: boolean; concurrency: number } {
    const targets =
      ids == null
        ? this.jobs.filter((job) => job.stage === 'ready')
        : this.jobs.filter((job) => ids.includes(job.id))

    for (const job of targets) {
      if (!['ready', 'queued', 'failed'].includes(job.stage) || this.controllers.has(job.id) || this.probing.has(job.id)) continue
      if (this.settlePublished(job)) continue
      this.setStage(job.id, 'queued', { progress: 0, error: null, message: 'Waiting for a worker…' })
    }

    if (this.paused) {
      this.paused = false
    }

    this.markChanged(true)
    this.markPersist()
    this.pump()
    return this.snapshot()
  }

  retry(id: string): { jobs: Job[]; paused: boolean; concurrency: number } {
    const job = this.getJob(id)
    if (!job || this.controllers.has(id) || this.probing.has(id)) return this.snapshot()
    if (this.settlePublished(job)) return this.snapshot()

    const needsProbe = !job.sourceTitle
    this.setStage(id, needsProbe ? 'probing' : 'queued', {
      progress: 0,
      error: null,
      speed: null,
      eta: null,
      message: needsProbe ? 'Reading source metadata…' : 'Waiting for a worker…'
    })
    this.markChanged(true)
    this.markPersist()
    if (needsProbe) this.pumpProbes()
    this.pump()
    return this.snapshot()
  }

  async cancel(id: string): Promise<{ jobs: Job[]; paused: boolean; concurrency: number }> {
    const job = this.getJob(id)
    if (!job) return this.snapshot()

    this.cancelActive(id)
    if (!TERMINAL.includes(job.stage)) {
      this.setStage(id, 'cancelled', { message: 'Cancelled', speed: null, eta: null })
      await this.tasks.get(id)
      await cleanStaging(id, true)
    }
    this.markChanged(true)
    this.markPersist()
    this.pump()
    return this.snapshot()
  }

  setPaused(paused: boolean): { jobs: Job[]; paused: boolean; concurrency: number } {
    this.paused = paused
    this.markChanged(true)
    this.markPersist()
    if (!paused) this.pump()
    return this.snapshot()
  }

  setConcurrency(value: number): { jobs: Job[]; paused: boolean; concurrency: number } {
    this.concurrency = Math.min(3, Math.max(1, Math.round(value) || 1))
    this.markChanged(true)
    this.markPersist()
    this.pump()
    return this.snapshot()
  }

  reorder(ids: string[]): { jobs: Job[]; paused: boolean; concurrency: number } {
    const byId = new Map(this.jobs.map((job) => [job.id, job]))
    const reordered: Job[] = []
    for (const id of ids) {
      const job = byId.get(id)
      if (job) {
        reordered.push(job)
        byId.delete(id)
      }
    }
    // Anything not mentioned keeps its relative position at the end.
    this.jobs = [...reordered, ...byId.values()]
    this.markChanged(true)
    this.markPersist()
    return this.snapshot()
  }

  clearFinished(): { jobs: Job[]; paused: boolean; concurrency: number } {
    this.jobs = this.jobs.filter((job) => job.stage !== 'complete' && job.stage !== 'cancelled')
    void pruneCovers(this.jobs.map(job => job.id)).catch(() => undefined)
    this.markChanged(true)
    this.markPersist()
    return this.snapshot()
  }

  updateJob(id: string, patch: JobPatch): Job | null {
    const job = this.getJob(id)
    if (!job) return null

    const next: Partial<Job> = { updatedAt: Date.now() }

    if (patch.presetId) {
      if (!['ready', 'queued', 'failed', 'cancelled'].includes(job.stage)) throw new Error('The format is locked once processing starts. Re-export completed audio from the library.')
      next.presetId = patch.presetId
    }

    if ((patch.metadataEdit || patch.clearOverrides?.length || patch.adoptAnalyzed?.length) &&
      (METADATA_LOCKED.includes(job.stage) || job.libraryId)) {
      throw new Error('Metadata is locked once conversion starts. Edit the finished track from the Library inspector.')
    }

    if (patch.metadataEdit) {
      next.metadata = applyFinalEdit(job.metadata, patch.metadataEdit.field, patch.metadataEdit.value)
      next.revision = job.revision + 1
    }

    if (patch.clearOverrides && patch.clearOverrides.length > 0) {
      let draft = job.metadata
      for (const field of patch.clearOverrides) draft = clearOverride(draft, field)
      next.metadata = draft
      next.revision = job.revision + 1
    }

    if (patch.adoptAnalyzed && patch.adoptAnalyzed.length > 0) {
      next.metadata = adoptAnalyzed(job.metadata, patch.adoptAnalyzed)
      next.revision = job.revision + 1
    }

    Object.assign(job, next)
    this.markChanged(true)
    this.markPersist()
    return job
  }

  /** Settle a failed job whose export already reached disk. True when it must not run again. */
  private settlePublished(job: Job): boolean {
    if (job.stage !== 'failed' || !job.libraryId || !job.outputPath) return false
    if (libraryService.get(job.libraryId)) {
      this.setStage(job.id, 'complete', { progress: 1, error: null, message: path.basename(job.outputPath) })
      return true
    }
    if (libraryService.pendingRevision() !== null) {
      this.setStage(job.id, 'failed', { message: PENDING_PUBLICATION, error: 'Retry saving the library first; the exported file is kept and will not be downloaded again.' })
      return true
    }
    // The pending record was discarded; only then is a fresh export the way forward.
    Object.assign(job, { outputPath: null, libraryId: null })
    return false
  }

  private reconcilePublished(): void {
    for (const job of this.jobs) {
      if (job.stage === 'failed' && job.libraryId && job.outputPath && libraryService.get(job.libraryId)) this.settlePublished(job)
    }
  }

  // ------------------------------------------------------------------- worker

  private runCount(): number {
    return this.controllers.size
  }

  private pump(): void {
    if (this.paused || isStopping() || this.shutdownTask) return

    while (this.runCount() < this.concurrency) {
      const next = this.jobs.find((job) => job.stage === 'queued' && !this.controllers.has(job.id) && !this.probing.has(job.id))
      if (!next) return
      // Claim it before the async work starts so the loop cannot double-pick it.
      this.setStage(next.id, 'downloading', { progress: 0, message: 'Preparing…' })
      const task = this.run(next.id).finally(() => { this.tasks.delete(next.id); this.pump() })
      this.tasks.set(next.id, task)
    }
  }

  private cancelActive(id: string): void {
    const controller = this.controllers.get(id)
    if (controller) {
      controller.abort()
    }
    this.probeControllers.get(id)?.abort()
    // Stop any analysis running for this job so no worker or scratch file is
    // left behind, and so a late result cannot update a cancelled job.
    analysisService.cancelPrefix(`job:${id}:`)
  }

  /**
   * Analyses a downloaded source.
   *
   * Never throws and never rejects: a failed or inconclusive analysis must not
   * discard a successful download. The request id embeds the job id and revision,
   * so a result is always attributable to the attempt that produced it.
   */
  private async runJobAnalysis(
    id: string,
    inputPath: string,
    durationSec: number,
    signal: AbortSignal
  ): Promise<AudioAnalysis | null> {
    const job = this.getJob(id)
    if (!job || signal.aborted) return null
    const requestId = `job:${id}:${job.revision}`
    const onAbort = (): void => analysisService.cancel(requestId)
    signal.addEventListener('abort', onAbort, { once: true })
    try {
      const outcome = await analysisService.analyze({ requestId, inputPath, durationSec })
      if (signal.aborted || !outcome.ok || !outcome.analysis) return null
      return outcome.analysis
    } finally {
      signal.removeEventListener('abort', onAbort)
    }
  }

  private async run(id: string): Promise<void> {
    const controller = new AbortController()
    this.controllers.set(id, controller)
    const { signal } = controller

    try {
      await this.process(id, signal)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      if (error instanceof PendingPublicationError) {
        // The files exist; a retry must finish this record, not export a copy.
        this.setStage(id, 'failed', { error: message, message: PENDING_PUBLICATION, speed: null, eta: null,
          outputPath: error.outputPath, libraryId: error.beatId })
        this.reconcilePublished()
      } else if (signal.aborted) {
        this.setStage(id, 'cancelled', { message: 'Cancelled', speed: null, eta: null })
      } else {
        this.setStage(id, 'failed', { error: message, message, speed: null, eta: null, outputPath: null, libraryId: null })
      }
      await cleanStaging(id)
    } finally {
      this.controllers.delete(id)
      this.markChanged(true)
      this.markPersist()
    }
  }

  private async process(id: string, signal: AbortSignal): Promise<void> {
    const settings = settingsService.get()
    const startJob = this.getJob(id)
    if (!startJob) return

    // Skip work that already exists in the library.
    if (settings.skipExisting) {
      // Identity comparison only: any stored https link may be matched, whatever the intake gate says.
      const sourceUrl = parseVideoUrl(startJob.url, { allowOtherSites: true }).normalized
      const existing = libraryService
        .list()
        .find((beat) => !beat.missing && sourceUrl != null && beat.sourceKind === startJob.sourceKind &&
          beat.sourceUrl != null && parseVideoUrl(beat.sourceUrl, { allowOtherSites: true }).normalized === sourceUrl)
      if (existing) {
        this.setStage(id, 'complete', {
          progress: 1,
          outputPath: existing.filePath,
          libraryId: existing.id,
          message: 'Already in your library'
        })
        return
      }
    }

    // Fail before downloading when the export could not be recorded.
    libraryService.assertWritable()

    // 1 ─ Download the best audio stream into private staging.
    const acquired = await acquireAudio(id, startJob.url, {
      signal,
      onProgress: (progress) => {
        this.patch(id, {
          progress: progress.percent ?? 0,
          speed: progress.speed,
          eta: progress.eta,
          message:
            progress.percent != null
              ? `Downloading ${Math.round(progress.percent * 100)}%`
              : 'Downloading…'
        })
      }
    })

    // 2 ─ Fold any container tags into the metadata draft.
    let embedded: MetadataValues = {}
    try {
      embedded = await readEmbeddedMetadata(acquired.filePath, signal)
    } catch {
      // A file without readable tags is normal for a fresh provider download.
    }
    signal.throwIfAborted()
    const afterDownload = this.getJob(id)
    if (!afterDownload) return
    if (Object.keys(embedded).length > 0) {
      this.patch(id, { metadata: withEmbedded(afterDownload.metadata, embedded) })
    }

    // 3 ─ Start acoustic analysis of the acquired source.
    //
    // Stage order is deliberate: download → tags → analyze → cover → convert →
    // tag readback → publish. The analyser is given the untouched original rather
    // than the re-encoded export, and the result lands *before* conversion so
    // accepted values reach the embedded tags, the sidecar and the file name.
    // Analysis is started here and awaited below so it overlaps the cover fetch.
    const analysisPromise =
      settings.analyzeOnDownload && !signal.aborted
        ? this.runJobAnalysis(id, acquired.filePath, afterDownload.durationSec ?? 0, signal)
        : null

    // 4 ─ Grab cover art while we still have network context.
    const coverJob = this.getJob(id)
    const coverPath = settings.embedThumbnail
      ? await fetchCover(coverJob?.thumbnail ?? null, id, signal)
      : null
    if (signal.aborted) {
      // Let the cancelled decoder settle before removing its source staging.
      await analysisPromise
      signal.throwIfAborted()
    }

    // 5 ─ Fold the analysis in. A failure or an inconclusive result is recorded
    //     and the download continues — audio is never discarded for this.
    if (analysisPromise) {
      this.setStage(id, 'analyzing', {
        progress: 0,
        speed: null,
        eta: null,
        message: 'Analyzing tempo and key…'
      })

      const analysis = await analysisPromise
      signal.throwIfAborted()
      const duringAnalysis = this.getJob(id)

      if (duringAnalysis && analysis) {
        this.patch(id, {
          metadata: withAnalyzed(
            duringAnalysis.metadata,
            analyzedValuesFrom(analysis),
            analysis,
            buildAudioEvidence(analysis)
          )
        })
      }
    }

    // 6 ─ Convert to the chosen recipe and write the reviewed tags.
    signal.throwIfAborted()
    const beforeConvert = this.getJob(id)
    if (!beforeConvert) return

    const extension = sourceExtensionFor(beforeConvert.presetId, acquired.extension)
    const outputPath = path.join(stagingDir(), `${id}.out.${extension}`)

    this.setStage(id, 'converting', { progress: 0, speed: null, eta: null, message: 'Converting…' })

    await transcode({
      inputPath: acquired.filePath,
      outputPath,
      presetId: beforeConvert.presetId,
      channels: settings.channelMode,
      lufs: settings.normalizeLufs,
      coverPath,
      tags: buildTagContext(beforeConvert.metadata.final, beforeConvert.url),
      durationSec: beforeConvert.durationSec,
      signal,
      onProgress: (percent) => this.patch(id, { progress: percent ?? 0 })
    })

    // 5 ─ Read the result back to prove the tags landed.
    this.setStage(id, 'tagging', { progress: 0, message: 'Verifying tags…' })
    const media = await probeMediaFile(outputPath, signal)
    const readback = tagsToMetadata(media.tags)

    signal.throwIfAborted()
    const beforePublish = this.getJob(id)
    if (!beforePublish) return

    const evidence: Evidence[] = [...beforePublish.metadata.evidence]
    for (const [field, value] of Object.entries(readback)) {
      if (value == null || value === '') continue
      evidence.push({
        field: field as Evidence['field'],
        value: String(value),
        source: 'tags',
        matched: 'container tag readback',
        confidence: 1
      })
    }

    // Readback verifies generated tags; it is not independent source evidence.

    // 6 ─ Fingerprint the exact bytes that will be published.
    const fingerprint = await sha256File(outputPath)

    // 7 ─ Render the name, publish without clobbering, write the sidecar.
    this.setStage(id, 'publishing', { progress: 0, message: 'Publishing…' })

    const [ytdlp, ffmpeg] = await Promise.all([
      engineService.resolve('yt-dlp', false, signal),
      engineService.resolve('ffmpeg', false, signal)
    ])

    const conflicts: MetadataConflict[] = this.getJob(id)?.metadata.conflicts ?? []
    signal.throwIfAborted()
    const finalJob = this.getJob(id)
    if (!finalJob) return

    const result = await publishExport({
      signal,
      jobId: id,
      stagedPath: outputPath,
      extension,
      metadata: finalJob.metadata.final,
      presetId: finalJob.presetId,
      sourceKind: finalJob.sourceKind,
      sourceUrl: finalJob.url,
      videoId: finalJob.videoId,
      uploader: finalJob.uploader,
      thumbnail: finalJob.thumbnail,
      sourceTitle: finalJob.sourceTitle,
      evidence,
      conflicts,
      analysis: finalJob.metadata.analysis,
      audioEvidence: finalJob.metadata.audioEvidence,
      verification: finalJob.metadata.verification,
      overrides: finalJob.metadata.overrides,
      sources: finalJob.metadata.sources,
      embedded: finalJob.metadata.embedded,
      tagReadback: readback,
      channels: settings.channelMode,
      lufs: settings.normalizeLufs,
      embedTags: settings.embedTags,
      fingerprint,
      index: this.jobs.length - this.jobs.findIndex((job) => job.id === id),
      durationSec: media.durationSec || finalJob.durationSec || 0,
      engine: { ytdlp: ytdlp.version, ffmpeg: ffmpeg.version },
      output: {
        sizeBytes: media.sizeBytes,
        format: media.container,
        bitrateKbps: media.audio?.bitrateKbps ?? media.bitrateKbps,
        sampleRate: media.audio?.sampleRate ?? null,
        channels: media.audio?.channels ?? null
      }
    })

    await cleanStaging(id)

    this.setStage(id, 'complete', {
      progress: 1,
      speed: null,
      eta: null,
      outputPath: result.filePath,
      libraryId: result.beat.id,
      message: result.fileName
    })
  }

  // -------------------------------------------------------------------- probe

  private pumpProbes(): void {
    if (isStopping() || this.shutdownTask) return
    while (this.probeActive < this.probeConcurrency) {
      const next = this.jobs.find((job) => job.stage === 'probing' && !this.probing.has(job.id))
      if (!next) return
      this.probing.add(next.id)
      this.probeActive += 1
      const task = this.runProbe(next.id).catch(error => {
        if (this.getJob(next.id)?.stage === 'probing') this.setStage(next.id, 'failed', { error: String(error) })
      }).finally(() => {
        this.probing.delete(next.id)
        this.probeActive -= 1
        this.markChanged(true)
        this.markPersist()
        this.pumpProbes()
        this.pump()
        this.probeTasks.delete(task)
      })
      this.probeTasks.add(task)
    }
  }

  private async runProbe(id: string): Promise<void> {
    const job = this.getJob(id)
    if (!job) return

    const controller = new AbortController()
    this.probeControllers.set(id, controller)
    let result
    try { result = await probeUrl(job.url, controller.signal) }
    finally { this.probeControllers.delete(id) }
    if (controller.signal.aborted || this.getJob(id) !== job || job.stage !== 'probing') return

    if (result.error) {
      if (job.stage === 'probing') {
        this.setStage(id, 'failed', { error: result.error, message: result.error })
      }
      return
    }

    if (result.isLive) {
      this.setStage(id, 'failed', {
        error: 'Live streams cannot be converted to a beat file.',
        message: 'Live stream — not supported'
      })
      return
    }

    if (settingsService.get().maxDurationSec > 0 && result.durationSec != null) {
      if (result.durationSec > settingsService.get().maxDurationSec) {
        this.setStage(id, 'failed', {
          error: `This source is longer than the ${Math.round(settingsService.get().maxDurationSec / 60)} minute limit set in Settings.`,
          message: 'Over the duration limit'
        })
        return
      }
    }

    const { values, evidence, bySource } = parseDeclared({
      title: result.title,
      description: result.description
    })

    const current = this.getJob(id)
    if (!current) return

    // Folding the declared layer in is always safe now: reconciliation is
    // per-field, so anything the producer edited while the probe was in flight is
    // protected by its override and everything else still updates.
    const draft = createDraft({
      declared: values,
      embedded: current.metadata.embedded,
      analyzed: current.metadata.analyzed,
      sources: bySource,
      evidence,
      audioEvidence: current.metadata.audioEvidence,
      overrides: current.metadata.overrides,
      analysis: current.metadata.analysis
    })

    const autoStart = settingsService.get().autoStart

    Object.assign(current, {
      url: result.url ?? current.url,
      videoId: result.videoId ?? current.videoId,
      sourceTitle: result.title,
      sourceDescription: result.description ? result.description.slice(0, 20_000) : null,
      uploader: result.uploader,
      thumbnail: result.thumbnail,
      durationSec: result.durationSec,
      metadata: draft,
      updatedAt: Date.now()
    })

    this.setStage(id, autoStart ? 'queued' : 'ready', {
      message: autoStart ? 'Waiting for a worker…' : 'Ready to download',
      progress: 0
    })

    if (autoStart) this.pump()
  }

  // ---------------------------------------------------------------- internals

  private setStage(id: string, stage: JobStage, patch: Partial<Job> = {}): void {
    const job = this.getJob(id)
    if (!job) return
    Object.assign(job, { stage, updatedAt: Date.now(), ...patch })
    this.markChanged(true)
    this.markPersist()
  }

  private patch(id: string, patch: Partial<Job>): void {
    const job = this.getJob(id)
    if (!job) return
    Object.assign(job, patch, { updatedAt: Date.now() })
    this.markChanged()
  }

  /** Coalesces high-frequency progress updates into one renderer push. */
  private markChanged(immediate = false): void {
    if (immediate) {
      if (this.emitTimer) {
        clearTimeout(this.emitTimer)
        this.emitTimer = null
      }
      this.emit('changed', this.snapshot())
      return
    }
    if (this.emitTimer) return
    this.emitTimer = setTimeout(() => {
      this.emitTimer = null
      this.emit('changed', this.snapshot())
    }, 80)
  }

  private markPersist(): void {
    if (isStopping() || this.shutdownTask) return
    if (this.persistTimer) return
    this.persistTimer = setTimeout(() => {
      this.persistTimer = null
      try { this.persist() } catch (error) { this.emit('persistence-error', String(error)) }
    }, 900)
  }

  private persist(): void {
    this.store.write({
      version: 1,
      paused: this.paused,
      concurrency: this.concurrency,
      jobs: this.jobs
    }, { replacePending: true })
  }

  /** Flushes any pending write; called on shutdown. */
  flush(): void {
    if (this.persistTimer) {
      clearTimeout(this.persistTimer)
      this.persistTimer = null
    }
    this.persist()
  }

  /** Aborts everything in flight, used when the app is quitting. */
  stopAll(): Promise<void> {
    if (this.shutdownTask) return this.shutdownTask
    for (const controller of this.controllers.values()) controller.abort()
    for (const controller of this.probeControllers.values()) controller.abort()
    if (this.persistTimer) clearTimeout(this.persistTimer)
    this.persistTimer = null
    if (this.emitTimer) clearTimeout(this.emitTimer)
    this.emitTimer = null
    this.shutdownTask = Promise.allSettled([...this.tasks.values(), ...this.probeTasks]).then(() => {
      // Work is now settled; only recoverable queued states remain on disk.
      for (const job of this.jobs) if (NON_RESUMABLE.includes(job.stage) || job.stage === 'probing') {
        job.stage = 'ready'
        job.message = 'Interrupted by shutdown; ready to resume.'
      }
    })
    return this.shutdownTask
  }
}

export const queueService = new QueueService()
