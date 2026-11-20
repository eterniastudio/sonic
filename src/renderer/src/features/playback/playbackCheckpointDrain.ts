import type { PlaybackCheckpoint } from '@shared/playback'

export interface PlaybackDrainState {
  pending: PlaybackCheckpoint[]
  drainPromise: Promise<void> | null
  blocked: boolean
  disposed: boolean
}

/** Serialize renderer IPC acknowledgements; an empty drain never pins a promise. */
export function drainPlaybackCheckpoints(
  state: PlaybackDrainState,
  send: (command: PlaybackCheckpoint) => Promise<unknown>,
  onSaved: () => void,
  onError: (error: unknown) => void
): Promise<void> {
  if (state.drainPromise) return state.drainPromise
  if (state.blocked || state.disposed || state.pending.length === 0) return Promise.resolve()
  // Defer the body until after assignment even if `send` throws before it
  // returns a Promise (for example, while the IPC bridge is unavailable).
  const running = Promise.resolve().then(async () => {
    try {
      while (state.pending.length > 0 && !state.disposed) {
        try {
          await send(state.pending[0])
          state.pending.shift()
          onSaved()
        } catch (error) {
          state.blocked = true
          onError(error)
          return
        }
      }
    } finally {
      state.drainPromise = null
    }
  })
  state.drainPromise = running
  return running
}
