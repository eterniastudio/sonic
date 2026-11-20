/**
 * Sonic — shared domain model.
 *
 * These types cross the process boundary (main ⇄ preload ⇄ renderer), so this
 * module must stay free of Node and DOM dependencies.
 */

import type { AnalysisStatus, AudioAnalysis, AudioEvidence } from './analysis'
import type { ExportOwnershipEvidence, RecoveryInfo } from './recovery'
import type { ProviderId } from './providers'

export type ThemeMode = 'dark' | 'light' | 'system'

export type AccentId = 'violet' | 'cyan' | 'emerald' | 'amber' | 'rose'

export type PresetId =
  | 'original'
  | 'mp3-v0'
  | 'mp3-320'
  | 'm4a-256'
  | 'wav-44100-24'
  | 'wav-48000-24'
  | 'flac'
  | 'opus-192'

export type ChannelMode = 'preserve' | 'stereo' | 'mono'

/**
 * Where a library record came from: a download provider id from the registry,
 * a local import, or unknown. Records written before the registry existed
 * ('youtube' | 'soundcloud' | 'local' | 'unknown') are a subset and load unchanged.
 */
export type SourceKind = ProviderId | 'local' | 'unknown'

/** Only Sonic-created exports may be renamed or removed from disk by library actions. */
export type FileOwnership = 'sonic-export' | 'external'

export interface LocalImportItem {
  id: string
  filePath: string
  fileName: string
  status: 'ready' | 'already-indexed' | 'unsupported' | 'unreadable' | 'failed' | 'imported' | 'skipped'
  duplicateOf: string | null
  error: string | null
  title: string | null
  bpm: number | null
  key: string | null
  durationSec: number | null
}

export interface LocalImportReview {
  sessionId: string
  kind: 'files' | 'folder'
  recursive: boolean
  phase: 'scanning' | 'ready' | 'importing' | 'done' | 'cancelled' | 'error'
  scanned: number
  items: LocalImportItem[]
  error: string | null
}

/** Where a text/tag metadata value came from. */
export type EvidenceSource = 'title' | 'description' | 'filename' | 'tags' | 'manual'

export type MetadataField =
  | 'title'
  | 'producer'
  | 'bpm'
  | 'altBpm'
  | 'key'
  | 'camelot'
  | 'detune'
  | 'tuning'
  | 'genre'

export interface BeatMetadata {
  title: string
  producer: string | null
  bpm: number | null
  /** The other side of a half/double-time pairing, when the source declares two. */
  altBpm: number | null
  /** Canonical spelling, e.g. `F# minor`. */
  key: string | null
  /** Camelot wheel position, e.g. `11A`. */
  camelot: string | null
  /** Signed cents offset from A440. */
  detune: number | null
  /** Raw tuning declaration, e.g. `A=432Hz`. */
  tuning: string | null
  genre: string | null
}

export type MetadataValues = Partial<BeatMetadata>

export interface Evidence {
  field: MetadataField
  /** Human-readable value as interpreted. */
  value: string
  source: EvidenceSource
  /** The literal substring in the source that produced this value. */
  matched: string
  /** 0..1 — how strongly the pattern matched. Not comparable to audio quality. */
  confidence: number
}

export interface MetadataConflict {
  field: MetadataField
  declared: string | null
  embedded: string | null
  /** Present when an audio estimate also exists for the field. */
  analyzed?: string | null
  note: string
}

/** The three text sources, kept apart so they can be cross-checked. */
export type DeclaredSourceId = 'title' | 'description' | 'filename'

export type SourceValues = Record<DeclaredSourceId, MetadataValues>

/** Every place a value can come from, including the analyser and the producer. */
export type CandidateOrigin =
  | 'title'
  | 'description'
  | 'filename'
  | 'embeddedTag'
  | 'audioEstimate'
  | 'manual'

export type AgreementVerdict =
  /** Sources agree within tolerance. */
  | 'match'
  /** Related but not identical: a small difference, or a half/double-time or relative-key reading. */
  | 'close'
  /** Sources contradict each other. */
  | 'mismatch'
  /** Only one source said anything, so there is nothing to cross-check. */
  | 'single-source'
  /** Nothing declared anything about this field. */
  | 'no-evidence'

export interface VerificationCandidate {
  origin: CandidateOrigin
  /** Human label for the origin, e.g. `Video title`. */
  label: string
  value: string
  /** Parsed numeric value for tempo/detune comparisons. */
  numeric: number | null
}

export interface FieldVerification {
  field: MetadataField
  verdict: AgreementVerdict
  /** Every value found for this field, in authority order. */
  candidates: VerificationCandidate[]
  /** The value the model settled on. */
  effective: string | null
  note: string
}

/**
 * The result of checking what the source claimed against what the audio
 * actually measures. Recomputed whenever any evidence layer changes.
 */
export interface MetadataVerification {
  checkedAt: number
  fields: FieldVerification[]
  summary: { match: number; close: number; mismatch: number; unchecked: number }
}


