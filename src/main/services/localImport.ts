import { createHash, randomUUID } from 'node:crypto'
import { createReadStream, type Dirent } from 'node:fs'
import { lstat, readdir, realpath } from 'node:fs/promises'
import path from 'node:path'
import type { LibraryBeat, LocalImportItem, LocalImportReview } from '@shared/domain'
import { createDraft, parseDeclared } from '@shared/metadata'
import { libraryAnalysis } from '../analysis/libraryAnalysis'
import { createId } from '../lib/id'
import { storageStatus } from '../lib/jsonStore'
import { isStopping } from '../lifecycle'
import { probeMediaFile, tagsToMetadata, type MediaInfo } from './ffprobe'
import { libraryService } from './library'
import { libraryFile } from './paths'

const AUDIO_EXTENSIONS = new Set(['.mp3', '.wav', '.flac', '.m4a', '.aac', '.ogg', '.opus', '.aif', '.aiff', '.wma'])
const MAX_ROOTS = 200
const MAX_ITEMS = 1_000
const MAX_DEPTH = 12
const MAX_SESSIONS = 20
const PROBE_CONCURRENCY = 2
const MAX_FILE_BYTES = 2 * 1024 ** 3
const MAX_REVIEW_BYTES = 8 * 1024 ** 3
const MAX_REVIEW_MS = 10 * 60_000
const MAX_INSPECT_MS = 120_000
const IMPORT_COMMIT_BATCH = 250
const IMPORT_COMMIT_INTERVAL_MS = 2_000

interface FileIdentity {
  path: string
  size: number
  modified: number
  fingerprint: string
}

interface Candidate {
  item: LocalImportItem
  identity: FileIdentity | null
  media: MediaInfo | null
}

interface Session {
  review: LocalImportReview
  controller: AbortController
  scanTask: Promise<void>
  confirmTask: Promise<LocalImportReview> | null
  candidates: Candidate[]
  importedIds: Map<string, string>
  analysisAdmissionAttempted: Set<string>
  failedSaveRevision: number | null
  analysisQueueError: boolean
  inspectedBytes: number
  deadline: number
}

function canonicalPath(filePath: string): string {
  const normalized = path.normalize(path.resolve(filePath))
  return process.platform === 'win32' ? normalized.toLocaleLowerCase('en-US') : normalized
}

function snapshot(review: LocalImportReview): LocalImportReview {
  return { ...review, items: review.items.map(item => ({ ...item })) }
}

type LibraryLookup = { byPath: Map<string, LibraryBeat>; byFingerprint: Map<string, LibraryBeat> }
const lookups = new WeakMap<readonly LibraryBeat[], LibraryLookup>()
/** First newest-first record per canonical path and per fingerprint, built once per
 * library revision instead of scanning every record for every inspected file. */
function libraryLookup(): LibraryLookup {
  const records = libraryService.ordered()
  let lookup = lookups.get(records)
  if (!lookup) {
    lookup = { byPath: new Map(), byFingerprint: new Map() }
    for (const beat of records) {
      const key = canonicalPath(beat.filePath)
      if (!lookup.byPath.has(key)) lookup.byPath.set(key, beat)
      if (!lookup.byFingerprint.has(beat.fingerprint)) lookup.byFingerprint.set(beat.fingerprint, beat)
    }
    lookups.set(records, lookup)
  }
  return lookup
}

async function fingerprint(filePath: string, signal: AbortSignal): Promise<string> {
  const hash = createHash('sha256')
  const stream = createReadStream(filePath, { signal })
  try {
    for await (const chunk of stream) {
      signal.throwIfAborted()
      hash.update(chunk)
    }
    return hash.digest('hex')
  } finally { stream.destroy() }
}

async function identityOf(filePath: string, signal: AbortSignal): Promise<FileIdentity> {
  signal.throwIfAborted()
  const before = await lstat(filePath)
  if (!before.isFile() || before.isSymbolicLink()) throw new Error('Only regular audio files can be imported.')
  const resolved = await realpath(filePath)
  const digest = await fingerprint(resolved, signal)
  const after = await lstat(filePath)
  if (!after.isFile() || after.isSymbolicLink() || before.size !== after.size || before.mtimeMs !== after.mtimeMs ||
    before.ino !== after.ino || before.dev !== after.dev) throw new Error('The file changed while it was being read.')
  return { path: canonicalPath(resolved), size: after.size, modified: after.mtimeMs, fingerprint: digest }
}

/** Reviews main-process dialog selections, then indexes selected originals in place. */
export class LocalImportService {
  private readonly sessions = new Map<string, Session>()
  private stopped = false

