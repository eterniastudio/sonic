import path from 'node:path'
import { mkdtemp, rmdir } from 'node:fs/promises'
import type { PresetId } from '@shared/domain'
import { getPreset } from '@shared/presets'
import { ensureDir, fileExists, removeFile } from '../lib/fsx'
import { probeMediaFile, tagsToMetadata } from './ffprobe'
import { libraryService } from './library'
import { stagingDir } from './paths'
import { buildTagContext, PendingPublicationError, publishExport } from './publish'
import { buildAudioEvidence } from '@shared/metadata'
import { settingsService } from './settings'
import { transcode } from './transcode'
import { engineService } from './engine'
import { sha256File } from '../lib/fsx'
import { isStopping } from '../lifecycle'
import { storageDiagnostic } from '../lib/jsonStore'
import { libraryFile } from './paths'

export interface ReexportResult {
  ok: boolean
  outputPath: string | null
  error: string | null
  /** Files were published but their library revision is still pending. */
  pendingSave?: boolean
  publishedBeatId?: string
}

const active = new Map<string, Promise<ReexportResult>>()
const controllers = new Set<AbortController>()
let stopped = false

/** One re-export per source beat; a queued request sees fresh state when it starts. */
export function reexportBeat(beatId: string, presetId: PresetId): Promise<ReexportResult> {
  const previous = active.get(beatId) ?? Promise.resolve({ ok: false, outputPath: null, error: null })
  const task = previous.then(() => reexportLocked(beatId, presetId))
  active.set(beatId, task)
  void task.finally(() => { if (active.get(beatId) === task) active.delete(beatId) }).catch(() => undefined)
  return task
}

export async function stopReexports(): Promise<void> {
  stopped = true
  for (const controller of controllers) controller.abort()
  await Promise.allSettled([...active.values()])
}

/**
 * Creates a new export of an existing library beat at a different recipe.
 *
 * This always works from the file already on disk, so exporting a lossy MP3 to
 * a lossless preset cannot restore detail that was never there — the UI says so
 * rather than implying an upgrade.
 */
async function reexportLocked(beatId: string, presetId: PresetId): Promise<ReexportResult> {
  if (stopped || isStopping()) return { ok: false, outputPath: null, error: 'Sonic is closing.' }
  const beat = libraryService.get(beatId)
  if (!beat) {
    return { ok: false, outputPath: null, error: 'That beat is no longer in your library.' }
  }

  if (!(await fileExists(beat.filePath))) {
    return { ok: false, outputPath: null, error: 'The source file for this beat is missing.' }
  }
  if (libraryService.pendingRevision() !== null) {
    return { ok: false, outputPath: null, error: 'A library save is pending. Retry saving before exporting; no files were written.' }
  }

  const settings = settingsService.get()
  const preset = getPreset(presetId)
  let operationDir: string | null = null
  const controller = new AbortController()
  controllers.add(controller)

  try {
    await ensureDir(stagingDir())
    operationDir = await mkdtemp(path.join(stagingDir(), 'reexport-'))
    const tempOutput = path.join(operationDir, `output.${preset.extension}`)
    if (await sha256File(beat.filePath) !== beat.fingerprint) throw new Error('The source audio changed since Sonic recorded it.')
    controller.signal.throwIfAborted()
    const source = await probeMediaFile(beat.filePath, controller.signal)

    await transcode({
      inputPath: beat.filePath,
      outputPath: tempOutput,
      presetId,
      channels: settings.channelMode,
      lufs: settings.normalizeLufs,
      coverPath: null,
      tags: buildTagContext(
        {
          title: beat.title,
          producer: beat.producer,
          bpm: beat.bpm,
          altBpm: beat.altBpm,
          key: beat.key,
          camelot: beat.camelot,
          detune: beat.detune,
          tuning: null,
          genre: null
        },
        beat.sourceUrl
      ),
      durationSec: source.durationSec,
      signal: controller.signal,
      onProgress: () => undefined
    })

    const output = await probeMediaFile(tempOutput, controller.signal)
    const fingerprint = await sha256File(tempOutput)
    controller.signal.throwIfAborted()
    const current = libraryService.get(beatId)
    if (!current || current.filePath !== beat.filePath || current.fingerprint !== beat.fingerprint ||
      current.title !== beat.title || current.producer !== beat.producer || current.bpm !== beat.bpm ||
      current.key !== beat.key || current.camelot !== beat.camelot || current.detune !== beat.detune ||
      await sha256File(beat.filePath) !== beat.fingerprint) {
      throw new Error('This beat changed during re-export. Review it and retry from the latest version.')
    }

    const [ytdlp, ffmpeg] = await Promise.all([
      engineService.resolve('yt-dlp', false, controller.signal),
      engineService.resolve('ffmpeg', false, controller.signal)
    ])
    controller.signal.throwIfAborted()

    const result = await publishExport({
      signal: controller.signal,
      jobId: `reexport_${beat.id}`,
      stagedPath: tempOutput,
      extension: preset.extension,
      metadata: {
        title: beat.title,
        producer: beat.producer,
        bpm: beat.bpm,
        altBpm: beat.altBpm,
        key: beat.key,
        camelot: beat.camelot,
        detune: beat.detune,
        tuning: null,
        genre: null
      },
      presetId,
      sourceKind: beat.sourceKind,
      sourceUrl: beat.sourceUrl,
      videoId: null,
      uploader: beat.sourceChannel ?? null,
      thumbnail: beat.thumbnail ?? null,
      sourceTitle: beat.title,
      evidence: [],
      conflicts: [],
      // Provenance carries over: re-exporting must not throw away the analysis
      // history or the producer's overrides.
      analysis: beat.analysis,
      audioEvidence: beat.analysis ? buildAudioEvidence(beat.analysis) : [],
      verification: beat.verification,
      overrides: beat.overrides,
      sources: beat.sources,
      embedded: beat.embedded,
      tagReadback: tagsToMetadata(output.tags),
      channels: settings.channelMode,
      lufs: settings.normalizeLufs,
      embedTags: settings.embedTags,
      fingerprint,
      index: 1,
      durationSec: output.durationSec,
      engine: { ytdlp: ytdlp.version, ffmpeg: ffmpeg.version },
      output: {
        sizeBytes: output.sizeBytes,
        format: output.container,
        bitrateKbps: output.audio?.bitrateKbps ?? output.bitrateKbps,
        sampleRate: output.audio?.sampleRate ?? null,
        channels: output.audio?.channels ?? null
      }
    })

    return { ok: true, outputPath: result.filePath, error: null }
  } catch (error) {
    if (error instanceof PendingPublicationError) {
      return {
        ok: false,
        outputPath: error.outputPath,
        error: error.message,
        pendingSave: true,
        publishedBeatId: error.beatId
      }
    }
    return {
      ok: false,
      outputPath: null,
      error: error instanceof Error ? error.message : String(error)
    }
  } finally {
    controllers.delete(controller)
    if (operationDir) {
      try {
        await removeFile(path.join(operationDir, `output.${preset.extension}`))
        await rmdir(operationDir)
      } catch (error) {
        storageDiagnostic(libraryFile(), { operation: 'reexport-staging-cleanup', operationDir, error: String(error) })
      }
    }
  }
}
