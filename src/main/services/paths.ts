import { app } from 'electron'
import { existsSync } from 'node:fs'
import path from 'node:path'

/** Root for all Sonic state. Nothing is written outside this plus the export folder. */
export function userDataDir(): string {
  return app.getPath('userData')
}

/** Private staging area for in-flight downloads and conversions. */
export function stagingDir(): string {
  return path.join(userDataDir(), 'staging')
}

/** Where the managed yt-dlp / ffmpeg binaries live. */
export function engineDir(): string {
  return path.join(userDataDir(), 'engine')
}

export function settingsFile(): string {
  return path.join(userDataDir(), 'settings.json')
}

export function libraryFile(): string {
  return path.join(userDataDir(), 'library.json')
}

export function organizationFile(): string {
  return path.join(userDataDir(), 'organization.json')
}

export function playbackSessionFile(): string {
  return path.join(userDataDir(), 'playback-session.json')
}

export function queueFile(): string {
  return path.join(userDataDir(), 'queue.json')
}

export function coverCacheDir(): string {
  return path.join(userDataDir(), 'covers')
}

/** Scratch space for raw PCM decoded for analysis. */
export function analysisDir(): string {
  return path.join(userDataDir(), 'analysis')
}

/** Persistent cache of completed analyses, keyed by input identity. */
export function analysisCacheFile(): string {
  return path.join(userDataDir(), 'analysis-cache.json')
}

/**
 * Default export destination: the user's Music folder. Before the rename to
 * Sonic it was `Music\Sonic V2`; an existing folder of that name stays the default.
 */
export function defaultDownloadDir(): string {
  try {
    const music = app.getPath('music')
    const current = path.join(music, 'Sonic')
    const legacy = path.join(music, 'Sonic V2')
    return !existsSync(current) && existsSync(legacy) ? legacy : current
  } catch {
    return path.join(userDataDir(), 'exports')
  }
}

export function logsDir(): string {
  return path.join(userDataDir(), 'logs')
}
