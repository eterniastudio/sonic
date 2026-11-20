import { EventEmitter } from 'node:events'
import { chmodSync, existsSync, readdirSync, statSync } from 'node:fs'
import path from 'node:path'
import type { EngineComponent, EngineProgress, EngineStatus } from '@shared/domain'
import { downloadToFile, fetchText } from '../lib/net'
import { run } from '../lib/child'
import { ensureDir, removeDir, removeFile, sha256File, moveFile } from '../lib/fsx'
import { engineDir, stagingDir } from './paths'
import { settingsService } from './settings'

export type ToolName = 'yt-dlp' | 'ffmpeg' | 'ffprobe'

const IS_WINDOWS = process.platform === 'win32'

const TOOL_BINARY: Record<ToolName, string> = {
  'yt-dlp': IS_WINDOWS ? 'yt-dlp.exe' : 'yt-dlp',
  ffmpeg: IS_WINDOWS ? 'ffmpeg.exe' : 'ffmpeg',
  ffprobe: IS_WINDOWS ? 'ffprobe.exe' : 'ffprobe'
}

const YTDLP_RELEASE_BASE = 'https://github.com/yt-dlp/yt-dlp/releases/latest/download'
const FFMPEG_RELEASE_BASE = 'https://github.com/BtbN/FFmpeg-Builds/releases/download/latest'
const FFMPEG_ZIP_NAME = 'ffmpeg-master-latest-win64-gpl.zip'
const FFMPEG_ZIP_URL = `${FFMPEG_RELEASE_BASE}/${FFMPEG_ZIP_NAME}`
/** BtbN publishes one SHA-256 manifest per release, covering every archive. */
const FFMPEG_CHECKSUMS_URL = `${FFMPEG_RELEASE_BASE}/checksums.sha256`

export interface ResolvedTool {
  name: ToolName
  path: string | null
  version: string | null
  origin: 'managed' | 'system' | null
}

/**
 * Scans PATH for an executable. On Windows only `.exe` counts: Node refuses to
 * spawn `.bat`/`.cmd` shims without a shell, so a shim would look available
 * and then fail on every run.
 */
function which(binary: string): string | null {
  const pathValue = process.env.PATH ?? process.env.Path ?? ''
  if (pathValue.length === 0) return null

  const hasExtension = path.extname(binary).length > 0
  const extensions = hasExtension
    ? ['']
    : IS_WINDOWS
      ? ['.exe']
      : ['']

  for (const directory of pathValue.split(path.delimiter)) {
    if (!directory) continue
    for (const extension of extensions) {
      const candidate = path.join(directory, hasExtension ? binary : binary + extension.toLowerCase())
      try {
        if (statSync(candidate).isFile()) return candidate
      } catch {
        // Keep looking.
      }
    }
  }
  return null
}

/** Reads a tool's self-reported version without blocking the main process. */
async function probeVersion(binary: string, signal?: AbortSignal): Promise<string | null> {
  const args = binary.toLowerCase().includes('yt-dlp') ? ['--version'] : ['-version']
  try {
    const result = await run(binary, args, { signal, timeoutMs: 12_000, maxCaptureBytes: 4096 })
    if (result.aborted || result.timedOut || result.code !== 0) return null
    const firstLine = result.stdout.split(/\r?\n/)[0]?.trim() ?? ''
    if (firstLine.length === 0) return null
    // `ffmpeg version 8.0-essentials_build ...` → `8.0-essentials_build`
    const versioned = /\bversion\s+(\S+)/i.exec(firstLine)
    return versioned ? versioned[1] : firstLine.slice(0, 60)
  } catch {
    return null
  }
}

/** yt-dlp releases often to keep up with site changes; repair refreshes a managed copy older than this. */
const YTDLP_REFRESH_AGE_MS = 7 * 24 * 60 * 60_000

