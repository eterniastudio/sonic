import type { LibraryBeat } from '@shared/domain'
import type { PlaybackCheckpoint, PlaybackSessionSnapshot } from '@shared/playback'

export type PlaybackStatus = 'idle' | 'loading' | 'ready' | 'playing' | 'paused' | 'ended' | 'error'

export interface PlaybackState {
  beatId: string | null
  closing: boolean
  status: PlaybackStatus
  current: number
  duration: number
  volume: number
  repeat: boolean
  queueContext: { label: string; index: number; count: number } | null
  error: string | null
  saveError: string | null
}

export interface PlaybackEngine {
  load(url: string): Promise<void>
  play(): Promise<void>
  pause(): void
  stop(): void
  setTime(seconds: number): void
  getDuration(): number
  setVolume(volume: number): void
  setColors?(wave: string, progress: string): void
  on(event: 'play' | 'pause' | 'timeupdate' | 'interaction' | 'finish' | 'error', callback: (value?: unknown) => void): void
  destroy(): void
}

export interface PlaybackControllerOptions {
  getBeat: (id: string) => LibraryBeat | undefined
  /** Resolves current bytes behind the ID without exposing a filesystem path. */
  identify: (id: string) => Promise<string>
  createEngine: (container: HTMLElement) => PlaybackEngine
  checkpoint: (command: PlaybackCheckpoint) => void
  onNotice?: (message: string) => void
  now?: () => number
}

const PREVIOUS_RESTART_THRESHOLD_SEC = 3
const PROGRESS_CHECKPOINT_MS = 20_000
const PROGRESS_PUBLISH_MS = 100

function validSeconds(value: number): number {
  return Number.isFinite(value) ? Math.max(0, value) : 0
}

function clampVolume(value: number): number {
  return Number.isFinite(value) ? Math.min(1, Math.max(0, value)) : 1
}

/** Owns the sole live decoder. Every load and event callback is generation checked. */
export class PlaybackController {
  private state: PlaybackState = {
    beatId: null, closing: false, status: 'idle', current: 0, duration: 0, volume: 1,
    repeat: false, queueContext: null, error: null, saveError: null
  }
  private readonly listeners = new Set<() => void>()
  private container: HTMLElement | null = null
  private engine: PlaybackEngine | null = null
  private generation = 0
  private activeFingerprint: string | null = null
  private activeLibraryFingerprint: string | null = null
  private activePath: string | null = null
  private autoplay = false
  private queueIds: string[] = []
  private queueLabel = ''
  private queueIndex = -1
  private positions = new Map<string, { fingerprint: string; positionSec: number; completed: boolean }>()
  private lastProgressCheckpoint = 0
  private lastProgressPublished = -Infinity
  private latestPosition = 0
  private seekTimer: ReturnType<typeof setTimeout> | null = null
  private disposed = false

  constructor(private readonly options: PlaybackControllerOptions) {}

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  getSnapshot = (): PlaybackState => this.state

  private update(patch: Partial<PlaybackState>): void {
    if ((Object.keys(patch) as (keyof PlaybackState)[]).every(key => Object.is(this.state[key], patch[key]))) return
    this.state = { ...this.state, ...patch }
    this.listeners.forEach(listener => listener())
  }

  attachWaveform = (container: HTMLElement | null): void => {
    if (this.disposed || this.state.closing || this.container === container) return
    this.container = container
    this.invalidateEngine()
    if (container && this.state.beatId) void this.loadTrack(this.state.beatId, false, false)
  }

  restore(snapshot: PlaybackSessionSnapshot): void {
    if (this.disposed || this.state.closing) return
    this.positions.clear()
    for (const entry of snapshot.positions) {
      if (entry.beatId && entry.fingerprint && Number.isFinite(entry.positionSec)) {
        this.positions.set(entry.beatId, {
          fingerprint: entry.fingerprint,
          positionSec: validSeconds(entry.positionSec),
          completed: entry.completed
        })
      }
    }
    const volume = clampVolume(snapshot.volume)
    const beat = snapshot.lastTrackId ? this.options.getBeat(snapshot.lastTrackId) : undefined
    this.latestPosition = 0
    const available = beat && !beat.missing && !beat.fileAccessError
    this.update({ beatId: available ? beat.id : null, status: available ? 'paused' : 'idle', current: 0, duration: beat?.durationSec ?? 0, volume, error: null })
    this.engine?.setVolume(volume)
    if (this.container && available) void this.loadTrack(beat.id, false, false)
  }

  playOne = (id: string): void => {
    if (this.state.closing) return
    this.queueIds = []
    this.queueIndex = -1
    this.queueLabel = ''
    void this.loadTrack(id, true, true)
  }

