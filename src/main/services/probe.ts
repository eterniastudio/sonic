import type { ProbeResult } from '@shared/domain'
import { artworkFor, describeProviderError, isSoundCloudShareUrl, parseVideoUrl, type ProviderId } from '@shared/url'
import { assertPublicUrl, guardedYtDlpArgs } from '../lib/publicAddress'
import { run } from '../lib/child'
import { engineService } from './engine'
import { settingsService } from './settings'

interface YtDlpInfo {
  id?: string
  title?: string
  description?: string
  uploader?: string
  channel?: string
  thumbnail?: string
  thumbnails?: { url?: unknown }[]
  duration?: number
  is_live?: boolean
  live_status?: string
  webpage_url?: string
  _type?: string
  entries?: unknown[]
}

export function preferredSourceChannel(info: Pick<YtDlpInfo, 'channel' | 'uploader'>): string | null {
  return info.channel?.trim() || info.uploader?.trim() || null
}

/**
 * Whether links outside the provider registry may reach yt-dlp's generic
 * extractor. Read lazily so a missing settings record simply means "no".
 */
export function allowOtherSites(): boolean {
  return settingsService?.get()?.allowOtherSites === true
}

/** Builds the shared, non-interactive prefix every yt-dlp invocation uses. */
export async function baseYtDlpArgs(signal?: AbortSignal): Promise<string[]> {
  const settings = settingsService.get()
  const args = ['--ignore-config', '--no-playlist', '--no-warnings', '--no-call-home']

  if (settings.cookiesFromBrowser !== 'none') {
    args.push('--cookies-from-browser', settings.cookiesFromBrowser)
  }

  const ffmpeg = await engineService.resolve('ffmpeg', false, signal)
  signal?.throwIfAborted()
  if (ffmpeg.path) {
    args.push('--ffmpeg-location', ffmpeg.path)
  }

  return args
}

/**
 * Capture ceiling for a metadata dump.
 *
 * `--dump-single-json` is not a log — it is a structured document. A real
 * YouTube video routinely returns over a megabyte (a 10-minute upload measured
 * 1.28 MB), mostly formats, thumbnails, chapters and automatic captions. Under
 * the default 512 KB log cap that document was cut in half and every probe
 * failed with a parse error, so this path gets its own, much larger ceiling.
 */
const PROBE_MAX_CAPTURE_BYTES = 32 * 1024 * 1024

/** Resolve share links before handing anything to the media extractor. */
export async function resolveSoundCloudUrl(url: string, signal?: AbortSignal): Promise<string> {
  const timeout = AbortSignal.timeout(20_000)
  const requestSignal = signal ? AbortSignal.any([signal, timeout]) : timeout
  let current = url
  for (let hop = 0; hop < 6; hop += 1) {
    requestSignal.throwIfAborted()
    const parsed = parseVideoUrl(current)
    if (!parsed.ok || parsed.provider !== 'soundcloud' || !parsed.normalized) {
      throw new Error('This share link does not point to a supported SoundCloud track. Paste the full track link.')
    }
    if (!isSoundCloudShareUrl(parsed.normalized)) return parsed.normalized
    const response = await fetch(parsed.normalized, { redirect: 'manual', signal: requestSignal })
    await response.body?.cancel()
    const location = response.headers.get('location')
    if (response.status < 300 || response.status >= 400 || !location) break
    current = new URL(location, parsed.normalized).href
  }
  throw new Error('Could not resolve this SoundCloud share link. Paste the full track link from soundcloud.com.')
}

