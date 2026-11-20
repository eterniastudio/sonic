/** A recovery plan is process-local. Only committed library paths survive restart. */
export type RecoveryPhase = 'scanning' | 'ready' | 'applying' | 'complete' | 'cancelled' | 'pending-save' | 'error'
export type RecoveryItemStatus = 'matched' | 'ambiguous' | 'not-found' | 'unverifiable' | 'error' | 'reconnected' | 'invalid'

/** File-system identity is ownership evidence, independent of the content hash. */
export interface PhysicalFileIdentity {
  device: string
  inode: string
  born: string
}

export interface ExportOwnershipEvidence {
  audio: PhysicalFileIdentity
  sidecar?: { id: string; file: PhysicalFileIdentity }
}

export function validOwnershipEvidence(value: unknown): value is ExportOwnershipEvidence {
  const record = (entry: unknown): entry is Record<string, unknown> => !!entry && typeof entry === 'object' && !Array.isArray(entry)
  const physical = (entry: unknown): entry is PhysicalFileIdentity => record(entry) &&
    ['device', 'inode', 'born'].every(key => typeof entry[key] === 'string' && /^\d{1,30}$/.test(entry[key] as string))
  return record(value) && physical(value.audio) && (value.sidecar === undefined || (record(value.sidecar) &&
    typeof value.sidecar.id === 'string' && value.sidecar.id.length > 0 && value.sidecar.id.length <= 256 && physical(value.sidecar.file)))
}

export interface RecoveryInfo {
  recoveredAt: number
  previousPath: string
  ownership: 'retained' | 'read-only'
  sidecar: 'verified' | 'unresolved' | 'not-applicable'
  note: string | null
}

export interface RecoveryCandidate {
  id: string
  path: string
  ownership: RecoveryInfo['ownership']
  sidecar: RecoveryInfo['sidecar']
  note: string | null
}

export interface RecoveryItem {
  beatId: string
  title: string
  oldPath: string
  status: RecoveryItemStatus
  candidates: RecoveryCandidate[]
  error: string | null
}

export interface RecoveryStats {
  visited: number
  files: number
  hashed: number
  hashedBytes: number
  skippedLinks: number
  elapsedMs: number
}

export interface RecoveryReview {
  planId: string
  kind: 'file' | 'folder'
  rootPath: string
  phase: RecoveryPhase
  requestedCount: number
  /** Omitted until inspection finishes, so progress never copies the whole library. */
  items: RecoveryItem[]
  stats: RecoveryStats
  errors: { path: string; message: string }[]
  error: string | null
  completeSearch: boolean
  committedIds: string[]
  pendingRevision: number | null
}

export interface RecoverySelection { beatId: string; candidateId: string }

export const RECOVERY_LIMITS = {
  records: 10_000,
  entries: 25_000,
  depth: 12,
  candidatesPerRecord: 20,
  hashConcurrency: 2,
  fileBytes: 2 * 1024 ** 3,
  totalHashBytes: 8 * 1024 ** 3,
  scanMs: 10 * 60_000,
  fileMs: 120_000
} as const
