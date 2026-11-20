import { readdir, unlink } from 'node:fs/promises'
import path from 'node:path'
import { run } from '../lib/child'
import { ensureDir, fileSize, removeFile, moveFile } from '../lib/fsx'
import { engineService } from './engine'
import { baseYtDlpArgs, summariseYtDlpError } from './probe'
import { stagingDir } from './paths'
import { settingsService } from './settings'
import { isSoundCloudShareUrl, parseVideoUrl } from '@shared/url'
import { assertPublicUrl, guardedYtDlpArgs } from '../lib/publicAddress'

export interface AcquireProgress {
  percent: number | null
  downloadedBytes: number
  totalBytes: number | null
  speed: string | null
  eta: string | null
}

export interface AcquireResult {
  filePath: string
  extension: string
  /** True when the same video was already present and was reused. */
  reused: boolean
}

/** Marks each machine-readable progress line so it can be told apart from logs. */
const PROGRESS_PREFIX = 'SONIC_PROGRESS'

function numeric(value: string): number | null {
  if (!value || value === 'NA' || value === 'None') return null
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : null
}

function humanSpeed(bytesPerSecond: number | null): string | null {
  if (bytesPerSecond == null || bytesPerSecond <= 0) return null
  const units = ['B/s', 'KB/s', 'MB/s', 'GB/s']
  let value = bytesPerSecond
  let unit = 0
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024
    unit += 1
  }
  return `${value >= 100 ? value.toFixed(0) : value.toFixed(1)} ${units[unit]}`
}

function humanEta(seconds: number | null): string | null {
  if (seconds == null || seconds < 0) return null
  const whole = Math.round(seconds)
  if (whole < 60) return `${whole}s`
  const minutes = Math.floor(whole / 60)
  const rest = whole % 60
  return `${minutes}m ${rest.toString().padStart(2, '0')}s`
}

/**
 * Downloads the best audio stream for one job into the private staging area.
 *
 * The output template is keyed by job id, so concurrent workers can never
 * collide, and the resulting file is discovered by prefix rather than by
 * parsing yt-dlp's own output.
 */
export async function acquireAudio(
  jobId: string,
  url: string,
  options: {
    signal: AbortSignal
    onProgress: (progress: AcquireProgress) => void
    onLog?: (line: string) => void
  }
): Promise<AcquireResult> {
  options.signal.throwIfAborted()
  // The same gate as intake: a link from outside the registry needs "Allow other sites".
  const parsed = parseVideoUrl(url, { allowOtherSites: settingsService?.get()?.allowOtherSites === true })
  if (!parsed.ok || !parsed.normalized || isSoundCloudShareUrl(parsed.normalized)) {
    throw new Error(parsed.reason ?? 'Inspect the SoundCloud share link before downloading.')
  }
  if (parsed.provider === 'direct' || parsed.provider === 'generic') await assertPublicUrl(parsed.normalized, options.signal)
  const ytdlp = await engineService.resolve('yt-dlp', false, options.signal)
  options.signal.throwIfAborted()
  if (!ytdlp.path) {
    throw new Error('yt-dlp is not installed. Run media engine setup from Settings.')
  }

  // A crashed attempt leaves a finished-looking file behind, and the file picker
  // keeps the largest match. Remove that attempt before this one writes anything.
  await cleanStaging(jobId, true)
  options.signal.throwIfAborted()

  const staging = stagingDir()
  await ensureDir(staging)

  const outputTemplate = path.join(staging, `${jobId}.%(ext)s`)
  const args = [
    ...(await baseYtDlpArgs(options.signal)),
    ...(await guardedYtDlpArgs(parsed.provider)),
    '--newline',
    '--progress',
    '--progress-template',
    `download:${PROGRESS_PREFIX} %(progress.downloaded_bytes)s %(progress.total_bytes)s %(progress.total_bytes_estimate)s %(progress.speed)s %(progress.eta)s`,
    '--retries',
    '3',
    '--fragment-retries',
    '3',
    '--socket-timeout',
    '30',
    '-f',
    'bestaudio/best',
    '-o',
    outputTemplate,
    parsed.normalized
  ]

  const settings = settingsService.get()
  options.signal.throwIfAborted()

  const result = await run(ytdlp.path, args, {
    signal: options.signal,
    onStdoutLine: (line) => {
      if (!line.startsWith(PROGRESS_PREFIX)) {
        options.onLog?.(line)
        return
      }
      const [, downloadedRaw, totalRaw, estimateRaw, speedRaw, etaRaw] = line.split(/\s+/)
      const downloadedBytes = numeric(downloadedRaw) ?? 0
      const totalBytes = numeric(totalRaw) ?? numeric(estimateRaw)
      const speed = numeric(speedRaw)
      const eta = numeric(etaRaw)

      options.onProgress({
        downloadedBytes,
        totalBytes,
        percent: totalBytes && totalBytes > 0 ? Math.min(1, downloadedBytes / totalBytes) : null,
        speed: humanSpeed(speed),
        eta: humanEta(eta)
      })
    },
    onStderrLine: (line) => options.onLog?.(line)
  })

  if (result.aborted) {
    await cleanStaging(jobId)
    throw new Error('Cancelled')
  }

  const staged = await findStagedFile(jobId)
  if (result.code !== 0 || !staged) {
    await cleanStaging(jobId)
    throw new Error(summariseYtDlpError(result.stderr, parsed.provider))
  }

  const info = path.parse(staged)
  const sizeBytes = await fileSize(staged)

  // A configured ceiling keeps an accidental hour-long upload from filling disk.
  const maxBytes = settings.maxDurationSec > 0 ? settings.maxDurationSec * 1024 * 1024 * 2 : 0
  if (maxBytes > 0 && sizeBytes > maxBytes) {
    await cleanStaging(jobId)
    throw new Error('The downloaded audio exceeded the configured size ceiling.')
  }

  options.onProgress({
    downloadedBytes: sizeBytes,
    totalBytes: sizeBytes,
    percent: 1,
    speed: null,
    eta: null
  })

  return {
    filePath: staged,
    extension: info.ext.replace(/^\./, '').toLowerCase(),
    reused: false
  }
}

