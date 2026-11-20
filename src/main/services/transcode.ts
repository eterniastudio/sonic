import path from 'node:path'
import type { ChannelMode, PresetId } from '@shared/domain'
import { buildFfmpegArgs, getPreset, tagDialectFor, wavId3Frames, type FfmpegTagContext } from '@shared/presets'
import { run } from '../lib/child'
import { removeFile } from '../lib/fsx'
import { engineService } from './engine'

export interface TranscodeOptions {
  inputPath: string
  outputPath: string
  presetId: PresetId
  channels: ChannelMode
  lufs: number | null
  coverPath: string | null
  tags: FfmpegTagContext
  durationSec: number | null
  signal: AbortSignal
  onProgress: (percent: number | null) => void
  onLog?: (line: string) => void
}

/** Parses ffmpeg's `-progress` stream, which reports `out_time=HH:MM:SS.ffffff`. */
function parseOutTime(line: string): number | null {
  const match = /^out_time=(\d+):(\d{2}):(\d{2}(?:\.\d+)?)/.exec(line.trim())
  if (!match) return null
  return Number(match[1]) * 3600 + Number(match[2]) * 60 + Number(match[3])
}

/**
 * Converts one staged audio file into the chosen export recipe and writes the
 * reviewed metadata as container tags.
 */
export async function transcode(options: TranscodeOptions): Promise<void> {
  options.signal.throwIfAborted()
  const ffmpeg = await engineService.resolve('ffmpeg', false, options.signal)
  options.signal.throwIfAborted()
  if (!ffmpeg.path) {
    throw new Error('ffmpeg is not installed. Run media engine setup from Settings.')
  }

  const preset = getPreset(options.presetId)
  const coverPath = preset.supportsCoverArt ? options.coverPath : null

  const args = buildFfmpegArgs(options.presetId, {
    inputPath: options.inputPath,
    outputPath: options.outputPath,
    channels: options.channels,
    lufs: options.lufs,
    coverPath,
    tags: options.tags
  })

  // Machine-readable progress goes to stdout; the human log stays on stderr.
  const bannerIndex = args.indexOf('-hide_banner')
  args.splice(bannerIndex + 1, 0, '-progress', 'pipe:1', '-nostats', '-loglevel', 'error')

  const result = await run(ffmpeg.path, args, {
    signal: options.signal,
    onStdoutLine: (line) => {
      if (line.startsWith('progress=end')) {
        options.onProgress(1)
        return
      }
      const seconds = parseOutTime(line)
      if (seconds == null || !options.durationSec || options.durationSec <= 0) return
      options.onProgress(Math.max(0, Math.min(0.999, seconds / options.durationSec)))
    },
    onStderrLine: (line) => options.onLog?.(line)
  })

  if (result.aborted) {
    await removeFile(options.outputPath)
    throw new Error('Cancelled')
  }

  if (result.code !== 0) {
    await removeFile(options.outputPath)
    const detail = result.stderr
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line.length > 0)
      .slice(-3)
      .join(' ')
    throw new Error(`Conversion failed: ${detail.slice(0, 300) || 'ffmpeg reported an error.'}`)
  }

  // ffmpeg's WAV muxer has no BPM/key field; append a standard ID3 chunk.
  const frames = tagDialectFor(options.outputPath) === 'riff' ? wavId3Frames(options.tags) : []
  if (frames.length > 0) {
    options.signal.throwIfAborted()
    try {
      await appendWavId3Chunk(options.outputPath, frames)
    } catch (error) {
      await removeFile(options.outputPath)
      throw new Error(`Conversion failed: the WAV BPM/key tags could not be written (${error instanceof Error ? error.message : String(error)}).`)
    }
  }

  options.onProgress(1)
}

/**
 * ffmpeg 6's WAV muxer writes only a LIST/INFO chunk, which has no BPM or key
 * field, and has no ID3 option. A standard `id3 ` chunk holding an ID3v2.3 tag
 * (TBPM/TKEY) is the form read by ffmpeg/ffprobe, TagLib and the common DJ
 * applications, so it is appended after encoding.
 */
const MAX_RIFF_BYTES = 0xffffffff

