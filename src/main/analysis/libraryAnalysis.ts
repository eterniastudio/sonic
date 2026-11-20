import { EventEmitter } from 'node:events'
import { isStopping } from '../lifecycle'
import { deriveAnalysisStatus, type AudioAnalysis } from '@shared/analysis'
import { analysisService, type AnalysisProgress } from './service'
import { analysisCache } from './cache'
import { libraryService } from '../services/library'
import { settingsService } from '../services/settings'
import { storageEvents } from '../lib/jsonStore'

/**
 * Connects acoustic analysis to the library.
 *
 * Library analysis works entirely from the file already on disk — no download,
 * no network — so a track captured before analysis existed can be measured
 * offline. Results are rejected if the record was removed or the file changed
 * while the analysis was in flight.
 */
class LibraryAnalysisCoordinator extends EventEmitter {
  /** Beat ids queued behind the concurrency limit. */
  private readonly pending: string[] = []
  private readonly running = new Set<string>()
  /** Cancellation remains authoritative even if a completed service reply races it. */
  private readonly cancelled = new Set<string>()
  private stopped = false
  private blockedAdmission = false
  private readonly cancelAfterRetry = new Set<string>()
  private readonly tasks = new Set<Promise<{ ok: boolean; error: string | null; analysis: AudioAnalysis | null }>>()

  constructor() {
    super()
    analysisService.on('progress', (progress: AnalysisProgress) => {
      // The request id encodes the beat, so progress can be routed back to a row.
      const beatId = this.beatIdFromRequest(progress.requestId)
      if (!beatId || this.stopped) return
      this.emit('progress', { beatId, jobId: null, phase: progress.phase, message: progress.message })
    })
    storageEvents.on('changed', () => {
      if (!this.blockedAdmission) return
      // JsonStore announces a successful retry after its committed cache moves
      // forward. Never run a batch whose status revision is still unsaved.
      queueMicrotask(() => {
        try { this.settlePendingAdmission() }
        catch (error) { this.emit('storage-error', String(error)) }
      })
    })
  }

  /** Called after final storage retry so close cannot outrun a queued microtask. */
  settlePendingAdmission(): void {
    if (!this.blockedAdmission || !libraryService.analysisStatusesSaved()) return
    if (this.cancelAfterRetry.size) {
      const ids = [...this.cancelAfterRetry]
      libraryService.restoreAnalysisStatuses(ids)
      for (const id of ids) {
        const index = this.pending.indexOf(id)
        if (index >= 0) this.pending.splice(index, 1)
      }
      this.cancelAfterRetry.clear()
    }
    this.blockedAdmission = false
    this.drain()
  }

  private requestIdFor(beatId: string, generation: number): string {
    return `beat:${beatId}:${generation}`
  }

  private beatIdFromRequest(requestId: string): string | null {
    const parts = requestId.split(':')
    return parts[0] === 'beat' && parts.length === 3 && parts[1] && parts[2] ? parts[1] : null
  }

  isRunning(beatId: string): boolean {
    return this.running.has(beatId)
  }

  get queuedCount(): number {
    return this.pending.length
  }

  /**
   * Analyzes one library track.
   *
   * `force` re-runs even when a cached result exists.
   */
  async analyze(
    beatId: string,
    options: { force?: boolean } = {}
  ): Promise<{ ok: boolean; error: string | null; analysis: AudioAnalysis | null }> {
    const task = this.perform(beatId, options)
    this.tasks.add(task)
    try { return await task } finally { this.tasks.delete(task) }
  }

  async shutdown(): Promise<void> {
    this.stopped = true
    this.cancelAll()
    await Promise.allSettled([...this.tasks])
  }