  playQueue = (ids: readonly string[], startId: string, label: string): void => {
    if (this.state.closing) return
    const seen = new Set<string>()
    this.queueIds = ids.filter(id => {
      if (!id || seen.has(id)) return false
      seen.add(id)
      return true
    })
    this.queueLabel = label.trim() || 'Audition queue'
    this.queueIndex = this.queueIds.indexOf(startId)
    if (this.queueIndex < 0) this.queueIndex = 0
    const next = this.findPlayable(this.queueIndex, 1, true)
    if (next < 0) {
      this.clearActive('No playable tracks in this audition queue.')
      return
    }
    this.queueIndex = next
    void this.loadTrack(this.queueIds[next], true, true)
  }

  private findPlayable(from: number, direction: 1 | -1, includeFrom = false): number {
    for (let index = includeFrom ? from : from + direction;
      index >= 0 && index < this.queueIds.length;
      index += direction) {
      const beat = this.options.getBeat(this.queueIds[index])
      if (beat && !beat.missing && !beat.fileAccessError) return index
      this.options.onNotice?.('A missing or removed track was skipped in the audition queue.')
    }
    return -1
  }

  private context(): PlaybackState['queueContext'] {
    return this.queueIndex >= 0 && this.queueIndex < this.queueIds.length
      ? { label: this.queueLabel, index: this.queueIndex + 1, count: this.queueIds.length }
      : null
  }

  private savedPosition(beat: LibraryBeat, fingerprint: string): number {
    const saved = this.positions.get(beat.id)
    if (!saved || saved.fingerprint !== fingerprint || saved.completed) return 0
    // The library's duration can be absent or stale. Clamp only after decode.
    return validSeconds(saved.positionSec)
  }

  private checkpointPosition(completed = this.state.status === 'ended'): void {
    const id = this.state.beatId
    const beat = id ? this.options.getBeat(id) : undefined
    if (!beat || !this.activeFingerprint) return
    // Progress paints are bounded, but persistence always uses the latest frame.
    const positionSec = completed ? this.state.duration : this.latestPosition
    if (!Number.isFinite(positionSec)) return
    this.positions.set(id!, { fingerprint: this.activeFingerprint, positionSec, completed })
    this.options.checkpoint({ type: 'position', beatId: id!, fingerprint: this.activeFingerprint, positionSec, completed })
    this.lastProgressCheckpoint = (this.options.now ?? Date.now)()
  }

  private invalidateEngine(): void {
    this.generation += 1
    this.autoplay = false
    const old = this.engine
    this.engine = null
    if (old) old.destroy()
  }

  private async loadTrack(id: string, play: boolean, saveActive: boolean, force = false): Promise<void> {
    if (this.disposed || this.state.closing) return
    const beat = this.options.getBeat(id)
    if (!beat || beat.missing || beat.fileAccessError) {
      this.clearActive('This track is missing or was removed from the library.')
      return
    }
    if (!force && this.state.beatId === id && this.engine && this.state.status !== 'error') {
      this.update({ queueContext: this.context() })
      if (play) this.resume()
      return
    }
    if (this.state.beatId && this.state.beatId !== id) this.checkpointPosition()
    this.invalidateEngine()
    this.activeFingerprint = null
    this.activeLibraryFingerprint = beat.fingerprint
    this.activePath = beat.filePath
    const generation = this.generation
    this.autoplay = play
    this.latestPosition = 0
    this.lastProgressPublished = -Infinity
    this.update({ beatId: id, status: this.container ? 'loading' : 'paused', current: 0,
      duration: beat.durationSec, queueContext: this.context(), error: null })
    if (saveActive) this.options.checkpoint({ type: 'active', beatId: id })
    if (!this.container) return

    let fingerprint: string
    try {
      fingerprint = await this.options.identify(id)
    } catch (error) {
      if (generation === this.generation) this.loadFailed(error)
      return
    }
    if (this.disposed || this.state.closing || generation !== this.generation || !this.container) return
    this.activeFingerprint = fingerprint
    const position = this.savedPosition(beat, fingerprint)
    this.latestPosition = position
    this.update({ current: position })
    try {
      const engine = this.options.createEngine(this.container)
      this.engine = engine
      engine.setVolume(this.state.volume)
      const live = (): boolean => !this.disposed && generation === this.generation && this.engine === engine
      engine.on('play', () => {
        if (!live()) return
        if (this.autoplay) this.update({ status: 'playing' })
        else engine.pause()
      })
      engine.on('pause', () => {
        if (live() && this.state.status === 'playing') this.update({ status: 'paused', current: this.latestPosition })
      })
      engine.on('timeupdate', value => {
        if (!live() || typeof value !== 'number' || !Number.isFinite(value)) return
        this.latestPosition = validSeconds(value)
        const now = (this.options.now ?? Date.now)()
        // WaveSurfer keeps its waveform smooth at frame rate. React's controls
        // need at most ten progress paints per second, plus immediate seeks.
        if (this.state.status !== 'playing' || now - this.lastProgressPublished >= PROGRESS_PUBLISH_MS) {
          this.lastProgressPublished = now
          this.update({ current: this.latestPosition })
        }
        if (this.state.status === 'playing' && now - this.lastProgressCheckpoint >= PROGRESS_CHECKPOINT_MS) this.checkpointPosition()
      })
      engine.on('interaction', value => {
        // WaveSurfer owns the actual seek, including its paused drag debounce.
        // An interaction previews the target; timeupdate confirms the position.
        if (live() && typeof value === 'number' && Number.isFinite(value)) this.publishSeek(value)
      })
      engine.on('finish', () => { if (live()) this.onFinish() })
      engine.on('error', value => {
        if (live()) this.loadFailed(value)
      })
      await engine.load(`sonic-media://beat/${encodeURIComponent(id)}?identity=${encodeURIComponent(fingerprint)}`)
      if (!live() || this.state.status === 'error') return
      const duration = validSeconds(engine.getDuration())
      const current = Math.min(position, Math.max(0, duration - 0.25))
      if (current > 0) engine.setTime(current)
      this.latestPosition = current
      this.update({ status: 'ready', current, duration })
      if (this.autoplay) await this.startPlaying(engine, generation)
      else this.update({ status: 'paused' })
    } catch (error) {
      if (this.disposed || generation !== this.generation) return
      if (this.state.status !== 'error') this.loadFailed(error)
    }
  }

