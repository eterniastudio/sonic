import { app } from 'electron'
import { existsSync, renameSync } from 'node:fs'
import path from 'node:path'

/** The app was called "Sonic V2" up to 2.0.x, so its state lives in `%APPDATA%\Sonic V2`. */
const LEGACY_DIR_NAME = 'Sonic V2'

function hasSonicState(dir: string): boolean {
  return ['library.json', 'settings.json', 'queue.json'].some((file) => existsSync(path.join(dir, file)))
}

/**
 * Keeps the library, settings and media engine of a Sonic V2 install after the
 * rename to Sonic.
 *
 * Moves the old folder to the new name when it can. When the move fails (an old
 * copy is still running, or antivirus holds a file), Sonic keeps using the old
 * folder in place, so nothing is copied or lost. A profile chosen with
 * `--user-data-dir` (tests, development) is never touched.
 *
 * Must run before anything reads userData, including the single-instance lock.
 */
export function adoptLegacyUserData(): void {
  if (app.commandLine.hasSwitch('user-data-dir')) return
  let current: string
  let legacy: string
  try {
    current = app.getPath('userData')
    legacy = path.join(app.getPath('appData'), LEGACY_DIR_NAME)
  } catch {
    return
  }
  if (path.resolve(current).toLowerCase() === path.resolve(legacy).toLowerCase()) return
  if (!hasSonicState(legacy) || hasSonicState(current)) return

  if (!existsSync(current)) {
    try {
      renameSync(legacy, current)
      return
    } catch {
      // Fall through and use the old folder where it is.
    }
  }
  app.setPath('userData', legacy)
}

adoptLegacyUserData()
