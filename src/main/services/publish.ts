import { app } from 'electron'
import { createReadStream, existsSync } from 'node:fs'
import { open, lstat, unlink } from 'node:fs/promises'
import { pipeline } from 'node:stream/promises'
import path from 'node:path'
import type {
  BeatMetadata,
  BeatSidecar,
  ChannelMode,
  Evidence,
  LibraryBeat,
  MetadataConflict,
  MetadataField,
  MetadataValues,
  MetadataVerification,
  PresetId,
  SourceKind,
  SourceValues
} from '@shared/domain'
import type { AudioAnalysis, AudioEvidence } from '@shared/analysis'
import { deriveAnalysisStatus } from '@shared/analysis'
import { formatDateStamp } from '@shared/format'
import { getPreset } from '@shared/presets'
import { renderExportStem, resolveCollision, sanitizeFilename } from '@shared/template'
import { ensureDir } from '../lib/fsx'
import { storageDiagnostic } from '../lib/jsonStore'
import { libraryFile } from './paths'
import { createId } from '../lib/id'
import { libraryService } from './library'
import { settingsService } from './settings'
import { capturePhysicalIdentity } from '../lib/fileIdentity'

export interface PublishInput {
  signal?: AbortSignal
  jobId: string
  /** Converted, tagged file sitting in staging. */
  stagedPath: string
  extension: string
  metadata: BeatMetadata
  presetId: PresetId
  sourceKind: SourceKind
  sourceUrl: string | null
  videoId: string | null
  uploader: string | null
  thumbnail?: string | null
  sourceTitle: string | null
  evidence: Evidence[]
  conflicts: MetadataConflict[]
  channels: ChannelMode
  lufs: number | null
  embedTags: boolean
  fingerprint: string
  index: number
  durationSec: number
  /** Acoustic analysis, when one ran. */
  analysis: AudioAnalysis | null
  audioEvidence: AudioEvidence[]
  /** Declared-vs-measured cross-check, when one could be made. */
  verification: MetadataVerification | null
  /** Fields the producer set by hand. */
  overrides: MetadataField[]
  /** What each source claimed, retained for later library-side checks. */
  sources: SourceValues
  /** Container tags read at export time. */
  embedded: MetadataValues
  /** Tags read back from the converted output before publication. */
  tagReadback?: MetadataValues
  /** Tool versions recorded in the sidecar for provenance. */
  engine: { ytdlp: string | null; ffmpeg: string | null }
  output: {
    sizeBytes: number
    format: string
    bitrateKbps: number | null
    sampleRate: number | null
    channels: number | null
  }
}

export interface PublishResult {
  filePath: string
  fileName: string
  sidecarPath: string | null
  beat: LibraryBeat
}

/** Publication reached disk, but its library revision has not been committed. */
export class PendingPublicationError extends Error {
  constructor(
    readonly outputPath: string,
    readonly beatId: string,
    cause: unknown
  ) {
    super(`Export files preserved at ${outputPath}; library save needs retry: ${String(cause)}`, { cause })
    this.name = 'PendingPublicationError'
  }
}

const SIDECAR_FOLDER = '.json'
interface OwnedOutput { path: string; ino: number; birthtimeMs: number }

async function createOwned(file: string, owned: OwnedOutput[]): Promise<Awaited<ReturnType<typeof open>>> {
  const handle = await open(file, 'wx')
  try {
    const stat = await handle.stat()
    owned.push({ path: file, ino: stat.ino, birthtimeMs: stat.birthtimeMs })
    return handle
  } catch (error) { await handle.close(); throw error }
}

/**
 * Renders the final filename, moves the export into the destination folder
 * without ever clobbering an existing file, writes the sidecar, and records the
 * result in the library.
 */
