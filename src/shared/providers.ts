/**
 * Download source registry.
 *
 * Pure on purpose: the renderer classifies links at paste time with exactly the
 * rules the main process applies before anything reaches yt-dlp. Every provider
 * here is served by yt-dlp without cookies for public content.
 *
 * A provider only ever sees URLs that are already `https:` with no credentials
 * and no custom port; `src/shared/url.ts` enforces that preamble.
 */

export type ProviderId =
  | 'youtube'
  | 'soundcloud'
  | 'bandcamp'
  | 'vimeo'
  | 'mixcloud'
  | 'audiomack'
  | 'dailymotion'
  | 'twitch'
  | 'tiktok'
  | 'instagram'
  | 'reddit'
  | 'streamable'
  | 'twitter'
  | 'archive'
  | 'direct'
  | 'generic'

/**
 * Where cover art comes from. YouTube artwork is derived from the video id
 * (i.ytimg.com); every other provider uses the thumbnail yt-dlp reports when
 * the link is probed.
 */
export type ArtworkStrategy = 'youtube-thumbnail' | 'probe-thumbnail'

export interface ProviderParse {
  ok: boolean
  normalized: string | null
  videoId: string | null
  reason: string | null
}

export interface SourceProvider {
  id: ProviderId
  /** Display name, e.g. for "Open on <name>". */
  name: string
  /** Short value for the `{source}` naming token. */
  tokenLabel: string
  /** Label for the library's open-source action. */
  openLabel: string
  /** True when this provider owns the hostname (already lower-cased). */
  matchesHost(host: string, url: URL): boolean
  /** Validates and canonicalises a single-track link. */
  parseTrack(url: URL): ProviderParse
  /** Whether collection links (playlists, albums) can be expanded for review. */
  supportsCollections: boolean
  /** Canonical collection link, or null when the URL is not one. */
  parseCollection?(url: URL): string | null
  artwork: ArtworkStrategy
  /** Maps yt-dlp stderr (ERROR prefixes stripped, warnings removed) to one plain sentence. */
  describeError(lines: string[]): string
}

const ok = (normalized: string, videoId: string | null = null): ProviderParse => ({ ok: true, normalized, videoId, reason: null })
const no = (reason: string): ProviderParse => ({ ok: false, normalized: null, videoId: null, reason })
const segmentsOf = (url: URL): string[] => url.pathname.split('/').filter(Boolean)
const SLUG = /^[A-Za-z0-9_-]+$/
const lastLine = (lines: string[]): string => lines[lines.length - 1].slice(0, 240)

/** Plain-language yt-dlp errors shared by every provider without bespoke wording. */
function standardErrors(name: string, extra?: (joined: string) => string | null): (lines: string[]) => string {
  return (lines) => {
    const joined = lines.join(' ')
    const special = extra?.(joined)
    if (special) return special
    if (/private/i.test(joined)) return `This ${name} link is private.`
    if (/login|log in|sign.in|registered|cookies|authenticat|rate.limit|401|403/i.test(joined)) {
      return `${name} only shows this to signed-in viewers. Choose a browser for cookies in Settings if your account can see it.`
    }
    if (/not found|404|does not exist|no longer exists/i.test(joined)) return `This ${name} link was not found. Check that it still opens in a browser.`
    if (/removed|deleted|unavailable|taken down|copyright/i.test(joined)) return `This ${name} media is unavailable or has been removed.`
    if (/geo|not available in your country/i.test(joined)) return `This ${name} media is region-locked.`
    if (/no video formats|no formats|requested format is not available|no media/i.test(joined)) return `${name} offered no downloadable audio for this link.`
    if (/unsupported url/i.test(joined)) return `yt-dlp does not recognise this ${name} link.`
    if (/timed out|timeout/i.test(joined)) return `The connection to ${name} timed out.`
    if (/urlopen error|unable to download|network/i.test(joined)) return `Could not reach ${name}. Check your connection.`
    return lastLine(lines)
  }
}

// ------------------------------------------------------------------ YouTube

const YOUTUBE_HOSTS = new Set(['youtube.com', 'www.youtube.com', 'm.youtube.com', 'music.youtube.com', 'youtu.be', 'www.youtu.be'])
const VIDEO_ID = /^[A-Za-z0-9_-]{11}$/

