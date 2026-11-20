// Must stay first: it picks the userData folder before any other module reads it.
import './legacyUserData'
import { BrowserWindow, app, session, dialog, shell } from 'electron'
import { registerIpcHandlers, wireServiceEvents } from './ipc'
import { installMediaProtocol, registerMediaScheme } from './protocol'
import { queueService } from './services/queue'
import { installSmokeTest } from './smoke'
import { createMainWindow, flushWindowState, getMainWindow } from './window'
import { beginShutdown, isStopping, settleOperations } from './lifecycle'
import { stopPlaylists } from './services/playlist'
import { analysisService } from './analysis/service'
import { libraryAnalysis } from './analysis/libraryAnalysis'
import { libraryService } from './services/library'
import { retryStorage, storageDiagnostic } from './lib/jsonStore'
import { queueFile } from './services/paths'
import { settleChildren } from './lib/child'
import { stopReexports } from './services/reexport'
import { localImportService } from './services/localImport'
import { batchOperations } from './services/batchOperations'
import { playbackSessionService } from './services/playbackSession'
import { recoveryService } from './services/recovery'
import { engineService } from './services/engine'
import { updateService } from './services/updater'

let readyToQuit = false
let closing: Promise<void> | null = null
let shutdownWork: Promise<void> | null = null
/** Set by "Restart to update": once state is saved, the installer replaces the normal quit. */
let installUpdateOnQuit = false
/** Renderers that crashed or stopped answering: their playback state cannot be flushed. */
const unavailableRenderers = new WeakSet<BrowserWindow>()
function rendererAvailable(window: BrowserWindow | null): window is BrowserWindow {
  return !!window && !window.isDestroyed() && !window.webContents.isDestroyed() &&
    !window.webContents.isCrashed() && !unavailableRenderers.has(window)
}
async function flushRendererPlayback(): Promise<void> {
  const window = getMainWindow()
  if (!rendererAvailable(window)) return
  let timer: NodeJS.Timeout | undefined
  try {
    await Promise.race([
      window.webContents.executeJavaScript(`(() => {
        if (window.__sonicPlaybackFlush) return window.__sonicPlaybackFlush()
        if (document.querySelector('[data-playback-dock]')) throw new Error('The playback close handler is unavailable.')
        return null
      })()`),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('The playback position is still saving after 8 seconds.')), 8_000)
      })
    ])
  } finally { if (timer) clearTimeout(timer) }
}
/** False only when the producer chose to keep Sonic open after a failed playback save. */
async function flushPlaybackBeforeClose(): Promise<boolean> {
  try {
    await flushRendererPlayback()
    return true
  } catch (error) {
    storageDiagnostic(queueFile(), { operation: 'playback-flush-failed', error: String(error) })
    // A renderer that died or hung mid-flush can never answer; never wedge close on it.
    if (!rendererAvailable(getMainWindow())) return true
    const { response } = await dialog.showMessageBox({ type: 'warning', title: 'Playback position not saved', message: 'Sonic could not save the current playback position.', detail: `${String(error)}\nEverything else is still saved when Sonic closes.`, buttons: ['Keep open', 'Close anyway'], defaultId: 0, cancelId: 0 })
    return response === 1
  }
}
function requestShutdown(options: { installUpdate?: boolean } = {}): void {
  if (options.installUpdate) installUpdateOnQuit = true
  if (readyToQuit || closing) return
  // Defer work out of the close/Inspector callback. Never nest a flush inside another synchronous write.
  closing = new Promise<void>(resolve => setImmediate(resolve)).then(async () => {
    storageDiagnostic(queueFile(), { operation: 'shutdown-start' })
    // Admission closes only once the renderer's playback state is saved or abandoned,
    // so keeping Sonic open after a failed flush leaves it fully usable, not half-stopped.
    if (!(await flushPlaybackBeforeClose())) { installUpdateOnQuit = false; return }
    beginShutdown()
    updateService.shutdown()
    stopPlaylists()
    libraryService.scheduleRescan(0)
    shutdownWork ??= (async () => {
      await Promise.all([queueService.stopAll(), libraryAnalysis.shutdown(), analysisService.shutdown(), stopReexports(), localImportService.shutdown(), batchOperations.shutdown(), recoveryService.shutdown(), engineService.shutdown()])
      await settleOperations()
      await libraryService.shutdown()
      await settleChildren()
    })().catch(error => { shutdownWork = null; throw error })
    let timer: NodeJS.Timeout | undefined
    try {
      await Promise.race([shutdownWork, new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('Work is still stopping after 20 seconds. Your app remains open; retry close when it settles.')), 20_000)
      })])
      queueService.flush()
      flushWindowState()
      await retryStorage()
      libraryAnalysis.settlePendingAdmission()
      storageDiagnostic(queueFile(), { operation: 'shutdown-saved' })
      readyToQuit = true
      // quitAndInstall starts the installer and quits on its own.
      if (installUpdateOnQuit && updateService.quitAndInstall()) return
      app.quit()
    } finally { if (timer) clearTimeout(timer) }
  }).catch(async error => {
    installUpdateOnQuit = false
    storageDiagnostic(queueFile(), { operation: 'shutdown-failed', error: String(error) })
    // Intentional failure UI, never an uncaught native exception. No forced exit or claimed save.
    await dialog.showMessageBox({ type: 'error', title: 'Sonic could not finish closing', message: 'Sonic is still open to protect pending changes.', detail: `${String(error)}\nResolve the storage problem, then use Retry saving or close again.`, buttons: ['Keep open'] })
  }).finally(() => { closing = null })
}

