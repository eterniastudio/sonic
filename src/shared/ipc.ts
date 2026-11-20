/**
 * The typed contract between the renderer and the main process.
 *
 * `IpcMap` is the single source of truth: both sides derive their signatures
 * from it, so adding a channel is a compile error until it is handled.
 */

import type {
  AppInfo,
  BeatMetadata,
  EngineProgress,
  EngineStatus,
  Job,
  LibraryBeat,
  LocalImportReview,
  MetadataDraft,
  MetadataField,
  PresetId,
  ProbeResult,
  QueueSnapshot,
  Settings,
  TemplatePreview
} from './domain'
import type { AudioAnalysis } from './analysis'
import type { OrganizationCommand, OrganizationSnapshot } from './organization'
import type { BatchRequest, BatchSession } from './batch'
import type { PlaybackCheckpoint, PlaybackIdentity, PlaybackSessionSnapshot } from './playback'
import type { RecoveryReview, RecoverySelection } from './recovery'
import type { PlaylistReview } from './playlist'
import type { UpdateStatus } from './update'

export type ToolName = 'yt-dlp' | 'ffmpeg' | 'ffprobe'

/** Editable slice of a job — everything a producer can change before export. */
export interface JobPatch {
  presetId?: PresetId
  /** Set one field by hand. Records it as a manual override. */
  metadataEdit?: { field: MetadataField; value: string | number | null }
  /** Return fields to the evidence layers, discarding the manual override. */
  clearOverrides?: MetadataField[]
  /** Promote the analysed value into `final` as an explicit decision. */
  adoptAnalyzed?: MetadataField[]
}

export interface IpcMap {
  'playback:get': { args: []; result: PlaybackSessionSnapshot }
  'playback:identity': { args: [beatId: string]; result: PlaybackIdentity }
  'playback:checkpoint': { args: [command: PlaybackCheckpoint]; result: PlaybackSessionSnapshot }
  'storage:status': { args: []; result: StorageStatus[] }
  'storage:retry': { args: []; result: StorageStatus[] }
  'library:retrySidecar': { args: [id: string]; result: LibraryBeat[] }
  'app:readClipboard': { args: []; result: string }
  'app:info': { args: []; result: AppInfo }
  'app:openDirectory': { args: [kind: 'userData' | 'downloads' | 'engine']; result: boolean }

  'update:status': { args: []; result: UpdateStatus }
  'update:check': { args: []; result: UpdateStatus }
  /** Closes Sonic normally, then installs the downloaded update and relaunches. False when none is ready. */
  'update:install': { args: []; result: boolean }

  'window:minimize': { args: []; result: void }
  'window:toggleMaximize': { args: []; result: boolean }
  'window:close': { args: []; result: void }
  'window:isMaximized': { args: []; result: boolean }

  'engine:status': { args: []; result: EngineStatus }
  'engine:setup': { args: []; result: EngineStatus }
  'engine:pickTool': { args: [name: ToolName]; result: string | null }

  'settings:get': { args: []; result: Settings }
  'settings:patch': { args: [patch: Partial<Settings>]; result: Settings }
  'settings:chooseDir': { args: []; result: string | null }
  'settings:previewTemplate': {
    args: [template: string, presetId: PresetId]
    result: TemplatePreview
  }

  'probe:url': { args: [url: string]; result: ProbeResult }
  'playlist:inspect': { args: [url: string, requestId: string]; result: PlaylistReview }
  'playlist:cancel': { args: [requestId: string]; result: void }

