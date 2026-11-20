import { create } from 'zustand'
import type {
  AccentId,
  AppInfo,
  BeatMetadata,
  EngineProgress,
  EngineStatus,
  Job,
  LibraryBeat,
  MetadataField,
  PresetId,
  QueueSnapshot,
  Settings
} from '@shared/domain'
import type { IpcEvents, JobPatch, LibraryDelta } from '@shared/ipc'
import type { UpdateStatus } from '@shared/update'

/** Directly derived from the push channel, so the two can never drift apart. */
export type AnalysisProgressEvent = IpcEvents['analysis:progress']
import { DEFAULT_PRESET_ID } from '@shared/presets'
import { DEFAULT_NAMING_TEMPLATE } from '@shared/template'
import { ipc } from '../lib/ipc'
import { applySnapshotDelta, reuseQueueSnapshot, reuseSnapshotItems } from './snapshots'

export type ViewId = 'download' | 'library' | 'settings'

/** Mirrors the main-process defaults so the first paint is never unstyled. */
const FALLBACK_SETTINGS: Settings = {
  theme: 'dark',
  accent: 'violet',
  reduceMotion: 'system',
  downloadDir: '',
  defaultPresetId: DEFAULT_PRESET_ID,
  namingTemplate: DEFAULT_NAMING_TEMPLATE,
  concurrency: 2,
  autoStart: true,
  channelMode: 'preserve',
  normalizeLufs: null,
  embedTags: true,
  writeSidecar: true,
  sidecarInSubfolder: true,
  embedThumbnail: true,
  analyzeOnDownload: true,
  analysisConcurrency: 1,
  rewriteTagsOnEdit: false,
  ytdlpPath: null,
  ffmpegPath: null,
  ffprobePath: null,
  maxDurationSec: 3600,
  skipExisting: true,
  cookiesFromBrowser: 'none',
  allowOtherSites: false,
  rescanIntervalMs: 120_000,
  watchClipboard: false
}

interface AppState {
  booted: boolean
  /** Why the last bootstrap attempt failed, so the splash can offer a retry. */
  bootError: string | null
  info: AppInfo | null
  settings: Settings
  engine: EngineStatus | null
  engineProgress: EngineProgress | null
  queue: QueueSnapshot
  library: LibraryBeat[]
  view: ViewId
  /** Job currently open in the metadata inspector. */
  selectedJobId: string | null
  commandOpen: boolean
  /** Library entry to scroll to and highlight when the Library view opens. */
  libraryFocusId: string | null
  /** Live analysis progress for a library track, or null. */
  analysisProgress: AnalysisProgressEvent | null
  /** App self-update state; null until the main process answers. */
  update: UpdateStatus | null

  bootstrap: () => Promise<void>
  setView: (view: ViewId) => void
  setSelectedJob: (id: string | null) => void
  setCommandOpen: (open: boolean) => void
  setLibraryFocus: (id: string | null) => void
  setQueueSnapshot: (queue: QueueSnapshot) => void
  setLibrarySnapshot: (library: LibraryBeat[]) => void
  /** Applies a `library:delta` push; falls back to a full fetch if it cannot. */
  applyLibraryDelta: (delta: LibraryDelta) => void

  patchSettings: (patch: Partial<Settings>) => Promise<void>
  chooseDownloadDir: () => Promise<void>
  setAccent: (accent: AccentId) => Promise<void>
  cycleTheme: () => Promise<void>
  toggleAutoStart: () => Promise<void>

  setupEngine: () => Promise<void>
  pickTool: (name: 'yt-dlp' | 'ffmpeg' | 'ffprobe') => Promise<void>

  addUrls: (urls: string[]) => Promise<void>
  startJobs: (ids: string[] | null) => Promise<void>
  cancelJob: (id: string) => Promise<void>
  retryJob: (id: string) => Promise<void>
  removeJob: (id: string) => Promise<void>
  clearFinished: () => Promise<void>
  setPaused: (paused: boolean) => Promise<void>
  setConcurrency: (value: number) => Promise<void>
  reorderJobs: (ids: string[]) => Promise<void>
  updateJob: (id: string, patch: JobPatch) => Promise<void>
  setJobPreset: (id: string, presetId: PresetId) => Promise<void>

