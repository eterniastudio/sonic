/**
 * Source URL classification. Shared so paste-time validation in the renderer
 * matches what the main process will actually accept.
 *
 * Per-site rules live in the provider registry (`./providers`); this module
 * applies the common https/credential checks and delegates the rest.
 */

import {
  SOUNDCLOUD_SHARE_HOSTS,
  providerById,
  providerForUrl,
  PROVIDERS,
  type ProviderId,
  type ProviderOptions
} from './providers'

export {
  ALL_PROVIDERS,
  PROVIDERS,
  PROVIDER_IDS,
  artworkFor,
  describeProviderError,
  isProviderId,
  providerById,
  sourceKindName
} from './providers'
export type { ProviderId, ProviderOptions, SourceProvider } from './providers'

export interface ParsedVideoUrl {
  ok: boolean
  /** Canonical https URL, when the input could be normalised. */
  normalized: string | null
  videoId: string | null
  provider: ProviderId | null
  reason: string | null
}

export interface ParsedCollectionUrl {
  provider: ProviderId
  /** Canonical collection link handed to the playlist review. */
  normalized: string
}

function safeUrl(input: string): URL | null {
  try {
    const url = new URL(input.trim())
    return url.protocol !== 'https:' || url.username || url.password || url.port ? null : url
  } catch { return null }
}

/** A playlist or album is expanded separately; media jobs always retain single-track URLs. */
export function parseCollectionUrl(input: string): ParsedCollectionUrl | null {
  const url = safeUrl(input)
  if (!url) return null
  const provider = PROVIDERS.find(entry => entry.matchesHost(url.hostname.toLowerCase(), url))
  const normalized = provider?.supportsCollections ? provider.parseCollection?.(url) ?? null : null
  return provider && normalized ? { provider: provider.id, normalized } : null
}

/** Canonical link of a collection the playlist review can expand, or null. */
export function parsePlaylistUrl(input: string): string | null {
  return parseCollectionUrl(input)?.normalized ?? null
}

export function extractIntakeUrls(blob: string, options: ProviderOptions = {}): { tracks: ParsedVideoUrl[]; playlists: string[]; rejected: string[] } {
  const playlists = new Set<string>()
  const tracks: string[] = []
  for (const token of blob.split(/[\s,]+/).filter(Boolean)) {
    const playlist = parsePlaylistUrl(token)
    if (playlist) playlists.add(playlist)
    else tracks.push(token)
  }
  const parsed = extractVideoUrls(tracks.join('\n'), options)
  return { tracks: parsed.accepted, playlists: [...playlists], rejected: parsed.rejected }
}

export function isSoundCloudShareUrl(input: string): boolean {
  try { return SOUNDCLOUD_SHARE_HOSTS.has(new URL(input).hostname) } catch { return false }
}

export function parseVideoUrl(input: string, options: ProviderOptions = {}): ParsedVideoUrl {
  const trimmed = input.trim()
  if (trimmed.length === 0) {
    return { ok: false, normalized: null, videoId: null, provider: null, reason: 'Empty input' }
  }

  let url: URL
  try {
    url = new URL(trimmed)
  } catch {
    return { ok: false, normalized: null, videoId: null, provider: null, reason: 'Not a valid URL' }
  }

  if (url.protocol !== 'https:') {
    return { ok: false, normalized: null, videoId: null, provider: null, reason: 'Only https links are supported' }
  }

  if (url.username || url.password || url.port) {
    return { ok: false, normalized: null, videoId: null, provider: null, reason: 'Links with credentials or custom ports are not supported' }
  }

  const provider = providerForUrl(url, options)
  if (!provider) {
    return {
      ok: false,
      normalized: null,
      videoId: null,
      provider: null,
      reason: options.allowOtherSites
        ? 'Local and private network addresses are not supported'
        : 'This site is not on the supported list. Turn on "Allow other sites" in Settings to try it anyway'
    }
  }

  const result = provider.parseTrack(url)
  return { ok: result.ok, normalized: result.normalized, videoId: result.videoId, provider: provider.id, reason: result.reason }
}

/**
 * Pulls every distinct, valid video URL out of a pasted blob.
 * Accepts newline-, comma-, or whitespace-separated input.
 */
export function extractVideoUrls(blob: string, options: ProviderOptions = {}): { accepted: ParsedVideoUrl[]; rejected: string[] } {
  const tokens = blob
    .split(/[\s,]+/)
    .map((token) => token.trim())
    .filter((token) => token.length > 0)

  const accepted: ParsedVideoUrl[] = []
  const rejected: string[] = []
  const seen = new Set<string>()

  for (const token of tokens) {
    const parsed = parseVideoUrl(token, options)
    if (parsed.ok && parsed.normalized) {
      if (seen.has(parsed.normalized)) continue
      seen.add(parsed.normalized)
      accepted.push(parsed)
    } else {
      rejected.push(token)
    }
  }

  return { accepted, rejected }
}

export function thumbnailFor(videoId: string): string {
  return `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg`
}

/** Pulls the YouTube video id out of a stored source URL, if it is one. */
export function videoIdFromUrl(url: string | null | undefined): string | null {
  if (!url) return null
  const parsed = parseVideoUrl(url)
  return providerById(parsed.provider)?.artwork === 'youtube-thumbnail' ? parsed.videoId : null
}

/** Sixteen-by-nine cover art for a stored source URL, or null. */
export function coverArtFor(url: string | null | undefined): string | null {
  const id = videoIdFromUrl(url)
  return id ? thumbnailFor(id) : null
}