/** yt-dlp versions are release dates: `2026.10.22`, or `2026.10.22.123456` for nightlies. */
export function ytDlpReleaseDate(version: string | null): Date | null {
  const match = /^(\d{4})\.(\d{1,2})\.(\d{1,2})/.exec(version ?? '')
  if (!match) return null
  const date = new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])))
  return Number.isNaN(date.getTime()) ? null : date
}

/** True for a Sonic-managed yt-dlp old enough that a repair should replace it. */
export function ytDlpNeedsRefresh(tool: Pick<ResolvedTool, 'path' | 'version' | 'origin'>, now = Date.now()): boolean {
  if (!tool.path || tool.origin !== 'managed') return false
  const released = ytDlpReleaseDate(tool.version)
  return released == null || now - released.getTime() > YTDLP_REFRESH_AGE_MS
}

/** A resolved tool is reused this long; `invalidate()` and setup clear it sooner. */
const RESOLVE_TTL_MS = 5 * 60_000
const STATUS_TTL_MS = 20_000

class EngineService extends EventEmitter {
  private cached: { status: EngineStatus; at: number } | null = null
  /** Keyed by the explicit setting it was resolved under, so a changed path is never served stale. */
  private readonly resolved = new Map<ToolName, { tool: ResolvedTool; explicit: string | null; at: number }>()
  private generation = 0
  private setupPromise: Promise<EngineStatus> | null = null
  private setupController: AbortController | null = null
  private setupError: string | null = null
  private stopped = false

  get directory(): string {
    return engineDir()
  }

  private explicitPath(name: ToolName): string | null {
    const settings = settingsService.get()
    if (name === 'yt-dlp') return settings.ytdlpPath
    if (name === 'ffmpeg') return settings.ffmpegPath
    return settings.ffprobePath
  }

  async resolve(name: ToolName, force = false, signal?: AbortSignal): Promise<ResolvedTool> {
    const explicit = this.explicitPath(name)
    if (!force) {
      // Jobs resolve tools several times each; spawning `--version` every time
      // is wasted work. A cached path must still exist and match the setting.
      const hit = this.resolved.get(name)
      if (hit?.tool.path && hit.explicit === explicit && Date.now() - hit.at < RESOLVE_TTL_MS && existsSync(hit.tool.path)) {
        return { ...hit.tool }
      }
    }
    const generation = this.generation
    const tool = await this.locate(name, explicit, signal)
    // An invalidation during the probe means the answer may already be stale; a
    // failed probe is retried next time rather than remembered.
    if (generation === this.generation && tool.path && tool.version) this.resolved.set(name, { tool: { ...tool }, explicit, at: Date.now() })
    return tool
  }

  private async locate(name: ToolName, explicit: string | null, signal?: AbortSignal): Promise<ResolvedTool> {
    if (explicit && existsSync(explicit)) {
      return { name, path: explicit, version: await probeVersion(explicit, signal), origin: 'system' }
    }

    const managed = path.join(engineDir(), TOOL_BINARY[name])
    if (existsSync(managed)) {
      return { name, path: managed, version: await probeVersion(managed, signal), origin: 'managed' }
    }

    const system = which(TOOL_BINARY[name])
    if (system) {
      return { name, path: system, version: await probeVersion(system, signal), origin: 'system' }
    }

    return { name, path: null, version: null, origin: null }
  }

  async status(force = false, signal?: AbortSignal): Promise<EngineStatus> {
    signal?.throwIfAborted()
    if (!force && this.cached && Date.now() - this.cached.at < STATUS_TTL_MS && this.setupPromise == null) {
      return this.cached.status
    }

    const [ytdlp, ffmpeg, ffprobe] = await Promise.all([
      this.resolve('yt-dlp', true, signal),
      this.resolve('ffmpeg', true, signal),
      this.resolve('ffprobe', true, signal)
    ])
    signal?.throwIfAborted()

    const components: EngineComponent[] = [ytdlp, ffmpeg, ffprobe].map((tool) => ({
      name: tool.name,
      available: tool.path != null,
      path: tool.path,
      version: tool.version,
      origin: tool.origin
    }))

    const status: EngineStatus = {
      ready: components.every((component) => component.available),
      engineDir: engineDir(),
      components,
      setupRunning: this.setupPromise != null,
      lastError: this.setupError
    }

    this.cached = { status, at: Date.now() }
    return status
  }

