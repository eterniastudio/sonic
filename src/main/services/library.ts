import { randomUUID } from 'node:crypto'
import { EventEmitter } from 'node:events'
import { existsSync, readFileSync } from 'node:fs'
import { readFile, writeFile, unlink, rename, lstat, link, open, stat } from 'node:fs/promises'
import path from 'node:path'
import type {
  AnalysisStatus,
  AudioAnalysis
} from '@shared/analysis'
import { analyzedValuesFrom, deriveAnalysisStatus, needsAnalysisRefresh } from '@shared/analysis'
import type { BeatMetadata, BeatSidecar, LibraryBeat, MetadataField, MetadataValues, MetadataVerification, PresetId, SourceKind, SourceValues } from '@shared/domain'
import { reconcile, decideMetadataField, BPM_MIN, BPM_MAX } from '@shared/metadata'
import { parseKeyString } from '@shared/music'
import { renderExportStem, resolveCollision } from '@shared/template'
import { buildAudioEvidence } from '@shared/metadata'
import { verifyMetadata } from '@shared/verification'
import { JsonStore, storageDiagnostic, storageStatus } from '../lib/jsonStore'
import { fileExists, sha256File } from '../lib/fsx'
import { libraryFile } from './paths'
import { settingsService } from './settings'
import { isStopping } from '../lifecycle'
import { capturePhysicalIdentity, samePhysicalFile } from '../lib/fileIdentity'
import { validOwnershipEvidence, type RecoveryInfo, type ExportOwnershipEvidence } from '@shared/recovery'

