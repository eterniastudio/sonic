import { createWriteStream } from 'node:fs'
import { Readable, Transform } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { ensureDir, removeFile } from './fsx'
import path from 'node:path'
import { request as httpsRequest } from 'node:https'
import type { IncomingMessage } from 'node:http'
import { publicLookup, refuseLiteral } from './publicAddress'

export interface DownloadOptions {
  signal?: AbortSignal
  headers?: Record<string, string>
  onProgress?: (receivedBytes: number, totalBytes: number | null) => void
  /** Give up if no bytes arrive for this long. */
  idleTimeoutMs?: number
  /** Refuse the request, and every redirect hop, unless the host resolves to public addresses. */
  publicOnly?: boolean
  /** Stop, and delete a partial file, once this many bytes have arrived. */
  maxBytes?: number
}

const MAX_REDIRECTS = 5

/**
 * Follows redirects by hand over https, checking each hop where the socket
 * connects: `publicLookup` refuses private addresses during resolution, so the
 * address checked is the address used.
 */
async function fetchPublic(url: string, init: RequestInit): Promise<Response> {
  let current = url
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    const target = new URL(current)
    if (target.protocol !== 'https:') throw new Error('Refused a non-https link.')
    if (target.username || target.password || target.port) throw new Error('Refused a link with credentials or a custom port.')
    refuseLiteral(target.hostname)
    const response = await new Promise<IncomingMessage>((resolve, reject) => {
      const request = httpsRequest(target, {
        method: 'GET',
        headers: init.headers as Record<string, string>,
        signal: init.signal ?? undefined,
        lookup: publicLookup
      }, resolve)
      request.on('error', reject)
      request.end()
    })
    const status = response.statusCode ?? 502
    const location = response.headers.location
    if (status >= 300 && status < 400 && location) {
      response.on('error', () => response.destroy())
      response.resume()
      current = new URL(location, current).href
      continue
    }
    const headers = new Headers()
    for (const [name, value] of Object.entries(response.headers)) {
      if (value != null) headers.set(name, Array.isArray(value) ? value.join(', ') : value)
    }
    const body = status === 204 || status === 304 ? null : Readable.toWeb(response) as ReadableStream<Uint8Array>
    return new Response(body, { status, statusText: response.statusMessage, headers })
  }
  throw new Error('Too many redirects.')
}

const DEFAULT_IDLE_TIMEOUT = 45_000

/**
 * Streams an HTTP(S) resource to disk with progress reporting.
 *
 * Uses the platform fetch so redirects, TLS and proxy settings behave the same
 * as the rest of Electron's networking.
 */
export async function downloadToFile(
  url: string,
  destination: string,
  options: DownloadOptions = {}
): Promise<void> {
  options.signal?.throwIfAborted()
  await ensureDir(path.dirname(destination))
  options.signal?.throwIfAborted()

  const controller = new AbortController()
  const onOuterAbort = (): void => controller.abort(options.signal?.reason)
  options.signal?.addEventListener('abort', onOuterAbort, { once: true })
  if (options.signal?.aborted) onOuterAbort()

  let idleTimer: NodeJS.Timeout | null = null
  let stalled = false
  let destinationOpened = false
  const idleTimeout = options.idleTimeoutMs ?? DEFAULT_IDLE_TIMEOUT
  const resetIdle = (): void => {
    if (idleTimer) clearTimeout(idleTimer)
    idleTimer = setTimeout(() => { stalled = true; controller.abort() }, idleTimeout)
  }

  try {
    resetIdle()
    const response = await (options.publicOnly ? fetchPublic : fetch)(url, {
      redirect: 'follow',
      signal: controller.signal,
      headers: {
        'user-agent': 'Sonic (+https://github.com/eterniastudio/sonic)',
        accept: '*/*',
        ...options.headers
      }
    })

    if (!response.ok) {
      await response.body?.cancel().catch(() => undefined)
      throw new Error(`${response.status} ${response.statusText} for ${url}`)
    }
    if (!response.body) {
      throw new Error(`Empty response body for ${url}`)
    }

    const declaredLength = Number(response.headers.get('content-length'))
    const totalBytes = Number.isFinite(declaredLength) && declaredLength > 0 ? declaredLength : null
    if (options.maxBytes != null && totalBytes != null && totalBytes > options.maxBytes) {
      await response.body.cancel().catch(() => undefined)
      throw new Error(`Download is larger than the ${options.maxBytes} byte limit.`)
    }

    const file = createWriteStream(destination)
    file.once('open', () => { destinationOpened = true })
    const source = Readable.fromWeb(response.body as import('node:stream/web').ReadableStream<Uint8Array>)
    let received = 0
    let lastReport = 0
    const progress = new Transform({
      transform(chunk: Buffer, _encoding, callback) {
        try {
          resetIdle()
          received += chunk.byteLength
          if (options.maxBytes != null && received > options.maxBytes) {
            callback(new Error(`Download is larger than the ${options.maxBytes} byte limit.`))
            return
          }
          // Throttle UI updates to roughly 20/s.
          const now = Date.now()
          if (options.onProgress && now - lastReport > 50) {
            lastReport = now
            options.onProgress(received, totalBytes)
          }
          callback(null, chunk)
        } catch (error) {
          callback(error instanceof Error ? error : new Error(String(error)))
        }
      }
    })
    // Own both streams until they close. A failed socket or disk write must not
    // leave a Windows file handle open when partial-download cleanup begins.
    await pipeline(source, progress, file, { signal: controller.signal })
    options.onProgress?.(received, totalBytes ?? received)
  } catch (error) {
    if (destinationOpened) await removeQuietly(destination)
    if (stalled && !options.signal?.aborted) {
      throw new Error('Download stalled and was cancelled')
    }
    throw error
  } finally {
    if (idleTimer) clearTimeout(idleTimer)
    options.signal?.removeEventListener('abort', onOuterAbort)
  }
}

/** Fetches a small text resource, e.g. a checksum manifest. */
export async function fetchText(url: string, signal?: AbortSignal): Promise<string> {
  const response = await fetch(url, {
    redirect: 'follow',
    signal,
    headers: { 'user-agent': 'Sonic', accept: 'text/plain,*/*' }
  })
  if (!response.ok) {
    await response.body?.cancel().catch(() => undefined)
    throw new Error(`${response.status} ${response.statusText} for ${url}`)
  }
  return response.text()
}

async function removeQuietly(target: string): Promise<void> {
  await removeFile(target)
}