/** yt-dlp partials and fragments, and Sonic's own conversion output, are never source media. */
export function isStagingScratch(entry: string, jobId: string): boolean {
  const rest = entry.slice(jobId.length + 1).toLowerCase()
  if (rest.startsWith('out.')) return true
  if (/(^|\.)(part|ytdl|temp|tmp)$/.test(rest) || /(^|\.)(part-frag|frag)\d+/.test(rest) || /(^|\.)temp\./.test(rest)) return true
  // Intermediate per-format files look like `<id>.f137.mp4`.
  return /(^|\.)f\d+\./.test(rest)
}

/** Locates the finished media file for a job, ignoring yt-dlp's scratch files. */
export async function findStagedFile(jobId: string): Promise<string | null> {
  const staging = stagingDir()
  let entries: string[]
  try {
    entries = await readdir(staging)
  } catch {
    return null
  }

  const candidates = entries.filter((entry) => entry.startsWith(`${jobId}.`) && !isStagingScratch(entry, jobId))
  if (candidates.length === 0) return null
  // One finished download is expected; prefer the largest if a stray remains.
  const sized = await Promise.all(candidates.map(async (entry) => ({ entry, size: await fileSize(path.join(staging, entry)) })))
  sized.sort((a, b) => b.size - a.size || a.entry.localeCompare(b.entry))
  return path.join(staging, sized[0].entry)
}

/**
 * Removes crash leftovers: every artefact of a job that no longer exists, and
 * partial conversion output of a job that is not running. Shared areas
 * (engine downloads, re-export folders) are left alone.
 */
export async function sweepStaging(known: (jobId: string) => boolean, running: (jobId: string) => boolean): Promise<void> {
  let entries: string[]
  try { entries = await readdir(stagingDir()) } catch { return }
  for (const entry of entries) {
    const id = /^(job_[0-9a-f]+)\./.exec(entry)?.[1]
    if (!id || running(id)) continue
    if (!known(id) || entry.slice(id.length + 1).startsWith('out.')) await removeFile(path.join(stagingDir(), entry))
  }
}

/** Removes every staging artefact belonging to a job. */
export async function cleanStaging(jobId: string, strict = false): Promise<void> {
  const staging = stagingDir()
  let entries: string[]
  try {
    entries = await readdir(staging)
  } catch {
    return
  }
  for (const entry of entries) {
    if (entry.startsWith(`${jobId}.`)) {
      if (strict) {
        try { await unlink(path.join(staging, entry)) } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
      } else await removeFile(path.join(staging, entry))
    }
  }
}

/** Moves an intermediate artefact to a stable path inside staging. */
export async function renameInStaging(source: string, jobId: string, suffix: string): Promise<string> {
  const target = path.join(stagingDir(), `${jobId}${suffix}`)
  await moveFile(source, target)
  return target
}
