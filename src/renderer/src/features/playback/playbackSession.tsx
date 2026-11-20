import { createContext, useContext, useEffect, useMemo, useRef, useSyncExternalStore, type ReactNode } from 'react'
import WaveSurfer from 'wavesurfer.js'
import type { LibraryBeat } from '@shared/domain'
import type { PlaybackCheckpoint } from '@shared/playback'
import { ipc } from '@/lib/ipc'
import { useApp } from '@/store/app'
import { toast } from '@/components/ui/Toaster'
import { PlaybackController, type PlaybackEngine, type PlaybackState } from './playbackController'
import { drainPlaybackCheckpoints } from './playbackCheckpointDrain'

declare global {
  interface Window {
    /** Main awaits this before normal shutdown; it rejects if persistence remains pending. */
    __sonicPlaybackFlush?: () => Promise<void>
  }
}

interface PlaybackActions {
  playOne: (id: string) => void
  playQueue: (ids: readonly string[], startId: string, label: string) => void
  toggle: () => void
  pause: () => void
  stop: () => void
  previous: () => void
  next: () => void
  seek: (seconds: number) => void
  checkpointNow: () => void
  setVolume: (volume: number) => void
  setRepeat: (repeat: boolean) => void
  attachWaveform: (container: HTMLElement | null) => void
  retrySave: () => Promise<void>
}

const ActionsContext = createContext<PlaybackActions | null>(null)
const StateContext = createContext<PlaybackState | null>(null)
type PlaybackIdentity = Pick<PlaybackState, 'beatId' | 'status'>
const IdentityContext = createContext<PlaybackIdentity | null>(null)

function colors(): { wave: string; progress: string; cursor: string } {
  const styles = getComputedStyle(document.documentElement)
  return {
    wave: styles.getPropertyValue('--sonic-border-strong').trim() || 'rgba(255,255,255,0.2)',
    progress: styles.getPropertyValue('--sonic-accent').trim() || '#7c5cff',
    cursor: styles.getPropertyValue('--sonic-fg-subtle').trim() || '#69707f'
  }
}

function createWaveSurfer(container: HTMLElement): PlaybackEngine {
  const palette = colors()
  // Keep the existing WebAudio backend and local ID-resolved protocol.
  const wave = WaveSurfer.create({
    container,
    height: 25,
    waveColor: palette.wave,
    progressColor: palette.progress,
    cursorColor: palette.cursor,
    cursorWidth: 1,
    barWidth: 2,
    barGap: 1,
    barRadius: 2,
    normalize: true,
    dragToSeek: true,
    backend: 'WebAudio'
  })
  return {
    load: url => wave.load(url),
    play: () => wave.play(),
    pause: () => wave.pause(),
    stop: () => wave.stop(),
    setTime: seconds => wave.setTime(seconds),
    getDuration: () => wave.getDuration(),
    setVolume: volume => wave.setVolume(volume),
    setColors: (waveColor, progressColor) => wave.setOptions({ waveColor, progressColor }),
    on: (event, callback) => {
      switch (event) {
        case 'play': wave.on('play', () => callback()); break
        case 'pause': wave.on('pause', () => callback()); break
        case 'timeupdate': wave.on('timeupdate', time => callback(time)); break
        case 'interaction': wave.on('interaction', time => callback(time)); break
        case 'finish': wave.on('finish', () => callback()); break
        case 'error': wave.on('error', error => callback(error)); break
      }
    },
    destroy: () => {
      // WaveSurfer treats its WebAudio backend as external media, so destroy()
      // removes the waveform without pausing the live source. We own playback.
      try { wave.pause() } finally { wave.destroy() }
    }
  }
}

/** Id lookup over the store's library, rebuilt only when the library array changes. */
let beatIndex: { library: LibraryBeat[]; byId: Map<string, LibraryBeat> } | null = null
function beatById(id: string): LibraryBeat | undefined {
  const library = useApp.getState().library
  if (beatIndex?.library !== library) {
    const byId = new Map<string, LibraryBeat>()
    // First match wins, as with `Array.find`.
    for (const beat of library) if (!byId.has(beat.id)) byId.set(beat.id, beat)
    beatIndex = { library, byId }
  }
  return beatIndex.byId.get(id)
}