  begin(paths: string[], kind: 'files' | 'folder', recursive: boolean): string {
    if (this.stopped || isStopping()) throw new Error('Sonic is closing; import cannot start.')
    for (const [id, session] of this.sessions) {
      if (this.sessions.size < MAX_SESSIONS) break
      this.reconcileRetriedSave(session)
      if (session.failedSaveRevision === null && session.review.phase !== 'scanning' && session.review.phase !== 'importing') this.sessions.delete(id)
    }
    if (this.sessions.size >= MAX_SESSIONS) throw new Error('Too many active import reviews. Finish or cancel one before starting another.')
    if (!Array.isArray(paths) || paths.length < 1 || paths.length > MAX_ROOTS ||
      paths.some(value => typeof value !== 'string' || value.length === 0 || value.length > 32_767)) {
      throw new Error('The selected import paths are invalid or exceed the limit.')
    }
    if (kind !== 'files' && kind !== 'folder') throw new Error('Invalid import selection.')
    const sessionId = randomUUID()
    const review: LocalImportReview = { sessionId, kind, recursive, phase: 'scanning', scanned: 0, items: [], error: null }
    const session: Session = { review, controller: new AbortController(), scanTask: Promise.resolve(), confirmTask: null,
      candidates: [], importedIds: new Map(), analysisAdmissionAttempted: new Set(), failedSaveRevision: null,
      analysisQueueError: false, inspectedBytes: 0, deadline: Date.now() + MAX_REVIEW_MS }
    this.sessions.set(sessionId, session)
    session.scanTask = this.scan(session, paths).catch(error => {
      if (session.controller.signal.aborted) review.phase = 'cancelled'
      else { review.phase = 'error'; review.error = String(error) }
    })
    return sessionId
  }

  status(sessionId: string): LocalImportReview | null {
    const session = this.sessions.get(sessionId)
    if (!session) return null
    this.reconcileRetriedSave(session)
    return snapshot(session.review)
  }

  async confirm(sessionId: string, selectedIds: string[]): Promise<LocalImportReview> {
    const session = this.sessions.get(sessionId)
    if (!session) throw new Error('Import review no longer exists.')
    if (this.stopped || isStopping()) throw new Error('Sonic is closing; import cannot continue.')
    if (session.confirmTask) return session.confirmTask
    if (!Array.isArray(selectedIds) || selectedIds.length > MAX_ITEMS || selectedIds.some(id => typeof id !== 'string')) {
      throw new Error('Invalid import selection.')
    }
    this.reconcileRetriedSave(session)
    if (session.review.phase === 'error' && session.analysisQueueError && session.failedSaveRevision === null) {
      session.review.phase = 'ready'
      session.review.error = null
      session.analysisQueueError = false
    }
    const selected = new Set(selectedIds)
    if (selected.size !== selectedIds.length) throw new Error('Import selection contains duplicate items.')
    session.confirmTask = this.confirmSelected(session, selected).finally(() => { session.confirmTask = null })
    return session.confirmTask
  }

  async cancel(sessionId: string): Promise<LocalImportReview | null> {
    const session = this.sessions.get(sessionId)
    if (!session) return null
    this.reconcileRetriedSave(session)
    if (session.failedSaveRevision !== null) {
      throw new Error('A library save is pending. Retry the save before dismissing this import review.')
    }
    if (session.review.phase === 'done') return snapshot(session.review)
    session.controller.abort()
    for (const beatId of session.importedIds.values()) libraryAnalysis.cancel(beatId)
    await Promise.allSettled([session.scanTask, ...(session.confirmTask ? [session.confirmTask] : [])])
    session.review.phase = 'cancelled'
    return snapshot(session.review)
  }

  async shutdown(): Promise<void> {
    this.stopped = true
    for (const session of this.sessions.values()) session.controller.abort()
    await Promise.allSettled([...this.sessions.values()].flatMap(session => [session.scanTask, ...(session.confirmTask ? [session.confirmTask] : [])]))
  }

  private reconcileRetriedSave(session: Session): void {
    const review = session.review
    if (review.phase !== 'error' || session.failedSaveRevision === null) return
    const state = storageStatus().find(entry => canonicalPath(entry.file) === canonicalPath(libraryFile()))
    if (!state || state.error || state.persisted < session.failedSaveRevision || state.persisted !== state.revision) return
    for (const candidate of session.candidates) {
      if (candidate.item.status !== 'failed' || !candidate.item.error?.startsWith('Library save is pending:')) continue
      const saved = libraryService.list().find(beat => canonicalPath(beat.filePath) === candidate.identity?.path)
      candidate.item.status = saved ? 'imported' : 'ready'
      if (saved) session.importedIds.set(candidate.item.id, saved.id)
      candidate.item.error = null
    }
    review.error = null
    review.phase = 'ready'
    session.failedSaveRevision = null
  }

