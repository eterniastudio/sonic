import { BrowserWindow, app, dialog, screen, shell } from 'electron'
import { existsSync } from 'node:fs'
import path from 'node:path'
import { JsonStore } from './lib/jsonStore'
import { isStopping } from './lifecycle'
import { broadcast } from './broadcast'
import { userDataDir } from './services/paths'
import { settingsService } from './services/settings'

interface WindowState {
  width: number
  height: number
  x: number | null
  y: number | null
  maximized: boolean
}

const DEFAULTS: WindowState = { width: 1280, height: 820, x: null, y: null, maximized: false }

const store = new JsonStore<WindowState>(
  path.join(userDataDir(), 'window.json'),
  DEFAULTS,
  (raw) => ({ ...DEFAULTS, ...(raw as object) }) as WindowState
)

let mainWindow: BrowserWindow | null = null
let flushState: (() => void) | null = null
export function flushWindowState(): void { flushState?.() }

export function getMainWindow(): BrowserWindow | null {
  return mainWindow
}

/** Background colour matched to the active theme, so there is no white flash. */
function backgroundColor(): string {
  return settingsService.get().theme === 'light' ? '#f4f5f8' : '#08090c'
}

/**
 * True when a saved rectangle still overlaps a connected display.
 *
 * Window bounds are persisted across runs, but a monitor arrangement is not
 * permanent: unplugging a second screen, undocking a laptop or changing
 * resolution can leave the stored position pointing at empty space. Restoring it
 * blindly opens the window off-screen, which looks to the user exactly like the
 * app failed to start.
 */
function isOnSomeDisplay(bounds: { x: number; y: number; width: number; height: number }): boolean {
  return screen.getAllDisplays().some((display) => {
    const area = display.workArea
    return (
      bounds.x < area.x + area.width &&
      bounds.x + bounds.width > area.x &&
      bounds.y < area.y + area.height &&
      bounds.y + bounds.height > area.y
    )
  })
}

export function createMainWindow(): BrowserWindow {
  const saved = store.read()
  const hiddenTest = !app.isPackaged && process.env['SONIC_TEST_HIDDEN'] === '1'

  // Only reuse the saved position when it is still reachable; otherwise let
  // Electron centre the window on the primary display.
  const placementIsUsable =
    saved.x != null && saved.y != null && isOnSomeDisplay({
      x: saved.x,
      y: saved.y,
      width: saved.width,
      height: saved.height
    })

  const window = new BrowserWindow({
    icon: app.isPackaged
      ? path.join(process.resourcesPath, 'icon.png')
      : path.join(app.getAppPath(), 'build', 'icon.png'),
    width: saved.width,
    height: saved.height,
    x: placementIsUsable ? (saved.x as number) : undefined,
    y: placementIsUsable ? (saved.y as number) : undefined,
    minWidth: 1024,
    minHeight: 680,
    show: false,
    // Frameless: the renderer draws its own title bar so the app chrome can
    // follow the theme instead of fighting the OS one.
    frame: false,
    backgroundColor: backgroundColor(),
    title: 'Sonic',
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, '../preload/index.js'),
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      webSecurity: true,
      spellcheck: false,
      backgroundThrottling: !hiddenTest
    }
  })

  mainWindow = window

  if (saved.maximized && !hiddenTest) window.maximize()

  window.on('ready-to-show', () => {
    if (!hiddenTest) window.show()
  })

  const persistState = (): void => {
    if (window.isDestroyed()) return
    const maximized = window.isMaximized()
    const bounds = maximized ? window.getNormalBounds() : window.getBounds()
    store.write({
      width: bounds.width,
      height: bounds.height,
      x: bounds.x,
      y: bounds.y,
      maximized
    }, { replacePending: true })
    broadcast('window:maximized', maximized)
  }

  let persistTimer: NodeJS.Timeout | null = null
  const schedulePersist = (): void => {
    if (isStopping()) return
    if (persistTimer) clearTimeout(persistTimer)
    persistTimer = setTimeout(() => { persistTimer = null; safePersist() }, 150)
  }
  const safePersist = (): void => { try { persistState() } catch { /* JsonStore retains pending data and broadcasts persistent error. */ } }
  flushState = () => {
    if (persistTimer) clearTimeout(persistTimer)
    persistTimer = null
    persistState()
  }
  window.on('resize', schedulePersist)
  window.on('move', schedulePersist)
  window.on('maximize', safePersist)
  window.on('unmaximize', safePersist)
  window.on('closed', () => {
    if (persistTimer) clearTimeout(persistTimer)
    mainWindow = null
    flushState = null
  })

  // Anything that tries to open a new window goes to the system browser instead.
  window.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url)) void shell.openExternal(url)
    return { action: 'deny' }
  })

  // The renderer is a fixed shell; navigating it away is never legitimate.
  window.webContents.on('will-navigate', (event, url) => {
    const current = window.webContents.getURL()
    if (url !== current) {
      event.preventDefault()
      if (/^https?:\/\//i.test(url)) void shell.openExternal(url)
    }
  })

  const devServer = process.env['ELECTRON_RENDERER_URL']
  const load = (): Promise<void> => !app.isPackaged && devServer
    ? window.loadURL(devServer)
    : window.loadFile(path.join(__dirname, '../renderer/index.html'))

  // The window is frameless and hidden until the renderer paints, so a failed
  // load or a crashed renderer would otherwise leave an invisible or blank
  // window with no close button. Offer a reload instead.
  if (!hiddenTest && !process.argv.includes('--smoke')) {
    let prompting = false
    const offerRecovery = (title: string, detail: string): void => {
      if (prompting || window.isDestroyed() || isStopping()) return
      prompting = true
      if (!window.isVisible()) window.show()
      void dialog.showMessageBox(window, {
        type: 'error',
        title,
        message: title,
        detail: `${detail}\nYour library and settings are saved. Reload Sonic to continue.`,
        buttons: ['Reload', 'Quit Sonic'],
        defaultId: 0,
        cancelId: 1
      }).then(({ response }) => {
        prompting = false
        if (window.isDestroyed()) return
        if (response === 0) void load().catch(() => undefined)
        else app.quit()
      })
    }
    window.webContents.on('did-fail-load', (_event, code, description, _url, isMainFrame) => {
      // -3 is an aborted navigation (for example a reload during load), not a failure.
      if (!isMainFrame || code === -3) return
      offerRecovery('Sonic could not open its window', `${description} (${code})`)
    })
    window.webContents.on('render-process-gone', (_event, details) => {
      if (details.reason === 'clean-exit') return
      offerRecovery('Sonic stopped responding', `The window process ended unexpectedly (${details.reason}).`)
    })
  }

  // A rejected load is reported through did-fail-load above.
  void load().catch(() => undefined)

  return window
}

/** Re-applies the themed background when the theme changes. */
export function syncWindowTheme(): void {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.setBackgroundColor(backgroundColor())
  }
}

export function windowStateExists(): boolean {
  return existsSync(path.join(userDataDir(), 'window.json'))
}

export function minimizeWindow(): void {
  mainWindow?.minimize()
}

export function toggleMaximizeWindow(): boolean {
  if (!mainWindow) return false
  if (mainWindow.isMaximized()) {
    mainWindow.unmaximize()
  } else {
    mainWindow.maximize()
  }
  return mainWindow.isMaximized()
}

export function closeWindow(): void {
  mainWindow?.close()
}

export function isWindowMaximized(): boolean {
  return mainWindow?.isMaximized() ?? false
}