  private loadFailed(error: unknown): void {
    const shouldPlay = this.autoplay
    // Release decoded buffers and AudioContext on every failure, including
    // synchronous construction/setup errors and errors after playback starts.
    this.invalidateEngine()
    const message = error instanceof Error ? error.message : String(error)
    this.update({ status: 'error', current: this.latestPosition, error: message })
    this.options.onNotice?.(`This track could not be played: ${message}`)
    if (this.queueIndex >= 0) {
      const next = this.findPlayable(this.queueIndex, 1)
      if (next >= 0) {
        this.queueIndex = next
        void this.loadTrack(this.queueIds[next], shouldPlay, true)
      }
    }
  }

  private async startPlaying(engine: PlaybackEngine, generation: number): Promise<void> {
    try {
      if (!this.autoplay || generation !== this.generation || this.engine !== engine) return
      await engine.play()
      if (generation === this.generation && this.engine === engine) {
        if (this.autoplay) this.update({ status: 'playing' })
        else engine.pause()
      }
    } catch (error) {
      if (generation !== this.generation || this.engine !== engine || !this.autoplay) return
      this.loadFailed(error)
    }
  }

  private onFinish(): void {
    // WaveSurfer can emit pause before a natural finish. `autoplay` remains
    // true for that event, but a user Pause clears it before any late finish.
    if (!this.autoplay || this.state.closing || this.state.status === 'ended') return
    this.autoplay = false
    this.latestPosition = this.state.duration
    this.update({ status: 'ended', current: this.state.duration })
    this.checkpointPosition(true)
    if (this.state.repeat) {
      this.seek(0)
      this.resume()
      return
    }
    if (this.queueIndex >= 0) this.next(true)
  }

  private resume(): void {
    if (!this.state.beatId) return
    if (this.state.status === 'error') {
      void this.loadTrack(this.state.beatId, true, false, true)
      return
    }
    this.autoplay = true
    if (this.state.status === 'loading') return
    if (this.state.status === 'ended') this.seek(0)
    if (!this.engine) {
      void this.loadTrack(this.state.beatId, true, false)
      return
    }
    void this.startPlaying(this.engine, this.generation)
  }

  toggle = (): void => {
    if (this.state.closing) return
    if (this.state.status === 'playing' || (this.state.status === 'loading' && this.autoplay)) this.pause()
    else this.resume()
  }

  pause = (): void => {
    if (this.state.closing) return
    this.autoplay = false
    this.engine?.pause()
    if (this.state.beatId && this.state.status !== 'error' && this.state.status !== 'ended') {
      this.update({ status: this.state.status === 'loading' ? 'loading' : 'paused', current: this.latestPosition })
    }
    this.checkpointPosition()
  }

  stop = (): void => {
    if (this.state.closing) return
    this.clearActive(null)
  }

  private clearActive(message: string | null): void {
    // This path also handles a wholly invalid new queue. Preserve the prior
    // audible track before the decoder and active ID are released.
    this.checkpointPosition()
    this.invalidateEngine()
    this.queueIds = []
    this.queueIndex = -1
    this.queueLabel = ''
    this.activeFingerprint = null
    this.activeLibraryFingerprint = null
    this.activePath = null
    this.latestPosition = 0
    this.update({ beatId: null, status: message ? 'error' : 'idle', current: 0,
      duration: 0, queueContext: null, error: message })
    this.options.checkpoint({ type: 'active', beatId: null })
  }

