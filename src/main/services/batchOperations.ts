import { randomUUID } from 'node:crypto'
import { stat } from 'node:fs/promises'
import path from 'node:path'
import type { LibraryBeat } from '@shared/domain'
import { validateBatchRequest, type BatchRequest, type BatchSession } from '@shared/batch'
import { isStopping } from '../lifecycle'
import { storageStatus } from '../lib/jsonStore'
import { sha256File } from '../lib/fsx'
import { libraryAnalysis } from '../analysis/libraryAnalysis'
import { libraryService } from './library'
import { reexportBeat, type ReexportResult } from './reexport'

export interface BatchDependencies {
  getBeat(id: string): Pick<LibraryBeat, 'id' | 'filePath' | 'missing'> | null
  fileExists(path: string): Promise<boolean>
  hashFile(path: string): Promise<string>
  analyze(id: string): Promise<{ ok: boolean; error: string | null; analysis: unknown }>
  cancelAnalysis(id: string): void
  exportBeat(id: string, presetId: NonNullable<BatchRequest['presetId']>): Promise<ReexportResult>
  findRegisteredOutput(outputPath: string, publishedBeatId: string): string | null
  isStopping(): boolean
  hasPendingStorage(): boolean
}

const productionDependencies: BatchDependencies = {
  getBeat: id => libraryService.get(id),
  fileExists: async filePath => { try { return (await stat(filePath)).isFile() } catch { return false } },
  hashFile: sha256File,
  analyze: id => libraryAnalysis.analyze(id),
  cancelAnalysis: id => libraryAnalysis.cancel(id),
  exportBeat: reexportBeat,
  findRegisteredOutput: (outputPath, publishedBeatId) => {
    const key = path.resolve(outputPath).toLowerCase()
    const beat = libraryService.get(publishedBeatId)
    return beat && path.resolve(beat.filePath).toLowerCase() === key && beat.fileOwnership === 'sonic-export'
      ? beat.fingerprint : null
  },
  isStopping,
  hasPendingStorage: () => storageStatus().some(state => state.revision > state.persisted || state.error !== null)
}

interface ActiveSession { id: string; task: Promise<void>; cancelled: boolean; currentId: string | null }

/** A single bounded operation owner. Export cancellation cannot revoke a published copy. */
export class BatchOperations {
  private readonly sessions = new Map<string, BatchSession>()
  private active: ActiveSession | null = null
  private stopped = false

  constructor(private readonly dependencies: BatchDependencies = productionDependencies) {}

  start(input: unknown): BatchSession {
    return this.admit(input)
  }

  private admit(input: unknown, previous?: BatchSession): BatchSession {
    const request = validateBatchRequest(input)
    if (this.stopped || this.dependencies.isStopping()) throw new Error('Sonic is closing.')
    if (this.dependencies.hasPendingStorage()) throw new Error('Retry saving unsaved changes before starting a batch.')
    if (this.active) throw new Error('Another batch operation is still running.')
    const id = randomUUID()
    const session: BatchSession = {
      id, request, status: 'running',
      items: request.beatIds.map(beatId => {
        const prior = previous?.items.find(item => item.beatId === beatId)
        return { beatId, status: 'pending' as const, error: null,
          outputPath: prior?.outputPath ?? null, publishedBeatId: prior?.publishedBeatId ?? null }
      }),
      startedAt: Date.now(), finishedAt: null
    }
    this.sessions.set(id, session)
    // Keep bounded diagnostics without evicting the active operation.
    while (this.sessions.size > 20) this.sessions.delete(this.sessions.keys().next().value as string)
    const active: ActiveSession = { id, task: Promise.resolve(), cancelled: false, currentId: null }
    this.active = active
    active.task = this.run(session, active).finally(() => {
      if (this.active === active) this.active = null
    })
    return this.snapshot(session)
  }

  status(id: string): BatchSession | null {
    const session = this.sessions.get(id)
    return session ? this.snapshot(session) : null
  }

  cancel(id: string): BatchSession | null {
    const session = this.sessions.get(id)
    if (!session) return null
    const active = this.active
    if (active?.id === id && !active.cancelled) {
      active.cancelled = true
      if (session.request.action === 'analyze' && active.currentId) {
        this.dependencies.cancelAnalysis(active.currentId)
      }
    }
    return this.snapshot(session)
  }

