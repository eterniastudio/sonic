import type { MetadataValues } from '@shared/domain'
import { parseText } from '@shared/metadata'
import { run } from '../lib/child'
import { engineService } from './engine'

export interface MediaStreamInfo {
  codec: string | null
  sampleRate: number | null
  channels: number | null
  bitrateKbps: number | null
  bitsPerSample: number | null
}

export interface MediaInfo {
  durationSec: number
  sizeBytes: number
  container: string
  formatName: string
  bitrateKbps: number | null
  audio: MediaStreamInfo | null
  tags: Record<string, string>
}

interface RawFfprobeOutput {
  format?: {
    duration?: string
    size?: string
    bit_rate?: string
    format_name?: string
    format_long_name?: string
    tags?: Record<string, unknown>
  }
  streams?: {
    tags?: Record<string, unknown>
    codec_type?: string
    codec_name?: string
    sample_rate?: string
    channels?: number
    bit_rate?: string
    bits_per_raw_sample?: string
    bits_per_sample?: string
  }[]
}

function toNumber(value: string | number | undefined): number | null {
  if (value == null) return null
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : null
}

/** Reads container and stream facts for a local file. */
export async function probeMediaFile(filePath: string, signal?: AbortSignal): Promise<MediaInfo> {
  const ffprobe = await engineService.resolve('ffprobe', false, signal)
  if (signal?.aborted) throw new Error('Reading audio metadata was cancelled.')
  if (!ffprobe.path) {
    throw new Error('ffprobe is not installed. Run media engine setup from Settings.')
  }

  const result = await run(
    ffprobe.path,
    ['-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', filePath],
    { timeoutMs: 60_000, signal }
  )

  if (result.aborted || signal?.aborted) throw new Error('Reading audio metadata was cancelled.')
  if (result.timedOut) throw new Error('Reading audio metadata timed out.')
  if (result.code !== 0) {
    throw new Error(`ffprobe could not read ${filePath}: ${result.stderr.trim().slice(0, 200)}`)
  }

  if (result.stdoutTruncated) throw new Error('Audio metadata exceeded the capture limit.')

  let raw: RawFfprobeOutput
  try {
    raw = JSON.parse(result.stdout) as RawFfprobeOutput
  } catch {
    throw new Error('ffprobe returned output that could not be parsed.')
  }

  const audioStream = raw.streams?.find((stream) => stream.codec_type === 'audio') ?? null
  const tags: Record<string, string> = {}
  // Ogg/Opus keep Vorbis comments on the audio stream, not the container, so
  // stream tags are folded in underneath any container tag of the same name.
  for (const [key, value] of [...Object.entries(audioStream?.tags ?? {}), ...Object.entries(raw.format?.tags ?? {})]) {
    if (value == null) continue
    tags[key] = String(value)
  }
  // ffprobe does not report the iTunes `tmpo` atom that MP4 exports carry.
  const formatName = raw.format?.format_name ?? ''
  if (/(^|,)(mov|mp4|m4a|ipod)(,|$)/.test(formatName) && !Object.keys(tags).some((key) => key.toLowerCase() === 'tmpo')) {
    try {
      const tempo = await readMp4Tempo(filePath)
      if (tempo != null) tags.tmpo = String(tempo)
    } catch {
      // Unreadable atoms leave readback to the tags ffprobe did report.
    }
  }

  const formatBitrate = toNumber(raw.format?.bit_rate)
  const streamBitrate = toNumber(audioStream?.bit_rate)

  return {
    durationSec: toNumber(raw.format?.duration) ?? 0,
    sizeBytes: toNumber(raw.format?.size) ?? 0,
    container: raw.format?.format_name ?? '',
    formatName: raw.format?.format_long_name ?? raw.format?.format_name ?? '',
    bitrateKbps: (formatBitrate ?? streamBitrate ?? 0) / 1000 || null,
    audio: audioStream
      ? {
          codec: audioStream.codec_name ?? null,
          sampleRate: toNumber(audioStream.sample_rate),
          channels: audioStream.channels ?? null,
          bitrateKbps: streamBitrate != null ? streamBitrate / 1000 : null,
          bitsPerSample:
            toNumber(audioStream.bits_per_raw_sample) ?? toNumber(audioStream.bits_per_sample)
        }
      : null,
    tags
  }
}

/**
 * ffmpeg writes the iTunes `tmpo` atom for MP4 exports, but its demuxer does
 * not report it, so ffprobe readback alone cannot verify an MP4 BPM tag. The
 * atom is read directly from moov/udta/meta/ilst with bounded reads.
 */
/** Larger `moov` boxes are not parsed (they would be unusual for audio). */
const MAX_MOOV_BYTES = 64 * 1024 * 1024

interface Box {
  type: string
  /** Offset of the box payload within the buffer. */
  start: number
  /** End of the box within the buffer. */
  end: number
}

function boxesIn(buffer: Buffer, from: number, to: number): Box[] {
  const boxes: Box[] = []
  let offset = from
  while (offset + 8 <= to) {
    let size = buffer.readUInt32BE(offset)
    const type = buffer.toString('latin1', offset + 4, offset + 8)
    let header = 8
    if (size === 1) {
      if (offset + 16 > to) break
      size = Number(buffer.readBigUInt64BE(offset + 8))
      header = 16
    } else if (size === 0) {
      size = to - offset
    }
    if (size < header || offset + size > to) break
    boxes.push({ type, start: offset + header, end: offset + size })
    offset += size
  }
  return boxes
}