  invalidate(): void {
    this.cached = null
    this.resolved.clear()
    this.generation += 1
  }

  /** Installs whatever is missing and refreshes a stale managed yt-dlp. Concurrent calls share a single run. */
  async setup(): Promise<EngineStatus> {
    if (this.stopped) throw new Error('Sonic is closing; media engine setup cannot start.')
    if (this.setupPromise) return this.setupPromise

    this.setupController = new AbortController()
    this.setupPromise = this.runSetup(this.setupController.signal)
      .catch((error: unknown) => {
        this.setupError = error instanceof Error ? error.message : String(error)
        throw error
      })
      .finally(() => {
        this.setupPromise = null
        this.setupController = null
      })

    return this.setupPromise
  }

  async shutdown(): Promise<void> {
    this.stopped = true
    this.setupController?.abort(new Error('Media engine setup was cancelled because Sonic is closing.'))
    await this.setupPromise?.catch(() => undefined)
  }

  private async runSetup(signal: AbortSignal): Promise<EngineStatus> {
    this.setupError = null
    await ensureDir(engineDir())
    this.emitProgress({
      phase: 'resolving',
      component: 'engine',
      receivedBytes: 0,
      totalBytes: null,
      percent: null,
      message: 'Checking installed tools…'
    })

    signal.throwIfAborted()
    const ytdlp = await this.resolve('yt-dlp', true, signal)
    signal.throwIfAborted()
    if (!ytdlp.path) {
      await this.installYtDlp(signal)
    } else if (ytDlpNeedsRefresh(ytdlp)) {
      // Sites change often and an old yt-dlp is the usual cause of failed
      // downloads. A failed refresh keeps the working copy.
      try {
        await this.installYtDlp(signal)
      } catch (error) {
        signal.throwIfAborted()
        this.emitProgress({
          phase: 'resolving',
          component: 'yt-dlp',
          receivedBytes: 0,
          totalBytes: null,
          percent: null,
          message: `Kept the installed yt-dlp: ${error instanceof Error ? error.message : String(error)}`
        })
      }
    }

    const ffmpeg = await this.resolve('ffmpeg', true, signal)
    signal.throwIfAborted()
    const ffprobe = await this.resolve('ffprobe', true, signal)
    signal.throwIfAborted()
    if (!ffmpeg.path || !ffprobe.path) {
      await this.installFfmpeg(signal)
    }

    signal.throwIfAborted()
    this.invalidate()
    const status = await this.status(true, signal)
    this.emitProgress({
      phase: status.ready ? 'done' : 'error',
      component: 'engine',
      receivedBytes: 0,
      totalBytes: null,
      percent: status.ready ? 1 : null,
      message: status.ready ? 'Media engine ready.' : 'Some tools are still missing.'
    })
    return status
  }

