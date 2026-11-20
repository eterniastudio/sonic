import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { open, readdir, rename, stat } from 'node:fs/promises'
import { downloadToFile } from '../lib/net'
import { ensureDir, removeFile } from '../lib/fsx'
import { coverCacheDir } from './paths'

const PARTIAL = '.part'
/** A partial file this old belongs to no live download (downloads stall out far sooner). */
const STALE_PARTIAL_MS = 60 * 60_000
/** Embedded art is cosmetic. Anything larger is discarded instead of filling the disk. */
const MAX_COVER_BYTES = 8 * 1024 * 1024
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
const PNG_ENDING = Buffer.from([0x49, 0x45, 0x4e, 0x44, 0xae, 0x42, 0x60, 0x82])

/**
 * A complete JPEG, PNG, GIF or WebP. Other payloads (an HTML error page, a
 * truncated image) are not embedded: ffmpeg would fail the whole export.
 */
function isCompleteImage(head: Buffer, tail: Buffer, size: number): boolean {
  if (head.length >= 2 && head[0] === 0xff && head[1] === 0xd8) {
    return tail.length >= 2 && tail[tail.length - 2] === 0xff && tail[tail.length - 1] === 0xd9
  }
  if (head.length >= 8 && head.subarray(0, 8).equals(PNG_SIGNATURE)) {
    return tail.length >= 8 && tail.subarray(tail.length - 8).equals(PNG_ENDING)
  }
  if (head.length >= 6) {
    const gif = head.subarray(0, 6).toString('ascii')
    if (gif === 'GIF87a' || gif === 'GIF89a') return tail.length > 0 && tail[tail.length - 1] === 0x3b
  }
  if (head.length >= 12 && head.subarray(0, 4).toString('ascii') === 'RIFF' && head.subarray(8, 12).toString('ascii') === 'WEBP') {
    return head.readUInt32LE(4) === size - 8
  }
  return false
}

/** A cached cover is reusable only when it is a complete image within the size cap. */
async function usableCover(file: string): Promise<boolean> {
  let handle
  try {
    handle = await open(file, 'r')
    const { size } = await handle.stat()
    if (size < 4 || size > MAX_COVER_BYTES) return false
    const headLen = Math.min(12, size)
    const tailLen = Math.min(8, size)
    const head = Buffer.alloc(headLen)
    const tail = Buffer.alloc(tailLen)
    await handle.read(head, 0, headLen, 0)
    await handle.read(tail, 0, tailLen, size - tailLen)
    return isCompleteImage(head, tail, size)
  } catch {
    return false
  } finally { await handle?.close() }
}

/** Cover art is only ever fetched over https, with no credentials or custom port. */
function isFetchableCover(url: string): boolean {
  try {
    const parsed = new URL(url)
    return parsed.protocol === 'https:' && !parsed.username && !parsed.password && !parsed.port
  } catch { return false }
}

/**
 * Downloads a provider thumbnail for use as embedded cover art.
 *
 * The URL is the job's probed thumbnail: i.ytimg.com artwork for YouTube, and
 * the thumbnail yt-dlp reported for every other provider (already filtered to
 * public https hosts by `artworkFor` at probe time).
 *
 * Failures are non-fatal by design: cover art is cosmetic, and a missing image
 * must never block an export. The image is written to a private partial file
 * and renamed into place, so an interrupted download is never reused.
 */
export async function fetchCover(
  url: string | null,
  key: string,
  signal?: AbortSignal
): Promise<string | null> {
  if (!url || !isFetchableCover(url)) return null

  const directory = coverCacheDir()
  await ensureDir(directory)
  const target = path.join(directory, `${key}.jpg`)

  if (await usableCover(target)) return target

  const partial = path.join(directory, `${key}.${process.pid}.${randomUUID()}.jpg${PARTIAL}`)
  try {
    await downloadToFile(url, partial, { signal, idleTimeoutMs: 20_000, publicOnly: true, maxBytes: MAX_COVER_BYTES })
    if (!(await usableCover(partial))) throw new Error('Incomplete cover image.')
    await rename(partial, target)
    return target
  } catch {
    await removeFile(partial)
    return null
  }
}

export async function forgetCover(key: string): Promise<void> {
  await removeFile(path.join(coverCacheDir(), `${key}.jpg`))
}

/**
 * Removes cached covers whose job is gone, plus abandoned partial downloads.
 * `liveKeys` are the ids of every job still in the queue. Returns the number removed.
 */
export async function pruneCovers(liveKeys: Iterable<string>, now = Date.now()): Promise<number> {
  const keep = new Set(liveKeys)
  let entries: string[]
  try { entries = await readdir(coverCacheDir()) } catch { return 0 }
  let removed = 0
  for (const name of entries) {
    const file = path.join(coverCacheDir(), name)
    if (name.endsWith(PARTIAL)) {
      // A partial may belong to a download in flight; only an old one is abandoned.
      const info = await stat(file).catch(() => null)
      if (!info || now - info.mtimeMs < STALE_PARTIAL_MS) continue
    } else if (!name.endsWith('.jpg') || keep.has(name.slice(0, -'.jpg'.length))) continue
    await removeFile(file)
    removed++
  }
  return removed
}