// Must happen before the app is ready.
registerMediaScheme()

/**
 * Locks the renderer down to its own bundle.
 *
 * The relaxed policy is keyed to the Vite dev server rather than to packaging:
 * HMR needs inline/eval, but a `file://` renderer does not — including an
 * unpackaged one — so only a real dev server gets the looser policy. Remote
 * images are allowed because provider thumbnails load directly, and
 * `sonic-media:` is the only route to local audio.
 */
function installContentSecurityPolicy(): void {
  const isDevServer = Boolean(process.env['ELECTRON_RENDERER_URL'])

  const common = [
    "default-src 'self'",
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob: https:",
    "media-src 'self' blob: sonic-media:",
    "font-src 'self' data:",
    "worker-src 'self' blob:",
    "object-src 'none'",
    "base-uri 'none'",
    "form-action 'none'",
    "frame-src 'none'"
  ]

  const policy = isDevServer
    ? [
        ...common,
        "script-src 'self' 'unsafe-inline' 'unsafe-eval'",
        "connect-src 'self' ws: wss: http://localhost:* http://127.0.0.1:* sonic-media: blob: data:"
      ].join('; ')
    : [...common, "script-src 'self'", "connect-src 'self' sonic-media: blob: data:"].join('; ')

  session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
    callback({
      responseHeaders: {
        ...details.responseHeaders,
        'Content-Security-Policy': [policy]
      }
    })
  })

  // Sonic never needs camera, microphone, geolocation, or notifications.
  session.defaultSession.setPermissionRequestHandler((_contents, _permission, callback) => {
    callback(false)
  })
}

const hasSingleInstanceLock = app.requestSingleInstanceLock()

if (!hasSingleInstanceLock) {
  app.quit()
} else {
  app.on('browser-window-created', (_event, window) => {
    window.webContents.on('render-process-gone', () => unavailableRenderers.add(window))
    window.webContents.on('did-finish-load', () => unavailableRenderers.delete(window))
    window.on('unresponsive', () => unavailableRenderers.add(window))
    window.on('responsive', () => unavailableRenderers.delete(window))
    window.on('close', event => { if (!readyToQuit) { event.preventDefault(); requestShutdown() } })
    window.on('query-session-end', event => { event.preventDefault(); requestShutdown() })
    window.on('session-end', () => {
      // Windows may bypass normal quit. Only already committed changes are guaranteed.
      beginShutdown()
      try { queueService.flush() } catch (error) { storageDiagnostic(queueFile(), { operation: 'session-end-save-failed', error: String(error) }) }
    })
  })
  app.on('second-instance', () => {
    const [existing] = BrowserWindow.getAllWindows()
    if (!existing) return
    if (existing.isMinimized()) existing.restore()
    existing.focus()
  })

  app.whenReady().then(() => {
    installContentSecurityPolicy()
    installMediaProtocol()
    wireServiceEvents()
    registerIpcHandlers()
    // Validate saved state before producers start. Unrecoverable data is preserved
    // and reported intentionally instead of leaving an unhandled bootstrap rejection.
    libraryService.list()
    playbackSessionService.snapshot()
    libraryAnalysis.status()
    const window = createMainWindow()
    queueService.init()
    installSmokeTest(window)
    updateService.setRestartHandler(() => requestShutdown({ installUpdate: true }))
    updateService.start()

    app.on('activate', () => {
      if (!isStopping() && BrowserWindow.getAllWindows().length === 0) createMainWindow()
    })
  }).catch(async error => {
    beginShutdown()
    storageDiagnostic(queueFile(), { operation: 'startup-failed', error: String(error) })
    const dataDir = app.getPath('userData')
    const { response } = await dialog.showMessageBox({ type: 'error', title: 'Saved state could not be recovered', message: 'Sonic could not safely load its saved state.', detail: `${String(error)}\nThe damaged data has been preserved in:\n${dataDir}\nRestore a valid backup there before reopening.`, buttons: ['Close', 'Open data folder'], defaultId: 0, cancelId: 0 })
    if (response === 1) await shell.openPath(dataDir).catch(() => undefined)
    readyToQuit = true
    app.quit()
  })

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit()
  })

  app.on('before-quit', event => {
    if (!readyToQuit) { event.preventDefault(); requestShutdown() }
  })
}
