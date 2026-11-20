import { randomUUID } from 'node:crypto'
import { lstat, opendir, readFile } from 'node:fs/promises'
import path from 'node:path'
import type { BeatSidecar, LibraryBeat } from '@shared/domain'
import { RECOVERY_LIMITS, type RecoveryCandidate, type RecoveryItem, type RecoveryReview, type RecoverySelection } from '@shared/recovery'
import { assertUnlinkedPath, canonicalPath, insideRoot, isContentFingerprint, sameFileStamp, samePhysicalFile, verifyFile, type VerifiedFile } from '../lib/fileIdentity'
import { isStopping } from '../lifecycle'
import { libraryService, recoveryRecordKey, type RecoveryCommit } from './library'

interface ExpectedRecord { beat: LibraryBeat; key: string; item: RecoveryItem }
interface CandidateState { value: RecoveryCandidate; file: VerifiedFile; sidecar: VerifiedFile | null; sidecarId: string | null }
interface Plan {
  owner: number
  review: RecoveryReview
  records: Map<string, ExpectedRecord>
  candidates: Map<string, CandidateState>
  controller: AbortController
  scan: Promise<void>
  applying: Promise<RecoveryReview> | null
  started: number
  chosen: Map<string, CandidateState>
}

const MAX_PLANS = 8
const MAX_ERRORS = 100
const sidecarLimit = 8 * 1024 ** 2
const errorMessage = (error: unknown): string => error instanceof Error ? error.message : String(error)
const unavailable = (error: unknown): boolean => ['ENOENT', 'ENOTDIR'].includes((error as NodeJS.ErrnoException).code ?? '')

function commonFolder(files: string[]): string {
  let common = path.dirname(files[0])
  for (const file of files.slice(1)) {
    while (!insideRoot(common, file) && path.dirname(common) !== common) common = path.dirname(common)
  }
  return common
}

/** Main-process, picker-authorized recovery. Renderer messages contain only scoped IDs. */
export class RecoveryService {
  private readonly plans = new Map<string, Plan>()
  private stopped = false

  begin(owner: number, ids: string[], selectedPath: string, kind: 'file' | 'folder'): string {
    if (this.stopped || isStopping()) throw new Error('Sonic is closing; recovery cannot start.')
    if (!ids.length || ids.length > RECOVERY_LIMITS.records || new Set(ids).size !== ids.length || (kind === 'file' && ids.length !== 1)) {
      throw new Error('Choose between 1 and 10,000 distinct unavailable library records.')
    }
    for (const [id, old] of this.plans) {
      if (this.plans.size < MAX_PLANS) break
      this.reconcileSave(old)
      if (['complete', 'cancelled', 'error'].includes(old.review.phase) && !old.applying) this.plans.delete(id)
    }
    if (this.plans.size >= MAX_PLANS) throw new Error('Finish or cancel an existing recovery review first.')
    const records = new Map<string, ExpectedRecord>()
    for (const id of ids) {
      const beat = libraryService.get(id)
      if (!beat) throw new Error('One of the selected records is no longer in the library.')
      if (!beat.missing && !beat.fileAccessError) throw new Error('This track is no longer marked unavailable. Rescan the library before locating it.')
      records.set(id, { beat: structuredClone(beat), key: recoveryRecordKey(beat), item: {
        beatId: id, title: beat.title, oldPath: beat.filePath, status: isContentFingerprint(beat.fingerprint) ? 'not-found' : 'unverifiable',
        candidates: [], error: isContentFingerprint(beat.fingerprint) ? null : 'This record has no usable saved SHA-256 identity. Import different audio as a new track instead.'
      } })
    }
    const planId = randomUUID()
    const plan: Plan = {
      owner, records, candidates: new Map(), controller: new AbortController(), scan: Promise.resolve(), applying: null,
      started: Date.now(), chosen: new Map(),
      review: { planId, kind, rootPath: path.resolve(selectedPath), phase: 'scanning', requestedCount: ids.length, items: [],
        stats: { visited: 0, files: 0, hashed: 0, hashedBytes: 0, skippedLinks: 0, elapsedMs: 0 }, errors: [], error: null,
        completeSearch: true, committedIds: [], pendingRevision: null }
    }
    this.plans.set(planId, plan)
    plan.scan = this.scan(plan).catch(error => {
      if (plan.controller.signal.aborted) plan.review.phase = 'cancelled'
      else { plan.review.phase = 'error'; plan.review.error = errorMessage(error) }
    }).finally(() => { plan.review.stats.elapsedMs = Date.now() - plan.started })
    return planId
  }