  /** Downloads yt-dlp and verifies it against the publisher's SHA-256 manifest. */
  private async installYtDlp(signal?: AbortSignal): Promise<void> {
    const binaryName = TOOL_BINARY['yt-dlp']
    await ensureDir(engineDir())
    const target = path.join(engineDir(), binaryName)
    const partial = `${target}.download`

    this.emitProgress({
      phase: 'resolving',
      component: 'yt-dlp',
      receivedBytes: 0,
      totalBytes: null,
      percent: null,
      message: 'Fetching the yt-dlp checksum manifest…'
    })

    let expectedHash: string | null
    try {
      const manifest = await fetchText(`${YTDLP_RELEASE_BASE}/SHA2-256SUMS`, signal)
      expectedHash = parseChecksumManifest(manifest, binaryName)
    } catch (error) {
      signal?.throwIfAborted()
      throw new Error(`Could not verify the yt-dlp release checksums. Setup left the installed tool unchanged; please retry. ${error instanceof Error ? error.message : String(error)}`)
    }
    if (!expectedHash) throw new Error('The yt-dlp release has no valid checksum for this platform. Setup left the installed tool unchanged; please retry later.')
    signal?.throwIfAborted()

    this.emitProgress({
      phase: 'downloading',
      component: 'yt-dlp',
      receivedBytes: 0,
      totalBytes: null,
      percent: 0,
      message: 'Downloading yt-dlp…'
    })

    try {
      await downloadToFile(`${YTDLP_RELEASE_BASE}/${binaryName}`, partial, {
        signal,
        onProgress: (received, total) => {
          this.emitProgress({
            phase: 'downloading',
            component: 'yt-dlp',
            receivedBytes: received,
            totalBytes: total,
            percent: total ? received / total : null,
            message: 'Downloading yt-dlp…'
          })
        }
      })

      this.emitProgress({
        phase: 'verifying',
        component: 'yt-dlp',
        receivedBytes: 0,
        totalBytes: null,
        percent: null,
        message: 'Verifying the yt-dlp download…'
      })
      verifyChecksum(await sha256File(partial, signal), expectedHash, 'yt-dlp')

      signal?.throwIfAborted()
      await moveFile(partial, target)
      if (!IS_WINDOWS) {
        try {
          chmodSync(target, 0o755)
        } catch {
          // Non-fatal: the archive bit may already be correct.
        }
      }
      this.invalidate()
    } finally {
      await removeFile(partial)
    }
  }

