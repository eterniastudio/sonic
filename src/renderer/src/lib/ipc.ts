import type { IpcChannel, IpcEventChannel, IpcEvents, IpcMap } from '@shared/ipc'

/**
 * Thin, typed wrapper over the preload bridge.
 *
 * If the bridge is missing the app was loaded outside Electron (or the preload
 * failed), which is worth saying plainly rather than crashing on `undefined`.
 */
function bridge(): Window['sonic'] {
  if (typeof window === 'undefined' || !window.sonic) {
    throw new Error(
      'The Sonic preload bridge is unavailable. Run the app through Electron rather than a plain browser tab.'
    )
  }
  return window.sonic
}

export const ipc = {
  invoke<K extends IpcChannel>(channel: K, ...args: IpcMap[K]['args']): Promise<IpcMap[K]['result']> {
    return bridge().invoke(channel, ...args)
  },

  on<K extends IpcEventChannel>(channel: K, listener: (payload: IpcEvents[K]) => void): () => void {
    if (typeof window === 'undefined' || !window.sonic) return () => undefined
    return window.sonic.on(channel, listener)
  },

  platform: (typeof window !== 'undefined' && window.sonic?.platform) || 'win32'
}

export const isMac = ipc.platform === 'darwin'