  private async scan(session: Session, roots: string[]): Promise<void> {
    const { review, controller } = session
    const signal = controller.signal
    const paths: string[] = []
    const seen = new Set<string>()
    const visitedDirectories = new Set<string>()
    const preclassified = new Map<string, { status: 'unsupported' | 'unreadable' | 'failed'; error: string }>()
    const add = (filePath: string, outcome?: { status: 'unsupported' | 'unreadable' | 'failed'; error: string }): void => {
      const key = canonicalPath(filePath)
      if (seen.has(key)) return
      if (paths.length >= MAX_ITEMS) throw new Error(`Import review reached its ${MAX_ITEMS} file limit. Choose a smaller folder.`)
      seen.add(key)
      paths.push(filePath)
      if (outcome) preclassified.set(key, outcome)
    }
    const walk = async (directory: string, depth: number): Promise<void> => {
      signal.throwIfAborted()
      if (Date.now() > session.deadline) throw new Error('Import review reached its ten-minute time limit.')
      if (depth > MAX_DEPTH) throw new Error(`Import review reached its ${MAX_DEPTH}-level folder limit.`)
      try {
        const info = await lstat(directory)
        if (!info.isDirectory() || info.isSymbolicLink()) {
          add(directory, { status: 'unsupported', error: 'Linked files and folders are not followed.' })
          return
        }
        const actual = canonicalPath(await realpath(directory))
        if (actual !== canonicalPath(directory) || visitedDirectories.has(actual)) {
          add(directory, { status: 'unsupported', error: 'Linked or repeated folder was skipped.' })
          return
        }
        visitedDirectories.add(actual)
      } catch (error) {
        add(directory, { status: 'unreadable', error: `Folder could not be read: ${String(error)}` })
        return
      }
      let entries: Dirent[]
      try { entries = await readdir(directory, { withFileTypes: true }) }
      catch (error) { add(directory, { status: 'unreadable', error: `Folder could not be read: ${String(error)}` }); return }
      for (const entry of entries) {
        signal.throwIfAborted()
        if (Date.now() > session.deadline) throw new Error('Import review reached its ten-minute time limit.')
        const child = path.join(directory, entry.name)
        if (entry.isSymbolicLink()) { add(child, { status: 'unsupported', error: 'Linked files and folders are not followed.' }); continue }
        if (entry.isDirectory()) { if (review.recursive) await walk(child, depth + 1) }
        else if (entry.isFile()) add(child)
      }
    }
    try {
      for (const root of roots) {
        signal.throwIfAborted()
        if (Date.now() > session.deadline) throw new Error('Import review reached its ten-minute time limit.')
        const info = await lstat(root).catch(() => null)
        if (info?.isSymbolicLink()) { add(root, { status: 'unsupported', error: 'Linked files and folders are not followed.' }); continue }
        if (info?.isDirectory() && review.kind === 'folder') await walk(root, 0)
        else if (info?.isDirectory()) add(root, { status: 'unsupported', error: 'Select this folder using folder import.' })
        else if (!info) add(root, { status: 'unreadable', error: 'The selected path could not be read.' })
        else add(root)
      }
    } catch (error) {
      if (signal.aborted) throw error
      review.error = String(error)
    }
    let cursor = 0
    const workers = Array.from({ length: Math.min(PROBE_CONCURRENCY, paths.length) }, async () => {
      while (cursor < paths.length) {
        signal.throwIfAborted()
        if (Date.now() > session.deadline) throw new Error('Import review reached its ten-minute time limit.')
        const filePath = paths[cursor++]
        const candidate = await this.inspect(filePath, session, preclassified.get(canonicalPath(filePath)))
        session.candidates.push(candidate)
        review.items.push(candidate.item)
        review.scanned++
      }
    })
    const results = await Promise.allSettled(workers)
    const failure = results.find(result => result.status === 'rejected')
    if (failure?.status === 'rejected') throw failure.reason
    signal.throwIfAborted()
    const order = new Map(paths.map((filePath, index) => [canonicalPath(filePath), index]))
    session.candidates.sort((a, b) => (order.get(canonicalPath(a.item.filePath)) ?? 0) - (order.get(canonicalPath(b.item.filePath)) ?? 0))
    review.items = session.candidates.map(candidate => candidate.item)
    const firstByFingerprint = new Map<string, string>()
    for (const candidate of session.candidates) {
      if (candidate.item.status !== 'ready' || !candidate.identity) continue
      const first = firstByFingerprint.get(candidate.identity.fingerprint)
      if (first && !candidate.item.duplicateOf) candidate.item.duplicateOf = first
      else if (!first) firstByFingerprint.set(candidate.identity.fingerprint, candidate.item.id)
    }
    review.phase = review.error ? 'error' : 'ready'
  }

