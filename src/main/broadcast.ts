import { BrowserWindow } from 'electron'
import type { IpcEventChannel, IpcEvents } from '@shared/ipc'
import { LibraryDeltaEncoder } from './libraryDelta'

const library = new LibraryDeltaEncoder()

/** Pushes an event to every live renderer. Library snapshots travel as deltas
 * against the previous library push whenever that is smaller; the renderer
 * rebuilds the same ordered list from it. */
export function broadcast<K extends IpcEventChannel>(channel: K, payload: IpcEvents[K]): void {
  if (channel === 'library:changed') {
    const encoded = library.encode(payload as IpcEvents['library:changed'])
    if ('delta' in encoded) return send('library:delta', encoded.delta)
  }
  send(channel, payload)
}

function send<K extends IpcEventChannel>(channel: K, payload: IpcEvents[K]): void {
  for (const window of BrowserWindow.getAllWindows()) {
    if (window.isDestroyed()) continue
    window.webContents.send(channel, payload)
  }
}