  'queue:snapshot': { args: []; result: QueueSnapshot }
  'queue:add': { args: [urls: string[]]; result: QueueSnapshot }
  'queue:remove': { args: [id: string]; result: QueueSnapshot }
  'queue:start': { args: [ids: string[] | null]; result: QueueSnapshot }
  'queue:cancel': { args: [id: string]; result: QueueSnapshot }
  'queue:retry': { args: [id: string]; result: QueueSnapshot }
  'queue:setPaused': { args: [paused: boolean]; result: QueueSnapshot }
  'queue:setConcurrency': { args: [value: number]; result: QueueSnapshot }
  'queue:reorder': { args: [ids: string[]]; result: QueueSnapshot }
  'queue:updateJob': { args: [id: string, patch: JobPatch]; result: Job | null }
  'queue:clearFinished': { args: []; result: QueueSnapshot }
  /** Re-queues every failed job in one step; cancelled jobs stay cancelled. */
  'queue:retryFailed': { args: []; result: QueueSnapshot }
  'queue:revealOutput': { args: [id: string]; result: boolean }
  'queue:openOutput': { args: [id: string]; result: boolean }

  'library:list': { args: []; result: LibraryBeat[] }
  'recovery:chooseFile': { args: [beatId: string]; result: { planId: string | null } }
  'recovery:chooseFolder': { args: [beatIds: string[]]; result: { planId: string | null } }
  'recovery:status': { args: [planId: string]; result: RecoveryReview }
  'recovery:apply': { args: [planId: string, selected: RecoverySelection[]]; result: RecoveryReview }
  'recovery:cancel': { args: [planId: string]; result: RecoveryReview }
  'organization:snapshot': { args: []; result: OrganizationSnapshot }
  'organization:command': { args: [command: OrganizationCommand]; result: OrganizationSnapshot }
  'batch:start': { args: [request: BatchRequest]; result: BatchSession }
  'batch:status': { args: [sessionId: string]; result: BatchSession | null }
  'batch:cancel': { args: [sessionId: string]; result: BatchSession | null }
  'batch:retry': { args: [sessionId: string]; result: BatchSession }
  'import:chooseFiles': { args: []; result: { sessionId: string | null } }
  'import:chooseFolder': { args: [recursive: boolean]; result: { sessionId: string | null } }
  'import:status': { args: [sessionId: string]; result: LocalImportReview | null }
  'import:confirm': { args: [sessionId: string, selectedIds: string[]]; result: LocalImportReview }
  'import:cancel': { args: [sessionId: string]; result: LocalImportReview | null }
  'library:openSource': { args: [id: string]; result: boolean }
  /** Edits reach the window through `library:changed`/`library:delta`; replies stay small. */
  'library:refreshSource': { args: [id: string]; result: LibraryBeat | null }
  'library:revealFile': { args: [id: string]; result: boolean }
  'library:openFile': { args: [id: string]; result: boolean }
  'library:openSidecarFile': { args: [id: string]; result: boolean }
  'library:updateMetadata': {
    args: [id: string, patch: Partial<BeatMetadata>, clearOverrides?: MetadataField[]]
    /** The updated record. The list itself arrives through the library change push. */
    result: LibraryBeat | null
  }
  /** Starts an OS drag of these records' audio files (to a DAW or Explorer). Paths stay in main. */
  'library:startDrag': { args: [ids: string[]]; result: { started: boolean; count: number } }
  /** Saves these records as a CSV or JSON track list via a native save dialog. */
  'library:exportList': { args: [ids: string[]]; result: { saved: boolean; count: number; fileName: string | null } }
  /** Keeps one record of a duplicate group, merges its annotations, and removes the others from the library only. */
  'library:resolveDuplicates': { args: [keepId: string, removeIds: string[]]; result: LibraryBeat[] }
  'library:remove': { args: [id: string, deleteFiles: boolean, expected?: { filePath: string; fingerprint: string }]; result: { ok: true } }

  // --------------------------------------------------------------- analysis
  'analysis:beat': {
    args: [id: string, force: boolean]
    result: { ok: boolean; error: string | null; analysis: AudioAnalysis | null }
  }
  'analysis:cancel': { args: [beatId: string]; result: void }
  'analysis:queueMissing': { args: []; result: { queued: number } }
  'analysis:clearCache': { args: []; result: { cleared: number } }
  'analysis:status': {
    args: []
    result: {
      engine: string
      cacheEntries: number
      running: number
      queued: number
      concurrency: number
      enabled: boolean
    }
  }
  'library:rescan': { args: []; result: { count: number } }
  'library:reexport': {
    args: [id: string, presetId: PresetId]
    result: { ok: boolean; outputPath: string | null; error: string | null; pendingSave?: boolean; publishedBeatId?: string }
  }