  private async inspect(filePath: string, session: Session, preclassified?: { status: 'unsupported' | 'unreadable' | 'failed'; error: string }): Promise<Candidate> {
    const item: LocalImportItem = { id: randomUUID(), filePath, fileName: path.basename(filePath), status: 'ready',
      duplicateOf: null, error: null, title: null, bpm: null, key: null, durationSec: null }
    const candidate: Candidate = { item, identity: null, media: null }
    if (preclassified) { item.status = preclassified.status; item.error = preclassified.error; return candidate }
    if (!AUDIO_EXTENSIONS.has(path.extname(filePath).toLowerCase())) {
      item.status = 'unsupported'; item.error = 'This audio format is not supported by local import.'
      return candidate
    }
    const controller = new AbortController()
    const onAbort = (): void => controller.abort()
    session.controller.signal.addEventListener('abort', onAbort, { once: true })
    const timeout = setTimeout(() => controller.abort(new Error('File inspection timed out.')), Math.min(MAX_INSPECT_MS, Math.max(1, session.deadline - Date.now())))
    try {
      const signal = controller.signal
      const initial = await lstat(filePath)
      if (!initial.isFile() || initial.isSymbolicLink()) throw new Error('Only regular audio files can be imported.')
      if (initial.size > MAX_FILE_BYTES) throw new Error('Audio file exceeds the 2 GiB review limit.')
      if (session.inspectedBytes + initial.size > MAX_REVIEW_BYTES) throw new Error('Import review reached its 8 GiB total reading limit.')
      session.inspectedBytes += initial.size
      const identity = await identityOf(filePath, signal)
      candidate.identity = identity
      const existing = libraryLookup()
      const already = existing.byPath.get(identity.path)
      if (already) {
        item.status = 'already-indexed'; item.duplicateOf = already.id
        return candidate
      }
      const media = await probeMediaFile(filePath, signal)
      signal.throwIfAborted()
      if (!media.audio) throw new Error('The media file has no audio stream.')
      candidate.media = media
      const embedded = tagsToMetadata(media.tags)
      const parsed = parseDeclared({ filename: item.fileName })
      const draft = createDraft({ declared: parsed.values, embedded, sources: parsed.bySource, evidence: parsed.evidence })
      item.title = draft.final.title || embedded.title || path.parse(item.fileName).name
      item.bpm = draft.final.bpm
      item.key = draft.final.key
      item.durationSec = media.durationSec
      const duplicate = existing.byFingerprint.get(identity.fingerprint)
      item.duplicateOf = duplicate?.id ?? null
    } catch (error) {
      if (session.controller.signal.aborted) throw error
      item.status = ['EACCES', 'EPERM'].includes((error as NodeJS.ErrnoException).code ?? '') ? 'unreadable' : 'failed'
      item.error = controller.signal.aborted ? 'File inspection timed out.' : String(error)
    } finally {
      clearTimeout(timeout)
      session.controller.signal.removeEventListener('abort', onAbort)
    }
    return candidate
  }

