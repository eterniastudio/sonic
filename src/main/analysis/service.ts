import { EventEmitter } from 'node:events'
import { isStopping } from '../lifecycle'
import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import path from 'node:path'
import { Worker } from 'node:worker_threads'
import type { AudioAnalysis } from '@shared/analysis'
import { ANALYSIS_ENGINE } from '@shared/analysis'
import { ensureDir, removeFile } from '../lib/fsx'
import { analysisDir } from '../services/paths'
import { engineService } from '../services/engine'
import { settingsService } from '../services/settings'
import { analysisCache } from './cache'
import { decodeWindow, planWindows } from './decode'
import { probeMediaFile } from '../services/ffprobe'
import { assembleAnalysis } from './merge'
import type { AnalysisWorkerJob, AnalysisWorkerReply, AnalysisWorkerWindow } from './protocol'

export interface AnalyzeRequest {
  /**
   * Caller-owned identity (job id, or library id plus a generation counter).
   * Used for cancellation and to reject results that arrive after the caller
   * has moved on.
   */
  requestId: string
  inputPath: string
  /** Duration from ffprobe. 0 when unknown; window planning then falls back. */
  durationSec: number
  channels?: number
  /** Ignore a cached result and analyse again. */
  force?: boolean
  /** Optional shorter request deadline, useful for bounded callers and tests. */
  timeoutMs?: number
}

export interface AnalyzeOutcome {
  ok: boolean
  analysis: AudioAnalysis | null
  fromCache: boolean
  cancelled: boolean
  error: string | null
  elapsedMs: number
}

export interface AnalysisProgress {
  requestId: string
  phase: 'starting' | 'decoding' | 'analyzing' | 'done' | 'failed' | 'cancelled'
  message: string
}

/** Hard ceiling for one request, including resolution, probing, hashing, waiting and decode. */
const ANALYSIS_TIMEOUT_MS = 180_000

function safeSegment(value: string): string {
  return value.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 64)
}

/** Streaming SHA-256 — the analysis-cache identity, not the export fingerprint. */
function hashFile(filePath: string, signal: AbortSignal): Promise<string> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) { reject(new Error('Cancelled')); return }
    const hash = createHash('sha256')
    const stream = createReadStream(filePath)
    const onAbort = (): void => { stream.destroy(new Error('Cancelled')) }
    signal.addEventListener('abort', onAbort, { once: true })
    stream.on('error', (error) => { signal.removeEventListener('abort', onAbort); reject(error) })
    stream.on('data', (chunk) => hash.update(chunk))
    stream.on('end', () => { signal.removeEventListener('abort', onAbort); resolve(hash.digest('hex')) })
  })
}

interface InFlight {
  worker: Worker | null
  controller: AbortController
  timedOut: boolean
  deadlineMs: number
}

type DecodedWorkerWindow = AnalysisWorkerWindow & { sampleCount: number }

/**
 * Orchestrates audio analysis.
 *
 * Owns the process boundaries: ffmpeg decodes on a child process, the DSP runs
 * on a worker thread, and the main process only ever coordinates. Concurrency is
 * bounded, every wait is cancellable, and all scratch files are removed on every
 * exit path — including cancellation and failure.
 */
class AnalysisService extends EventEmitter {
  private active = 0
  private waiting: (() => void)[] = []
  private readonly inFlight = new Map<string, InFlight>()
  private readonly requests = new Set<string>()
  private readonly cancelled = new Set<string>()
  private readonly tasks = new Set<Promise<AnalyzeOutcome>>()
  private stopped = false

  /** True while this request id is being worked on. */
  isRunning(requestId: string): boolean {
    return this.inFlight.has(requestId)
  }

  /** Analyzer identity, surfaced through diagnostics. */
  get engine(): string {
    return ANALYSIS_ENGINE
  }

  /**
   * Cancels every in-flight request whose id starts with `prefix`.
   *
   * Request ids are namespaced (`beat:<id>:<generation>`), so this lets a caller
   * cancel a logical target without tracking each generation it started.
   */
  cancelPrefix(prefix: string): void {
    for (const requestId of [...this.requests]) {
      if (requestId.startsWith(prefix)) this.cancel(requestId)
    }
  }