  rescanLibrary: () => Promise<void>
  updateBeatMetadata: (
    id: string,
    patch: Partial<BeatMetadata>,
    clearOverrides?: MetadataField[]
  ) => Promise<void>
  removeBeat: (id: string, deleteFiles: boolean, expected?: { filePath: string; fingerprint: string }) => Promise<void>
  reexportBeat: (id: string, presetId: PresetId) => Promise<{ ok: boolean; error: string | null }>

  /** Run (or re-run) acoustic analysis on a library track. Never re-downloads. */
  analyzeBeat: (id: string, force?: boolean) => Promise<{ ok: boolean; error: string | null }>
  cancelAnalysis: (beatId: string) => Promise<void>
  /** Queue every track that has never been analysed. Returns how many were queued. */
  analyzeMissing: () => Promise<number>
  clearAnalysisCache: () => Promise<number>
  setAnalysisProgress: (progress: AnalysisProgressEvent | null) => void
}

const EMPTY_QUEUE: QueueSnapshot = { jobs: [], paused: false, concurrency: 2 }

export const useApp = create<AppState>()((set, get) => ({
  booted: false,
  bootError: null,
  info: null,
  settings: FALLBACK_SETTINGS,
  engine: null,
  engineProgress: null,
  queue: EMPTY_QUEUE,
  library: [],
  view: 'download',
  selectedJobId: null,
  commandOpen: false,
  libraryFocusId: null,
  analysisProgress: null,
  update: null,

  async bootstrap() {
    set({ bootError: null })
    try {
      const [info, settings, engine, queue, library] = await Promise.all([
        ipc.invoke('app:info'),
        ipc.invoke('settings:get'),
        ipc.invoke('engine:status'),
        ipc.invoke('queue:snapshot'),
        ipc.invoke('library:list')
      ])
      set({ info, settings, engine, queue: reuseQueueSnapshot(get().queue, queue),
        library: reuseSnapshotItems(get().library, library), booted: true })
      // Optional: an update status failure must never block the workspace.
      void ipc.invoke('update:status').then((update) => set({ update })).catch(() => undefined)
    } catch (error) {
      set({ bootError: error instanceof Error ? error.message : String(error) })
    }
  },

  setView: (view) => set({ view }),
  setSelectedJob: (selectedJobId) => set({ selectedJobId }),
  setCommandOpen: (commandOpen) => set({ commandOpen }),
  setLibraryFocus: (libraryFocusId) => set({ libraryFocusId }),
  setQueueSnapshot: (queue) => set(state => {
    const next = reuseQueueSnapshot(state.queue, queue)
    return next === state.queue ? state : { queue: next }
  }),
  setLibrarySnapshot: (library) => set(state => {
    const next = reuseSnapshotItems(state.library, library)
    return next === state.library ? state : { library: next }
  }),
  applyLibraryDelta: (delta) => {
    const next = applySnapshotDelta(get().library, delta.ids, delta.changed)
    if (next) {
      if (next !== get().library) set({ library: next })
      return
    }
    void ipc.invoke('library:list').then(library => get().setLibrarySnapshot(library), () => undefined)
  },

  async patchSettings(patch) {
    const settings = await ipc.invoke('settings:patch', patch)
    set({ settings })
  },

  async chooseDownloadDir() {
    const chosen = await ipc.invoke('settings:chooseDir')
    if (chosen) await get().patchSettings({ downloadDir: chosen })
  },

  async setAccent(accent) {
    await get().patchSettings({ accent })
  },

  async cycleTheme() {
    const order: Settings['theme'][] = ['dark', 'light', 'system']
    const current = order.indexOf(get().settings.theme)
    await get().patchSettings({ theme: order[(current + 1) % order.length] })
  },

  async toggleAutoStart() {
    await get().patchSettings({ autoStart: !get().settings.autoStart })
  },

  async setupEngine() {
    const engine = await ipc.invoke('engine:setup')
    set({ engine })
  },

  async pickTool(name) {
    await ipc.invoke('engine:pickTool', name)
  },

  async addUrls(urls) {
    const queue = await ipc.invoke('queue:add', urls)
    get().setQueueSnapshot(queue)
  },

  async startJobs(ids) {
    const queue = await ipc.invoke('queue:start', ids)
    get().setQueueSnapshot(queue)
  },

  async cancelJob(id) {
    const queue = await ipc.invoke('queue:cancel', id)
    get().setQueueSnapshot(queue)
  },

  async retryJob(id) {
    const queue = await ipc.invoke('queue:retry', id)
    get().setQueueSnapshot(queue)
  },

  async removeJob(id) {
    const queue = await ipc.invoke('queue:remove', id)
    set({ queue: reuseQueueSnapshot(get().queue, queue), selectedJobId: get().selectedJobId === id ? null : get().selectedJobId })
  },

  async clearFinished() {
    const queue = await ipc.invoke('queue:clearFinished')
    get().setQueueSnapshot(queue)
  },

  async setPaused(paused) {
    const queue = await ipc.invoke('queue:setPaused', paused)
    get().setQueueSnapshot(queue)
  },

  async setConcurrency(value) {
    const queue = await ipc.invoke('queue:setConcurrency', value)
    set({ queue: reuseQueueSnapshot(get().queue, queue), settings: { ...get().settings, concurrency: queue.concurrency } })
  },

  async reorderJobs(ids) {
    const queue = await ipc.invoke('queue:reorder', ids)
    get().setQueueSnapshot(queue)
  },

  async updateJob(id, patch) {
    const job = await ipc.invoke('queue:updateJob', id, patch)
    if (!job) return
    set({ queue: { ...get().queue, jobs: get().queue.jobs.map((entry) => (entry.id === id ? job : entry)) } })
  },

  async setJobPreset(id, presetId) {
    await get().updateJob(id, { presetId })
  },

  async rescanLibrary() {
    // The refreshed list arrives through the library change push.
    await ipc.invoke('library:rescan')
  },

  async updateBeatMetadata(id, patch, clearOverrides) {
    await ipc.invoke('library:updateMetadata', id, patch, clearOverrides)
  },

  async analyzeBeat(id, force = false) {
    const result = await ipc.invoke('analysis:beat', id, force)
    // The library list arrives through `library:changed`; nothing to set here.
    return { ok: result.ok, error: result.error }
  },

  async cancelAnalysis(beatId) {
    await ipc.invoke('analysis:cancel', beatId)
  },

  async analyzeMissing() {
    const result = await ipc.invoke('analysis:queueMissing')
    return result.queued
  },

  async clearAnalysisCache() {
    const result = await ipc.invoke('analysis:clearCache')
    return result.cleared
  },

  setAnalysisProgress: (analysisProgress) => set({ analysisProgress }),

  async removeBeat(id, deleteFiles, expected) {
    await ipc.invoke('library:remove', id, deleteFiles, expected)
  },

  async reexportBeat(id, presetId) {
    const result = await ipc.invoke('library:reexport', id, presetId)
    const library = await ipc.invoke('library:list')
    get().setLibrarySnapshot(library)
    return { ok: result.ok, error: result.error }
  }
}))

/** Convenience selector: the job currently open in the inspector. */
export function selectSelectedJob(state: AppState): Job | null {
  if (!state.selectedJobId) return null
  return state.queue.jobs.find((job) => job.id === state.selectedJobId) ?? null
}

/** Metadata of the selected job, or null. */
export function selectSelectedMetadata(state: AppState): BeatMetadata | null {
  return selectSelectedJob(state)?.metadata.final ?? null
}