  private async perform(
    beatId: string,
    options: { force?: boolean }
  ): Promise<{ ok: boolean; error: string | null; analysis: AudioAnalysis | null }> {
    if (this.stopped || isStopping()) return { ok: false, error: 'Sonic is closing.', analysis: null }
    if (this.running.has(beatId)) {
      return { ok: false, error: 'This beat is already being analyzed.', analysis: null }
    }

    // A direct request can promote a pending beat; it must not remain queued if
    // the file disappeared since the batch was accepted.
    const pendingIndex = this.pending.indexOf(beatId)
    if (pendingIndex >= 0) this.pending.splice(pendingIndex, 1)
    const beat = libraryService.get(beatId)
    if (!beat) return { ok: false, error: 'That beat is no longer in your library.', analysis: null }
    if (beat.missing) {
      this.restoreAnalysisStatus(beatId)
      return { ok: false, error: 'The audio file for this beat is missing.', analysis: null }
    }
    this.cancelled.delete(beatId)
    this.running.add(beatId)

    let acoustic: AudioAnalysis | null = null
    try {
      libraryService.setAnalysisStatus(beatId, 'analyzing')
      const outcome = await analysisService.analyze({
        requestId: this.requestIdFor(beatId, Date.now()),
        inputPath: beat.filePath,
        durationSec: beat.durationSec,
        channels: beat.channels ?? undefined,
        force: options.force === true
      })

      if (outcome.cancelled || this.cancelled.has(beatId)) {
        this.restoreAnalysisStatus(beatId)
        return { ok: false, error: null, analysis: null }
      }

      if (!outcome.ok || !outcome.analysis) {
        libraryService.markAnalysisFailed(beatId)
        return { ok: false, error: outcome.error ?? 'Analysis failed.', analysis: null }
      }

      // The library re-checks the current record and audio hash before applying.
      // A null result can mean either removal or changed input bytes.
      acoustic = outcome.analysis
      const applied = await libraryService.applyAnalysis(beatId, outcome.analysis)
      if (!applied) {
        if (libraryService.get(beatId)) libraryService.markAnalysisFailed(beatId)
        return {
          ok: false,
          error: 'The audio file changed or this beat was removed before the analysis could be saved.',
          analysis: null
        }
      }

      return { ok: true, error: null, analysis: outcome.analysis }
    } catch (error) {
      if (acoustic) {
        // The library may already be committed when an optional sidecar fails.
        // Keep that result, but never acknowledge the whole command as saved.
        const current = libraryService.get(beatId)
        if (current?.analysisStatus === 'analyzing' || current?.analysisStatus === 'queued') {
          try { libraryService.markAnalysisFailed(beatId) } catch { /* Storage diagnostics retain the unsaved revision. */ }
        }
        return {
          ok: false,
          error: `Audio analysis completed, but saving the library or sidecar did not finish. Retry the reported storage operation before re-analyzing: ${String(error)}`,
          analysis: acoustic
        }
      }
      try { libraryService.markAnalysisFailed(beatId) } catch { /* Keep the failed storage revision for explicit retry. */ }
      return {
        ok: false,
        error: error instanceof Error ? error.message : String(error),
        analysis: null
      }
    } finally {
      this.running.delete(beatId)
      this.cancelled.delete(beatId)
      this.drain()
    }
  }

  /** Queues each available track once, running it as capacity allows. */
  queue(beatIds: string[]): number {
    if (this.stopped || isStopping()) return 0
    if (this.blockedAdmission) throw new Error('Library batch admission is waiting for a storage retry.')
    const fresh = [...new Set(beatIds)].filter((id) => {
      const beat = libraryService.get(id)
      return beat != null && !beat.missing && !this.running.has(id) && !this.pending.includes(id)
    })
    this.pending.push(...fresh)
    try {
      libraryService.setAnalysisStatuses(fresh, 'queued')
    } catch (error) {
      this.blockedAdmission = true
      throw error
    }
    this.drain()
    return fresh.length
  }

  /** A cancelled retry does not erase a previously completed acoustic result. */
  private restoreAnalysisStatus(beatId: string): void {
    const beat = libraryService.get(beatId)
    if (!beat) return
    libraryService.setAnalysisStatus(beatId, beat.analysis
      ? deriveAnalysisStatus(beat.analysis.tempo, beat.analysis.key)
      : 'not-analyzed')
  }

  cancel(beatId: string): void {
    const index = this.pending.indexOf(beatId)
    if (index !== -1) {
      if (this.blockedAdmission) {
        this.cancelAfterRetry.add(beatId)
        return
      }
      this.pending.splice(index, 1)
      this.restoreAnalysisStatus(beatId)
      return
    }
    if (this.running.has(beatId)) {
      this.cancelled.add(beatId)
      analysisService.cancelPrefix(`beat:${beatId}:`)
      this.restoreAnalysisStatus(beatId)
    }
  }

  cancelAll(): void {
    const pending = [...this.pending]
    if (this.blockedAdmission) {
      for (const id of pending) this.cancelAfterRetry.add(id)
    } else {
      try {
        libraryService.restoreAnalysisStatuses(pending)
        this.pending.length = 0
      } catch (error) {
        this.blockedAdmission = true
        for (const id of pending) this.cancelAfterRetry.add(id)
        this.emit('storage-error', String(error))
      }
    }
    for (const id of this.running) this.cancelled.add(id)
    // This coordinator owns library requests, not the download queue's jobs.
    // The shared service performs global cancellation during its own shutdown.
    analysisService.cancelPrefix('beat:')
  }

  /** Starts as many queued analyses as the configured concurrency allows. */
  private drain(): void {
    if (this.stopped || isStopping() || this.blockedAdmission) return
    const limit = Math.max(1, settingsService.get().analysisConcurrency)
    while (this.running.size < limit && this.pending.length > 0) {
      const beatId = this.pending.shift()
      if (!beatId) break
      if (this.running.has(beatId)) continue
      void this.analyze(beatId).then(result => {
        // Expected failures resolve as outcomes, not rejected promises. Batch
        // callers have no awaiting UI, so forward them to the existing notice path.
        if (result.error) this.emit('storage-error', result.error)
      }).catch(error => this.emit('storage-error', String(error)))
    }
  }

  status(): {
    engine: string
    cacheEntries: number
    running: number
    queued: number
    concurrency: number
    enabled: boolean
  } {
    return {
      engine: analysisService.engine,
      cacheEntries: analysisCache.size(),
      running: this.running.size,
      queued: this.pending.length,
      concurrency: settingsService.get().analysisConcurrency,
      enabled: settingsService.get().analyzeOnDownload
    }
  }

  clearCache(): number {
    const size = analysisCache.size()
    analysisCache.clear()
    return size
  }
}

export const libraryAnalysis = new LibraryAnalysisCoordinator()