  private owned(id: string, owner: number): Plan {
    const plan = this.plans.get(id)
    if (!plan || plan.owner !== owner) throw new Error('This recovery review is unavailable in this window.')
    return plan
  }

  status(id: string, owner: number): RecoveryReview {
    const plan = this.owned(id, owner)
    this.reconcileSave(plan)
    return this.snapshot(plan)
  }

  private snapshot(plan: Plan): RecoveryReview {
    return structuredClone({ ...plan.review,
      stats: { ...plan.review.stats, elapsedMs: plan.review.phase === 'scanning' ? Date.now() - plan.started : plan.review.stats.elapsedMs },
      items: plan.review.phase === 'scanning' ? [] : [...plan.records.values()].map(record => record.item) })
  }

  async apply(id: string, owner: number, selection: RecoverySelection[]): Promise<RecoveryReview> {
    const plan = this.owned(id, owner)
    this.reconcileSave(plan)
    if (plan.applying) return plan.applying
    if (plan.review.phase === 'complete' || plan.review.phase === 'pending-save') return this.snapshot(plan)
    if (this.stopped || isStopping()) throw new Error('Sonic is closing; recovery cannot be applied.')
    if (plan.review.phase !== 'ready') throw new Error('Wait for the recovery scan to finish before applying it.')
    if (!selection.length || selection.length > RECOVERY_LIMITS.records || new Set(selection.map(item => item.beatId)).size !== selection.length) {
      throw new Error('Choose at least one verified match, with one candidate per track.')
    }
    const chosen = new Map<string, CandidateState>()
    for (const item of selection) {
      const record = plan.records.get(item.beatId)
      const candidate = plan.candidates.get(item.candidateId)
      if (!record || !candidate || !record.item.candidates.some(value => value.id === item.candidateId)) throw new Error('A selected candidate does not belong to this recovery plan.')
      chosen.set(item.beatId, candidate)
    }
    plan.chosen = chosen
    plan.review.phase = 'applying'
    plan.applying = libraryService.withRecoveryMutation([...chosen.keys()], () => this.applyChosen(plan))
      .finally(() => { plan.applying = null })
    return plan.applying
  }

  async cancel(id: string, owner: number): Promise<RecoveryReview> {
    const plan = this.owned(id, owner)
    this.reconcileSave(plan)
    if (plan.review.phase === 'complete') return this.snapshot(plan)
    plan.controller.abort()
    if (plan.review.phase === 'pending-save' && plan.review.pendingRevision !== null) {
      await libraryService.discardRecoveryPending(plan.review.pendingRevision)
      this.reconcileSave(plan)
      if (plan.review.committedIds.length) return this.snapshot(plan)
      plan.review.pendingRevision = null
      plan.review.error = 'Recovery cancelled. The storage error remains available through Retry saving.'
    }
    await Promise.allSettled([plan.scan, ...(plan.applying ? [plan.applying] : [])])
    // A synchronous committed revision wins over a later Cancel message.
    if (plan.review.committedIds.length === 0) plan.review.phase = 'cancelled'
    return this.snapshot(plan)
  }

  async shutdown(): Promise<void> {
    this.stopped = true
    for (const plan of this.plans.values()) plan.controller.abort()
    await Promise.allSettled([...this.plans.values()].flatMap(plan => [plan.scan, ...(plan.applying ? [plan.applying] : [])]))
    for (const plan of this.plans.values()) {
      this.reconcileSave(plan)
      if (plan.review.phase === 'pending-save' && plan.review.pendingRevision !== null) {
        await libraryService.discardRecoveryPending(plan.review.pendingRevision)
        this.reconcileSave(plan)
        if (!plan.review.committedIds.length) { plan.review.phase = 'cancelled'; plan.review.pendingRevision = null }
      }
    }
  }

  private addError(plan: Plan, filePath: string, message: string): void {
    plan.review.completeSearch = false
    if (plan.review.errors.length < MAX_ERRORS) plan.review.errors.push({ path: filePath, message })
  }

