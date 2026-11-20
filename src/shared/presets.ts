import type { ChannelMode, PresetId } from './domain'

export interface PresetDefinition {
  id: PresetId
  label: string
  /** Compact badge shown in dense UI. */
  short: string
  description: string
  extension: string
  lossless: boolean
  /** Whether the container can carry embedded cover art. */
  supportsCoverArt: boolean
  /** Audio codec arguments handed to ffmpeg. */
  codecArgs: string[]
  /** Relative size hint, used only for UI copy. */
  sizeHint: string
}

export const PRESETS: readonly PresetDefinition[] = [
  {
    id: 'mp3-320',
    label: 'MP3 320',
    short: '320',
    description: 'Constant 320 kbps MP3. The safe default for sharing and DJ software.',
    extension: 'mp3',
    lossless: false,
    supportsCoverArt: true,
    codecArgs: ['-c:a', 'libmp3lame', '-b:a', '320k'],
    sizeHint: '~2.4 MB/min'
  },
  {
    id: 'mp3-v0',
    label: 'MP3 V0',
    short: 'V0',
    description: 'Highest-quality variable-bitrate MP3. Smaller than 320 with equal transparency.',
    extension: 'mp3',
    lossless: false,
    supportsCoverArt: true,
    codecArgs: ['-c:a', 'libmp3lame', '-q:a', '0'],
    sizeHint: '~1.9 MB/min'
  },
  {
    id: 'm4a-256',
    label: 'M4A AAC 256',
    short: 'AAC',
    description: 'AAC at 256 kbps in an M4A container. Great quality per megabyte.',
    extension: 'm4a',
    lossless: false,
    supportsCoverArt: true,
    codecArgs: ['-c:a', 'aac', '-b:a', '256k'],
    sizeHint: '~1.9 MB/min'
  },
  {
    id: 'flac',
    label: 'FLAC',
    short: 'FLAC',
    description: 'Lossless compressed audio for archiving and further production work.',
    extension: 'flac',
    lossless: true,
    supportsCoverArt: true,
    codecArgs: ['-c:a', 'flac', '-compression_level', '8'],
    sizeHint: '~6 MB/min'
  },
  {
    id: 'wav-44100-24',
    label: 'WAV 44.1 / 24',
    short: 'WAV 44',
    description: '24-bit PCM at 44.1 kHz. The standard session format for most DAWs.',
    extension: 'wav',
    lossless: true,
    supportsCoverArt: false,
    codecArgs: ['-c:a', 'pcm_s24le', '-ar', '44100'],
    sizeHint: '~15 MB/min'
  },
  {
    id: 'wav-48000-24',
    label: 'WAV 48 / 24',
    short: 'WAV 48',
    description: '24-bit PCM at 48 kHz, for video and 48 kHz production sessions.',
    extension: 'wav',
    lossless: true,
    supportsCoverArt: false,
    codecArgs: ['-c:a', 'pcm_s24le', '-ar', '48000'],
    sizeHint: '~16 MB/min'
  },
  {
    id: 'opus-192',
    label: 'Opus 192',
    short: 'Opus',
    description: 'Efficient 192 kbps Opus. Small files, excellent quality.',
    extension: 'opus',
    lossless: false,
    supportsCoverArt: false,
    codecArgs: ['-c:a', 'libopus', '-b:a', '192k'],
    sizeHint: '~1.4 MB/min'
  },
  {
    id: 'original',
    label: 'Original stream',
    short: 'Src',
    description: 'Keep the acquired audio stream untouched — no re-encode, no quality loss.',
    extension: 'm4a',
    lossless: true,
    supportsCoverArt: true,
    codecArgs: ['-c:a', 'copy'],
    sizeHint: 'source'
  }
] as const

export const PRESET_MAP: Record<PresetId, PresetDefinition> = PRESETS.reduce(
  (accumulator, preset) => {
    accumulator[preset.id] = preset
    return accumulator
  },
  {} as Record<PresetId, PresetDefinition>
)

export const DEFAULT_PRESET_ID: PresetId = 'mp3-320'

export function getPreset(id: PresetId | string | null | undefined): PresetDefinition {
  if (id && id in PRESET_MAP) return PRESET_MAP[id as PresetId]
  return PRESET_MAP[DEFAULT_PRESET_ID]
}

export interface FfmpegTagContext {
  title?: string | null
  producer?: string | null
  album?: string | null
  comment?: string | null
  date?: string | null
  genre?: string | null
  bpm?: number | null
  key?: string | null
}

export interface FfmpegBuildContext {
  inputPath: string
  outputPath: string
  channels: ChannelMode
  /** Target loudness in LUFS, or null to leave dynamics alone. */
  lufs: number | null
  coverPath: string | null
  tags: FfmpegTagContext
}