  next = (natural = false): void => {
    if (this.state.closing) return
    if (this.queueIndex < 0) {
      if (natural) this.update({ status: 'ended' })
      return
    }
    const play = natural || this.state.status === 'playing' || (this.state.status === 'loading' && this.autoplay)
    const next = this.findPlayable(this.queueIndex, 1)
    if (next < 0) {
      if (natural) this.update({ status: 'ended' })
      else this.options.onNotice?.('End of audition queue.')
      return
    }
    this.queueIndex = next
    void this.loadTrack(this.queueIds[next], play, true)
  }

  previous = (): void => {
    if (this.state.closing) return
    if (this.latestPosition > PREVIOUS_RESTART_THRESHOLD_SEC) {
      this.seek(0)
      return
    }
    if (this.queueIndex < 0) {
      this.seek(0)
      return
    }
    const previous = this.findPlayable(this.queueIndex, -1)
    if (previous < 0) { this.seek(0); return }
    const play = this.state.status === 'playing' || (this.state.status === 'loading' && this.autoplay)
    this.queueIndex = previous
    void this.loadTrack(this.queueIds[previous], play, true)
  }

  seek = (seconds: number): void => {
    if (this.state.closing) return
    if (!this.state.beatId) return
    const current = Math.min(validSeconds(seconds), this.state.duration || Number.MAX_SAFE_INTEGER)
    this.latestPosition = current
    this.engine?.setTime(current)
    this.publishSeek(current)
  }

  private publishSeek(seconds: number): void {
    const current = Math.min(validSeconds(seconds), this.state.duration || Number.MAX_SAFE_INTEGER)
    this.update({ current, status: this.state.status === 'ended' && current < this.state.duration ? 'paused' : this.state.status })
    if (this.seekTimer) clearTimeout(this.seekTimer)
    this.seekTimer = setTimeout(() => { this.seekTimer = null; this.checkpointPosition() }, 250)
  }

  checkpointNow = (): void => {
    if (this.seekTimer) { clearTimeout(this.seekTimer); this.seekTimer = null }
    this.checkpointPosition()
  }

  setVolume = (volume: number): void => {
    if (this.state.closing) return
    const next = clampVolume(volume)
    this.engine?.setVolume(next)
    this.update({ volume: next })
    this.options.checkpoint({ type: 'volume', volume: next })
  }

  setRepeat = (repeat: boolean): void => {
    if (!this.state.closing) this.update({ repeat })
  }

  /** Latches the renderer into teardown and releases the live decoder. */
  beginClosing = (): void => {
    if (this.state.closing) return
    this.pause()
    this.checkpointNow()
    this.invalidateEngine()
    this.update({ closing: true, status: this.state.beatId && this.state.status !== 'ended' && this.state.status !== 'error'
      ? 'paused' : this.state.status })
  }

  setSaveError = (error: string | null): void => this.update({ saveError: error })

  setColors = (wave: string, progress: string): void => this.engine?.setColors?.(wave, progress)

  /** A removed/currently missing track releases its decoder; metadata-only updates do nothing. */
  reconcile = (): void => {
    if (this.state.closing) return
    const id = this.state.beatId
    if (!id) return
    const beat = this.options.getBeat(id)
    if (!beat) {
      this.clearActive('The playing track was removed or is now missing.')
    } else if (beat.missing || beat.fileAccessError) {
      // An unavailable record retains its captured queue and content position.
      // Reconnection can then resume it only on an explicit Play action.
      if (this.engine) { this.checkpointPosition(); this.invalidateEngine() }
      this.update({ status: 'error', current: this.latestPosition, error: beat.fileAccessError || 'This audio file is missing. Locate it from the Library.' })
    } else if (this.activeLibraryFingerprint && beat.fingerprint !== this.activeLibraryFingerprint) {
      this.positions.delete(id)
      const play = this.state.status === 'playing' || (this.state.status === 'loading' && this.autoplay)
      void this.loadTrack(id, play, false, true)
      this.options.onNotice?.('The audio changed; its remembered position was reset.')
    } else if (this.activePath && beat.filePath !== this.activePath) {
      this.checkpointPosition()
      this.invalidateEngine()
      this.activePath = beat.filePath
      this.update({ status: 'paused', current: this.latestPosition, error: null })
    }
  }

  dispose = (): void => {
    if (this.disposed) return
    this.disposed = true
    if (this.seekTimer) clearTimeout(this.seekTimer)
    this.invalidateEngine()
    this.listeners.clear()
  }
}

export { PREVIOUS_RESTART_THRESHOLD_SEC }