  private checkScan(plan: Plan): void {
    plan.controller.signal.throwIfAborted()
    if (Date.now() - plan.started > RECOVERY_LIMITS.scanMs) throw new Error('The recovery scan reached its ten-minute limit. Choose a smaller folder.')
  }

  private async scan(plan: Plan): Promise<void> {
    const selected = plan.review.rootPath
    const root = plan.review.kind === 'file' ? path.dirname(selected) : selected
    await assertUnlinkedPath(root, root)
    if (!(await lstat(root)).isDirectory()) throw new Error('The selected folder is unavailable or is not a directory.')
    const validRecords = [...plan.records.values()].filter(record => record.item.status !== 'unverifiable')
    if (!validRecords.length) { plan.review.phase = 'ready'; return }
    const byHash = new Map<string, ExpectedRecord[]>()
    for (const record of validRecords) {
      const key = record.beat.fingerprint.toLowerCase()
      byHash.set(key, [...(byHash.get(key) ?? []), record])
    }
    const knownPaths = new Map<string, Set<string>>()
    for (const beat of libraryService.list()) {
      const key = canonicalPath(beat.filePath)
      if (!knownPaths.has(key)) knownPaths.set(key, new Set())
      knownPaths.get(key)!.add(beat.id)
    }
    const seen = new Set<string>()
    const inspect = async (filePath: string, required = false): Promise<void> => {
      this.checkScan(plan)
      const key = canonicalPath(filePath)
      if (seen.has(key)) return
      seen.add(key)
      let info
      try { await assertUnlinkedPath(root, filePath); info = await lstat(filePath) }
      catch (error) {
        if (required || !unavailable(error)) this.addError(plan, filePath, `Could not read candidate: ${errorMessage(error)}`)
        return
      }
      if (info.isSymbolicLink()) { plan.review.stats.skippedLinks++; this.addError(plan, filePath, 'Linked files are not followed.'); return }
      if (!info.isFile()) return
      plan.review.stats.files++
      if (info.size > RECOVERY_LIMITS.fileBytes || plan.review.stats.hashedBytes + info.size > RECOVERY_LIMITS.totalHashBytes) {
        this.addError(plan, filePath, 'Content verification reached its file or total-byte limit. Choose a smaller set of files.')
        return
      }
      plan.review.stats.hashedBytes += info.size
      plan.review.stats.hashed++
      try {
        const file = await verifyFile(filePath, root, AbortSignal.any([plan.controller.signal, AbortSignal.timeout(RECOVERY_LIMITS.fileMs)]), RECOVERY_LIMITS.fileBytes)
        const matches = byHash.get(file.fingerprint) ?? []
        if (!matches.length && plan.review.kind === 'file') {
          const item = validRecords[0].item
          item.status = 'invalid'; item.error = 'Different content: this file does not match the saved SHA-256 fingerprint. Import it as a new track instead.'
        }
        for (const record of matches) {
          if ([...(knownPaths.get(key) ?? [])].some(id => id !== record.beat.id)) {
            this.addError(plan, filePath, 'This location is already referenced by another library record. It was not selected for recovery.')
            continue
          }
          if (record.item.candidates.length >= RECOVERY_LIMITS.candidatesPerRecord) {
            this.addError(plan, filePath, 'This track has more than 20 matching locations. Choose a smaller folder or locate it individually.')
            continue
          }
          const candidate = await this.describeCandidate(record.beat, file, root, plan.controller.signal)
          plan.candidates.set(candidate.value.id, candidate)
          record.item.candidates.push(candidate.value)
        }
      } catch (error) {
        plan.controller.signal.throwIfAborted()
        this.addError(plan, filePath, errorMessage(error))
      }
    }

    if (plan.review.kind === 'file') await inspect(selected, true)
    else {
      // Check the likely replacement paths first, even if the saved size is stale.
      const oldRoot = commonFolder(validRecords.map(record => record.beat.filePath))
      const plausible = new Set<string>()
      for (const record of validRecords) {
        const relative = path.relative(oldRoot, record.beat.filePath)
        if (!path.isAbsolute(relative) && !relative.startsWith('..')) plausible.add(path.join(root, relative))
        plausible.add(path.join(root, path.basename(record.beat.filePath)))
      }
      await this.parallel([...plausible], file => inspect(file))
      const sizes = new Set(validRecords.map(record => record.beat.sizeBytes).filter(size => size > 0))
      const unknownSizeNames = new Set(validRecords.filter(record => record.beat.sizeBytes <= 0).map(record => record.beat.fileName.toLowerCase()))
      const directories: { file: string; depth: number }[] = [{ file: root, depth: 0 }]
      const visitedDirectories = new Set<string>()
      let limit = false
      while (directories.length && !limit) {
        this.checkScan(plan)
        const current = directories.pop()!
        if (current.depth > RECOVERY_LIMITS.depth) { this.addError(plan, current.file, 'The 12-level folder limit was reached.'); continue }
        try {
          await assertUnlinkedPath(root, current.file)
          const key = canonicalPath(current.file)
          if (visitedDirectories.has(key)) continue
          visitedDirectories.add(key)
          const entries = await opendir(current.file)
          const candidates: string[] = []
          for await (const entry of entries) {
            this.checkScan(plan)
            if (++plan.review.stats.visited > RECOVERY_LIMITS.entries) { this.addError(plan, current.file, 'The 25,000-entry scan limit was reached. Choose a smaller folder.'); limit = true; break }
            const file = path.join(current.file, entry.name)
            if (entry.isSymbolicLink()) { plan.review.stats.skippedLinks++; this.addError(plan, file, 'Linked files and folders are not followed.'); continue }
            if (entry.isDirectory()) { directories.push({ file, depth: current.depth + 1 }); continue }
            if (!entry.isFile() || seen.has(canonicalPath(file))) continue
            try {
              const info = await lstat(file)
              if (info.isSymbolicLink()) { plan.review.stats.skippedLinks++; this.addError(plan, file, 'Linked files are not followed.'); continue }
              if (sizes.has(info.size) || unknownSizeNames.has(entry.name.toLowerCase())) candidates.push(file)
            } catch (error) { this.addError(plan, file, `Could not inspect candidate size: ${errorMessage(error)}`) }
          }
          await this.parallel(candidates, file => inspect(file))
        } catch (error) {
          plan.controller.signal.throwIfAborted()
          this.addError(plan, current.file, `Folder could not be read: ${errorMessage(error)}`)
        }
      }
    }
    this.checkScan(plan)
    for (const record of validRecords) {
      const count = record.item.candidates.length
      if (count) record.item.status = count === 1 ? 'matched' : 'ambiguous'
      else if (record.item.status !== 'invalid' && plan.review.errors.length) {
        record.item.status = 'error'
        record.item.error = 'No match was verified; access or scan errors are listed below. This is not proof that the file was deleted.'
      }
    }
    plan.review.phase = 'ready'
  }