/**
 * The five-layer metadata model:
 *
 *   declared  — parsed from source text (title / description / filename)
 *   embedded  — read back from the acquired or local file's container tags
 *   analyzed  — estimated from the decoded audio signal
 *   suggested — reconciliation of the three evidence layers above
 *   final     — the producer's effective decision, used for naming and tagging
 *
 * `overrides` replaces the old single `dirty` flag. That flag froze every field
 * the moment any one was edited, so renaming a beat blocked a BPM estimate from
 * ever landing. Overrides are tracked per field instead.
 */
export interface MetadataDraft {
  declared: MetadataValues
  embedded: MetadataValues
  analyzed: MetadataValues
  suggested: MetadataValues
  final: BeatMetadata
  /**
   * Each declared source kept separately, so the video title can be checked
   * against the description and against the audio estimate rather than being
   * flattened into one `declared` blob.
   */
  sources: SourceValues
  /** Text/tag evidence, each carrying the source substring that produced it. */
  evidence: Evidence[]
  /** Acoustic evidence, carrying analyzer quality rather than regex confidence. */
  audioEvidence: AudioEvidence[]
  conflicts: MetadataConflict[]
  /** Declared-vs-measured agreement, or null before an analysis has run. */
  verification: MetadataVerification | null
  /** Fields the producer set explicitly. Analysis never overwrites these. */
  overrides: MetadataField[]
  /** Full record of the most recent analysis run, or null. */
  analysis: AudioAnalysis | null
}

export type JobStage =
  /** Metadata is being fetched from the provider. */
  | 'probing'
  /** Metadata is in hand and the job is waiting for the producer to start it. */
  | 'ready'
  /** Started, waiting for a free worker. */
  | 'queued'
  | 'downloading'
  /** Acoustic tempo/key analysis of the downloaded source. */
  | 'analyzing'
  | 'converting'
  | 'tagging'
  | 'publishing'
  | 'complete'
  | 'failed'
  | 'cancelled'

export interface Job {
  id: string
  url: string
  videoId: string | null
  sourceKind: SourceKind
  /** Raw source title from the provider, before parsing. */
  sourceTitle: string | null
  sourceDescription: string | null
  uploader: string | null
  thumbnail: string | null
  durationSec: number | null
  stage: JobStage
  /** 0..1 within the current stage. */
  progress: number
  speed: string | null
  eta: string | null
  message: string | null
  error: string | null
  presetId: PresetId
  metadata: MetadataDraft
  outputPath: string | null
  libraryId: string | null
  /** Bumped on every producer edit so late-arriving worker writes cannot clobber it. */
  revision: number
  createdAt: number
  updatedAt: number
}

export interface LibraryBeat {
  id: string
  title: string
  producer: string | null
  bpm: number | null
  altBpm: number | null
  key: string | null
  camelot: string | null
  detune: number | null
  presetId: PresetId
  format: string
  filePath: string
  fileName: string
  fileOwnership: FileOwnership
  /** Receipts captured when Sonic creates files; content hashes alone do not prove ownership. */
  ownershipEvidence?: ExportOwnershipEvidence
  recoveryInfo?: RecoveryInfo
  sidecarPath: string | null
  /** Library is authoritative; audio tags are unchanged by correction. */
  sidecarSync?: { status: 'pending' | 'synced' | 'error'; error: string | null }
  /** Tags read back from this exact published audio file, before library edits. */
  publishedTags?: MetadataValues | null
  sizeBytes: number
  durationSec: number
  bitrateKbps: number | null
  sampleRate: number | null
  channels: number | null
  sourceUrl: string | null
  /** Channel credited by the source platform; distinct from a producer credit. */
  sourceChannel?: string | null
  /** Artwork returned by the source platform, retained across restarts. */
  thumbnail?: string | null
  /** Template used for this export, retained when global settings change. */
  namingTemplate?: string | null
  namingIndex?: number | null
  sourceKind: SourceKind
  addedAt: number
  /** SHA-256 of the published audio, used to verify before destructive actions. */
  fingerprint: string
  /** Set by a rescan when the file is gone from disk. */
  missing: boolean
  /** Access/volume failures are not evidence that an audio file was deleted. */
  fileAccessError?: string | null
  /** Track-level analysis state, for the library UI. */
  analysisStatus: AnalysisStatus
  /** Full analysis record, when one has been run. */
  analysis: AudioAnalysis | null
  /** Fields the producer set by hand; analysis and reconciliation must not overwrite them. */
  overrides: MetadataField[]
  /**
   * What each source claimed at export time. Kept so a library track can still
   * be cross-checked against the audio long after the original job is gone.
   */
  sources: SourceValues
  /** Container tags read at export time, for the same reason. */
  embedded: MetadataValues
  /** Declared-vs-measured agreement, recomputed whenever evidence changes. */
  verification: MetadataVerification | null
}

