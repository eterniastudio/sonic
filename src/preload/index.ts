import { contextBridge, ipcRenderer } from 'electron'
import type { IpcChannel, IpcEventChannel, IpcEvents, IpcMap } from '@shared/ipc'
import { IPC_CHANNELS, IPC_EVENT_CHANNELS } from '@shared/ipc'

const allowed = new Set<string>(IPC_CHANNELS)
const allowedEvents = new Set<string>(IPC_EVENT_CHANNELS)

/**
 * The only surface the renderer gets.
 *
 * Channels are validated against the shared contract at call time, so even a
 * compromised renderer cannot reach a channel that was never declared.
 */
const api = {
  invoke<K extends IpcChannel>(channel: K, ...args: IpcMap[K]['args']): Promise<IpcMap[K]['result']> {
    if (!allowed.has(channel)) {
      return Promise.reject(new Error(`Unknown IPC channel: ${String(channel)}`))
    }
    return ipcRenderer.invoke(channel, ...args) as Promise<IpcMap[K]['result']>
  },

  /** Subscribes to a push channel. Returns an unsubscribe function. */
  on<K extends IpcEventChannel>(channel: K, listener: (payload: IpcEvents[K]) => void): () => void {
    if (!allowedEvents.has(channel)) {
      throw new Error(`Unknown IPC event channel: ${String(channel)}`)
    }
    const wrapped = (_event: unknown, payload: IpcEvents[K]): void => listener(payload)
    ipcRenderer.on(channel, wrapped)
    return () => {
      ipcRenderer.removeListener(channel, wrapped)
    }
  },

  platform: process.platform
}

contextBridge.exposeInMainWorld('sonic', api)

export type SonicApi = typeof api