  private async parallel<T>(values: T[], work: (value: T) => Promise<void>): Promise<void> {
    let cursor = 0
    const settled = await Promise.allSettled(Array.from({ length: Math.min(RECOVERY_LIMITS.hashConcurrency, values.length) }, async () => {
      while (cursor < values.length) await work(values[cursor++])
    }))
    const failed = settled.find(result => result.status === 'rejected')
    if (failed?.status === 'rejected') throw failed.reason
  }

  private async describeCandidate(beat: LibraryBeat, file: VerifiedFile, root: string, signal: AbortSignal): Promise<CandidateState> {
    const retained = beat.fileOwnership === 'sonic-export' && samePhysicalFile(beat.ownershipEvidence?.audio, file.file)
    const candidate: CandidateState = { file, sidecar: null, sidecarId: null, value: { id: randomUUID(), path: file.path,
      ownership: retained ? 'retained' : 'read-only', sidecar: beat.fileOwnership === 'external' ? 'not-applicable' : 'unresolved',
      note: retained ? null : beat.fileOwnership === 'external' ? 'Imported original: the file remains read-only.' : 'Ownership at this location cannot be verified. The reconnected file will be read-only.' } }
    if (!retained) {
      if (beat.fileOwnership === 'sonic-export') candidate.value.note += ' Audio can reconnect; its sidecar remains unresolved.'
      return candidate
    }
    if (!beat.sidecarPath) { candidate.value.sidecar = 'not-applicable'; return candidate }
    const evidence = beat.ownershipEvidence?.sidecar
    if (evidence) {
      const relative = path.relative(path.dirname(beat.filePath), beat.sidecarPath)
      const possible = path.resolve(path.dirname(file.path), relative)
      if (insideRoot(root, possible)) {
        try {
          const verified = await verifyFile(possible, root, signal, sidecarLimit)
          if (!samePhysicalFile(evidence.file, verified.file)) throw new Error('Sidecar ownership does not match the saved receipt.')
          const sidecar = JSON.parse(await readFile(possible, 'utf8')) as BeatSidecar
          if (sidecar.schema !== 'sonic-v2/beat' || sidecar.id !== evidence.id || sidecar.output?.fingerprint !== beat.fingerprint ||
            sidecar.output?.filePath !== path.basename(file.path) || sidecar.source?.kind !== beat.sourceKind || sidecar.source?.url !== beat.sourceUrl) {
            throw new Error('The neighboring sidecar does not belong to this library export.')
          }
          candidate.sidecar = verified; candidate.sidecarId = sidecar.id
          candidate.value.sidecar = 'verified'
          candidate.value.note = 'Sonic ownership verified. Saved library corrections remain authoritative; use the existing sidecar retry to synchronize them.'
          return candidate
        } catch (error) { signal.throwIfAborted(); candidate.value.note = `Audio can reconnect; sidecar unresolved: ${errorMessage(error)}` }
      }
    }
    candidate.value.note ??= 'Audio can reconnect; sidecar unresolved. No matching sidecar ownership receipt was found in the selected folder.'
    return candidate
  }