/** One live media owner for the entire app shell. The view subtree can remount freely. */
export function PlaybackProvider({ children }: { children: ReactNode }): ReactNode {
  const library = useApp(state => state.library)
  const theme = useApp(state => state.settings.theme)
  const accent = useApp(state => state.settings.accent)
  const controllerRef = useRef<PlaybackController | null>(null)
  const saveRef = useRef({ pending: [] as PlaybackCheckpoint[], drainPromise: null as Promise<void> | null, blocked: false, disposed: false })
  const retryRef = useRef<() => Promise<void>>(async () => undefined)
  const flushRef = useRef<() => Promise<void>>(async () => undefined)
  const disposeTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const userTouched = useRef(false)

  if (!controllerRef.current) {
    const save = saveRef.current
    const controller = new PlaybackController({
      getBeat: beatById,
      identify: async id => (await ipc.invoke('playback:identity', id)).fingerprint,
      createEngine: createWaveSurfer,
      checkpoint: command => {
        const key = (item: PlaybackCheckpoint): string => item.type === 'position' ? `position:${item.beatId}` : item.type
        const protectedIndex = save.drainPromise ? 1 : 0
        save.pending = save.pending.filter((item, index) => index < protectedIndex || key(item) !== key(command))
        save.pending.push(command)
        void drain()
      },
      onNotice: message => toast({ kind: 'info', title: message })
    })
    controllerRef.current = controller

    function drain(): Promise<void> {
      return drainPlaybackCheckpoints(save,
        command => ipc.invoke('playback:checkpoint', command),
        () => controller.setSaveError(null),
        error => controller.setSaveError(error instanceof Error ? error.message : String(error)))
    }
    // The action context captures this retry function below through a ref.
    retryRef.current = async () => {
      try {
        await ipc.invoke('storage:retry')
        save.blocked = false
        await drain()
        if (save.blocked) throw new Error(controller.getSnapshot().saveError ?? 'Playback session still has unsaved changes.')
        // The first failed revision may have committed during storage:retry.
        // Recommit the latest state after replaying later local changes.
        controller.checkpointNow()
        const state = controller.getSnapshot()
        save.pending.push({ type: 'volume', volume: state.volume }, { type: 'active', beatId: state.beatId })
        await drain()
        if (save.blocked) throw new Error(controller.getSnapshot().saveError ?? 'Playback session still has unsaved changes.')
      } catch (error) {
        controller.setSaveError(error instanceof Error ? error.message : String(error))
        throw error
      }
    }
    flushRef.current = async () => {
      controller.beginClosing()
      await drain()
      if (save.blocked || save.pending.length > 0) {
        throw new Error(controller.getSnapshot().saveError ?? 'Listening state could not be saved before closing.')
      }
    }
  }
  const controller = controllerRef.current

  useEffect(() => {
    if (disposeTimer.current) { clearTimeout(disposeTimer.current); disposeTimer.current = null }
    saveRef.current.disposed = false
    window.__sonicPlaybackFlush = () => flushRef.current()
    let live = true
    void ipc.invoke('playback:get').then(snapshot => {
      // A user-initiated play before IPC bootstrap wins over the old session.
      if (live && !userTouched.current) controller.restore(snapshot)
    }).catch(error => controller.setSaveError(error instanceof Error ? error.message : String(error)))
    return () => {
      live = false
      delete window.__sonicPlaybackFlush
      // React StrictMode replays effects in development. Defer release one
      // task so its immediate setup can retain the one media owner.
      disposeTimer.current = setTimeout(() => {
        saveRef.current.disposed = true
        controller.dispose()
      }, 0)
    }
  }, [controller])

  useEffect(() => { controller.reconcile() }, [controller, library])
  useEffect(() => {
    // App's theme-sync effect may run after this child effect in the same
    // commit. Read the final CSS tokens on the next frame without remounting.
    const frame = requestAnimationFrame(() => {
      const palette = colors()
      controller.setColors(palette.wave, palette.progress)
    })
    return () => cancelAnimationFrame(frame)
  }, [controller, theme, accent])

  const state = useSyncExternalStore(controller.subscribe, controller.getSnapshot, controller.getSnapshot)
  const identity = useMemo<PlaybackIdentity>(() => ({ beatId: state.beatId, status: state.status }), [state.beatId, state.status])
  const actions = useMemo<PlaybackActions>(() => ({
    playOne: id => { userTouched.current = true; controller.playOne(id) },
    playQueue: (ids, startId, label) => { userTouched.current = true; controller.playQueue(ids, startId, label) },
    toggle: () => { userTouched.current = true; controller.toggle() },
    pause: () => { userTouched.current = true; controller.pause() },
    stop: () => { userTouched.current = true; controller.stop() },
    previous: () => { userTouched.current = true; controller.previous() },
    next: () => { userTouched.current = true; controller.next() },
    seek: seconds => { userTouched.current = true; controller.seek(seconds) },
    checkpointNow: () => { if (!controller.getSnapshot().closing) controller.checkpointNow() },
    setVolume: volume => { userTouched.current = true; controller.setVolume(volume) },
    setRepeat: repeat => { userTouched.current = true; controller.setRepeat(repeat) },
    attachWaveform: controller.attachWaveform,
    retrySave: () => retryRef.current()
  }), [controller])

  return <ActionsContext.Provider value={actions}><IdentityContext.Provider value={identity}><StateContext.Provider value={state}>{children}</StateContext.Provider></IdentityContext.Provider></ActionsContext.Provider>
}

/** Track/status changes only: Library rows do not subscribe to the moving playhead. */
export function usePlaybackIdentity(): PlaybackIdentity {
  const identity = useContext(IdentityContext)
  if (!identity) throw new Error('Playback identity must be inside PlaybackProvider.')
  return identity
}

/** Commands-only subscription: a moving playhead cannot rerender Library search/cards. */
export function usePlaybackActions(): PlaybackActions {
  const actions = useContext(ActionsContext)
  if (!actions) throw new Error('Playback controls must be inside PlaybackProvider.')
  return actions
}

export function usePlayback(): PlaybackState & PlaybackActions & { beat: LibraryBeat | null } {
  const actions = usePlaybackActions()
  const state = useContext(StateContext)
  if (!state) throw new Error('Playback state must be inside PlaybackProvider.')
  const selectBeat = useMemo(() => {
    let library: LibraryBeat[] | undefined
    let selected: LibraryBeat | null = null
    return (store: ReturnType<typeof useApp.getState>): LibraryBeat | null => {
      if (library !== store.library) {
        library = store.library
        selected = library.find(item => item.id === state.beatId) ?? null
      }
      return selected
    }
  }, [state.beatId])
  const beat = useApp(selectBeat)
  return { ...state, ...actions, beat }
}