  /** Analyses an audio file. Resolves; never throws for expected failures. */
  async analyze(request: AnalyzeRequest): Promise<AnalyzeOutcome> {
    const started = Date.now()
    if (this.stopped || isStopping()) return this.cancelledOutcome(started)
    if (this.requests.has(request.requestId)) {
      return { ok: false, analysis: null, fromCache: false, cancelled: false,
        error: 'An analysis with this request ID is already running.', elapsedMs: 0 }
    }
    const timeoutMs = Math.min(ANALYSIS_TIMEOUT_MS, Math.max(1, request.timeoutMs ?? ANALYSIS_TIMEOUT_MS))
    const entry: InFlight = { worker: null, controller: new AbortController(), timedOut: false, deadlineMs: timeoutMs }
    const timer = setTimeout(() => { entry.timedOut = true; entry.controller.abort() }, timeoutMs)
    this.requests.add(request.requestId)
    this.cancelled.delete(request.requestId)
    this.inFlight.set(request.requestId, entry)
    const task = this.perform(request, entry, started)
    this.tasks.add(task)
    try { return await task }
    finally {
      clearTimeout(timer)
      this.tasks.delete(task)
      this.requests.delete(request.requestId)
      this.cancelled.delete(request.requestId)
      this.inFlight.delete(request.requestId)
    }
  }