  private async validateCandidate(plan: Plan, record: ExpectedRecord, candidate: CandidateState, signal: AbortSignal): Promise<RecoveryCommit> {
    const current = libraryService.recoveryRecord(record.beat.id, record.key)
    const root = plan.review.kind === 'folder' ? plan.review.rootPath : path.dirname(plan.review.rootPath)
    const file = await verifyFile(candidate.file.path, root, AbortSignal.any([signal, AbortSignal.timeout(RECOVERY_LIMITS.fileMs)]), RECOVERY_LIMITS.fileBytes)
    if (!sameFileStamp(candidate.file, file) || file.fingerprint !== current.fingerprint.toLowerCase()) throw new Error('The candidate changed after preview. Scan or locate this track again.')
    const described = await this.describeCandidate(current, file, root, signal)
    // A changed optional sidecar never invalidates identical audio, but it loses adoption/authority.
    if (candidate.sidecar && (!described.sidecar || !sameFileStamp(candidate.sidecar, described.sidecar))) {
      described.sidecar = null; described.sidecarId = null; described.value.sidecar = 'unresolved'
      described.value.note = 'Audio reconnected; sidecar unresolved because it changed after preview.'
    }
    return { id: current.id, expected: record.key, filePath: file.path, sizeBytes: file.sizeBytes,
      fileOwnership: described.value.ownership === 'retained' ? 'sonic-export' : 'external',
      ownershipEvidence: described.value.ownership === 'retained' ? { audio: file.file,
        ...(described.sidecar && described.sidecarId ? { sidecar: { id: described.sidecarId, file: described.sidecar.file } } : {}) } : undefined,
      sidecarPath: described.sidecar?.path ?? null,
      recoveryInfo: { recoveredAt: Date.now(), previousPath: current.filePath,
        ownership: described.value.ownership, sidecar: described.value.sidecar, note: described.value.note } }
  }