/** Versioned sidecar written next to every processed export. */
export interface BeatSidecar {
  schema: 'sonic-v2/beat'
  /** 1 = pre-analysis. 2 adds the acoustic analysis record. */
  schemaVersion: 1 | 2
  id: string
  app: { name: string; version: string }
  exportedAt: string
  source: {
    kind: SourceKind
    url: string | null
    videoId: string | null
    uploader: string | null
    channel?: string | null
    thumbnail?: string | null
    title: string | null
  }
  metadata: BeatMetadata
  evidence: Evidence[]
  conflicts: MetadataConflict[]
  /** Acoustic analysis, from schemaVersion 2. */
  analysis?: AudioAnalysis | null
  audioEvidence?: AudioEvidence[]
  /** Declared-vs-measured cross-check, from schemaVersion 2. */
  verification?: MetadataVerification | null
  /** Fields the producer set by hand, from schemaVersion 2. */
  overrides?: MetadataField[]
  /** Independent source evidence retained when effective metadata changes. */
  sources?: SourceValues
  embedded?: MetadataValues
  naming: { template: string; fileName: string }
  recipe: {
    presetId: PresetId
    channels: ChannelMode
    lufs: number | null
    embedTags: boolean
  }
  output: {
    /** File name only, so a shared sidecar never reveals local paths. */
    filePath: string
    sizeBytes: number
    durationSec: number
    format: string
    bitrateKbps: number | null
    sampleRate: number | null
    channels: number | null
    /** SHA-256 of the audio exactly as published. */
    fingerprint: string
  }
  engine: {
    ytdlp: string | null
    ffmpeg: string | null
  }
}

export interface ProbeResult {
  url: string
  videoId: string | null
  title: string
  description: string | null
  uploader: string | null
  thumbnail: string | null
  durationSec: number | null
  isLive: boolean
  /** Populated when the URL cannot be read. */
  error: string | null
}

export interface EngineComponent {
  name: 'yt-dlp' | 'ffmpeg' | 'ffprobe'
  available: boolean
  path: string | null
  version: string | null
  origin: 'managed' | 'system' | null
}

export interface EngineStatus {
  ready: boolean
  engineDir: string
  components: EngineComponent[]
  setupRunning: boolean
  lastError: string | null
}

export interface EngineProgress {
  phase: 'idle' | 'resolving' | 'downloading' | 'verifying' | 'done' | 'error'
  component: string
  receivedBytes: number
  totalBytes: number | null
  percent: number | null
  message: string
}

export interface AppInfo {
  name: string
  version: string
  electron: string
  chrome: string
  node: string
  platform: string
  userDataDir: string
  defaultDownloadDir: string
}

export type ReduceMotionPreference = 'system' | 'on' | 'off'

export interface Settings {
  theme: ThemeMode
  accent: AccentId
  reduceMotion: ReduceMotionPreference

  downloadDir: string
  defaultPresetId: PresetId
  namingTemplate: string
  concurrency: number
  /** Begin exporting as soon as a pasted link has been inspected. */
  autoStart: boolean
  channelMode: ChannelMode
  normalizeLufs: number | null
  embedTags: boolean
  writeSidecar: boolean
  sidecarInSubfolder: boolean
  embedThumbnail: boolean

  /** Analyze downloaded audio automatically and fold the results into metadata. */
  analyzeOnDownload: boolean
  /** Concurrent analysis workers. Analysis is CPU-bound; 1–2 is usually right. */
  analysisConcurrency: number
  /**
   * Rewrite container tags inside the audio file when metadata is corrected.
   * Off by default: a library correction then updates the library record and the
   * sidecar, and never silently rewrites previously exported audio.
   */
  rewriteTagsOnEdit: boolean

  /** Explicit tool paths. `null` means "auto-resolve". */
  ytdlpPath: string | null
  ffmpegPath: string | null
  ffprobePath: string | null

  /** Advanced acquisition knobs. */
  maxDurationSec: number
  skipExisting: boolean
  cookiesFromBrowser: 'none' | 'chrome' | 'edge' | 'firefox' | 'brave' | 'opera' | 'vivaldi'
  /**
   * Accept links from sites outside the provider registry and hand them to
   * yt-dlp's generic extractor. Off by default.
   */
  allowOtherSites: boolean

  /** Library rescan cadence in ms; 0 disables the background rescan. */
  rescanIntervalMs: number

  /**
   * When Sonic gains focus, offer to queue a supported link found on the
   * clipboard. Opt-in: off by default, and nothing is queued without a click.
   */
  watchClipboard: boolean
}

export interface QueueSnapshot {
  jobs: Job[]
  paused: boolean
  concurrency: number
}

export interface TemplatePreview {
  rendered: string
  /** Tokens present in the template that Sonic does not understand. */
  unknownTokens: string[]
  /** True when sanitisation changed the rendered value. */
  sanitized: boolean
}
