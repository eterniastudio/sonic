/** Small, versioned listening preference. A successful checkpoint is a disk commit. */
export interface PlaybackPosition {
  beatId: string
  fingerprint: string
  positionSec: number
  completed: boolean
  updatedAt: number
}

export interface PlaybackSessionSnapshot {
  schemaVersion: 1
  lastTrackId: string | null
  volume: number
  positions: PlaybackPosition[]
}

/** Hash of the bytes currently on disk, resolved by stable library ID in main. */
export interface PlaybackIdentity {
  beatId: string
  fingerprint: string
  sizeBytes: number
  modifiedAt: number
}

export type PlaybackCheckpoint =
  | { type: 'active'; beatId: string | null }
  | { type: 'volume'; volume: number }
  | { type: 'position'; beatId: string; fingerprint: string; positionSec: number; completed: boolean }