  /**
   * Downloads a static FFmpeg build and lifts `ffmpeg`/`ffprobe` out of it.
   * Windows only — elsewhere Sonic expects the system package manager to provide it.
   */
  private async installFfmpeg(signal?: AbortSignal): Promise<void> {
    if (!IS_WINDOWS) {
      throw new Error(
        'Automatic FFmpeg setup is only available on Windows. Install ffmpeg with your package manager and set the path in Settings.'
      )
    }

    const workDir = path.join(stagingDir(), 'ffmpeg-download')
    const archive = path.join(stagingDir(), 'ffmpeg.zip')
    try {
      await ensureDir(workDir)

      this.emitProgress({
        phase: 'resolving',
        component: 'ffmpeg',
        receivedBytes: 0,
        totalBytes: null,
        percent: null,
        message: 'Fetching the FFmpeg checksum manifest…'
      })
      // Fail closed before spending the download: nothing unverified is ever extracted or run.
      let expectedHash: string | null
      try {
        expectedHash = parseChecksumManifest(await fetchText(FFMPEG_CHECKSUMS_URL, signal), FFMPEG_ZIP_NAME)
      } catch (error) {
        signal?.throwIfAborted()
        throw new Error(`Could not verify the FFmpeg release checksums. Setup left the installed tools unchanged; please retry. ${error instanceof Error ? error.message : String(error)}`)
      }
      if (!expectedHash) throw new Error('The FFmpeg release has no valid checksum for its Windows archive. Setup left the installed tools unchanged; please retry later.')
      signal?.throwIfAborted()

      this.emitProgress({
        phase: 'downloading',
        component: 'ffmpeg',
        receivedBytes: 0,
        totalBytes: null,
        percent: 0,
        message: 'Downloading FFmpeg (about 185 MB)…'
      })

      await downloadToFile(FFMPEG_ZIP_URL, archive, {
        signal,
        onProgress: (received, total) => {
          this.emitProgress({
            phase: 'downloading',
            component: 'ffmpeg',
            receivedBytes: received,
            totalBytes: total,
            percent: total ? received / total : null,
            message: 'Downloading FFmpeg…'
          })
        }
      })

      this.emitProgress({
        phase: 'verifying',
        component: 'ffmpeg',
        receivedBytes: 0,
        totalBytes: null,
        percent: null,
        message: 'Verifying the FFmpeg download…'
      })
      verifyChecksum(await sha256File(archive, signal), expectedHash, 'FFmpeg')
      signal?.throwIfAborted()

      this.emitProgress({
        phase: 'verifying',
        component: 'ffmpeg',
        receivedBytes: 0,
        totalBytes: null,
        percent: null,
        message: 'Extracting FFmpeg…'
      })

      await removeDir(workDir)
      await ensureDir(workDir)

      signal?.throwIfAborted()
      const extract = await run(
        'powershell.exe',
        [
          '-NoProfile',
          '-NonInteractive',
          '-ExecutionPolicy',
          'Bypass',
          '-Command',
          `Expand-Archive -LiteralPath '${archive.replace(/'/g, "''")}' -DestinationPath '${workDir.replace(/'/g, "''")}' -Force`
        ],
        { timeoutMs: 300_000, signal, maxCaptureBytes: 16 * 1024 }
      )

      if (extract.aborted || signal?.aborted) throw new Error('FFmpeg setup was cancelled.')
      if (extract.timedOut) throw new Error('Extracting FFmpeg timed out after five minutes. Please retry setup.')
      if (extract.code !== 0) {
        throw new Error(`Could not extract the FFmpeg archive: ${extract.stderr.slice(0, 300) || 'unknown error'}`)
      }

      const ffmpegSource = findFileRecursive(workDir, 'ffmpeg.exe')
      const ffprobeSource = findFileRecursive(workDir, 'ffprobe.exe')
      if (!ffmpegSource || !ffprobeSource) {
        throw new Error('The FFmpeg archive did not contain the expected binaries.')
      }

      await ensureDir(engineDir())
      signal?.throwIfAborted()
      await moveFile(ffmpegSource, path.join(engineDir(), 'ffmpeg.exe'))
      signal?.throwIfAborted()
      await moveFile(ffprobeSource, path.join(engineDir(), 'ffprobe.exe'))

      this.invalidate()
    } finally {
      await removeDir(workDir)
      await removeFile(archive)
    }
  }

  private emitProgress(progress: EngineProgress): void {
    this.emit('progress', progress)
  }
}

/** Throws unless a download's SHA-256 equals the publisher's value. */
export function verifyChecksum(actual: string, expected: string, label: string): void {
  if (!/^[a-f0-9]{64}$/i.test(expected) || actual.toLowerCase() !== expected.toLowerCase()) {
    throw new Error(`The ${label} download did not match its published checksum and was discarded.`)
  }
}

/** The SHA-256 a `sha256sum`-style manifest lists for exactly `fileName`, or null. */
export function parseChecksumManifest(manifest: string, fileName: string): string | null {
  for (const line of manifest.split(/\r?\n/)) {
    const trimmed = line.trim()
    if (trimmed.length === 0) continue
    const parts = trimmed.split(/\s+/)
    if (parts.length < 2) continue
    const candidate = parts[parts.length - 1].replace(/^\*/, '')
    if (candidate === fileName && /^[a-f0-9]{64}$/i.test(parts[0])) return parts[0]
  }
  return null
}

function findFileRecursive(root: string, fileName: string, depth = 0): string | null {
  if (depth > 6) return null
  let entries: string[]
  try {
    entries = readdirSync(root)
  } catch {
    return null
  }

  for (const entry of entries) {
    const full = path.join(root, entry)
    let info
    try {
      info = statSync(full)
    } catch {
      continue
    }
    if (info.isFile() && entry.toLowerCase() === fileName.toLowerCase()) return full
    if (info.isDirectory()) {
      const found = findFileRecursive(full, fileName, depth + 1)
      if (found) return found
    }
  }
  return null
}

export const engineService = new EngineService()