/**
 * Tag dialect of an output container, chosen from the output file's extension
 * (the `original` preset keeps whatever container was acquired, so the preset
 * alone does not name it).
 *
 *  - `id3`      MP3: ID3v2.3 frames TBPM / TKEY.
 *  - `vorbis`   FLAC, Ogg, Opus: Vorbis comments BPM / INITIALKEY.
 *  - `mp4`      M4A/MP4: the iTunes `tmpo` atom (integer BPM). ffmpeg 6 cannot
 *               write the freeform `----:com.apple.iTunes:initialkey` atom that
 *               DJ software reads, and `-movflags use_metadata_tags` would move
 *               *every* tag (title, artist…) into QuickTime `mdta` keys that
 *               iTunes-style readers ignore, so no key is embedded in MP4.
 *  - `matroska` WebM/MKV: Matroska SimpleTags BPM / INITIAL_KEY.
 *  - `riff`     WAV: ffmpeg's WAV muxer writes only LIST/INFO (no BPM or key
 *               field, and no ID3 option), so Sonic appends a standard `id3 `
 *               chunk with TBPM / TKEY after encoding (see `wavId3Frames`).
 *  - `other`    anything else: common text tags only.
 */
export type TagDialect = 'id3' | 'vorbis' | 'mp4' | 'matroska' | 'riff' | 'other'

export function tagDialectFor(outputPath: string): TagDialect {
  const match = /\.([A-Za-z0-9]+)$/.exec(outputPath)
  switch (match ? match[1].toLowerCase() : '') {
    case 'mp3':
      return 'id3'
    case 'flac':
    case 'ogg':
    case 'oga':
    case 'opus':
      return 'vorbis'
    case 'm4a':
    case 'mp4':
    case 'm4b':
    case 'mov':
      return 'mp4'
    case 'webm':
    case 'mkv':
    case 'mka':
      return 'matroska'
    case 'wav':
      return 'riff'
    default:
      return 'other'
  }
}

/** Text form of a BPM tag value; NaN/Infinity and non-positive values are dropped. */
function bpmText(bpm: number | null | undefined): string | null {
  return bpm != null && Number.isFinite(bpm) && bpm > 0 ? String(bpm) : null
}

/** ID3v2 TBPM/TKEY frames to append to a WAV file as an `id3 ` chunk. */
export function wavId3Frames(tags: FfmpegTagContext): { id: 'TBPM' | 'TKEY'; text: string }[] {
  const frames: { id: 'TBPM' | 'TKEY'; text: string }[] = []
  const bpm = bpmText(tags.bpm)
  if (bpm) frames.push({ id: 'TBPM', text: bpm })
  if (tags.key) frames.push({ id: 'TKEY', text: tags.key })
  return frames
}

/** Maps reviewed values onto the output container's own BPM/key fields. */
function tagArgs(dialect: TagDialect, tags: FfmpegTagContext): string[] {
  const pairs: [string, string | number | null | undefined][] = [
    ['title', tags.title],
    ['artist', tags.producer],
    ['album', tags.album],
    ['comment', tags.comment],
    ['date', tags.date],
    ['genre', tags.genre]
  ]

  const bpm = bpmText(tags.bpm)
  if (dialect === 'id3') pairs.push(['TBPM', bpm], ['TKEY', tags.key])
  if (dialect === 'vorbis') pairs.push(['BPM', bpm], ['INITIALKEY', tags.key])
  if (dialect === 'matroska') pairs.push(['BPM', bpm], ['INITIAL_KEY', tags.key])
  if (dialect === 'mp4' && tags.bpm != null && Number.isFinite(tags.bpm)) {
    // `tmpo` is a 16-bit integer atom; a fractional BPM is rounded to fit.
    const tempo = Math.round(tags.bpm)
    if (tempo >= 1 && tempo <= 65535) pairs.push(['tmpo', tempo])
  }

  const args: string[] = []
  for (const [key, value] of pairs) {
    if (value == null || value === '') continue
    args.push('-metadata', `${key}=${String(value)}`)
  }

  if (dialect === 'id3') {
    args.push('-id3v2_version', '3', '-write_id3v1', '1')
  }
  return args
}

/**
 * Builds a complete, non-interactive ffmpeg argument vector for one export.
 *
 * Every argument is enumerated — there is no path for arbitrary producer input
 * to reach ffmpeg as a flag, and source container metadata is stripped first so
 * only Sonic's reviewed values are written.
 */
export function buildFfmpegArgs(presetId: PresetId, context: FfmpegBuildContext): string[] {
  const preset = getPreset(presetId)
  const args: string[] = ['-hide_banner', '-nostdin', '-y', '-i', context.inputPath]

  const wantsCover = Boolean(context.coverPath) && preset.supportsCoverArt
  if (wantsCover && context.coverPath) {
    args.push('-i', context.coverPath)
  }

  args.push('-map', '0:a:0')

  if (wantsCover) {
    args.push('-map', '1:v:0', '-c:v', 'mjpeg', '-disposition:v:0', 'attached_pic')
  }

  // Strip the source container's own tags before writing reviewed values.
  args.push('-map_metadata', '-1')

  args.push(...preset.codecArgs)

  if (context.channels === 'stereo') args.push('-ac', '2')
  if (context.channels === 'mono') args.push('-ac', '1')

  if (context.lufs != null && preset.id !== 'original') {
    args.push('-af', `loudnorm=I=${context.lufs}:TP=-1.0:LRA=11`)
  }

  args.push(...tagArgs(tagDialectFor(context.outputPath), context.tags))

  args.push(context.outputPath)
  return args
}