/** One ID3v2.3 text frame; ISO-8859-1 when possible, UTF-16 with BOM otherwise. */
function id3TextFrame(id: string, text: string): Buffer {
  const latin1 = [...text].every((character) => character.charCodeAt(0) <= 0xff && character.length === 1)
  const body = latin1
    ? Buffer.concat([Buffer.from([0]), Buffer.from(text, 'latin1')])
    : Buffer.concat([Buffer.from([1, 0xff, 0xfe]), Buffer.from(text, 'utf16le')])
  const header = Buffer.alloc(10)
  header.write(id, 0, 'latin1')
  header.writeUInt32BE(body.length, 4)
  return Buffer.concat([header, body])
}

function syncsafe(value: number): Buffer {
  return Buffer.from([(value >> 21) & 0x7f, (value >> 14) & 0x7f, (value >> 7) & 0x7f, value & 0x7f])
}

/**
 * Appends an `id3 ` chunk with the given ID3v2.3 text frames to a RIFF/WAVE
 * file and updates the RIFF size. Leaves the file untouched when it already
 * has an ID3 chunk, is not a plain RIFF/WAVE file (RF64 cannot be extended
 * this way), or when there is nothing to write. Returns whether it wrote.
 */
async function appendWavId3Chunk(
  filePath: string,
  frames: { id: string; text: string }[]
): Promise<boolean> {
  const usable = frames.filter((frame) => /^[A-Z0-9]{4}$/.test(frame.id) && frame.text.length > 0)
  if (usable.length === 0) return false
  // Loaded on demand: only WAV exports need byte-level tag writing.
  const { open } = await import('node:fs/promises')
  const handle = await open(filePath, 'r+')
  try {
    const { size } = await handle.stat()
    const head = Buffer.alloc(12)
    await handle.read(head, 0, 12, 0)
    if (head.toString('latin1', 0, 4) !== 'RIFF' || head.toString('latin1', 8, 12) !== 'WAVE') return false

    // Refuse to add a second ID3 chunk.
    const chunk = Buffer.alloc(8)
    let offset = 12
    while (offset + 8 <= size) {
      await handle.read(chunk, 0, 8, offset)
      const id = chunk.toString('latin1', 0, 4)
      if (id === 'id3 ' || id === 'ID3 ') return false
      offset += 8 + chunk.readUInt32LE(4) + (chunk.readUInt32LE(4) % 2)
    }

    const body = Buffer.concat(usable.map((frame) => id3TextFrame(frame.id, frame.text)))
    const tag = Buffer.concat([Buffer.from('ID3', 'latin1'), Buffer.from([3, 0, 0]), syncsafe(body.length), body])
    const chunkHeader = Buffer.alloc(8)
    chunkHeader.write('id3 ', 0, 'latin1')
    chunkHeader.writeUInt32LE(tag.length, 4)
    // RIFF chunks are word aligned: pad the file before the chunk if needed,
    // and the chunk itself after its payload.
    const lead = size % 2 === 1 ? Buffer.from([0]) : Buffer.alloc(0)
    const trail = tag.length % 2 === 1 ? Buffer.from([0]) : Buffer.alloc(0)
    const appended = Buffer.concat([lead, chunkHeader, tag, trail])
    if (size + appended.length - 8 > MAX_RIFF_BYTES) return false

    await handle.write(appended, 0, appended.length, size)
    const riffSize = Buffer.alloc(4)
    riffSize.writeUInt32LE(size + appended.length - 8, 0)
    await handle.write(riffSize, 0, 4, 4)
    return true
  } finally {
    await handle.close()
  }
}

/** Remuxes into the final container without re-encoding, for the `original` preset. */
export function sourceExtensionFor(presetId: PresetId, stagedExtension: string): string {
  if (presetId !== 'original') return getPreset(presetId).extension
  // The `original` recipe keeps whatever container the provider handed us.
  const normalised = stagedExtension.toLowerCase()
  if (normalised === 'webm') return 'webm'
  if (normalised === 'm4a' || normalised === 'mp4') return 'm4a'
  if (normalised === 'opus' || normalised === 'ogg' || normalised === 'oga') return 'opus'
  if (normalised === 'mp3') return 'mp3'
  if (normalised === 'flac') return 'flac'
  if (normalised === 'wav') return 'wav'
  return normalised || 'm4a'
}

export function tempOutputFor(jobId: string, stagingDirPath: string, extension: string): string {
  return path.join(stagingDirPath, `${jobId}.out.${extension}`)
}