  private async confirmSelected(session: Session, selected: Set<string>): Promise<LocalImportReview> {
    await session.scanTask
    const { review, controller } = session
    if (review.phase !== 'ready') return snapshot(review)
    if (selected.size > 0 && [...selected].some(id => !session.candidates.some(candidate => candidate.item.id === id))) {
      throw new Error('Import selection contains an unknown item.')
    }
    review.phase = 'importing'
    // Validated records are committed together: one library revision per batch
    // instead of one full library rewrite per file.
    const staged: { item: LocalImportItem; beat: LibraryBeat; path: string }[] = []
    let stagedSince = 0
    const indexed = new Set(libraryService.list().map(beat => canonicalPath(beat.filePath)))
    const commit = (): boolean => {
      if (staged.length === 0) return true
      const batch = staged.splice(0, staged.length)
      // Another import may have indexed a path while this batch was validated.
      const current = new Map(libraryService.list().map(beat => [canonicalPath(beat.filePath), beat.id]))
      const fresh = batch.filter(entry => {
        const already = current.get(entry.path)
        if (already) { entry.item.status = 'already-indexed'; entry.item.duplicateOf = already }
        return !already
      })
      try { libraryService.addMany(fresh.map(entry => entry.beat)) }
      catch (error) {
        const state = storageStatus().find(entry => canonicalPath(entry.file) === canonicalPath(libraryFile()))
        session.failedSaveRevision = state?.error ? state.revision : null
        const message = `${session.failedSaveRevision === null ? 'Library save failed' : 'Library save is pending'}: ${String(error)}`
        for (const entry of fresh) { entry.item.status = 'failed'; entry.item.error = message }
        review.error = message
        return false
      }
      for (const entry of fresh) {
        entry.item.status = 'imported'
        session.importedIds.set(entry.item.id, entry.beat.id)
      }
      return true
    }
    for (const candidate of session.candidates) {
      if (controller.signal.aborted) break
      const { item, identity, media } = candidate
      if (!selected.has(item.id)) {
        if (item.status === 'ready') item.status = 'skipped'
        continue
      }
      if (item.status !== 'ready' || !identity || !media) continue
      try {
        const current = await identityOf(item.filePath, controller.signal)
        if (current.path !== identity.path || current.size !== identity.size || current.modified !== identity.modified ||
          current.fingerprint !== identity.fingerprint) throw new Error('The file changed after review; inspect it again.')
        if (indexed.has(identity.path)) {
          const already = libraryLookup().byPath.get(identity.path)
          item.status = 'already-indexed'; item.duplicateOf = already?.id ?? null
          continue
        }
        const embedded = tagsToMetadata(media.tags)
        const parsed = parseDeclared({ filename: item.fileName })
        const draft = createDraft({ declared: parsed.values, embedded, sources: parsed.bySource, evidence: parsed.evidence })
        const beat: LibraryBeat = {
          id: createId('beat'), title: draft.final.title || path.parse(item.fileName).name,
          producer: draft.final.producer, bpm: draft.final.bpm, altBpm: draft.final.altBpm,
          key: draft.final.key, camelot: draft.final.camelot, detune: draft.final.detune,
          presetId: 'original', format: path.extname(item.fileName).slice(1).toLowerCase(),
          filePath: item.filePath, fileName: item.fileName, fileOwnership: 'external', sidecarPath: null,
          publishedTags: null, sizeBytes: identity.size, durationSec: media.durationSec,
          bitrateKbps: media.bitrateKbps, sampleRate: media.audio?.sampleRate ?? null,
          channels: media.audio?.channels ?? null, sourceUrl: null, sourceChannel: null,
          sourceKind: 'local', addedAt: Date.now(), fingerprint: identity.fingerprint,
          missing: false, analysisStatus: 'not-analyzed', analysis: null, overrides: [],
          sources: parsed.bySource, embedded, verification: draft.verification
        }
        controller.signal.throwIfAborted()
        if (staged.length === 0) stagedSince = Date.now()
        staged.push({ item, beat, path: identity.path })
        indexed.add(identity.path)
        // Bounded batches keep progress visible during a long re-verification.
        if ((staged.length >= IMPORT_COMMIT_BATCH || Date.now() - stagedSince >= IMPORT_COMMIT_INTERVAL_MS) && !commit()) break
      } catch (error) {
        if (controller.signal.aborted) break
        item.status = 'failed'; item.error = String(error)
      }
    }
    // A cancelled review saves nothing it had not already committed.
    if (!controller.signal.aborted && !review.error) commit()
    if (!controller.signal.aborted && !review.error) {
      const needsAdmission = [...session.importedIds.entries()].filter(([itemId]) => !session.analysisAdmissionAttempted.has(itemId))
      if (needsAdmission.length) {
        try {
          // The coordinator owns admission, cancellation, workers and retry of a
          // failed queued-status revision. The import commit is already complete.
          libraryAnalysis.queue(needsAdmission.map(([, beatId]) => beatId))
          for (const [itemId] of needsAdmission) session.analysisAdmissionAttempted.add(itemId)
          session.analysisQueueError = false
        } catch (error) {
          session.analysisQueueError = true
          review.error = `Audio imported and saved; analysis scheduling needs attention: ${String(error)}`
        }
      }
    }
    if (controller.signal.aborted) review.phase = 'cancelled'
    else review.phase = review.error ? 'error' : 'done'
    return snapshot(review)
  }
}

export const localImportService = new LocalImportService()