  private async perform(request: AnalyzeRequest, entry: InFlight, started: number): Promise<AnalyzeOutcome> {
    const { controller } = entry
    let acquired = false
    const scratch: string[] = []
    try {
      // Bound the whole preparation path, including streaming file hashes, so
      // a burst of requests cannot saturate disk before waiting for DSP capacity.
      await this.acquire(controller.signal)
      acquired = true
      this.throwIfAborted(controller.signal)

      let inputId: string
      try {
        inputId = await hashFile(request.inputPath, controller.signal)
      } catch {
        this.throwIfAborted(controller.signal)
        return {
          ok: false,
          analysis: null,
          fromCache: false,
          cancelled: false,
          error: 'The audio file could not be read for analysis.',
          elapsedMs: Date.now() - started
        }
      }

      if (this.cancelled.has(request.requestId)) return this.cancelledOutcome(started)

      if (!request.force) {
        const cached = analysisCache.get(inputId)
        if (cached) {
          this.throwIfAborted(controller.signal)
          this.emitProgress(request.requestId, 'done', 'Loaded a cached analysis.')
          return {
            ok: true,
            analysis: cached,
            fromCache: true,
            cancelled: false,
            error: null,
            elapsedMs: Date.now() - started
          }
        }
      }

      // A cache hit needs only the byte identity. Resolve tools and measure
      // unknown duration only for work that will actually decode the audio.
      const ffmpeg = await engineService.resolve('ffmpeg', false, controller.signal)
      this.throwIfAborted(controller.signal)
      if (!ffmpeg.path) {
        return {
          ok: false,
          analysis: null,
          fromCache: false,
          cancelled: false,
          error: 'ffmpeg is not installed, so audio cannot be decoded for analysis.',
          elapsedMs: Date.now() - started
        }
      }

      // Window planning needs the real duration when it is available.
      let durationSec = request.durationSec
      if (!(durationSec > 0)) {
        try {
          const info = await probeMediaFile(request.inputPath, controller.signal)
          durationSec = info.durationSec
        } catch {
          this.throwIfAborted(controller.signal)
          // Leave it unknown; the window planner handles that case generously.
          durationSec = 0
        }
      }

      const workDir = analysisDir()
      this.emitProgress(request.requestId, 'starting', 'Preparing audio…')

      const plan = planWindows(durationSec)
      await ensureDir(workDir)
      this.throwIfAborted(controller.signal)

      const decodeOne = async (
        window: { offsetSec: number; durationSec: number },
        index: number
      ): Promise<DecodedWorkerWindow> => {
        const outputPath = path.join(
          workDir,
          `${safeSegment(request.requestId)}_${index}.f32`
        )
        scratch.push(outputPath)

        const decoded = await decodeWindow({
          inputPath: request.inputPath,
          ffmpegPath: ffmpeg.path as string,
          outputPath,
          signal: controller.signal,
          offsetSec: window.offsetSec,
          durationSec: window.durationSec
        })

        return {
          path: decoded.path,
          sampleRate: decoded.sampleRate,
          sourceDurationSec: durationSec > 0 ? durationSec : decoded.durationSec,
          sampleCount: decoded.sampleCount
        }
      }

      this.emitProgress(request.requestId, 'decoding', 'Decoding audio…')
      // Decode branches independently; a bad window does not erase the other branch.
      let tempoWindow: DecodedWorkerWindow | null = null
      let decodeError: unknown = null
      try { tempoWindow = await decodeOne(plan.tempo, 0) } catch (error) {
        if (controller.signal.aborted) throw error
        decodeError = error
      }

      const keyWindows: AnalysisWorkerWindow[] = []
      const examined = tempoWindow
        ? [{ start: plan.tempo.offsetSec, end: plan.tempo.offsetSec + tempoWindow.sampleCount / tempoWindow.sampleRate }]
        : []
      for (let index = 0; index < plan.key.length; index += 1) {
        if (this.cancelled.has(request.requestId)) throw new Error('Cancelled')
        const planned = plan.key[index]
        // The first key excerpt normally lives inside the longer tempo excerpt.
        // Share that file and read only its intended samples in the worker.
        const sampleOffset = tempoWindow ? Math.round((planned.offsetSec - plan.tempo.offsetSec) * tempoWindow.sampleRate) : -1
        // Match buildDecodeArgs' millisecond -t precision, including short
        // fractional-length files close to the detector's minimum duration.
        const requestedSamples = tempoWindow ? Math.round(Number(planned.durationSec.toFixed(3)) * tempoWindow.sampleRate) : 0
        if (tempoWindow && sampleOffset >= 0 && planned.offsetSec + planned.durationSec <= plan.tempo.offsetSec + plan.tempo.durationSec) {
          const sampleCount = Math.max(0, Math.min(requestedSamples, tempoWindow.sampleCount - sampleOffset))
          if (sampleCount > 0) {
            keyWindows.push({ ...tempoWindow, sampleOffset, sampleCount })
            continue
          }
        }
        try {
          const decoded = await decodeOne(planned, index + 1)
          keyWindows.push(decoded)
          examined.push({ start: planned.offsetSec, end: planned.offsetSec + decoded.sampleCount / decoded.sampleRate })
        } catch (error) {
          if (controller.signal.aborted) throw error
          decodeError = error
        }
      }

      this.throwIfAborted(controller.signal)

      if (!tempoWindow && keyWindows.length === 0) {
        const detail = decodeError instanceof Error ? decodeError.message : decodeError ? String(decodeError) : ''
        const message = detail ? `The audio could not be decoded for analysis: ${detail}` : 'The audio could not be decoded for analysis.'
        this.emitProgress(request.requestId, 'failed', message)
        return { ok: false, analysis: null, fromCache: false, cancelled: false, error: message, elapsedMs: Date.now() - started }
      }

      this.emitProgress(request.requestId, 'analyzing', 'Analyzing tempo and key…')

      const job: AnalysisWorkerJob = { tempo: tempoWindow, key: keyWindows }
      const reply = await this.runWorker(request.requestId, job, controller)

      this.throwIfAborted(controller.signal)

      if (!reply.ok || (!reply.tempo && !reply.key)) {
        return {
          ok: false,
          analysis: null,
          fromCache: false,
          cancelled: false,
          error: reply.error ?? 'The analyser did not return a result.',
          elapsedMs: Date.now() - started
        }
      }

      const tempo = reply.tempo ?? {
        status: 'failed' as const,
        bpm: null,
        bpmExact: null,
        alternatives: [],
        confidence: null,
        warning: 'Tempo analysis did not run.'
      }
      const key = reply.key ?? {
        status: 'failed' as const,
        key: null,
        camelot: null,
        alternatives: [],
        confidence: null,
        tuningCents: null,
        warning: 'Key analysis did not run.'
      }

      // Report the actual distinct audio covered, not planned lengths counted
      // twice for overlapping tempo/key windows or for windows that failed.
      let analyzedSeconds = 0
      let coveredUntil = 0
      for (const window of examined.sort((a, b) => a.start - b.start)) {
        analyzedSeconds += Math.max(0, window.end - Math.max(window.start, coveredUntil))
        coveredUntil = Math.max(coveredUntil, window.end)
      }

      const analysis = assembleAnalysis({
        tempo,
        key,
        inputId,
        inputName: path.basename(request.inputPath),
        analyzedAt: Date.now(),
        sampleRate: tempoWindow?.sampleRate ?? keyWindows[0]?.sampleRate ?? 22050,
        channels: request.channels ?? 0,
        durationSec: durationSec > 0 ? durationSec : tempoWindow?.sourceDurationSec ?? keyWindows[0]?.sourceDurationSec ?? 0,
        analyzedSeconds,
        windowDescription: plan.description
      })

      // A cache failure cannot invalidate a completed acoustic result. JsonStore retains
      // the unsaved cache revision and reports it independently through storage status.
      try { analysisCache.set(inputId, analysis) } catch { /* retryable storage failure */ }
      this.throwIfAborted(controller.signal)
      this.emitProgress(request.requestId, 'done', 'Analysis complete.')

      return {
        ok: true,
        analysis,
        fromCache: false,
        cancelled: false,
        error: null,
        elapsedMs: Date.now() - started
      }
    } catch (error) {
      if (entry.timedOut) {
        const message = `Analysis timed out after ${entry.deadlineMs} ms.`
        this.emitProgress(request.requestId, 'failed', message)
        return { ok: false, analysis: null, fromCache: false, cancelled: false,
          error: message, elapsedMs: Date.now() - started }
      }
      if (this.cancelled.has(request.requestId) || controller.signal.aborted) return this.cancelledOutcome(started)
      const message = error instanceof Error ? error.message : String(error)
      this.emitProgress(request.requestId, 'failed', message)
      return {
        ok: false,
        analysis: null,
        fromCache: false,
        cancelled: false,
        error: message,
        elapsedMs: Date.now() - started
      }
    } finally {
      // Always remove scratch PCM, and always release the slot.
      for (const file of scratch) await removeFile(file).catch(() => undefined)
      if (acquired) this.release()
    }
  }