  /** Retry is an explicit new snapshot of the failed IDs, never a continuation of mutable search results. */
  retry(id: string): BatchSession {
    const previous = this.sessions.get(id)
    if (!previous || previous.status === 'running') throw new Error('The batch must finish before retrying.')
    if (previous.items.some(item => item.status === 'pending-save' && (!item.outputPath || !item.publishedBeatId))) {
      throw new Error('The published output cannot be identified safely. Recover its library record before retrying.')
    }
    const failed = previous.items.filter(item => item.status === 'failed' || item.status === 'pending-save' || item.status === 'skipped' || item.status === 'cancelled').map(item => item.beatId)
    if (!failed.length) throw new Error('This batch has no unfinished items to retry.')
    return this.admit({ ...previous.request, beatIds: failed }, previous)
  }

  async shutdown(): Promise<void> {
    this.stopped = true
    const active = this.active
    if (!active) return
    this.cancel(active.id)
    await active.task
  }

  private async run(session: BatchSession, active: ActiveSession): Promise<void> {
    try {
      for (const item of session.items) {
        if (active.cancelled || this.stopped || this.dependencies.isStopping()) break
        if (this.dependencies.hasPendingStorage()) {
          for (const remaining of session.items) {
            if (remaining.status === 'pending') {
              remaining.status = 'skipped'
              remaining.error = 'Retry saving unsaved changes before continuing this batch.'
            }
          }
          break
        }
        // A prior attempt may have published audio and sidecar before the
        // library revision failed. Reconcile that exact output after the user
        // retries storage; never transcode or publish the same target again.
        if (session.request.action === 'export' && (item.outputPath || item.publishedBeatId)) {
          try {
            const registeredFingerprint = item.outputPath && item.publishedBeatId
              ? this.dependencies.findRegisteredOutput(item.outputPath, item.publishedBeatId) : null
            const exists = Boolean(item.outputPath && await this.dependencies.fileExists(item.outputPath))
            const matches = Boolean(exists && registeredFingerprint && item.outputPath &&
              await this.dependencies.hashFile(item.outputPath) === registeredFingerprint)
            if (matches) {
              item.status = 'completed'
              item.error = null
            } else {
              item.status = 'failed'
              item.error = !exists
                ? 'The previous export is missing. Review the output and library record before exporting again.'
                : !registeredFingerprint
                  ? 'The previous export exists without a saved library record. Recover that output before exporting again.'
                  : 'The previous export no longer matches the saved fingerprint. Review the changed file before exporting again.'
            }
          } catch (error) {
            item.status = 'failed'
            item.error = `Could not verify the previous export: ${String(error)}`
          }
          continue
        }
        try {
          const beat = this.dependencies.getBeat(item.beatId)
          if (!beat) { item.status = 'skipped'; item.error = 'Beat was removed from the library.'; continue }
          if (beat.missing || !(await this.dependencies.fileExists(beat.filePath))) {
            item.status = 'skipped'; item.error = 'Audio file is missing.'; continue
          }
        } catch (error) {
          item.status = 'failed'
          item.error = error instanceof Error ? error.message : String(error)
          continue
        }
        if (active.cancelled || this.stopped || this.dependencies.isStopping()) break
        item.status = 'running'
        active.currentId = item.beatId
        try {
          if (session.request.action === 'analyze') {
            const result = await this.dependencies.analyze(item.beatId)
            if (active.cancelled && !result.ok && !result.error) {
              item.status = 'cancelled'
            } else if (result.ok) {
              item.status = 'completed'
            } else {
              item.status = 'failed'
              item.error = result.error ?? 'Analysis did not complete.'
            }
          } else {
            const result = await this.dependencies.exportBeat(item.beatId, session.request.presetId!)
            // Export may have committed while cancellation was requested. Its actual
            // outcome wins; cancellation only prevents the next item from starting.
            item.status = result.ok ? 'completed' : 'failed'
            item.error = result.error
            item.outputPath = result.outputPath
            item.publishedBeatId = result.publishedBeatId ?? null
            if (!result.ok && result.pendingSave) item.status = 'pending-save'
          }
        } catch (error) {
          item.status = 'failed'
          item.error = error instanceof Error ? error.message : String(error)
        } finally { active.currentId = null }
      }
    } finally {
      if (active.cancelled || this.stopped || this.dependencies.isStopping()) {
        for (const item of session.items) if (item.status === 'pending') item.status = 'cancelled'
        session.status = 'cancelled'
      } else {
        session.status = 'completed'
      }
      session.finishedAt = Date.now()
    }
  }

  private snapshot(session: BatchSession): BatchSession {
    return { ...session, request: { ...session.request, beatIds: [...session.request.beatIds] },
      items: session.items.map(item => ({ ...item })) }
  }
}

export const batchOperations = new BatchOperations()