/** Fields a manual library edit can address, and therefore can override. */
const FIELD_KEYS = new Set<string>([
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

const SCAN_CONCURRENCY = 8
/** exFAT, FAT32 and many SMB shares cannot hard-link; those renames fall back to a reserved move. */
const LINK_UNSUPPORTED = new Set(['EPERM', 'ENOTSUP', 'EOPNOTSUPP', 'EXDEV', 'EISDIR', 'ENOSYS'])
/** `normalizeLibrary` resets these on load; they never need a durable commit. */
const TRANSIENT_STATUSES = new Set<AnalysisStatus>(['queued', 'analyzing'])
type FileObservation = { exists: boolean; isFile: boolean; size: number; error?: string }

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

/** Defensive read: a hand-edited or older library file must not crash the app. */
function normalizeLibrary(raw: unknown): LibraryBeat[] {
  if (!Array.isArray(raw)) throw new Error('Invalid library: expected an array of records.')
  const out: LibraryBeat[] = []

  for (const entry of raw) {
    if (!isRecord(entry)) throw new Error('Invalid library record: expected an object.')
    const filePath = typeof entry.filePath === 'string' ? entry.filePath : null
    if (!filePath) throw new Error('Invalid library record: missing filePath.')
    // Only an absent field proves this is a pre-import Sonic library record.
    // An explicit but unknown value may be a damaged external-import record;
    // treating it as owned would grant destructive authority over user audio.
    const fileOwnership = !Object.hasOwn(entry, 'fileOwnership') || entry.fileOwnership === 'sonic-export'
      ? 'sonic-export' : 'external'

    let restoredChannel = typeof entry.sourceChannel === 'string' ? entry.sourceChannel : null
    if (fileOwnership === 'sonic-export' && !restoredChannel && typeof entry.sidecarPath === 'string') {
      try {
        const sidecar = JSON.parse(readFileSync(entry.sidecarPath, 'utf8')) as BeatSidecar
        if (typeof entry.fingerprint === 'string' && entry.fingerprint && sidecar.schema === 'sonic-v2/beat' && sidecar.output?.filePath === path.basename(filePath) &&
          sidecar.output?.fingerprint === entry.fingerprint && sidecar.source?.url === entry.sourceUrl) {
          restoredChannel = sidecar.source.channel?.trim() || sidecar.source.uploader?.trim() || null
        }
      } catch { /* An absent or damaged optional sidecar cannot erase a library record. */ }
    }
    out.push({
      id: typeof entry.id === 'string' ? entry.id : path.basename(filePath),
      title: typeof entry.title === 'string' ? entry.title : path.parse(filePath).name,
      producer: typeof entry.producer === 'string' ? entry.producer : null,
      bpm: typeof entry.bpm === 'number' ? entry.bpm : null,
      altBpm: typeof entry.altBpm === 'number' ? entry.altBpm : null,
      key: typeof entry.key === 'string' ? entry.key : null,
      camelot: typeof entry.camelot === 'string' ? entry.camelot : null,
      detune: typeof entry.detune === 'number' ? entry.detune : null,
      presetId: (typeof entry.presetId === 'string' ? entry.presetId : 'mp3-320') as PresetId,
      format: typeof entry.format === 'string' ? entry.format : path.extname(filePath).replace('.', ''),
      filePath,
      fileName: typeof entry.fileName === 'string' ? entry.fileName : path.basename(filePath),
      fileOwnership,
      ownershipEvidence: fileOwnership === 'sonic-export' && validOwnershipEvidence(entry.ownershipEvidence) ? entry.ownershipEvidence : undefined,
      recoveryInfo: isRecord(entry.recoveryInfo) && typeof entry.recoveryInfo.recoveredAt === 'number' &&
        typeof entry.recoveryInfo.previousPath === 'string' && ['retained', 'read-only'].includes(String(entry.recoveryInfo.ownership)) &&
        ['verified', 'unresolved', 'not-applicable'].includes(String(entry.recoveryInfo.sidecar))
        ? entry.recoveryInfo as unknown as RecoveryInfo : undefined,
      sidecarPath: fileOwnership === 'external' ? null : typeof entry.sidecarPath === 'string' ? entry.sidecarPath : null,
      sidecarSync: fileOwnership === 'sonic-export' && isRecord(entry.sidecarSync) && ['pending', 'synced', 'error'].includes(String(entry.sidecarSync.status))
        ? entry.sidecarSync as LibraryBeat['sidecarSync'] : undefined,
      publishedTags: isRecord(entry.publishedTags) ? entry.publishedTags as MetadataValues : null,
      sizeBytes: typeof entry.sizeBytes === 'number' ? entry.sizeBytes : 0,
      durationSec: typeof entry.durationSec === 'number' ? entry.durationSec : 0,
      bitrateKbps: typeof entry.bitrateKbps === 'number' ? entry.bitrateKbps : null,
      sampleRate: typeof entry.sampleRate === 'number' ? entry.sampleRate : null,
      channels: typeof entry.channels === 'number' ? entry.channels : null,
      sourceUrl: typeof entry.sourceUrl === 'string' ? entry.sourceUrl : null,
      sourceChannel: restoredChannel,
      thumbnail: typeof entry.thumbnail === 'string' ? entry.thumbnail : null,
      namingTemplate: typeof entry.namingTemplate === 'string' ? entry.namingTemplate : null,
      namingIndex: typeof entry.namingIndex === 'number' ? entry.namingIndex : null,
      sourceKind: (typeof entry.sourceKind === 'string' ? entry.sourceKind : 'unknown') as SourceKind,
      addedAt: typeof entry.addedAt === 'number' ? entry.addedAt : Date.now(),
      fingerprint: typeof entry.fingerprint === 'string' ? entry.fingerprint : '',
      missing: entry.missing === true,
      fileAccessError: typeof entry.fileAccessError === 'string' ? entry.fileAccessError : null,
      // Records written before analysis existed simply have no analysis, and no
      // knowledge of which fields were hand-edited is invented for them. Analysis
      // only ever fills empty fields, so nothing is lost by defaulting to none.
      analysisStatus: (entry.analysisStatus === 'queued' || entry.analysisStatus === 'analyzing'
        ? (entry.analysis ? deriveAnalysisStatus((entry.analysis as AudioAnalysis).tempo, (entry.analysis as AudioAnalysis).key) : 'not-analyzed')
        : typeof entry.analysisStatus === 'string'
        ? entry.analysisStatus
        : 'not-analyzed') as AnalysisStatus,
      analysis: (entry.analysis as AudioAnalysis | null | undefined) ?? null,
      overrides: Array.isArray(entry.overrides)
        ? (entry.overrides.filter((value) => typeof value === 'string') as MetadataField[])
        : [],
      // Records written before analysis existed have no per-source provenance.
      // Leaving it empty is honest: verification simply reports "unverified"
      // rather than inventing what the source once said.
      sources: normalizeSources(entry.sources),
      embedded: (entry.embedded as MetadataValues | undefined) ?? {},
      verification: (entry.verification as MetadataVerification | null | undefined) ?? null
    })
  }

  return out
}

const EMPTY_SOURCES: SourceValues = { title: {}, description: {}, filename: {} }

function normalizeSources(raw: unknown): SourceValues {
  if (typeof raw !== 'object' || raw === null) return EMPTY_SOURCES
  const candidate = raw as Partial<SourceValues>
  return {
    title: (candidate.title as MetadataValues | undefined) ?? {},
    description: (candidate.description as MetadataValues | undefined) ?? {},
    filename: (candidate.filename as MetadataValues | undefined) ?? {}
  }
}

/** Rebuilds the declared-vs-measured cross-check for a stored record. */
function recomputeVerification(beat: LibraryBeat): MetadataVerification | null {
  const final = {
    title: beat.title,
    producer: beat.producer,
    bpm: beat.bpm,
    altBpm: beat.altBpm,
    key: beat.key,
    camelot: beat.camelot,
    detune: beat.detune,
    tuning: null,
    genre: null
  }

  return verifyMetadata({
    sources: beat.sources,
    embedded: beat.embedded,
    analyzed: beat.analysis ? analyzedValuesFrom(beat.analysis) : {},
    analysis: beat.analysis,
    final,
    overrides: beat.overrides
  })
}

/**
 * Re-normalises a record's key/Camelot pair through the same shared rules the
 * inspector uses, so a library record can never hold a Camelot code belonging to
 * a different key.
 */
function reconcileBeat(beat: LibraryBeat, overrides: MetadataField[], resetFields: MetadataField[] = []): LibraryBeat {
  const current = {
    title: beat.title,
    producer: beat.producer,
    bpm: beat.bpm,
    altBpm: beat.altBpm,
    key: beat.key,
    camelot: beat.camelot,
    detune: beat.detune
  }

  // Existing, untouched fields retain their chosen values. Only an explicit
  // reset returns a field to its evidence layers; a correction to one field
  // must not silently revise another field.
  const declared: MetadataValues = { ...current }
  const previousFinal = { ...current }
  for (const field of resetFields) {
    const fromSource = [beat.sources.title, beat.sources.description, beat.sources.filename]
      .map(layer => layer[field]).find(value => value != null && value !== '')
    Object.assign(declared, { [field]: fromSource ?? null })
    Object.assign(previousFinal, { [field]: null })
  }
  const { final } = reconcile({
    declared,
    embedded: beat.embedded,
    analyzed: beat.analysis ? analyzedValuesFrom(beat.analysis) : {},
    overrides,
    previousFinal
  })

  return {
    ...beat,
    title: final.title,
    producer: final.producer,
    bpm: final.bpm,
    altBpm: final.altBpm,
    key: final.key,
    camelot: final.camelot,
    detune: final.detune
  }
}

export interface DeleteResult {
  ok: boolean
  reason: string | null
}

/** Metadata edits are intentionally excluded: recovery always merges into the newest record. */
export function recoveryRecordKey(beat: LibraryBeat): string {
  return JSON.stringify([beat.id, beat.filePath, beat.fileName, beat.fingerprint, beat.fileOwnership,
    beat.ownershipEvidence?.audio ?? null, beat.sidecarPath, beat.sourceKind, beat.sourceUrl])
}

export interface RecoveryCommit {
  id: string
  expected: string
  filePath: string
  sizeBytes: number
  fileOwnership: LibraryBeat['fileOwnership']
  ownershipEvidence?: ExportOwnershipEvidence
  sidecarPath: string | null
  recoveryInfo: RecoveryInfo
}

/** Move onto a name reserved with an exclusive create, so no other writer's file is replaced. */
async function exclusiveRename(from: string, to: string): Promise<void> {
  const handle = await open(to, 'wx')
  let reservation: Awaited<ReturnType<typeof handle.stat>>
  try { reservation = await handle.stat() } finally { await handle.close() }
  try { await rename(from, to) } catch (error) {
    try {
      const current = await lstat(to)
      if (current.isFile() && current.ino === reservation.ino && current.size === 0) await unlink(to)
    } catch { /* The reservation is already gone. */ }
    throw error
  }
}

class LibraryService extends EventEmitter {
  // Records are replaced, never mutated, so a commit only serializes the records it changed.
  private store = new JsonStore<LibraryBeat[]>(libraryFile(), [], normalizeLibrary, { recordCache: true })
  private rescanTimer: NodeJS.Timeout | null = null
  private stopped = false
  private readonly sidecarTasks = new Map<string, Promise<void>>()
  private readonly scanTasks = new Set<Promise<LibraryBeat[]>>()
  private rescanTask: Promise<LibraryBeat[]> | null = null
  private viewRecords: LibraryBeat[] | null = null
  private orderedRecords: LibraryBeat[] | null = null
  private readonly recordsById = new Map<string, LibraryBeat>()
  private readonly deleting = new Set<string>()
  private readonly beatMutations = new Map<string, Promise<unknown>>()

  private withBeatMutation<T>(id: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.beatMutations.get(id) ?? Promise.resolve()
    const task = previous.catch(() => undefined).then(operation)
    this.beatMutations.set(id, task)
    void task.finally(() => { if (this.beatMutations.get(id) === task) this.beatMutations.delete(id) }).catch(() => undefined)
    return task
  }

  private refreshViews(): LibraryBeat[] {
    const records = this.store.read()
    // JsonStore replaces its committed snapshot on every successful write,
    // including storage retries, so views never include an unsaved revision.
    if (records !== this.viewRecords) {
      this.viewRecords = records
      this.orderedRecords = null
      this.recordsById.clear()
      for (const beat of records) {
        if (!this.recordsById.has(beat.id)) this.recordsById.set(beat.id, beat)
      }
    }
    return records
  }

  /** Reserve all affected records together; single-record renames/analysis use these same locks. */
  withRecoveryMutation<T>(ids: string[], operation: () => Promise<T>): Promise<T> {
    const previous = [...new Set(ids.map(id => this.beatMutations.get(id)).filter(Boolean))]
    const task = Promise.allSettled(previous).then(async () => {
      const sidecars = ids.map(id => this.get(id)?.sidecarPath).filter((value): value is string => !!value)
      await Promise.allSettled(sidecars.map(file => this.sidecarTasks.get(path.resolve(file).toLowerCase())))
      return operation()
    })
    for (const id of ids) this.beatMutations.set(id, task)
    void task.finally(() => {
      for (const id of ids) if (this.beatMutations.get(id) === task) this.beatMutations.delete(id)
    }).catch(() => undefined)
    return task
  }

  recoveryRecord(id: string, expected: string): LibraryBeat {
    const current = this.get(id)
    if (!current || this.deleting.has(id) || recoveryRecordKey(current) !== expected) {
      throw new Error('This record was removed or its file identity/location changed after review. Inspect it again.')
    }
    return current
  }

  pendingRevision(): number | null {
    const state = storageStatus().find(entry => path.resolve(entry.file).toLowerCase() === path.resolve(this.store.path).toLowerCase())
    return state?.error ? state.revision : null
  }

  assertWritable(): void {
    if (this.pendingRevision() !== null) throw new Error('A library save is pending. Retry saving before changing files or records.')
  }

  /** One synchronous revision, after async validation. No audio or sidecar bytes are changed. */
  commitRecovery(changes: RecoveryCommit[], signal: AbortSignal, prepareRetry: () => Promise<void>): void {
    signal.throwIfAborted()
    if (this.stopped || isStopping()) throw new Error('Sonic is closing; recovery was not applied.')
    this.assertWritable()
    for (const change of changes) this.recoveryRecord(change.id, change.expected)
    const byId = new Map(changes.map(change => [change.id, change]))
    const next = this.store.read().map(beat => {
      const change = byId.get(beat.id)
      if (!change) return beat
      if (beat.fileOwnership === 'external' && change.fileOwnership !== 'external') throw new Error('Recovery cannot grant ownership of an imported original.')
      return { ...beat, filePath: change.filePath, fileName: path.basename(change.filePath), sizeBytes: change.sizeBytes,
        missing: false, fileAccessError: null, fileOwnership: change.fileOwnership, ownershipEvidence: change.ownershipEvidence,
        sidecarPath: change.sidecarPath,
        sidecarSync: change.sidecarPath ? { status: 'pending' as const, error: null } : undefined,
        recoveryInfo: change.recoveryInfo }
    })
    this.store.write(next, { prepareRetry })
    this.emitChanged()
  }

  async discardRecoveryPending(revision: number): Promise<void> {
    await this.store.settleRetry()
    // A successful retry may have committed before cancellation was received.
    if (this.pendingRevision() !== null) this.store.discardPending(revision)
  }

  list(): LibraryBeat[] {
    return [...this.ordered()]
  }

  /** The newest-first records of the current revision. The same array is returned
   * until the library changes, so callers can cache work derived from it; it must
   * not be modified. */
  ordered(): readonly LibraryBeat[] {
    const records = this.refreshViews()
    // Sort once per committed revision.
    this.orderedRecords ??= [...records].sort((a, b) => b.addedAt - a.addedAt)
    return this.orderedRecords
  }

  get(id: string): LibraryBeat | null {
    this.refreshViews()
    return this.recordsById.get(id) ?? null
  }

  add(beat: LibraryBeat): LibraryBeat[] {
    this.assertWritable()
    if (beat.fileOwnership === 'external') beat = { ...beat, sidecarPath: null, sidecarSync: undefined }
    const next = [beat, ...this.store.read().filter((entry) => entry.id !== beat.id)]
    this.store.write(next)
    this.emitChanged()
    return this.list()
  }

  /** Adds a batch in one committed revision; the result matches sequential `add` calls. */
  addMany(beats: LibraryBeat[]): LibraryBeat[] {
    if (beats.length === 0) return this.list()
    this.assertWritable()
    const ids = new Set<string>()
    const incoming: LibraryBeat[] = []
    for (const beat of [...beats].reverse()) {
      if (ids.has(beat.id)) continue
      ids.add(beat.id)
      incoming.push(beat.fileOwnership === 'external' ? { ...beat, sidecarPath: null, sidecarSync: undefined } : beat)
    }
    this.store.write([...incoming, ...this.store.read().filter(entry => !ids.has(entry.id))])
    this.emitChanged()
    return this.list()
  }

  update(id: string, patch: Partial<LibraryBeat>): LibraryBeat | null {
    let updated: LibraryBeat | null = null
    const next = this.store.read().map((entry) => {
      if (entry.id !== id) return entry
      updated = { ...entry, ...patch }
      if (entry.fileOwnership === 'external') {
        updated.fileOwnership = 'external'
        updated.sidecarPath = null
        updated.sidecarSync = undefined
      }
      return updated
    })
    if (updated) {
      this.store.write(next)
      this.emitChanged()
    }
    return updated
  }

  /**
   * Removes a library record.
   *
   * When `deleteFiles` is set, the audio and its sidecar are only unlinked after
   * the file on disk is re-hashed and matches the fingerprint recorded at export
   * time. A file that was replaced or edited outside Sonic is left alone.
   */
  async remove(id: string, deleteFiles: boolean): Promise<DeleteResult & { library: LibraryBeat[] }> {
    if (this.stopped || this.deleting.has(id)) return { ok: false, reason: 'This record is closing or already being deleted.', library: this.list() }
    this.assertWritable()
    this.deleting.add(id)
    const removed: string[] = []
    try {
      await this.beatMutations.get(id)?.catch(() => undefined)
      const sidecarPath = this.get(id)?.sidecarPath
      if (sidecarPath) await this.sidecarTasks.get(path.resolve(sidecarPath).toLowerCase())
      return await this.removeVerified(id, deleteFiles, removed)
    } catch (error) {
      const reason = removed.length
        ? `${removed.join(' and ')} removed, but deletion did not finish: ${String(error)}. The library record is retained for recovery.`
        : `Deletion did not finish; no files were removed: ${String(error)}`
      storageDiagnostic(libraryFile(), { operation: 'library-delete-incomplete', id, removed, error: reason })
      if (removed.length && this.get(id)) {
        try { this.update(id, { missing: removed.includes('Audio'), sidecarSync: { status: 'error', error: reason } }) }
        catch (storageError) { this.emit('storage-error', String(storageError)) }
      }
      return { ok: false, reason, library: this.list() }
    } finally { this.deleting.delete(id) }
  }

  private async removeVerified(id: string, deleteFiles: boolean, removed: string[]): Promise<DeleteResult & { library: LibraryBeat[] }> {
    this.assertWritable()
    const beat = this.get(id)
    if (!beat) return { ok: false, reason: 'That record is no longer in the library.', library: this.list() }

    if (deleteFiles && beat.fileOwnership === 'external') {
      return { ok: false, reason: 'Imported files are externally owned. Remove the library record while keeping the file.', library: this.list() }
    }

    if (deleteFiles) {
      // Validate every owned artefact before removing either one.
      if (!beat.fingerprint) return { ok: false, reason: 'This record has no ownership fingerprint. Remove the record while keeping the files.', library: this.list() }
      if (beat.sidecarPath && await fileExists(beat.sidecarPath)) {
        const info = await lstat(beat.sidecarPath)
        const sidecar = JSON.parse(await readFile(beat.sidecarPath, 'utf8')) as BeatSidecar
        if (info.isSymbolicLink() || sidecar.schema !== 'sonic-v2/beat' || sidecar.output.filePath !== beat.fileName || sidecar.output.fingerprint !== beat.fingerprint) {
          return { ok: false, reason: 'The sidecar no longer belongs to this export. Files were left untouched.', library: this.list() }
        }
        await this.assertSidecarReceipt(beat, sidecar, beat.sidecarPath)
      }
      const stillThere = await fileExists(beat.filePath)
      if (stillThere) {
        if (beat.ownershipEvidence && !samePhysicalFile(beat.ownershipEvidence.audio, await capturePhysicalIdentity(beat.filePath))) {
          throw new Error('Ownership of this file can no longer be verified. The file was left untouched.')
        }
        if (beat.fingerprint) {
          const current = await sha256File(beat.filePath)
          if (current !== beat.fingerprint) {
            return {
              ok: false,
              reason: 'This file changed on disk since Sonic exported it, so it was left untouched.',
              library: this.list()
            }
          }
        }
        if ((await lstat(beat.filePath)).isSymbolicLink()) throw new Error('Refusing to delete a linked audio file.')
        if (this.get(id) !== beat) throw new Error('The record changed during verification. Review it and try again.')
        this.assertWritable()
        await unlink(beat.filePath)
        removed.push('Audio')
      }

      if (beat.sidecarPath && (await fileExists(beat.sidecarPath))) {
        await unlink(beat.sidecarPath)
        removed.push('Sidecar')
      }
    }

    this.store.write(this.store.read().filter((entry) => entry.id !== id))
    this.emitChanged()
    return { ok: true, reason: null, library: this.list() }
  }

  /** Drops records whose audio is gone, unless they are being kept as missing. */
  purgeMissing(): Promise<LibraryBeat[]> {
    if (this.stopped) return Promise.resolve(this.list())
    return this.trackScan(async () => {
      const records = this.store.read()
      const observations = await this.observeFiles(records)
      if (this.stopped || isStopping()) return this.list()
      const missing = new Set<LibraryBeat>()
      for (const beat of records) {
        if (observations.get(beat)?.exists === false) missing.add(beat)
      }
      // A rescan must never overwrite metadata committed while stat was awaiting.
      const current = this.store.read()
      const kept = current.filter(beat => !missing.has(beat))
      if (kept.length !== current.length) { this.store.write(kept); this.emitChanged() }
      return this.list()
    })
  }

  /** Re-checks every record against the filesystem and refreshes sizes. */
  rescan(): Promise<LibraryBeat[]> {
    if (this.stopped) return Promise.resolve(this.list())
    if (this.rescanTask) return this.rescanTask
    const task = this.trackScan(async () => {
      const records = this.store.read()
      const files = await this.observeFiles(records)
      if (this.stopped || isStopping()) return this.list()
      const observations = new Map<string, { path: string; fingerprint: string; missing: boolean; size: number; error: string | null }>()
      for (const beat of records) {
        const file = files.get(beat)
        // An inaccessible drive or permission error is not evidence of loss.
        if (!file) continue
        observations.set(beat.id, { path: beat.filePath, fingerprint: beat.fingerprint,
          missing: file.error ? false : !file.isFile, size: file.isFile ? file.size : beat.sizeBytes, error: file.error ?? null })
      }
      let changed = false
      const next = this.store.read().map(beat => {
        const seen = observations.get(beat.id)
        if (!seen || seen.path !== beat.filePath || seen.fingerprint !== beat.fingerprint) return beat
        const sizeBytes = seen.size
        if (seen.missing === beat.missing && sizeBytes === beat.sizeBytes && seen.error === (beat.fileAccessError ?? null)) return beat
        changed = true
        return { ...beat, missing: seen.missing, sizeBytes, fileAccessError: seen.error }
      })
      if (changed) { this.store.write(next); this.emitChanged() }
      return this.list()
    })
    this.rescanTask = task
    void task.then(() => { if (this.rescanTask === task) this.rescanTask = null },
      () => { if (this.rescanTask === task) this.rescanTask = null })
    return task
  }

  /** One stat per record, with bounded work even for a large library. */
  private async observeFiles(records: LibraryBeat[]): Promise<Map<LibraryBeat, FileObservation>> {
    const observations = new Map<LibraryBeat, FileObservation>()
    let cursor = 0
    let failures = 0
    let firstError: string | null = null
    const rootChecks = new Map<string, Promise<string | null>>()
    const rootError = (file: string): Promise<string | null> => {
      const root = path.parse(path.resolve(file)).root
      if (!rootChecks.has(root)) rootChecks.set(root, stat(root).then(() => null,
        error => `The drive or network share is unavailable: ${root}. ${String(error)}`))
      return rootChecks.get(root)!
    }
    await Promise.all(Array.from({ length: Math.min(SCAN_CONCURRENCY, records.length) }, async () => {
      while (cursor < records.length) {
        const beat = records[cursor++]
        try {
          const info = await stat(beat.filePath)
          observations.set(beat, { exists: true, isFile: info.isFile(), size: info.size })
        } catch (error) {
          const code = (error as NodeJS.ErrnoException).code
          const accessError = code === 'ENOENT' || code === 'ENOTDIR' ? await rootError(beat.filePath) : String(error)
          if (!accessError) {
            observations.set(beat, { exists: false, isFile: false, size: beat.sizeBytes })
          } else {
            failures++
            firstError ??= `${beat.filePath}: ${String(error)}`
            observations.set(beat, { exists: true, isFile: false, size: beat.sizeBytes, error: accessError })
          }
        }
      }
    }))
    if (failures) this.emit('storage-error', `Could not check ${failures} library file(s); their records were kept. ${firstError}`)
    return observations
  }

  private trackScan(operation: () => Promise<LibraryBeat[]>): Promise<LibraryBeat[]> {
    const task = operation()
    this.scanTasks.add(task)
    void task.then(() => this.scanTasks.delete(task), () => this.scanTasks.delete(task))
    return task
  }

  /**
   * Corrects a library record's musical metadata by hand.
   *
   * Exactly the fields named in `patch` become manual overrides. Fields listed
   * in `clearOverrides` are handed back to the evidence-priority rule.
   */
  async updateMetadata(
    id: string,
    patch: Partial<BeatMetadata>,
    clearOverrides: MetadataField[] = []
  ): Promise<LibraryBeat[]> {
    const sidecarPath = await this.withBeatMutation(id, () => this.updateMetadataLocked(id, patch, clearOverrides))
    if (sidecarPath) await this.synchronizeSidecar(id, sidecarPath)
    return this.list()
  }

  private async updateMetadataLocked(
    id: string,
    patch: Partial<BeatMetadata>,
    clearOverrides: MetadataField[]
  ): Promise<string | null> {
    if (this.stopped || this.deleting.has(id)) throw new Error('This record is closing or being deleted.')
    patch = { ...patch }
    for (const field of ['bpm', 'altBpm'] as const) {
      const value = patch[field]
      if (value !== undefined && value !== null && (!Number.isFinite(value) || value < BPM_MIN || value > BPM_MAX)) {
        throw new Error(`BPM must be between ${BPM_MIN} and ${BPM_MAX}.`)
      }
    }
    if (patch.key !== undefined) {
      const parsed = patch.key ? parseKeyString(patch.key) : null
      if (patch.key && !parsed) throw new Error('Enter a valid musical key.')
      patch.key = parsed?.key ?? null
      patch.camelot = parsed?.camelot ?? null
    }
    const beat = this.get(id)
    if (!beat) return null

    const patched: LibraryBeat = {
      ...beat,
      title: patch.title ?? beat.title,
      producer: patch.producer !== undefined ? patch.producer : beat.producer,
      bpm: patch.bpm !== undefined ? patch.bpm : beat.bpm,
      altBpm: patch.altBpm !== undefined ? patch.altBpm : beat.altBpm,
      key: patch.key !== undefined ? patch.key : beat.key,
      camelot: patch.camelot !== undefined ? patch.camelot : beat.camelot,
      detune: patch.detune !== undefined ? patch.detune : beat.detune
    }

    const edited = Object.keys(patch).filter((key): key is MetadataField => FIELD_KEYS.has(key) && !(key === 'camelot' && patch.key !== undefined))
    let overrides = [...new Set([...beat.overrides.filter(field => !(patch.key !== undefined && field === 'camelot')), ...edited])]
    if (clearOverrides.includes('key') && !clearOverrides.includes('camelot')) clearOverrides = [...clearOverrides, 'camelot']

    if (clearOverrides.length > 0) {
      overrides = overrides.filter((field) => !clearOverrides.includes(field))

      for (const field of clearOverrides) {
        const choice = decideMetadataField(field, {
          current: beat, overrides: beat.overrides, sources: beat.sources,
          embedded: beat.embedded, analyzed: beat.analysis ? analyzedValuesFrom(beat.analysis) : {}
        })
        Object.assign(patched, { [field]: choice.resetValue })
      }
    }

    const reconciled = reconcileBeat(patched, overrides, clearOverrides)
    const updated: LibraryBeat = { ...reconciled, overrides,
      sidecarSync: beat.fileOwnership === 'sonic-export' && beat.sidecarPath ? { status: 'pending', error: null } : undefined }
    updated.verification = recomputeVerification(updated)

    await this.commitBeatWithName(beat, updated)

    this.emitChanged()
    return updated.fileOwnership === 'sonic-export' ? updated.sidecarPath : null
  }

  /** Marks a record as queued/analyzing so the UI can show progress. */
  setAnalysisStatus(id: string, status: AnalysisStatus): void {
    let changed = false
    const next = this.store.read().map((entry) => {
      if (entry.id !== id || entry.analysisStatus === status) return entry
      changed = true
      return { ...entry, analysisStatus: status }
    })
    if (changed) {
      this.commitStatuses(next, status)
      this.emitChanged()
    }
  }

  /** In-progress markers are discarded on load, so they are kept in memory only
   * and ride along with the next durable commit; settled statuses are saved. */
  private commitStatuses(next: LibraryBeat[], status: AnalysisStatus): void {
    if (TRANSIENT_STATUSES.has(status)) this.store.stage(next)
    else this.store.write(next)
  }

  /**
   * Folds a completed analysis into a record.
   *
   * Fills empty fields only. An existing value — whether declared in the title,
   * read from a tag, or set by hand — is never overwritten by an estimate; the
   * producer promotes the detected value explicitly instead.
   */
  async applyAnalysis(id: string, analysis: AudioAnalysis): Promise<LibraryBeat | null> {
    const result = await this.withBeatMutation(id, () => this.applyAnalysisLocked(id, analysis))
    if (!result) return null
    if (result.sidecarPath) await this.synchronizeSidecar(id, result.sidecarPath)
    return this.get(id)
  }

  /** Admits a batch with one committed library revision. */
  setAnalysisStatuses(ids: string[], status: AnalysisStatus): void {
    const selected = new Set(ids)
    if (selected.size === 0) return
    let changed = false
    const next = this.store.read().map((entry) => {
      if (!selected.has(entry.id) || entry.analysisStatus === status) return entry
      changed = true
      return { ...entry, analysisStatus: status }
    })
    if (changed) {
      this.commitStatuses(next, status)
      this.emitChanged()
    }
  }

  /** Restore a cancelled batch in one revision, preserving previous analysis. */
  restoreAnalysisStatuses(ids: string[]): void {
    const selected = new Set(ids)
    if (selected.size === 0) return
    let changed = false
    const next = this.store.read().map((entry) => {
      if (!selected.has(entry.id)) return entry
      const status = entry.analysis
        ? deriveAnalysisStatus(entry.analysis.tempo, entry.analysis.key)
        : 'not-analyzed'
      if (entry.analysisStatus === status) return entry
      changed = true
      return { ...entry, analysisStatus: status }
    })
    if (changed) {
      this.store.write(next)
      this.emitChanged()
    }
  }

  /** A failed library replacement remains pending until JsonStore retries it. */
  analysisStatusesSaved(): boolean {
    const key = path.resolve(libraryFile()).toLowerCase()
    const state = storageStatus().find(item => path.resolve(item.file).toLowerCase() === key)
    return !state || (state.error === null && state.persisted === state.revision)
  }

  private async applyAnalysisLocked(id: string, analysis: AudioAnalysis): Promise<{ sidecarPath: string | null } | null> {
    if (this.stopped || this.deleting.has(id)) return null
    let beat = this.get(id)
    if (!beat) return null
    const filePath = beat.filePath
    const hash = await sha256File(filePath)
    beat = this.get(id)
    if (!beat || this.deleting.has(id) || beat.filePath !== filePath || hash !== analysis.inputId) return null

    const proposed = analyzedValuesFrom(analysis)
    const overrides = beat.overrides
    const keep = <T>(field: MetadataField, current: T | null, next: T | null): T | null =>
      overrides.includes(field) || current != null ? current : next

    const merged: LibraryBeat = {
      ...beat,
      bpm: keep('bpm', beat.bpm, proposed.bpm),
      altBpm: keep('altBpm', beat.altBpm, proposed.altBpm),
      key: keep('key', beat.key, proposed.key),
      camelot: keep('camelot', beat.camelot, proposed.camelot),
      analysis,
      analysisStatus: deriveAnalysisStatus(analysis.tempo, analysis.key)
    }

    const updated = reconcileBeat(merged, overrides)
    updated.sidecarSync = updated.fileOwnership === 'sonic-export' && updated.sidecarPath ? { status: 'pending', error: null } : undefined
    updated.verification = recomputeVerification(updated)
    await this.commitBeatWithName(beat, updated)

    this.emitChanged()
    return { sidecarPath: updated.fileOwnership === 'sonic-export' ? updated.sidecarPath : null }
  }

  /** Records that an analysis attempt failed, so the UI can offer a retry. */
  markAnalysisFailed(id: string): void {
    let changed = false
    const next = this.store.read().map((entry) => {
      if (entry.id !== id || entry.analysisStatus === 'failed') return entry
      changed = true
      return { ...entry, analysisStatus: 'failed' as AnalysisStatus }
    })
    if (changed) {
      this.store.write(next)
      this.emitChanged()
    }
  }

  /** Tracks that still need an analysis run. */
  listNeedingAnalysis(): LibraryBeat[] {
    return this.list().filter(needsAnalysisRefresh)
  }

  /** Retry the optional output only; the saved acoustic result remains authoritative. */
  async retrySidecar(id: string): Promise<LibraryBeat[]> {
    if (this.stopped || this.deleting.has(id)) throw new Error('This record is closing or being deleted.')
    const beat = this.get(id)
    if (beat?.fileOwnership === 'sonic-export' && beat.sidecarPath) {
      this.update(id, { sidecarSync: { status: 'pending', error: null } })
      await this.synchronizeSidecar(id, beat.sidecarPath)
    }
    return this.list()
  }

  /** Commit a new basename without ever replacing someone else's export. */
  private async commitBeatWithName(previous: LibraryBeat, updated: LibraryBeat): Promise<void> {
    this.assertWritable()
    if (previous.fileOwnership === 'external') {
      // An imported path belongs to the user, even when its metadata changes.
      updated.fileOwnership = 'external'
      updated.sidecarPath = null
      updated.sidecarSync = undefined
      this.commitChanged(previous, updated)
      return
    }
    const template = previous.namingTemplate || settingsService.get().namingTemplate
    const desiredStem = renderExportStem(template, {
      metadata: { title: updated.title, producer: updated.producer || updated.sourceChannel || null,
        bpm: updated.bpm, altBpm: updated.altBpm, key: updated.key, camelot: updated.camelot,
        detune: updated.detune, tuning: null, genre: null },
      presetId: updated.presetId, sourceKind: updated.sourceKind, durationSec: updated.durationSec,
      date: new Date(updated.addedAt), index: updated.namingIndex ?? undefined
    })
    const extension = path.extname(previous.fileName)
    const currentStem = path.parse(previous.fileName).name.replace(/ \(\d+\)$/, '')
    if (desiredStem === currentStem || previous.missing) {
      this.commitChanged(previous, updated)
      return
    }
    if (!previous.fingerprint || (await sha256File(previous.filePath)) !== previous.fingerprint ||
      (await lstat(previous.filePath)).isSymbolicLink()) throw new Error('The audio file changed on disk; its name was left untouched.')
    if (previous.ownershipEvidence && !samePhysicalFile(previous.ownershipEvidence.audio, await capturePhysicalIdentity(previous.filePath))) {
      throw new Error('Ownership of this file can no longer be verified. Its name was left untouched.')
    }
    let parsed: BeatSidecar | null = null
    if (previous.sidecarPath) {
      try {
        const info = await lstat(previous.sidecarPath)
        parsed = JSON.parse(await readFile(previous.sidecarPath, 'utf8')) as BeatSidecar
        if (!info.isFile() || info.isSymbolicLink() || parsed.schema !== 'sonic-v2/beat' ||
          !parsed.naming || !parsed.metadata ||
          parsed.output.filePath !== previous.fileName || parsed.output.fingerprint !== previous.fingerprint) {
          throw new Error('The sidecar changed on disk.')
        }
        await this.assertSidecarReceipt(previous, parsed, previous.sidecarPath)
      } catch (error) {
        // The library correction is authoritative. An optional, damaged sidecar
        // must not make a user's change disappear; sync will report the error.
        storageDiagnostic(libraryFile(), { operation: 'rename-deferred-sidecar', id: previous.id, error: String(error) })
        this.commitChanged(previous, updated)
        return
      }
    }
    const directory = path.dirname(previous.filePath)
    const candidate = resolveCollision(`${desiredStem}${extension}`, name => {
      if (name === previous.fileName) return false
      return existsSync(path.join(directory, name)) || Boolean(previous.sidecarPath && existsSync(path.join(path.dirname(previous.sidecarPath), `${name}.sonic.json`)))
    })
    const nextAudio = path.join(directory, candidate)
    const nextSidecar = previous.sidecarPath ? path.join(path.dirname(previous.sidecarPath), `${candidate}.sonic.json`) : null
    let moved: 'link' | 'rename' | null = null
    let createdSidecar = false
    let committed = false
    let pendingRename = false
    try {
      try {
        await link(previous.filePath, nextAudio)
        moved = 'link'
      } catch (error) {
        if (!LINK_UNSUPPORTED.has((error as NodeJS.ErrnoException).code ?? '')) throw error
        storageDiagnostic(libraryFile(), { operation: 'rename-link-unsupported', id: previous.id, nextAudio, error: String(error) })
      }
      if (parsed && nextSidecar) {
        parsed.naming.fileName = candidate
        parsed.output.filePath = candidate
        parsed.metadata = { ...parsed.metadata, title: updated.title, producer: updated.producer,
          bpm: updated.bpm, altBpm: updated.altBpm, key: updated.key, camelot: updated.camelot, detune: updated.detune }
        const output = await open(nextSidecar, 'wx')
        createdSidecar = true
        try { await output.writeFile(JSON.stringify(parsed, null, 2), 'utf8'); await output.sync() }
        finally { await output.close() }
      }
      if (!moved) {
        // The old name disappears before the library commit; a crash here leaves
        // the renamed audio and its new sidecar for recovery to match by fingerprint.
        await exclusiveRename(previous.filePath, nextAudio)
        moved = 'rename'
      }
      updated.filePath = nextAudio
      updated.fileName = candidate
      updated.missing = false
      updated.fileAccessError = null
      updated.sidecarPath = nextSidecar
      updated.namingTemplate = template
      if (previous.ownershipEvidence) updated.ownershipEvidence = {
        audio: await capturePhysicalIdentity(nextAudio),
        ...(parsed && nextSidecar ? { sidecar: { id: parsed.id, file: await capturePhysicalIdentity(nextSidecar) } } : {})
      }
      const storeKey = path.resolve(this.store.path).toLowerCase()
      const beforeRevision = storageStatus().find(state => path.resolve(state.file).toLowerCase() === storeKey)?.revision ?? 0
      try {
        // A scan that observed the vacated name must not leave the moved record marked missing.
        this.commitChanged(previous, updated, ['sidecarSync', 'missing', 'fileAccessError'])
      } catch (error) {
        const afterRevision = storageStatus().find(state => path.resolve(state.file).toLowerCase() === storeKey)?.revision ?? 0
        pendingRename = afterRevision > beforeRevision
        storageDiagnostic(libraryFile(), { operation: 'rename-library-write-failed', id: previous.id,
          previousPath: previous.filePath, nextAudio, nextSidecar, beforeRevision, afterRevision,
          pendingRename, error: String(error) })
        throw error
      }
      committed = true
    } catch (error) {
      if (!committed && !pendingRename) {
        if (createdSidecar && nextSidecar) await unlink(nextSidecar).catch(() => undefined)
        if (moved === 'link') await unlink(nextAudio).catch(() => undefined)
        if (moved === 'rename') {
          try { await exclusiveRename(nextAudio, previous.filePath) } catch (rollbackError) {
            storageDiagnostic(libraryFile(), { operation: 'rename-rollback-failed', id: previous.id,
              previousPath: previous.filePath, nextAudio, error: String(rollbackError) })
            throw new Error(`${String(error)}; the audio could not be moved back and remains at ${nextAudio}.`, { cause: error })
          }
        }
      }
      throw error
    }
    for (const oldPath of [previous.sidecarPath, moved === 'link' ? previous.filePath : null]) {
      if (!oldPath) continue
      try { await unlink(oldPath) }
      catch (error) { storageDiagnostic(libraryFile(), { operation: 'rename-old-file-cleanup', id: previous.id, oldPath, error: String(error) }) }
    }
  }

  /** Commit only the fields this operation changed onto the latest record, so status or
   * source writes made during its awaits are kept. Its sidecar state is always its own. */
  private commitChanged(previous: LibraryBeat, updated: LibraryBeat, force: (keyof LibraryBeat)[] = ['sidecarSync']): void {
    const changed: Partial<LibraryBeat> = {}
    for (const key of new Set([...Object.keys(previous), ...Object.keys(updated), ...force]) as Set<keyof LibraryBeat>) {
      if (force.includes(key) || JSON.stringify(previous[key]) !== JSON.stringify(updated[key])) Object.assign(changed, { [key]: updated[key] })
    }
    this.store.write(this.store.read().map(entry => entry.id === updated.id ? { ...entry, ...changed } : entry))
  }

  private async assertSidecarReceipt(beat: LibraryBeat, parsed: BeatSidecar, file: string): Promise<void> {
    if (!beat.ownershipEvidence) return
    const receipt = beat.ownershipEvidence.sidecar
    if (!receipt || receipt.id !== parsed.id || parsed.source?.kind !== beat.sourceKind || parsed.source?.url !== beat.sourceUrl ||
      !samePhysicalFile(receipt.file, await capturePhysicalIdentity(file))) {
      throw new Error('Sidecar ownership no longer matches the saved receipt. The file was left untouched.')
    }
  }

  /** Serialize the entire read/merge/replace, using fresh authoritative state. */
  private synchronizeSidecar(id: string, sidecarPath: string): Promise<void> {
    const key = path.resolve(sidecarPath).toLowerCase()
    const previous = this.sidecarTasks.get(key) ?? Promise.resolve()
    const task = previous.catch(() => undefined).then(async () => {
      let temporary: string | null = null
      let beat: LibraryBeat | null = null
      let stage = 'inspect'
      try {
        const info = await lstat(sidecarPath)
        if (!info.isFile() || info.isSymbolicLink()) throw new Error('Sidecar is not a regular owned file.')
        stage = 'read'
        const parsed = JSON.parse(await readFile(sidecarPath, 'utf8')) as BeatSidecar
        beat = this.get(id)
        if (!beat || beat.fileOwnership !== 'sonic-export' || beat.sidecarPath !== sidecarPath || this.deleting.has(id)) return
        stage = 'validate'
        if (parsed.schema !== 'sonic-v2/beat' || parsed.output?.filePath !== beat.fileName || parsed.output?.fingerprint !== beat.fingerprint) {
          throw new Error('The sidecar no longer belongs to this export.')
        }
        await this.assertSidecarReceipt(beat, parsed, sidecarPath)
        parsed.schemaVersion = 2
        parsed.metadata = { ...parsed.metadata, title: beat.title, producer: beat.producer,
          bpm: beat.bpm, altBpm: beat.altBpm, key: beat.key, camelot: beat.camelot, detune: beat.detune }
        parsed.analysis = beat.analysis
        parsed.audioEvidence = beat.analysis ? buildAudioEvidence(beat.analysis) : []
        parsed.verification = beat.verification
        parsed.overrides = [...beat.overrides]
        parsed.sources = beat.sources
        parsed.embedded = beat.embedded
        if (parsed.source) {
          parsed.source.channel = beat.sourceChannel ?? null
          parsed.source.thumbnail = beat.thumbnail ?? null
        }
        temporary = `${sidecarPath}.${process.pid}.${randomUUID()}.tmp`
        stage = 'write'
        await writeFile(temporary, JSON.stringify(parsed, null, 2), { encoding: 'utf8', flag: 'wx' })
        const latest = this.get(id)
        if (!latest || latest.fileOwnership !== 'sonic-export' || latest.sidecarPath !== sidecarPath || this.deleting.has(id)) return
        await this.assertSidecarReceipt(latest, parsed, sidecarPath)
        stage = 'replace'
        await rename(temporary, sidecarPath)
        stage = 'save-sync-status'
        if (JSON.stringify(this.get(id)) === JSON.stringify(beat)) this.update(id, {
          sidecarSync: { status: 'synced', error: null },
          ...(beat.ownershipEvidence ? { ownershipEvidence: { ...beat.ownershipEvidence,
            sidecar: { id: parsed.id, file: await capturePhysicalIdentity(sidecarPath) } } } : {})
        })
      } catch (error) {
        const current = this.get(id)
        const message = `Library saved; sidecar synchronization failed: ${String(error)}`
        storageDiagnostic(libraryFile(), { operation: 'sidecar-synchronization', stage, id, sidecarPath, temporary,
          temporaryExists: temporary ? existsSync(temporary) : false, destinationExists: existsSync(sidecarPath), directoryExists: existsSync(path.dirname(sidecarPath)),
          analysisAt: current?.analysis?.analyzedAt, error: String(error), stack: error instanceof Error ? error.stack : null })
        if (current?.sidecarPath === sidecarPath && (!beat || JSON.stringify(current) === JSON.stringify(beat))) {
          try { this.update(id, { sidecarSync: { status: 'error', error: message } }) }
          catch (storageError) { this.emit('storage-error', String(storageError)) }
        }
        this.emit('storage-error', message)
      } finally {
        if (temporary) {
          try { await unlink(temporary) } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== 'ENOENT') this.emit('storage-error', `Owned temporary cleanup failed: ${String(error)}`)
          }
        }
      }
    })
    this.sidecarTasks.set(key, task)
    void task.finally(() => { if (this.sidecarTasks.get(key) === task) this.sidecarTasks.delete(key) })
    return task
  }

  /** Starts a periodic background rescan so deleted files show up on their own. */
  scheduleRescan(intervalMs: number): void {
    if (this.rescanTimer) {
      clearInterval(this.rescanTimer)
      this.rescanTimer = null
    }
    if (intervalMs <= 0 || this.stopped || isStopping()) return
    this.rescanTimer = setInterval(() => {
      void this.rescan().catch(error => this.emit('storage-error', String(error)))
    }, intervalMs)
    this.rescanTimer.unref?.()
  }

  async shutdown(): Promise<void> {
    this.stopped = true
    this.scheduleRescan(0)
    await Promise.allSettled([...this.scanTasks, ...this.sidecarTasks.values(), ...this.beatMutations.values()])
  }

  private emitChanged(): void {
    this.emit('changed', this.list())
  }
}

export const libraryService = new LibraryService()
