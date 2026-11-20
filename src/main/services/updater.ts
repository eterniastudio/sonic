import { app } from 'electron'
import { appendFile, mkdir } from 'node:fs/promises'
import path from 'node:path'
// A static import: electron-updater is CommonJS and exposes `autoUpdater` as a
// lazy getter, which a dynamic import() cannot see. The updater object itself is
// only created on first access, inside start().
import { autoUpdater, type AppUpdater } from 'electron-updater'
import type { UpdateStatus } from '@shared/update'
import { broadcast } from '../broadcast'
import { logsDir } from './paths'

/** Long enough after launch that the update check never competes with startup work. */
const FIRST_CHECK_DELAY_MS = 20_000
const CHECK_INTERVAL_MS = 4 * 60 * 60_000

function logLine(level: string, message: unknown): void {
  const text = `${new Date().toISOString()} ${level} ${message instanceof Error ? message.stack ?? message.message : String(message)}\n`
  const dir = logsDir()
  void mkdir(dir, { recursive: true }).then(() => appendFile(path.join(dir, 'updater.log'), text)).catch(() => undefined)
}

/** The updater's own errors are long stack traces; producers get one plain sentence. */
export function describeUpdateError(error: unknown): string {
  const text = error instanceof Error ? error.message : String(error)
  if (/ENOTFOUND|EAI_AGAIN|ECONNREFUSED|ECONNRESET|ETIMEDOUT|net::ERR_/i.test(text)) {
    return 'Could not reach GitHub to check for updates. Sonic will try again later.'
  }
  // Also what an unauthenticated request to a private repository returns.
  if (/latest\.yml|404|Cannot find channel/i.test(text)) {
    return 'GitHub has no update information for Sonic yet. Sonic will try again later.'
  }
  if (/sha512|checksum/i.test(text)) {
    return 'The downloaded update did not match its checksum and was discarded. Sonic will try again later.'
  }
  const firstLine = text.split(/\r?\n/)[0] ?? text
  return firstLine.length > 200 ? `${firstLine.slice(0, 197)}…` : firstLine
}

/**
 * Checks GitHub Releases for a newer Sonic, downloads it in the background and
 * installs it when the producer restarts or next closes Sonic.
 *
 * Only an installed (packaged) Windows build updates itself. Development runs,
 * smoke runs and tests stay `disabled` and never touch the network.
 */
class UpdateService {
  private updater: AppUpdater | null = null
  private timer: NodeJS.Timeout | null = null
  private checking: Promise<UpdateStatus> | null = null
  private restartHandler: (() => void) | null = null
  private state: UpdateStatus = {
    phase: 'disabled',
    currentVersion: app.getVersion(),
    availableVersion: null,
    percent: null,
    checkedAt: null,
    message: 'Updates start once Sonic is running.'
  }

  status(): UpdateStatus {
    return { ...this.state }
  }

  /** `index.ts` owns the graceful close; the updater only asks for it. */
  setRestartHandler(handler: () => void): void {
    this.restartHandler = handler
  }

  private set(patch: Partial<UpdateStatus>): void {
    this.state = { ...this.state, ...patch }
    broadcast('update:status', this.status())
  }

  private disabledReason(): string | null {
    if (process.env['SONIC_DISABLE_UPDATES'] === '1') return 'Updates are turned off for this run.'
    if (!app.isPackaged) return 'Development builds do not update themselves.'
    if (process.argv.includes('--smoke')) return 'Updates are off during the smoke test.'
    if (process.platform !== 'win32') return 'Automatic updates are only available on Windows.'
    return null
  }

  start(): void {
    const reason = this.disabledReason()
    if (reason) {
      this.set({ phase: 'disabled', message: reason })
      return
    }
    try {
      autoUpdater.logger = {
        info: (message) => logLine('info', message),
        warn: (message) => logLine('warn', message),
        error: (message) => logLine('error', message),
        debug: () => undefined
      }
      autoUpdater.autoDownload = true
      autoUpdater.autoInstallOnAppQuit = true
      autoUpdater.allowPrerelease = false
      autoUpdater.allowDowngrade = false

      autoUpdater.on('checking-for-update', () => this.set({ phase: 'checking', message: null }))
      autoUpdater.on('update-available', (info) =>
        this.set({ phase: 'downloading', availableVersion: info.version, percent: 0, message: null }))
      autoUpdater.on('download-progress', (progress) => {
        if (this.state.phase === 'ready') return
        this.set({ phase: 'downloading', percent: Math.max(0, Math.min(1, progress.percent / 100)) })
      })
      autoUpdater.on('update-not-available', () =>
        this.set({ phase: 'up-to-date', availableVersion: null, percent: null, checkedAt: Date.now(), message: null }))
      autoUpdater.on('update-downloaded', (info) => {
        this.set({ phase: 'ready', availableVersion: info.version, percent: 1, checkedAt: Date.now(), message: null })
        broadcast('app:notice', {
          kind: 'success',
          message: `Sonic ${info.version} is ready. Restart from Settings → About, or it installs when you close Sonic.`
        })
      })
      // electron-updater already logs its errors through the logger above.
      autoUpdater.on('error', (error) => {
        // A failed background check must not hide an update that is already downloaded.
        if (this.state.phase === 'ready') return
        this.set({ phase: 'error', percent: null, checkedAt: Date.now(), message: describeUpdateError(error) })
      })

      this.updater = autoUpdater
      this.set({ phase: 'idle', message: null })
      this.timer = setTimeout(() => {
        void this.check()
        this.timer = setInterval(() => void this.check(), CHECK_INTERVAL_MS)
        this.timer.unref()
      }, FIRST_CHECK_DELAY_MS)
      this.timer.unref()
    } catch (error) {
      logLine('error', error)
      this.set({ phase: 'disabled', message: `The updater could not start: ${describeUpdateError(error)}` })
    }
  }

  /** Concurrent checks share one request. A downloaded update is never re-checked. */
  check(): Promise<UpdateStatus> {
    const updater = this.updater
    if (!updater || this.state.phase === 'ready' || this.state.phase === 'downloading') return Promise.resolve(this.status())
    this.checking ??= updater.checkForUpdates()
      .then(() => this.status())
      .catch((error: unknown) => {
        if (this.state.phase !== 'ready') {
          this.set({ phase: 'error', percent: null, checkedAt: Date.now(), message: describeUpdateError(error) })
        }
        return this.status()
      })
      .finally(() => { this.checking = null })
    return this.checking
  }

  /** Starts the normal close; `index.ts` calls `quitAndInstall` once everything is saved. */
  requestRestart(): boolean {
    if (this.state.phase !== 'ready' || !this.restartHandler) return false
    this.restartHandler()
    return true
  }

  /** Called by the shutdown path after state is saved. True when the installer took over. */
  quitAndInstall(): boolean {
    if (!this.updater || this.state.phase !== 'ready') return false
    try {
      // Silent install, then relaunch the updated Sonic.
      this.updater.quitAndInstall(true, true)
      return true
    } catch (error) {
      logLine('error', error)
      return false
    }
  }

  shutdown(): void {
    if (this.timer) clearTimeout(this.timer)
    this.timer = null
  }
}

export const updateService = new UpdateService()