function child(buffer: Buffer, parent: Box, type: string): Box | null {
  return boxesIn(buffer, parent.start, parent.end).find((box) => box.type === type) ?? null
}

/**
 * Reads the iTunes `tmpo` (BPM) atom from moov/udta/meta/ilst, or null when the
 * file is not an MP4 or carries no tempo atom.
 */
async function readMp4Tempo(filePath: string): Promise<number | null> {
  // Loaded on demand: only MP4-family files need byte-level reading.
  const { open } = await import('node:fs/promises')
  const handle = await open(filePath, 'r')
  try {
    const { size } = await handle.stat()
    const header = Buffer.alloc(16)
    let offset = 0
    while (offset + 8 <= size) {
      const { bytesRead } = await handle.read(header, 0, 16, offset)
      if (bytesRead < 8) return null
      let boxSize = header.readUInt32BE(0)
      const type = header.toString('latin1', 4, 8)
      if (boxSize === 1) {
        if (bytesRead < 16) return null
        boxSize = Number(header.readBigUInt64BE(8))
      } else if (boxSize === 0) {
        boxSize = size - offset
      }
      if (boxSize < 8 || offset + boxSize > size) return null
      if (type === 'moov') {
        if (boxSize > MAX_MOOV_BYTES) return null
        const moov = Buffer.alloc(boxSize)
        await handle.read(moov, 0, boxSize, offset)
        return tempoFromMoov(moov)
      }
      offset += boxSize
    }
    return null
  } finally {
    await handle.close()
  }
}

function tempoFromMoov(moov: Buffer): number | null {
  const [root] = boxesIn(moov, 0, moov.length)
  if (!root || root.type !== 'moov') return null
  const udta = child(moov, root, 'udta')
  const meta = udta ? child(moov, udta, 'meta') : null
  if (!meta) return null
  // ISO `meta` is a full box (4 bytes of version/flags before its children);
  // the QuickTime form is not. Its first child is always `hdlr`.
  const fullBox = moov.toString('latin1', meta.start + 4, meta.start + 8) !== 'hdlr'
  const ilst = child(moov, { ...meta, start: meta.start + (fullBox ? 4 : 0) }, 'ilst')
  const tmpo = ilst ? child(moov, ilst, 'tmpo') : null
  const data = tmpo ? child(moov, tmpo, 'data') : null
  if (!data || data.end - data.start < 9) return null
  // data payload: 4 bytes type indicator, 4 bytes locale, then the value.
  const value = moov.subarray(data.start + 8, data.end)
  let tempo = 0
  for (const byte of value) tempo = tempo * 256 + byte
  return value.length <= 4 && tempo > 0 ? tempo : null
}

/**
 * Maps container tags onto Sonic's metadata fields.
 *
 * Standard ID3 frames (TIT2/TPE1/TBPM/TKEY) and their Vorbis, Matroska and MP4
 * equivalents are folded into one shape, and free-text comments are run through the same
 * parser used for titles so detune and tuning survive a round trip.
 */
export function tagsToMetadata(tags: Record<string, string>): MetadataValues {
  const lower: Record<string, string> = {}
  for (const [key, value] of Object.entries(tags)) {
    lower[key.toLowerCase()] = value
  }

  const out: MetadataValues = {}

  const title = lower['title'] ?? lower['tit2']
  if (title && title.trim().length > 0) out.title = title.trim()

  const artist = lower['artist'] ?? lower['tpe1'] ?? lower['album_artist'] ?? lower['albumartist']
  if (artist && artist.trim().length > 0) out.producer = artist.trim()

  const genre = lower['genre'] ?? lower['tcon']
  if (genre && genre.trim().length > 0) out.genre = genre.trim()

  // ID3 TBPM, Vorbis/Matroska BPM, and the MP4 `tmpo` atom.
  const bpmRaw = lower['tbpm'] ?? lower['bpm'] ?? lower['tmpo']
  if (bpmRaw) {
    const bpm = Number(bpmRaw)
    if (Number.isFinite(bpm) && bpm >= 40 && bpm <= 300) out.bpm = bpm
  }

  // ID3 TKEY, Vorbis INITIALKEY (or KEY), Matroska INITIAL_KEY.
  const keyRaw = lower['tkey'] ?? lower['initialkey'] ?? lower['initial_key'] ?? lower['key']
  if (keyRaw && keyRaw.trim().length > 0) {
    const parsed = parseText(keyRaw.trim(), 'tags')
    if (parsed.values.key) out.key = parsed.values.key
    if (parsed.values.camelot) out.camelot = parsed.values.camelot
  }

  const comment = lower['comment'] ?? lower['comm'] ?? lower['description']
  if (comment && comment.trim().length > 0) {
    const parsed = parseText(comment, 'tags')
    for (const [field, value] of Object.entries(parsed.values)) {
      if (out[field as keyof MetadataValues] == null) {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        ;(out as any)[field] = value
      }
    }
  }

  return out
}

/** Convenience: probe a file and return only its interpreted metadata. */
export async function readEmbeddedMetadata(filePath: string, signal?: AbortSignal): Promise<MetadataValues> {
  const info = await probeMediaFile(filePath, signal)
  return tagsToMetadata(info.tags)
}