  private async applyChosen(plan: Plan): Promise<RecoveryReview> {
    const changes: RecoveryCommit[] = []
    const signal = plan.controller.signal
    const paths = new Map<string, string[]>()
    for (const [id, candidate] of plan.chosen) {
      const key = canonicalPath(candidate.file.path)
      paths.set(key, [...(paths.get(key) ?? []), id])
    }
    const validateLocations = (): void => {
      const currentPaths = new Map<string, Set<string>>()
      for (const beat of libraryService.list()) {
        const key = canonicalPath(beat.filePath)
        if (!currentPaths.has(key)) currentPaths.set(key, new Set())
        currentPaths.get(key)!.add(beat.id)
      }
      for (const [id, candidate] of plan.chosen) {
        const usedBy = currentPaths.get(canonicalPath(candidate.file.path))
        if ((paths.get(canonicalPath(candidate.file.path))?.length ?? 0) > 1 || [...(usedBy ?? [])].some(other => other !== id)) {
          throw new Error('A chosen location is referenced by another record or selected more than once. Review the candidates again.')
        }
      }
    }
    try {
      validateLocations()
      await this.parallel([...plan.chosen], async ([id, candidate]) => {
        const record = plan.records.get(id)!
        try { changes.push(await this.validateCandidate(plan, record, candidate, signal)) }
        catch (error) {
          signal.throwIfAborted()
          record.item.status = 'invalid'; record.item.error = errorMessage(error)
        }
      })
      signal.throwIfAborted()
      if (this.stopped || isStopping()) throw new Error('Sonic is closing; recovery was not applied.')
      // No async work is permitted between this final conflict check and the coherent revision.
      validateLocations()
      const valid = changes.filter(change => {
        try { libraryService.recoveryRecord(change.id, change.expected); return true }
        catch (error) { const item = plan.records.get(change.id)!.item; item.status = 'invalid'; item.error = errorMessage(error); return false }
      })
      if (!valid.length) { plan.review.phase = 'complete'; return this.snapshot(plan) }
      if (libraryService.pendingRevision() !== null) throw new Error('Another library save is pending. Retry saving before applying recovery.')
      const prepareRetry = async (): Promise<void> => {
        signal.throwIfAborted()
        if (this.stopped || isStopping()) throw new Error('Sonic is closing; recovery was not applied.')
        validateLocations()
        await this.parallel(valid, async change => {
          const record = plan.records.get(change.id)!
          const fresh = await this.validateCandidate(plan, record, plan.chosen.get(change.id)!, signal)
          if (fresh.fileOwnership !== change.fileOwnership || fresh.sidecarPath !== change.sidecarPath ||
            JSON.stringify(fresh.ownershipEvidence) !== JSON.stringify(change.ownershipEvidence)) {
            throw new Error('A candidate or sidecar changed while saving was pending. Cancel this recovery and review it again.')
          }
        })
        signal.throwIfAborted()
        if (this.stopped || isStopping()) throw new Error('Sonic is closing; recovery was not applied.')
        validateLocations()
        for (const change of valid) libraryService.recoveryRecord(change.id, change.expected)
      }
      try { libraryService.commitRecovery(valid, signal, prepareRetry) }
      catch (error) {
        const pendingRevision = libraryService.pendingRevision()
        if (pendingRevision !== null) {
          plan.review.phase = 'pending-save'; plan.review.pendingRevision = pendingRevision
          plan.review.error = `Reconnection save is pending; no new paths are committed. Use Retry saving. ${errorMessage(error)}`
          plan.chosen = new Map(valid.map(change => [change.id, plan.chosen.get(change.id)!]))
          return this.snapshot(plan)
        }
        throw error
      }
      this.markCommitted(plan, valid.map(change => change.id))
    } catch (error) {
      plan.review.phase = signal.aborted ? 'cancelled' : 'error'
      plan.review.error = signal.aborted ? null : errorMessage(error)
    }
    return this.snapshot(plan)
  }

  private markCommitted(plan: Plan, ids: string[]): void {
    plan.review.phase = 'complete'; plan.review.error = null; plan.review.pendingRevision = null; plan.review.committedIds = ids
    for (const id of ids) {
      const item = plan.records.get(id)!.item
      const beat = libraryService.get(id)!
      item.status = 'reconnected'; item.error = null
      const candidate = plan.chosen.get(id)!
      candidate.value.note = beat.recoveryInfo?.note ?? null
      candidate.value.sidecar = beat.recoveryInfo?.sidecar ?? 'not-applicable'
      item.candidates = [candidate.value]
    }
  }

  private reconcileSave(plan: Plan): void {
    if (plan.review.phase !== 'pending-save' || libraryService.pendingRevision() !== null) return
    const ids = [...plan.chosen.keys()].filter(id => {
      const beat = libraryService.get(id), candidate = plan.chosen.get(id)!
      return beat && canonicalPath(beat.filePath) === canonicalPath(candidate.file.path) && beat.fingerprint.toLowerCase() === candidate.file.fingerprint && !beat.missing
    })
    if (ids.length === plan.chosen.size) this.markCommitted(plan, ids)
  }
}

export const recoveryService = new RecoveryService()