export async function publishExport(input: PublishInput): Promise<PublishResult> {
  // An unsaved library revision would reject this record after the files exist.
  libraryService.assertWritable()
  const settings = settingsService.get()
  const directory = settings.downloadDir
  await ensureDir(directory)

  const preset = getPreset(input.presetId)
  const extension = input.extension || preset.extension

  const stem = renderExportStem(settings.namingTemplate, {
    metadata: { ...input.metadata, producer: input.metadata.producer || input.uploader },
    presetId: input.presetId,
    sourceKind: input.sourceKind,
    index: input.index,
    durationSec: input.durationSec
  })

  const fallbackStem = sanitizeFilename(input.metadata.title || preset.label).value

  // Numbered suffixes instead of overwrites — a producer's existing file is
  // never replaced without an explicit decision.
  const claimed = new Set<string>()
  const nextName = (): string => resolveCollision(`${stem || fallbackStem}.${extension}`, (candidate) =>
    claimed.has(candidate.toLowerCase()) || existsSync(path.join(directory, candidate)) || (settings.writeSidecar && existsSync(path.join(directory,
      settings.sidecarInSubfolder ? SIDECAR_FOLDER : '', `${candidate}.sonic.json`)))
  )
  let fileName = nextName()
  let filePath = path.join(directory, fileName)

  input.signal?.throwIfAborted()
  let sidecarPath: string | null = null
  let sidecarId: string | null = null
  const owned: OwnedOutput[] = []
  let libraryCommitAttempted = false
  let pendingBeatId: string | null = null
  try {
  // Exclusive reservation closes the check/create overwrite race. A concurrent
  // winner keeps its name; this export takes the next free one.
  let output: Awaited<ReturnType<typeof open>>
  for (let attempt = 1; ; attempt++) {
    try { output = await createOwned(filePath, owned); break } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST' || attempt >= 50) throw error
      claimed.add(fileName.toLowerCase())
      fileName = nextName()
      filePath = path.join(directory, fileName)
    }
  }
  try { await pipeline(createReadStream(input.stagedPath), output.createWriteStream(), { signal: input.signal }) }
  finally { await output.close() }
  input.signal?.throwIfAborted()
  const sidecarPayload = settings.writeSidecar ? buildSidecar({ ...input, fileName, filePath, extension }) : null
  sidecarId = sidecarPayload?.id ?? null
  sidecarPath = sidecarPayload
    ? await writeSidecar({
        directory,
        fileName,
        inSubfolder: settings.sidecarInSubfolder,
        payload: sidecarPayload, owned
      })
    : null

  const beat: LibraryBeat = {
    id: createId('beat'),
    title: input.metadata.title || path.parse(fileName).name,
    producer: input.metadata.producer,
    bpm: input.metadata.bpm,
    altBpm: input.metadata.altBpm,
    key: input.metadata.key,
    camelot: input.metadata.camelot,
    detune: input.metadata.detune,
    presetId: input.presetId,
    format: extension,
    filePath,
    fileName,
    fileOwnership: 'sonic-export',
    ownershipEvidence: { audio: await capturePhysicalIdentity(filePath),
      ...(sidecarPath && sidecarId ? { sidecar: { id: sidecarId, file: await capturePhysicalIdentity(sidecarPath) } } : {}) },
    sidecarPath,
    publishedTags: input.tagReadback ?? null,
    sizeBytes: input.output.sizeBytes,
    durationSec: input.durationSec || 0,
    bitrateKbps: input.output.bitrateKbps,
    sampleRate: input.output.sampleRate,
    channels: input.output.channels,
    sourceUrl: input.sourceUrl,
    sourceChannel: input.uploader,
    thumbnail: input.thumbnail ?? null,
    namingTemplate: settings.namingTemplate,
    namingIndex: input.index,
    sourceKind: input.sourceKind,
    addedAt: Date.now(),
    fingerprint: input.fingerprint,
    missing: false,
    analysisStatus: input.analysis
      ? deriveAnalysisStatus(input.analysis.tempo, input.analysis.key)
      : 'not-analyzed',
    analysis: input.analysis,
    overrides: input.overrides,
    sources: input.sources,
    embedded: input.embedded,
    verification: input.verification
  }

  input.signal?.throwIfAborted()
  // Checked in the same turn as the commit: only a failed write leaves this record pending.
  libraryService.assertWritable()
  libraryCommitAttempted = true
  pendingBeatId = beat.id
  libraryService.add(beat)

  try { await unlink(input.stagedPath) } catch (error) {
    storageDiagnostic(libraryFile(), { operation: 'published-staging-cleanup', filePath: input.stagedPath, error: String(error) })
  }

  return { filePath, fileName, sidecarPath, beat }
  } catch (error) {
    // Files are preserved whenever the record is pending or already committed.
    if (libraryCommitAttempted && (libraryService.pendingRevision() !== null || libraryService.get(pendingBeatId!))) {
      storageDiagnostic(libraryFile(), { operation: 'export-library-pending', filePath, sidecarPath, error: String(error) })
      throw new PendingPublicationError(filePath, pendingBeatId!, error)
    }
    const cleanupErrors: string[] = []
    for (const file of owned.reverse()) {
      try {
        const current = await lstat(file.path)
        if (current.isSymbolicLink() || current.ino !== file.ino || current.birthtimeMs !== file.birthtimeMs) throw new Error('Output ownership changed; file preserved.')
        await unlink(file.path)
      } catch (cleanupError) {
        if ((cleanupError as NodeJS.ErrnoException).code !== 'ENOENT') cleanupErrors.push(`${file.path}: ${String(cleanupError)}`)
      }
    }
    if (cleanupErrors.length) {
      storageDiagnostic(libraryFile(), { operation: 'export-rollback-incomplete', cleanupErrors, error: String(error) })
      throw new Error(`${String(error)}; cleanup incomplete: ${cleanupErrors.join('; ')}`)
    }
    throw error
  }
}