const youtube: SourceProvider = {
  id: 'youtube',
  name: 'YouTube',
  tokenLabel: 'YouTube',
  openLabel: 'Open on YouTube',
  matchesHost: host => YOUTUBE_HOSTS.has(host),
  parseTrack(url) {
    const host = url.hostname.toLowerCase()
    let videoId: string | null = null
    if (host.endsWith('youtu.be')) {
      videoId = url.pathname.replace(/^\//, '').split('/')[0] ?? null
    } else if (url.pathname === '/watch') {
      videoId = url.searchParams.get('v')
    } else {
      const segments = url.pathname.split('/').filter(Boolean)
      if (segments[0] === 'shorts' || segments[0] === 'embed' || segments[0] === 'live') videoId = segments[1] ?? null
    }
    if (!videoId || !VIDEO_ID.test(videoId)) return no('Could not read a video id — playlists and channel links are not supported')
    return ok(`https://www.youtube.com/watch?v=${videoId}`, videoId)
  },
  supportsCollections: true,
  parseCollection(url) {
    const path = url.pathname
    if (path !== '/playlist' && path !== '/watch' && !((url.hostname === 'youtu.be' || url.hostname === 'www.youtu.be') && /^\/[A-Za-z0-9_-]{11}$/.test(path))) return null
    const id = url.searchParams.get('list')
    return id && /^[A-Za-z0-9_-]{2,200}$/.test(id) ? `https://www.youtube.com/playlist?list=${id}` : null
  },
  artwork: 'youtube-thumbnail',
  describeError(lines) {
    const joined = lines.join(' ')
    if (/private video/i.test(joined)) return 'This video is private.'
    if (/video unavailable/i.test(joined)) return 'This video is unavailable.'
    if (/age|sign in to confirm/i.test(joined)) return 'YouTube asked for a signed-in session. Set a browser for cookies in Settings, then retry.'
    if (/removed|deleted|terminated/i.test(joined)) return 'This video has been removed.'
    if (/not available in your country|geo/i.test(joined)) return 'This video is region-locked.'
    if (/timed out|timeout/i.test(joined)) return 'The connection to YouTube timed out.'
    if (/urlopen error|unable to download|network/i.test(joined)) return 'Could not reach YouTube. Check your connection.'
    return lastLine(lines)
  }
}

// --------------------------------------------------------------- SoundCloud

const SOUNDCLOUD_HOSTS = new Set(['soundcloud.com', 'www.soundcloud.com', 'm.soundcloud.com'])
export const SOUNDCLOUD_SHARE_HOSTS: ReadonlySet<string> = new Set(['on.soundcloud.com', 'soundcloud.app.goo.gl'])
const SOUNDCLOUD_COLLECTIONS = new Set(['tracks', 'albums', 'sets', 'reposts', 'likes', 'spotlight', 'comments'])

const soundcloud: SourceProvider = {
  id: 'soundcloud',
  name: 'SoundCloud',
  tokenLabel: 'SoundCloud',
  openLabel: 'Open on SoundCloud',
  matchesHost: host => SOUNDCLOUD_HOSTS.has(host) || SOUNDCLOUD_SHARE_HOSTS.has(host),
  parseTrack(url) {
    const host = url.hostname.toLowerCase()
    const segments = url.pathname.replace(/\/$/, '').split('/').slice(1)
    const share = SOUNDCLOUD_SHARE_HOSTS.has(host)
    const valid = share
      ? segments.length === 1 && /^[A-Za-z0-9_-]+$/.test(segments[0])
      : (segments.length === 2 || (segments.length === 3 && /^s-[A-Za-z0-9]+$/.test(segments[2]))) &&
        segments.slice(0, 2).every(segment => /^[A-Za-z0-9_-]+$/.test(segment)) &&
        !SOUNDCLOUD_COLLECTIONS.has(segments[1]) &&
        !['discover', 'search', 'you', 'stations', 'stream', 'charts'].includes(segments[0])
    if (!valid) return no('Use a SoundCloud track link — playlists and profiles are not supported')
    let normalized = `https://${share ? host : 'soundcloud.com'}/${segments.join('/')}`
    const secret = url.searchParams.get('secret_token')
    if (!share && segments.length === 2 && secret && /^s-[A-Za-z0-9]+$/.test(secret)) normalized += `/${secret}`
    return ok(normalized)
  },
  supportsCollections: false,
  artwork: 'probe-thumbnail',
  describeError(lines) {
    const joined = lines.join(' ')
    if (/private|not found|404/i.test(joined)) return 'This SoundCloud track is private or unavailable. Check the track link and access.'
    if (/removed|deleted|unavailable/i.test(joined)) return 'This SoundCloud track is unavailable or has been removed.'
    if (/geo|not available in your country/i.test(joined)) return 'This SoundCloud track is region-locked.'
    if (/login|sign.in|registered|subscription|soundcloud go|403|401/i.test(joined)) return 'SoundCloud requires access to this track. Choose a browser for cookies in Settings if your account can play it.'
    if (/timed out|timeout/i.test(joined)) return 'The connection to SoundCloud timed out.'
    if (/urlopen error|unable to download|network/i.test(joined)) return 'Could not reach SoundCloud. Check your connection.'
    return lastLine(lines)
  }
}

// ----------------------------------------------------------------- Bandcamp

const BANDCAMP_RESERVED = new Set(['www', 'daily', 'bandcamp', 'get', 'blog', 'm'])
function bandcampArtist(host: string): string | null {
  const match = /^([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)\.bandcamp\.com$/.exec(host)
  return match && !BANDCAMP_RESERVED.has(match[1]) ? match[1] : null
}

const bandcamp: SourceProvider = {
  id: 'bandcamp',
  name: 'Bandcamp',
  tokenLabel: 'Bandcamp',
  openLabel: 'Open on Bandcamp',
  matchesHost: host => host === 'bandcamp.com' || host.endsWith('.bandcamp.com'),
  parseTrack(url) {
    const artist = bandcampArtist(url.hostname)
    const segments = segmentsOf(url)
    if (artist && segments.length === 2 && segments[0] === 'track' && SLUG.test(segments[1])) {
      return ok(`https://${artist}.bandcamp.com/track/${segments[1]}`)
    }
    return no('Use a Bandcamp track link, or an album link to review its tracks')
  },
  supportsCollections: true,
  parseCollection(url) {
    const artist = bandcampArtist(url.hostname)
    const segments = segmentsOf(url)
    return artist && segments.length === 2 && segments[0] === 'album' && SLUG.test(segments[1])
      ? `https://${artist}.bandcamp.com/album/${segments[1]}`
      : null
  },
  artwork: 'probe-thumbnail',
  describeError: standardErrors('Bandcamp', joined =>
    /no (?:video )?formats|not available for streaming|purchase/i.test(joined) ? 'Bandcamp does not stream this track for free. Only tracks with a public preview can be downloaded.' : null)
}

// -------------------------------------------------------------------- Vimeo

const VIMEO_ID = /^\d{1,12}$/
const VIMEO_HASH = /^[0-9a-f]{6,20}$/

const vimeo: SourceProvider = {
  id: 'vimeo',
  name: 'Vimeo',
  tokenLabel: 'Vimeo',
  openLabel: 'Open on Vimeo',
  matchesHost: host => host === 'vimeo.com' || host === 'www.vimeo.com' || host === 'player.vimeo.com',
  parseTrack(url) {
    const segments = segmentsOf(url)
    let id: string | null = null
    let hash: string | null = null
    if (url.hostname === 'player.vimeo.com') {
      if (segments.length === 2 && segments[0] === 'video') id = segments[1]
      hash = url.searchParams.get('h')
    } else if (segments.length === 1 || segments.length === 2) {
      id = segments[0]
      hash = segments[1] ?? url.searchParams.get('h')
    } else if (segments.length === 3 && segments[0] === 'channels') {
      id = segments[2]
    } else if (segments.length === 4 && ((segments[0] === 'groups' && segments[2] === 'videos') ||
      ((segments[0] === 'album' || segments[0] === 'showcase') && segments[2] === 'video'))) {
      id = segments[3]
    }
    if (!id || !VIMEO_ID.test(id)) return no('Use a Vimeo video link — channels, showcases and profiles are not supported')
    return ok(hash && VIMEO_HASH.test(hash) ? `https://vimeo.com/${id}/${hash}` : `https://vimeo.com/${id}`)
  },
  supportsCollections: false,
  artwork: 'probe-thumbnail',
  describeError: standardErrors('Vimeo', joined =>
    /password/i.test(joined) ? 'This Vimeo video is password-protected.' : null)
}

// ----------------------------------------------------------------- Mixcloud

const MIXCLOUD_RESERVED_USER = new Set(['discover', 'upload', 'dashboard', 'settings', 'search', 'categories', 'select', 'live',
  'about', 'pro', 'tag', 'genres', 'favorites', 'notifications', 'messages', 'for-creators', 'developers', 'mobile', 'privacy', 'terms'])
const MIXCLOUD_RESERVED_SHOW = new Set(['uploads', 'favorites', 'listens', 'playlists', 'stream', 'followers', 'following', 'reposts', 'hosts', 'shows', 'history'])
const MIXCLOUD_SLUG = /^[A-Za-z0-9_%.-]+$/

const mixcloud: SourceProvider = {
  id: 'mixcloud',
  name: 'Mixcloud',
  tokenLabel: 'Mixcloud',
  openLabel: 'Open on Mixcloud',
  matchesHost: host => ['mixcloud.com', 'www.mixcloud.com', 'm.mixcloud.com', 'beta.mixcloud.com'].includes(host),
  parseTrack(url) {
    const [user, show, ...rest] = segmentsOf(url)
    if (!user || !show || rest.length || !MIXCLOUD_SLUG.test(user) || !MIXCLOUD_SLUG.test(show) ||
      MIXCLOUD_RESERVED_USER.has(user.toLowerCase()) || MIXCLOUD_RESERVED_SHOW.has(show.toLowerCase())) {
      return no('Use a Mixcloud show link — profiles and playlists are not supported')
    }
    return ok(`https://www.mixcloud.com/${user}/${show}/`)
  },
  supportsCollections: false,
  artwork: 'probe-thumbnail',
  describeError: standardErrors('Mixcloud', joined =>
    /select|exclusive|subscri/i.test(joined) ? 'This Mixcloud show is for subscribers only.' : null)
}

// ---------------------------------------------------------------- Audiomack

const audiomack: SourceProvider = {
  id: 'audiomack',
  name: 'Audiomack',
  tokenLabel: 'Audiomack',
  openLabel: 'Open on Audiomack',
  matchesHost: host => host === 'audiomack.com' || host === 'www.audiomack.com',
  parseTrack(url) {
    const segments = segmentsOf(url)
    let artist: string | undefined
    let slug: string | undefined
    if (segments.length === 3 && segments[1] === 'song') [artist, , slug] = segments
    else if (segments.length === 3 && segments[0] === 'song') [, artist, slug] = segments
    if (!artist || !slug || !SLUG.test(artist) || !SLUG.test(slug)) return no('Use an Audiomack song link — albums, playlists and profiles are not supported')
    return ok(`https://audiomack.com/${artist}/song/${slug}`)
  },
  supportsCollections: false,
  artwork: 'probe-thumbnail',
  describeError: standardErrors('Audiomack')
}

// -------------------------------------------------------------- Dailymotion

const DAILYMOTION_ID = /^x[0-9a-z]{3,12}$/i

const dailymotion: SourceProvider = {
  id: 'dailymotion',
  name: 'Dailymotion',
  tokenLabel: 'Dailymotion',
  openLabel: 'Open on Dailymotion',
  matchesHost: host => ['dailymotion.com', 'www.dailymotion.com', 'm.dailymotion.com', 'geo.dailymotion.com', 'dai.ly', 'www.dai.ly'].includes(host),
  parseTrack(url) {
    const segments = segmentsOf(url)
    let id: string | null = null
    if (url.hostname.endsWith('dai.ly')) id = segments.length === 1 ? segments[0] : null
    else if (url.hostname === 'geo.dailymotion.com') id = url.searchParams.get('video')
    else if (segments.length === 2 && segments[0] === 'video') id = segments[1].split('_')[0]
    else if (segments.length === 3 && segments[0] === 'embed' && segments[1] === 'video') id = segments[2]
    if (!id || !DAILYMOTION_ID.test(id)) return no('Use a Dailymotion video link — channels and playlists are not supported')
    return ok(`https://www.dailymotion.com/video/${id}`)
  },
  supportsCollections: false,
  artwork: 'probe-thumbnail',
  describeError: standardErrors('Dailymotion')
}

// ------------------------------------------------------------------- Twitch

const twitch: SourceProvider = {
  id: 'twitch',
  name: 'Twitch',
  tokenLabel: 'Twitch',
  openLabel: 'Open on Twitch',
  matchesHost: host => ['twitch.tv', 'www.twitch.tv', 'm.twitch.tv', 'go.twitch.tv', 'clips.twitch.tv'].includes(host),
  parseTrack(url) {
    const segments = segmentsOf(url)
    const reject = no('Use a Twitch clip or past broadcast link — live channels are not supported')
    if (url.hostname === 'clips.twitch.tv') {
      const clip = segments.length === 1 && segments[0] === 'embed' ? url.searchParams.get('clip') : segments.length === 1 ? segments[0] : null
      return clip && SLUG.test(clip) ? ok(`https://clips.twitch.tv/${clip}`) : reject
    }
    if (segments.length === 2 && segments[0] === 'videos' && /^\d{1,15}$/.test(segments[1])) return ok(`https://www.twitch.tv/videos/${segments[1]}`)
    if (segments.length === 3 && segments[1] === 'v' && /^\d{1,15}$/.test(segments[2])) return ok(`https://www.twitch.tv/videos/${segments[2]}`)
    if (segments.length === 3 && segments[1] === 'clip' && /^\w{1,25}$/.test(segments[0]) && SLUG.test(segments[2])) return ok(`https://clips.twitch.tv/${segments[2]}`)
    return reject
  },
  supportsCollections: false,
  artwork: 'probe-thumbnail',
  describeError: standardErrors('Twitch', joined =>
    /subscriber|sub-only|subscribe/i.test(joined) ? 'This Twitch broadcast is for subscribers only.' : null)
}

// ------------------------------------------------------------------- TikTok

const tiktok: SourceProvider = {
  id: 'tiktok',
  name: 'TikTok',
  tokenLabel: 'TikTok',
  openLabel: 'Open on TikTok',
  matchesHost: host => ['tiktok.com', 'www.tiktok.com', 'm.tiktok.com', 'vm.tiktok.com', 'vt.tiktok.com'].includes(host),
  parseTrack(url) {
    const segments = segmentsOf(url)
    const host = url.hostname
    if ((host === 'vm.tiktok.com' || host === 'vt.tiktok.com') && segments.length === 1 && /^[A-Za-z0-9]{5,20}$/.test(segments[0])) {
      return ok(`https://${host}/${segments[0]}/`)
    }
    if (segments.length === 2 && segments[0] === 't' && /^[A-Za-z0-9]{5,20}$/.test(segments[1])) return ok(`https://www.tiktok.com/t/${segments[1]}/`)
    if (segments.length === 3 && /^@[\w.-]{1,64}$/.test(segments[0]) && segments[1] === 'video' && /^\d{5,25}$/.test(segments[2])) {
      return ok(`https://www.tiktok.com/${segments[0]}/video/${segments[2]}`)
    }
    return no('Use a TikTok video link — profiles, sounds and photo posts are not supported')
  },
  supportsCollections: false,
  artwork: 'probe-thumbnail',
  describeError: standardErrors('TikTok')
}

// ---------------------------------------------------------------- Instagram

const INSTAGRAM_KINDS: Record<string, string> = { p: 'p', reel: 'reel', reels: 'reel', tv: 'tv' }
const INSTAGRAM_CODE = /^[A-Za-z0-9_-]{5,40}$/

const instagram: SourceProvider = {
  id: 'instagram',
  name: 'Instagram',
  tokenLabel: 'Instagram',
  openLabel: 'Open on Instagram',
  matchesHost: host => host === 'instagram.com' || host === 'www.instagram.com',
  parseTrack(url) {
    const segments = segmentsOf(url)
    const [kind, code] = segments.length === 3 && /^[\w.]{1,30}$/.test(segments[0]) ? segments.slice(1) : segments.length === 2 ? segments : []
    const canonical = kind ? INSTAGRAM_KINDS[kind] : undefined
    if (!canonical || !code || !INSTAGRAM_CODE.test(code)) return no('Use a public Instagram reel or post link — profiles and stories are not supported')
    return ok(`https://www.instagram.com/${canonical}/${code}/`)
  },
  supportsCollections: false,
  artwork: 'probe-thumbnail',
  describeError: standardErrors('Instagram')
}

// ------------------------------------------------------------------- Reddit

const REDDIT_HOSTS = new Set(['reddit.com', 'www.reddit.com', 'old.reddit.com', 'new.reddit.com', 'np.reddit.com', 'm.reddit.com', 'redd.it', 'v.redd.it'])
const REDDIT_POST = /^[a-z0-9]{3,12}$/i
const REDDIT_NAME = /^[A-Za-z0-9_-]{2,30}$/

const reddit: SourceProvider = {
  id: 'reddit',
  name: 'Reddit',
  tokenLabel: 'Reddit',
  openLabel: 'Open on Reddit',
  matchesHost: host => REDDIT_HOSTS.has(host),
  parseTrack(url) {
    const segments = segmentsOf(url)
    const reject = no('Use a Reddit post link with a video — subreddits and profiles are not supported')
    if (url.hostname === 'v.redd.it') return segments.length === 1 && /^[a-z0-9]{5,20}$/i.test(segments[0]) ? ok(`https://v.redd.it/${segments[0]}`) : reject
    if (url.hostname === 'redd.it') return segments.length === 1 && REDDIT_POST.test(segments[0]) ? ok(`https://www.reddit.com/comments/${segments[0]}/`) : reject
    if (segments[0] === 'comments' && segments[1] && REDDIT_POST.test(segments[1])) return ok(`https://www.reddit.com/comments/${segments[1]}/`)
    const [scope, name, kind, id] = segments
    if ((scope === 'r' || scope === 'user' || scope === 'u') && name && REDDIT_NAME.test(name) && id) {
      const prefix = scope === 'r' ? 'r' : 'user'
      if (kind === 'comments' && REDDIT_POST.test(id)) return ok(`https://www.reddit.com/${prefix}/${name}/comments/${id}/`)
      if (kind === 's' && segments.length === 4 && /^[A-Za-z0-9]{5,20}$/.test(id)) return ok(`https://www.reddit.com/${prefix}/${name}/s/${id}`)
    }
    return reject
  },
  supportsCollections: false,
  artwork: 'probe-thumbnail',
  describeError: standardErrors('Reddit', joined =>
    /no (?:video|media)|not a video|no formats/i.test(joined) ? 'This Reddit post has no video or audio to download.' : null)
}

// --------------------------------------------------------------- Streamable

const streamable: SourceProvider = {
  id: 'streamable',
  name: 'Streamable',
  tokenLabel: 'Streamable',
  openLabel: 'Open on Streamable',
  matchesHost: host => host === 'streamable.com' || host === 'www.streamable.com',
  parseTrack(url) {
    const segments = segmentsOf(url)
    const code = segments.length === 1 ? segments[0] : segments.length === 2 && ['e', 'o', 's'].includes(segments[0]) ? segments[1] : null
    if (!code || !/^[a-z0-9]{3,12}$/i.test(code)) return no('Use a Streamable video link')
    return ok(`https://streamable.com/${code}`)
  },
  supportsCollections: false,
  artwork: 'probe-thumbnail',
  describeError: standardErrors('Streamable')
}

// ---------------------------------------------------------------- X/Twitter

const TWITTER_HOSTS = new Set(['twitter.com', 'www.twitter.com', 'mobile.twitter.com', 'm.twitter.com', 'x.com', 'www.x.com', 'mobile.x.com'])

const twitter: SourceProvider = {
  id: 'twitter',
  name: 'X',
  tokenLabel: 'X',
  openLabel: 'Open on X',
  matchesHost: host => TWITTER_HOSTS.has(host),
  parseTrack(url) {
    const segments = segmentsOf(url)
    let user: string | null = null
    let id: string | null = null
    if (segments[0] === 'i' && segments[1] === 'web' && segments[2] === 'status') { user = 'i'; id = segments[3] ?? null }
    else if (segments[1] === 'status' || segments[1] === 'statuses') { user = segments[0]; id = segments[2] ?? null }
    if (!user || !id || !/^\w{1,15}$/.test(user) || !/^\d{5,25}$/.test(id)) return no('Use an X (Twitter) post link with a video — profiles and spaces are not supported')
    return ok(`https://x.com/${user}/status/${id}`)
  },
  supportsCollections: false,
  artwork: 'probe-thumbnail',
  describeError: standardErrors('X', joined =>
    /no video|does not contain|no media/i.test(joined) ? 'This X post has no video to download.' : null)
}

// -------------------------------------------------------------- Archive.org

const ARCHIVE_ID = /^[A-Za-z0-9._-]{1,100}$/

const archive: SourceProvider = {
  id: 'archive',
  name: 'Internet Archive',
  tokenLabel: 'Archive',
  openLabel: 'Open on Internet Archive',
  matchesHost: host => host === 'archive.org' || host === 'www.archive.org',
  parseTrack(url) {
    const segments = segmentsOf(url)
    const [kind, identifier, ...file] = segments
    if (!identifier || !ARCHIVE_ID.test(identifier) || file.some(part => part === '..' || part === '.')) {
      return no('Use an Internet Archive item or file link')
    }
    if (kind === 'details' || kind === 'embed') return ok(`https://archive.org/details/${[identifier, ...file].join('/')}`)
    if (kind === 'download' && file.length) return ok(`https://archive.org/download/${[identifier, ...file].join('/')}`)
    return no('Use an Internet Archive item or file link')
  },
  supportsCollections: false,
  artwork: 'probe-thumbnail',
  describeError: standardErrors('the Internet Archive', joined =>
    /dark|restricted|lending|borrow/i.test(joined) ? 'This Internet Archive item is restricted or only available to borrow.' : null)
}

// ------------------------------------------------------- Direct media files

const DIRECT_MEDIA = /\.(?:mp3|wav|flac|m4a|aac|ogg|opus|mp4|webm)$/i

/**
 * Hosts yt-dlp may be pointed at for direct files and generic pages. Local and
 * private-network addresses are refused: a pasted link must never become a
 * request against the user's own machine or LAN.
 */
export function isPublicHost(host: string): boolean {
  const name = host.toLowerCase().replace(/\.$/, '')
  if (!name.includes('.') || name.startsWith('[')) return false
  if (/(?:^|\.)(?:localhost|local|internal|lan|home|arpa|invalid|test|example)$/.test(name)) return false
  const ipv4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(name)
  if (ipv4) {
    const [a, b] = [Number(ipv4[1]), Number(ipv4[2])]
    if (a === 0 || a === 10 || a === 127 || a >= 224) return false
    if ((a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127)) return false
  }
  return true
}

const withoutHash = (url: URL): string => `${url.origin}${url.pathname}${url.search}`

const direct: SourceProvider = {
  id: 'direct',
  name: 'Direct link',
  tokenLabel: 'Web',
  openLabel: 'Open source link',
  matchesHost: (host, url) => isPublicHost(host) && DIRECT_MEDIA.test(url.pathname),
  parseTrack: url => ok(withoutHash(url)),
  supportsCollections: false,
  artwork: 'probe-thumbnail',
  describeError: standardErrors('the file host', joined =>
    /unsupported url/i.test(joined) ? 'This file link could not be read. Check that it still downloads in a browser.' : null)
}

// ---------------------------------------------------------- Generic pages

const generic: SourceProvider = {
  id: 'generic',
  name: 'Other site',
  tokenLabel: 'Web',
  openLabel: 'Open source link',
  matchesHost: host => isPublicHost(host),
  parseTrack: url => ok(withoutHash(url)),
  supportsCollections: false,
  artwork: 'probe-thumbnail',
  describeError: standardErrors('this site', joined =>
    /unsupported url/i.test(joined) ? 'yt-dlp found no playable media on this page.' : null)
}

// ----------------------------------------------------------------- registry

/** Named providers, matched by host in this order. */
export const PROVIDERS: readonly SourceProvider[] = [
  youtube, soundcloud, bandcamp, vimeo, mixcloud, audiomack, dailymotion, twitch, tiktok, instagram, reddit, streamable, twitter, archive
]

/** Every provider, including the direct-file and opt-in generic fallbacks. */
export const ALL_PROVIDERS: readonly SourceProvider[] = [...PROVIDERS, direct, generic]

export const PROVIDER_IDS: readonly ProviderId[] = ALL_PROVIDERS.map(provider => provider.id)

const BY_ID = new Map<string, SourceProvider>(ALL_PROVIDERS.map(provider => [provider.id, provider]))

export function isProviderId(value: unknown): value is ProviderId {
  return typeof value === 'string' && BY_ID.has(value)
}

export function providerById(id: ProviderId): SourceProvider
export function providerById(id: string | null | undefined): SourceProvider | null
export function providerById(id: string | null | undefined): SourceProvider | null {
  return id ? BY_ID.get(id) ?? null : null
}

export interface ProviderOptions {
  /** Accept any public https page through yt-dlp's generic extractor. Off by default. */
  allowOtherSites?: boolean
}

/**
 * The provider responsible for a URL. A known host never falls through to the
 * generic extractor, so a malformed YouTube link is rejected as YouTube.
 */
export function providerForUrl(url: URL, options: ProviderOptions = {}): SourceProvider | null {
  const host = url.hostname.toLowerCase()
  for (const provider of PROVIDERS) if (provider.matchesHost(host, url)) return provider
  if (direct.matchesHost(host, url)) return direct
  if (options.allowOtherSites && generic.matchesHost(host, url)) return generic
  return null
}

/** Display name for a stored source kind, including local and unknown records. */
export function sourceKindName(kind: string): string {
  if (kind === 'local') return 'Local'
  return providerById(kind)?.name ?? 'Unknown'
}

/** Turns yt-dlp's noisy stderr into one actionable sentence for a provider. */
export function describeProviderError(stderr: string, provider: string | null = 'youtube'): string {
  const lines = stderr
    .split(/\r?\n/)
    .map((line) => line.replace(/^ERROR:\s*/i, '').trim())
    .filter((line) => line.length > 0 && !line.startsWith('WARNING'))
  if (lines.length === 0) return 'yt-dlp could not read this link.'
  // The guarded proxy for direct and other-site links refuses private addresses.
  if (lines.some(line => /Tunnel connection failed: 403/.test(line))) {
    return 'This link, or a page it leads to, points to a local or private network address, which Sonic does not download from.'
  }
  // Extractor breakage after a site change: yt-dlp itself asks to be updated.
  if (lines.some(line => /unable to extract|nsig extraction failed|signature extraction failed|latest version|yt-dlp -U|--update/i.test(line))) {
    return 'yt-dlp could not read this page, usually because it is out of date. Use Settings → Media engine → Set up / update engine, then retry.'
  }
  return (providerById(provider) ?? youtube).describeError(lines)
}

/**
 * Cover art for a probed link. YouTube keeps its i.ytimg.com artwork; every
 * other provider uses the https thumbnail yt-dlp reported.
 */
export function artworkFor(provider: string | null | undefined, videoId: string | null, reported: string | null | undefined): string | null {
  const strategy = providerById(provider)?.artwork
  let reportedUrl: URL | null = null
  try { reportedUrl = reported ? new URL(reported) : null } catch { reportedUrl = null }
  const https = reportedUrl?.protocol === 'https:' && !reportedUrl.username && !reportedUrl.password && !reportedUrl.port &&
    isPublicHost(reportedUrl.hostname) ? reportedUrl.href : null
  if (strategy === 'youtube-thumbnail') {
    if (https && reportedUrl!.hostname === 'i.ytimg.com') return https
    return videoId && VIDEO_ID.test(videoId) ? `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg` : null
  }
  return https
}