  /** Requests cancellation. Safe to call for an unknown or finished request. */
  cancel(requestId: string): void {
    this.cancelled.add(requestId)
    const entry = this.inFlight.get(requestId)
    entry?.controller.abort()

    // Bound the tombstone so the set cannot grow forever.
    if (this.cancelled.size > 200) {
      const [oldest] = this.cancelled
      this.cancelled.delete(oldest)
    }
  }

  /** Cancels everything; used on app shutdown. */
  cancelAll(): void {
    for (const requestId of [...this.requests]) this.cancel(requestId)
  }

  async shutdown(): Promise<void> {
    this.stopped = true
    this.cancelAll()
    await Promise.allSettled([...this.tasks])
  }

  private cancelledOutcome(started: number): AnalyzeOutcome {
    return {
      ok: false,
      analysis: null,
      fromCache: false,
      cancelled: true,
      error: null,
      elapsedMs: Date.now() - started
    }
  }

  /** Runs the DSP on a worker thread under the request's shared deadline. */
  private runWorker(
    requestId: string,
    job: AnalysisWorkerJob,
    controller: AbortController
  ): Promise<AnalysisWorkerReply> {
    return new Promise<AnalysisWorkerReply>((resolve) => {
      const workerPath = path.join(__dirname, 'analysisWorker.js')
      let settled = false
      let worker: Worker

      const finish = (reply: AnalysisWorkerReply): void => {
        if (settled) return
        settled = true
        controller.signal.removeEventListener('abort', onAbort)
        void worker.terminate().then(() => resolve(reply), () => resolve(reply))
      }

      const onAbort = (): void => finish({ ok: false, tempo: null, key: null, error: 'Cancelled', elapsedMs: 0 })

      try {
        worker = new Worker(workerPath, { workerData: job })
      } catch (error) {
        settled = true
        resolve({
          ok: false,
          tempo: null,
          key: null,
          error:
            'The analysis worker could not start: ' +
            (error instanceof Error ? error.message : String(error)),
          elapsedMs: 0
        })
        return
      }

      const entry = this.inFlight.get(requestId)
      if (entry) entry.worker = worker

      worker.on('message', (reply: AnalysisWorkerReply) => finish(reply))
      worker.on('error', (error) => {
        finish({ ok: false, tempo: null, key: null, error: error.message, elapsedMs: 0 })
      })
      worker.on('exit', (code) => {
        if (!settled) {
          finish({
            ok: false,
            tempo: null,
            key: null,
            error: `The analysis worker exited with code ${code} before returning a result.`,
            elapsedMs: 0
          })
        }
      })

      controller.signal.addEventListener('abort', onAbort, { once: true })
      if (controller.signal.aborted) onAbort()
    })
  }

  private async acquire(signal: AbortSignal): Promise<void> {
    const limit = Math.max(1, settingsService.get().analysisConcurrency)
    while (this.active >= limit) {
      this.throwIfAborted(signal)
      await new Promise<void>((resolve, reject) => {
        const wake = (): void => { signal.removeEventListener('abort', onAbort); resolve() }
        const onAbort = (): void => {
          this.waiting = this.waiting.filter((entry) => entry !== wake)
          reject(new Error('Cancelled'))
        }
        this.waiting.push(wake)
        signal.addEventListener('abort', onAbort, { once: true })
        if (signal.aborted) onAbort()
      })
    }
    this.throwIfAborted(signal)
    this.active += 1
  }

  private throwIfAborted(signal: AbortSignal): void {
    if (signal.aborted) throw new Error('Cancelled')
  }

  private release(): void {
    this.active = Math.max(0, this.active - 1)
    this.waiting.shift()?.()
  }

  private emitProgress(
    requestId: string,
    phase: AnalysisProgress['phase'],
    message: string
  ): void {
    this.emit('progress', { requestId, phase, message } satisfies AnalysisProgress)
  }
}

export const analysisService = new AnalysisService()
export { ANALYSIS_ENGINE }