function buildSidecar(
  input: PublishInput & { fileName: string; filePath: string; extension: string }
): BeatSidecar {
  const settings = settingsService.get()

  return {
    schema: 'sonic-v2/beat',
    schemaVersion: 2,
    id: createId('sc'),
    app: { name: 'Sonic', version: app.getVersion() },
    exportedAt: new Date().toISOString(),
    source: {
      kind: input.sourceKind,
      url: input.sourceUrl,
      videoId: input.videoId,
      uploader: input.uploader,
      channel: input.uploader,
      thumbnail: input.thumbnail ?? null,
      title: input.sourceTitle
    },
    metadata: input.metadata,
    evidence: input.evidence,
    conflicts: input.conflicts,
    analysis: input.analysis,
    audioEvidence: input.audioEvidence,
    verification: input.verification,
    overrides: input.overrides,
    naming: { template: settings.namingTemplate, fileName: input.fileName },
    recipe: {
      presetId: input.presetId,
      channels: input.channels,
      lufs: input.lufs,
      embedTags: input.embedTags
    },
    output: {
      // File name only — a sidecar is shareable and must not leak local paths.
      filePath: input.fileName,
      sizeBytes: input.output.sizeBytes,
      durationSec: input.durationSec,
      format: input.output.format || input.extension,
      bitrateKbps: input.output.bitrateKbps,
      sampleRate: input.output.sampleRate,
      channels: input.output.channels,
      fingerprint: input.fingerprint
    },
    engine: input.engine
  }
}

async function writeSidecar(options: {
  directory: string
  fileName: string
  inSubfolder: boolean
  payload: BeatSidecar
  owned: OwnedOutput[]
}): Promise<string> {
  const targetDirectory = options.inSubfolder
    ? path.join(options.directory, SIDECAR_FOLDER)
    : options.directory
  await ensureDir(targetDirectory)

  // Kept beside the audio so the pairing survives a move of the whole folder.
  const sidecarPath = path.join(targetDirectory, `${options.fileName}.sonic.json`)
  const output = await createOwned(sidecarPath, options.owned)
  try { await output.writeFile(JSON.stringify(options.payload, null, 2), 'utf8'); await output.sync() }
  finally { await output.close() }
  return sidecarPath
}

/** Builds the tag payload handed to ffmpeg for the reviewed metadata. */
export function buildTagContext(
  metadata: BeatMetadata,
  sourceUrl: string | null
): {
  title: string | null
  producer: string | null
  album: string | null
  comment: string | null
  date: string
  genre: string | null
  bpm: number | null
  key: string | null
} {
  const parts: string[] = []
  if (metadata.bpm != null) parts.push(`${metadata.bpm} BPM`)
  if (metadata.key) parts.push(metadata.key)
  if (metadata.camelot) parts.push(metadata.camelot)
  if (metadata.detune != null && metadata.detune !== 0) parts.push(`${metadata.detune} cents`)
  if (sourceUrl) parts.push(sourceUrl)

  return {
    title: metadata.title || null,
    producer: metadata.producer,
    album: metadata.producer ? `${metadata.title} — ${metadata.producer}` : metadata.title || null,
    comment: parts.length > 0 ? parts.join(' · ') : null,
    date: formatDateStamp(),
    genre: metadata.genre,
    bpm: metadata.bpm,
    key: metadata.key
  }
}
