import { readFile, stat } from 'node:fs/promises'
import { run } from '../lib/child'
import { ensureDir, removeFile } from '../lib/fsx'
import path from 'node:path'

/**
 * Decoding for analysis.
 *
 * Audio is decoded once, to a single canonical representation, so the DSP layer
 * never has to care about containers: 32-bit float, **mono**, at a fixed
 * analysis sample rate. Mono halves every downstream cost and 22050 Hz is ample
 * for both tempo (transient band) and chroma (energy below ~3.5 kHz), while
 * cutting STFT work roughly four-fold versus 44.1 kHz.
 */
export const ANALYSIS_SAMPLE_RATE = 22050

export interface DecodeWindow {
  /** Absolute path of the source media. */
  inputPath: string
  ffmpegPath: string
  /** Where the raw PCM lands. Caller owns cleanup. */
  outputPath: string
  signal: AbortSignal
  /** Start offset in seconds. */
  offsetSec: number
  /** Length in seconds. */
  durationSec: number
  sampleRate?: number
  timeoutMs?: number
}

export interface DecodedWindow {
  /** Raw f32le mono PCM on disk. The caller owns cleanup. */
  path: string
  sampleRate: number
  durationSec: number
  sampleCount: number
}

/** Reads a raw f32le PCM file into a Float32Array. Used by the analysis worker. */
export async function readPcmFile(filePath: string): Promise<Float32Array> {
  const buffer = await readFile(filePath)
  // A Float32Array view needs a byte length that is a multiple of 4. ffmpeg
  // always emits whole samples, so a remainder means a truncated write.
  if (buffer.byteLength % 4 !== 0) throw new Error('Decoded audio contains a truncated sample.')
  // On little-endian hosts the Buffer is already the canonical float storage.
  // Retaining a view avoids millions of scalar reads and a second PCM allocation.
  if (new Uint8Array(new Uint16Array([1]).buffer)[0] === 1) {
    return buffer.byteOffset % 4 === 0
      ? new Float32Array(buffer.buffer, buffer.byteOffset, buffer.byteLength / 4)
      : new Float32Array(buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength))
  }
  const pcm = new Float32Array(buffer.byteLength / 4)
  for (let index = 0; index < pcm.length; index += 1) {
    pcm[index] = buffer.readFloatLE(index * 4)
  }
  return pcm
}

/**
 * Decodes one window to a raw PCM file.
 *
 * A file is used rather than a pipe so the work is trivially cancellable, and so
 * the buffer is read by the analysis worker rather than transiting the main
 * process heap.
 */
export async function decodeWindow(window: DecodeWindow): Promise<DecodedWindow> {
  const sampleRate = window.sampleRate ?? ANALYSIS_SAMPLE_RATE
  await ensureDir(path.dirname(window.outputPath))

  const args = buildDecodeArgs(window, sampleRate)
  const result = await run(window.ffmpegPath, args, {
    signal: window.signal,
    timeoutMs: window.timeoutMs ?? 120_000
  })

  if (result.aborted) {
    await removeFile(window.outputPath)
    throw new Error('Cancelled')
  }

  if (result.code !== 0) {
    await removeFile(window.outputPath)
    const detail = result.stderr.trim().split(/\r?\n/).slice(-2).join(' ')
    throw new Error(`Could not decode audio for analysis: ${detail.slice(0, 200) || 'ffmpeg failed'}`)
  }

  const info = await stat(window.outputPath)
  if (info.size % 4 !== 0) throw new Error('Decoded audio contains a truncated sample.')
  const sampleCount = info.size / 4

  return {
    path: window.outputPath,
    sampleRate,
    sampleCount,
    durationSec: sampleCount / sampleRate
  }
}

/** Builds the ffmpeg argv for a raw mono float PCM window. */
export function buildDecodeArgs(window: DecodeWindow, sampleRate: number): string[] {
  const args = ['-hide_banner', '-nostdin', '-loglevel', 'error', '-nostats']

  // `-ss` before `-i` seeks by index rather than decoding and discarding, which
  // is dramatically faster on a long file.
  if (window.offsetSec > 0) args.push('-ss', window.offsetSec.toFixed(3))

  args.push('-i', window.inputPath)

  if (window.durationSec > 0) args.push('-t', window.durationSec.toFixed(3))

  args.push(
    '-vn',
    '-map',
    '0:a:0',
    '-ac',
    '1',
    // Resampling is explicit and declared, never assumed.
    '-ar',
    String(sampleRate),
    '-c:a',
    'pcm_f32le',
    '-f',
    'f32le',
    window.outputPath
  )

  return args
}

/**
 * Decodes one window to a raw PCM file and reads it back as Float32Array.
 *
 * The opening seconds of a beat are frequently a producer tag, a count-in, or
 * outright silence, so tempo is measured from a window that starts after a short
 * intro skip. Key is measured from two separated windows so a modulation, a
 * breakdown, or a drum-only section cannot decide the whole result on its own.
 */
export interface WindowPlan {
  tempo: { offsetSec: number; durationSec: number }
  key: { offsetSec: number; durationSec: number }[]
  /** Human-readable description of the sampling strategy, for the analysis record. */
  description: string
}

/**
 * Changing which windows are planned changes stored results without any DSP
 * change: bump `ANALYSIS_PIPELINE` (shared/analysis) with it, so cached and
 * library analyses from the old plan are not served as current.
 */
export function planWindows(durationSec: number): WindowPlan {
  // An unknown duration is planned *generously* rather than minimally. Decoding
  // past the end of a file simply yields less audio, whereas planning for a
  // short track silently starves the analyser: a 133 s beat was previously judged
  // on the 6 s minimum because its duration was not known.
  const known = durationSec > 0
  const total = known ? durationSec : 300

  // Skip a short intro, but never more than a fifth of a very short track.
  const introSkip = Math.min(8, total * 0.2)
  const tempoLength = Math.max(6, Math.min(150, total - introSkip))

  const keyWindows: { offsetSec: number; durationSec: number }[] = [
    { offsetSec: introSkip, durationSec: Math.max(6, Math.min(90, total - introSkip)) }
  ]

  // A second, later window only when there is enough material for it to be
  // genuinely independent of the first.
  if (total > 160) {
    const lateOffset = Math.min(total - 90, total * 0.55)
    if (lateOffset > introSkip + 60) {
      keyWindows.push({ offsetSec: lateOffset, durationSec: Math.min(90, total - lateOffset) })
    }
  }

  return {
    tempo: { offsetSec: introSkip, durationSec: tempoLength },
    key: keyWindows,
    description:
      `${known ? '' : 'duration unknown, planned for a full track; '}` +
      `tempo: ${tempoLength.toFixed(0)}s from ${introSkip.toFixed(1)}s; ` +
      `key: ${keyWindows.length} window${keyWindows.length === 1 ? '' : 's'}`
  }
}