  'metadata:parse': {
    args: [{ title?: string | null; description?: string | null; filename?: string | null }]
    result: MetadataDraft
  }
}

/** A library push relative to the previous push: the complete ordered ids, and
 * only the records that changed. Unlisted records are unchanged. */
export interface LibraryDelta {
  ids: string[]
  changed: LibraryBeat[]
}

/** Push channels, main → renderer. */
export interface IpcEvents {
  'storage:changed': StorageStatus[]
  'queue:changed': QueueSnapshot
  'engine:status': EngineStatus
  'engine:progress': EngineProgress
  'settings:changed': Settings
  'library:changed': LibraryBeat[]
  'library:delta': LibraryDelta
  'organization:changed': OrganizationSnapshot
  'app:notice': { kind: 'info' | 'success' | 'error'; message: string }
  'window:maximized': boolean
  'update:status': UpdateStatus
  /** Analysis progress for a library track or a download job. */
  'analysis:progress': {
    /** Library beat id when analysing an existing track, else null. */
    beatId: string | null
    jobId: string | null
    phase: 'starting' | 'decoding' | 'analyzing' | 'done' | 'failed' | 'cancelled'
    message: string
  }
}

export type IpcChannel = keyof IpcMap
export type IpcEventChannel = keyof IpcEvents

export const IPC_EVENT_CHANNELS: readonly IpcEventChannel[] = [
  'storage:changed',
  'queue:changed',
  'engine:status',
  'engine:progress',
  'settings:changed',
  'library:changed',
  'library:delta',
  'organization:changed',
  'app:notice',
  'window:maximized',
  'analysis:progress',
  'update:status'
] as const

export const IPC_CHANNELS: readonly IpcChannel[] = [
  'playback:get',
  'playback:identity',
  'playback:checkpoint',
  'storage:status',
  'storage:retry',
  'library:retrySidecar',
  'app:info',
  'app:readClipboard',
  'app:openDirectory',
  'update:status',
  'update:check',
  'update:install',
  'window:minimize',
  'window:toggleMaximize',
  'window:close',
  'window:isMaximized',
  'engine:status',
  'engine:setup',
  'engine:pickTool',
  'settings:get',
  'settings:patch',
  'settings:chooseDir',
  'settings:previewTemplate',
  'probe:url',
  'playlist:inspect',
  'playlist:cancel',
  'queue:snapshot',
  'queue:add',
  'queue:remove',
  'queue:start',
  'queue:cancel',
  'queue:retry',
  'queue:setPaused',
  'queue:setConcurrency',
  'queue:reorder',
  'queue:updateJob',
  'queue:clearFinished',
  'queue:retryFailed',
  'queue:revealOutput',
  'queue:openOutput',
  'library:list',
  'recovery:chooseFile',
  'recovery:chooseFolder',
  'recovery:status',
  'recovery:apply',
  'recovery:cancel',
  'organization:snapshot',
  'organization:command',
  'batch:start',
  'batch:status',
  'batch:cancel',
  'batch:retry',
  'import:chooseFiles',
  'import:chooseFolder',
  'import:status',
  'import:confirm',
  'import:cancel',
  'library:openSource',
  'library:refreshSource',
  'library:revealFile',
  'library:openFile',
  'library:openSidecarFile',
  'library:updateMetadata',
  'library:remove',
  'library:startDrag',
  'library:exportList',
  'library:resolveDuplicates',
  'analysis:beat',
  'analysis:cancel',
  'analysis:queueMissing',
  'analysis:clearCache',
  'analysis:status',
  'library:rescan',
  'library:reexport',
  'metadata:parse'
] as const

export interface StorageStatus { file: string; revision: number; persisted: number; error: string | null }