/** Reads a URL's metadata without downloading any media. */
export async function probeUrl(url: string, signal?: AbortSignal): Promise<ProbeResult> {
  const parsed = parseVideoUrl(url, { allowOtherSites: allowOtherSites() })
  const empty: ProbeResult = {
    url,
    videoId: parsed.videoId,
    title: '',
    description: null,
    uploader: null,
    thumbnail: null,
    durationSec: null,
    isLive: false,
    error: null
  }

  if (!parsed.ok || !parsed.normalized) {
    return { ...empty, error: parsed.reason ?? 'Unsupported URL' }
  }

  if (parsed.provider === 'direct' || parsed.provider === 'generic') {
    try { await assertPublicUrl(parsed.normalized, signal) }
    catch (error) {
      if (signal?.aborted) return { ...empty, error: 'Cancelled' }
      return { ...empty, error: error instanceof Error && /private network/.test(error.message) ? error.message : "Could not resolve this link's host. Check the address and your connection." }
    }
  }

  if (signal?.aborted) return { ...empty, error: 'Cancelled' }
  const ytdlp = await engineService.resolve('yt-dlp', false, signal)
  if (signal?.aborted) return { ...empty, error: 'Cancelled' }
  if (!ytdlp.path) {
    return { ...empty, error: 'yt-dlp is not installed yet. Finish media engine setup first.' }
  }

  let sharedArgs: string[]
  try { sharedArgs = await baseYtDlpArgs(signal) }
  catch (error) {
    if (signal?.aborted) return { ...empty, error: 'Cancelled' }
    throw error
  }

  if (parsed.provider === 'soundcloud') {
    try { parsed.normalized = await resolveSoundCloudUrl(parsed.normalized, signal) }
    catch (error) {
      return { ...empty, error: signal?.aborted ? 'Cancelled' : error instanceof Error ? error.message : 'Could not resolve this SoundCloud link.' }
    }
  }
  const args = [
    ...sharedArgs,
    ...(await guardedYtDlpArgs(parsed.provider)),
    '--dump-single-json',
    '--skip-download',
    '--socket-timeout',
    '20',
    '--retries',
    '2',
    parsed.normalized
  ]

  const result = await run(ytdlp.path, args, {
    signal,
    timeoutMs: 60_000,
    maxCaptureBytes: PROBE_MAX_CAPTURE_BYTES
  })

  if (result.aborted) {
    return { ...empty, error: 'Cancelled' }
  }

  if (result.timedOut) return { ...empty, error: 'Reading source metadata timed out after 60 seconds.' }

  if (result.code !== 0) {
    return { ...empty, error: summariseYtDlpError(result.stderr, parsed.provider) }
  }

  // Say what actually happened rather than reporting a parse failure.
  if (result.stdoutTruncated) {
    return {
      ...empty,
      error: 'The metadata for this link was unexpectedly large and could not be read in full.'
    }
  }

  const jsonStart = result.stdout.indexOf('{')
  if (jsonStart === -1) {
    return { ...empty, error: 'yt-dlp returned no metadata for this link.' }
  }

  let info: YtDlpInfo
  try {
    info = JSON.parse(result.stdout.slice(jsonStart)) as YtDlpInfo
  } catch {
    return { ...empty, error: 'Could not read the metadata yt-dlp returned.' }
  }

  const isLive = info.is_live === true || info.live_status === 'is_live'

  if (info._type === 'playlist' || info._type === 'multi_video' || info.entries != null) {
    return {
      ...empty,
      error: parsed.provider === 'archive'
        ? 'This Internet Archive item holds several files. Open the file you want on archive.org and paste its link.'
        : 'Use a single track link. Playlists and profiles are not supported.'
    }
  }

  const reported = info.thumbnail ??
    [...(info.thumbnails ?? [])].reverse().find(entry => typeof entry?.url === 'string')?.url as string | undefined

  return {
    url: parsed.normalized,
    videoId: info.id ?? parsed.videoId,
    title: info.title?.trim() ?? '',
    description: info.description ?? null,
    uploader: preferredSourceChannel(info),
    thumbnail: artworkFor(parsed.provider, info.id ?? parsed.videoId, reported),
    durationSec: typeof info.duration === 'number' ? info.duration : null,
    isLive,
    error: null
  }
}

/** Turns yt-dlp's noisy stderr into one actionable sentence, worded for the provider. */
export function summariseYtDlpError(stderr: string, provider: ProviderId | null = 'youtube'): string {
  return describeProviderError(stderr, provider)
}
