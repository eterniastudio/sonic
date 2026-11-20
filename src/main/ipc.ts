import { app, clipboard, dialog, ipcMain, shell } from 'electron'
import type { IpcMainInvokeEvent } from 'electron'
import { assertAccepting, ownOperation } from './lifecycle'
import { retryStorage, storageEvents, storageStatus } from './lib/jsonStore'
import type { IpcChannel, IpcMap } from '@shared/ipc'
import { createDraft, parseDeclared } from '@shared/metadata'
import { SAMPLE_METADATA } from '@shared/sample'
import { renderTemplate } from '@shared/template'
import { parseVideoUrl } from '@shared/url'
import { broadcast } from './broadcast'
import { directoryExists, fileExists } from './lib/fsx'
import { libraryAnalysis } from './analysis/libraryAnalysis'
import { engineService } from './services/engine'
import { libraryService } from './services/library'
import { localImportService } from './services/localImport'
import { recoveryService } from './services/recovery'
import { organizationService, validateOrganizationCommand } from './services/organization'
import { batchOperations } from './services/batchOperations'
import { playbackSessionService, validatePlaybackCheckpoint } from './services/playbackSession'
import { validateBatchRequest } from '@shared/batch'
import { defaultDownloadDir } from './services/paths'
import { updateService } from './services/updater'
import { probeUrl } from './services/probe'
import { inspectPlaylist, cancelPlaylist } from './services/playlist'
import { queueService } from './services/queue'
import { reexportBeat } from './services/reexport'
import { exportLibraryList, MAX_DRAG_FILES, resolveDuplicates, startLibraryDrag } from './services/libraryTools'
import { settingsService } from './services/settings'
import {
  closeWindow,
  isWindowMaximized,
  getMainWindow,
  minimizeWindow,
  syncWindowTheme,
  toggleMaximizeWindow
} from './window'

type Handler<K extends IpcChannel> = (
  ...args: IpcMap[K]['args']
) => IpcMap[K]['result'] | Promise<IpcMap[K]['result']>

/** Registers one channel, with the channel list checked at compile time. */
function handle<K extends IpcChannel>(channel: K, handler: Handler<K>): void {
  ipcMain.handle(channel, async (event, ...args: unknown[]) => {
    assertTrustedSender(event)
    assertValidArguments(channel, args)
    const readOnly = /:(get|list|snapshot|status|info|isMaximized|readClipboard|previewTemplate|parse|openSidecar)$/.test(channel)
    if (channel.startsWith('window:') || channel.startsWith('update:') || channel === 'storage:status' || channel === 'storage:retry') return handler(...(args as IpcMap[K]['args']))
    // The shell's close handshake must be able to finish already pending
    // listening checkpoints after new work has been refused.
    if (!readOnly && channel !== 'playback:checkpoint') assertAccepting()
    return ownOperation(async () => {
      const result = await handler(...(args as IpcMap[K]['args']))
      // Queue progress is optimistic/debounced; user-command acknowledgement is a disk commit.
      if (channel.startsWith('queue:') && !readOnly) queueService.flush()
      return result
    })
  })
}

function assertTrustedSender(event: IpcMainInvokeEvent): void {
  const window = getMainWindow()
  if (!window || window.isDestroyed() || event.sender !== window.webContents ||
    event.senderFrame !== window.webContents.mainFrame) {
    throw new Error('IPC request rejected: untrusted sender or frame.')
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isId(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 256
}

function isStringArray(value: unknown, limit = 1000, maxLength = 256): value is string[] {
  return Array.isArray(value) && value.length <= limit && value.every((item) =>
    typeof item === 'string' && item.length > 0 && item.length <= maxLength)
}

const PRESETS = new Set(['original', 'mp3-v0', 'mp3-320', 'm4a-256', 'wav-44100-24', 'wav-48000-24', 'flac', 'opus-192'])
const SETTINGS_OPTIONS: Record<string, ReadonlySet<string>> = {
  theme: new Set(['dark', 'light', 'system']),
  accent: new Set(['violet', 'cyan', 'emerald', 'amber', 'rose']),
  reduceMotion: new Set(['system', 'on', 'off']),
  defaultPresetId: PRESETS,
  channelMode: new Set(['preserve', 'stereo', 'mono']),
  cookiesFromBrowser: new Set(['none', 'chrome', 'edge', 'firefox', 'brave', 'opera', 'vivaldi'])
}
const FIELDS = new Set(['title', 'producer', 'bpm', 'altBpm', 'key', 'camelot', 'detune', 'tuning', 'genre'])
const STRING_FIELDS = new Set(['title', 'producer', 'key', 'camelot', 'tuning', 'genre'])
const NUMBER_FIELDS = new Set(['bpm', 'altBpm', 'detune'])

function isFieldArray(value: unknown): boolean {
  return isStringArray(value, 16) && value.every((field) => FIELDS.has(field))
}

function isMetadataPatch(value: unknown): boolean {
  return isRecord(value) && Object.entries(value).every(([field, entry]) =>
    STRING_FIELDS.has(field) ? entry === null || (typeof entry === 'string' && entry.length <= 2000)
      : NUMBER_FIELDS.has(field) && (entry === null || (typeof entry === 'number' && Number.isFinite(entry))))
}

function isSettingsPatch(value: unknown): boolean {
  if (!isRecord(value)) return false
  const current = settingsService.get() as unknown as Record<string, unknown>
  return Object.entries(value).every(([key, entry]) => {
    if (!Object.hasOwn(current, key)) return false
    if (SETTINGS_OPTIONS[key]) return typeof entry === 'string' && SETTINGS_OPTIONS[key].has(entry)
    if (['normalizeLufs', 'ytdlpPath', 'ffmpegPath', 'ffprobePath'].includes(key) && entry === null) return true
    if (key === 'normalizeLufs') return typeof entry === 'number' && Number.isFinite(entry)
    // Main executes these paths. Only the native engine:pickTool dialog may set
    // one; the renderer can merely reset a tool to automatic discovery.
    if (['ytdlpPath', 'ffmpegPath', 'ffprobePath'].includes(key)) return false
    const original = current[key]
    if (typeof entry !== typeof original) return false
    if (typeof entry === 'string') return entry.length <= 4096
    if (typeof entry === 'number') return Number.isFinite(entry)
    return typeof entry === 'boolean'
  })
}

/** TypeScript contracts do not validate messages from a compromised renderer. */
function assertValidArguments(channel: IpcChannel, args: unknown[]): void {
  const [a, b, c] = args
  let valid = false
  switch (channel) {
    case 'playback:get': case 'storage:status': case 'storage:retry': case 'app:readClipboard': case 'app:info':
    case 'update:status': case 'update:check': case 'update:install':
    case 'window:minimize': case 'window:toggleMaximize': case 'window:close': case 'window:isMaximized':
    case 'engine:status': case 'engine:setup': case 'settings:get': case 'settings:chooseDir': case 'queue:snapshot':
    case 'queue:clearFinished': case 'queue:retryFailed': case 'library:list': case 'library:rescan': case 'import:chooseFiles':
    case 'organization:snapshot':
    case 'analysis:queueMissing': case 'analysis:clearCache': case 'analysis:status':
      valid = args.length === 0; break
    case 'playback:identity': case 'library:retrySidecar': case 'queue:remove': case 'queue:cancel': case 'queue:retry':
    case 'queue:revealOutput': case 'queue:openOutput': case 'library:openSource':
    case 'library:refreshSource': case 'library:revealFile': case 'library:openFile':
    case 'library:openSidecarFile': case 'analysis:cancel':
    case 'import:status': case 'import:cancel': case 'batch:status': case 'batch:cancel': case 'batch:retry':
    case 'recovery:chooseFile': case 'recovery:status': case 'recovery:cancel': case 'playlist:cancel':
      valid = args.length === 1 && isId(a); break
    case 'library:startDrag':
      valid = args.length === 1 && isStringArray(a, MAX_DRAG_FILES) && a.length > 0; break
    case 'library:exportList':
      valid = args.length === 1 && isStringArray(a, 50_000) && a.length > 0; break
    case 'library:resolveDuplicates':
      valid = args.length === 2 && isId(a) && isStringArray(b, 1000) && b.length > 0; break
    case 'recovery:chooseFolder':
      valid = args.length === 1 && isStringArray(a, 10_000) && a.length > 0 && new Set(a).size === a.length; break
    case 'recovery:apply':
      valid = args.length === 2 && isId(a) && Array.isArray(b) && b.length > 0 && b.length <= 10_000 &&
        b.every(item => isRecord(item) && Object.keys(item).length === 2 && isId(item.beatId) && isId(item.candidateId)) &&
        new Set(b.map(item => item.beatId)).size === b.length; break
    case 'organization:command':
      valid = args.length === 1 && validateOrganizationCommand(a); break
    case 'playback:checkpoint':
      valid = args.length === 1 && validatePlaybackCheckpoint(a); break
    case 'batch:start':
      if (args.length === 1) {
        try { validateBatchRequest(a); valid = true } catch { valid = false }
      }
      break
    case 'import:chooseFolder':
      valid = args.length === 1 && typeof a === 'boolean'; break
    case 'import:confirm':
      valid = args.length === 2 && isId(a) && isStringArray(b, 5000); break
    case 'app:openDirectory':
      valid = args.length === 1 && ['userData', 'downloads', 'engine'].includes(a as string); break
    case 'engine:pickTool':
      valid = args.length === 1 && ['yt-dlp', 'ffmpeg', 'ffprobe'].includes(a as string); break
    case 'settings:patch':
      valid = args.length === 1 && isSettingsPatch(a); break
    case 'settings:previewTemplate':
      valid = args.length === 2 && typeof a === 'string' && a.length <= 4096 && PRESETS.has(b as string); break
    case 'probe:url':
      valid = args.length === 1 && typeof a === 'string' && a.length <= 4096; break
    case 'playlist:inspect':
      valid = args.length === 2 && typeof a === 'string' && a.length <= 4096 && isId(b); break
    case 'queue:add':
      valid = args.length === 1 && isStringArray(a, 1000, 4096); break
    case 'queue:reorder':
      valid = args.length === 1 && isStringArray(a); break
    case 'queue:start':
      valid = args.length === 1 && (a === null || isStringArray(a)); break
    case 'queue:setPaused':
      valid = args.length === 1 && typeof a === 'boolean'; break
    case 'queue:setConcurrency':
      valid = args.length === 1 && typeof a === 'number' && Number.isInteger(a) && a >= 1 && a <= 3; break
    case 'queue:updateJob':
      valid = args.length === 2 && isId(a) && isRecord(b) && Object.entries(b).every(([key, value]) => {
        if (key === 'presetId') return PRESETS.has(value as string)
        if (key === 'clearOverrides' || key === 'adoptAnalyzed') return isFieldArray(value)
        if (key === 'metadataEdit') return isRecord(value) && FIELDS.has(value.field as string) &&
          Object.keys(value).every((field) => field === 'field' || field === 'value') &&
          (value.value === null || (typeof value.value === 'string' && value.value.length <= 2000) ||
            (typeof value.value === 'number' && Number.isFinite(value.value)))
        return false
      }); break
    case 'library:updateMetadata':
      valid = (args.length === 2 || args.length === 3) && isId(a) && isMetadataPatch(b) &&
        (args.length === 2 || c === undefined || isFieldArray(c)); break
    case 'library:remove':
      valid = (args.length === 2 || args.length === 3) && isId(a) && typeof b === 'boolean' &&
        (args.length === 2 || c === undefined || (isRecord(c) && typeof c.filePath === 'string' && c.filePath.length <= 4096 && isId(c.fingerprint))); break
    case 'library:reexport':
      valid = args.length === 2 && isId(a) && PRESETS.has(b as string); break
    case 'analysis:beat':
      valid = args.length === 2 && isId(a) && typeof b === 'boolean'; break
    case 'metadata:parse':
      valid = args.length === 1 && isRecord(a) && Object.entries(a).every(([field, value]) =>
        ['title', 'description', 'filename'].includes(field) && (value === null || (typeof value === 'string' && value.length <= 20_000))); break
  }
  if (!valid) throw new Error(`Invalid ${channel} request.`)
}

export function registerIpcHandlers(): void {
  handle('playback:get', () => playbackSessionService.snapshot())
  handle('playback:identity', beatId => playbackSessionService.identity(beatId))
  handle('playback:checkpoint', command => playbackSessionService.checkpoint(command))
  handle('storage:status', () => storageStatus())
  handle('storage:retry', async () => {
    queueService.flush()
    await retryStorage()
    broadcast('settings:changed', settingsService.get())
    broadcast('library:changed', libraryService.list())
    broadcast('organization:changed', organizationService.snapshot())
    return storageStatus()
  })
  handle('library:retrySidecar', id => libraryService.retrySidecar(id))
  handle('app:readClipboard', () => clipboard.readText())
  // ------------------------------------------------------------------ app
  handle('app:info', () => ({
    name: app.getName(),
    version: app.getVersion(),
    electron: process.versions.electron,
    chrome: process.versions.chrome,
    node: process.versions.node,
    platform: process.platform,
    userDataDir: app.getPath('userData'),
    defaultDownloadDir: defaultDownloadDir()
  }))

  handle('update:status', () => updateService.status())
  handle('update:check', () => updateService.check())
  handle('update:install', () => updateService.requestRestart())

  handle('app:openDirectory', async (kind) => {
    const target = kind === 'userData' ? app.getPath('userData') :
      kind === 'engine' ? engineService.directory :
        settingsService.get().downloadDir || defaultDownloadDir()
    if (!(await directoryExists(target))) return false
    const error = await shell.openPath(target)
    return error.length === 0
  })

  // --------------------------------------------------------------- window
  handle('window:minimize', () => {
    minimizeWindow()
  })
  handle('window:toggleMaximize', () => toggleMaximizeWindow())
  handle('window:close', () => {
    closeWindow()
  })
  handle('window:isMaximized', () => isWindowMaximized())

  // --------------------------------------------------------------- engine
  handle('engine:status', () => engineService.status())

  handle('engine:setup', async () => {
    const status = await engineService.setup()
    broadcast('engine:status', status)
    broadcast('app:notice', {
      kind: status.ready ? 'success' : 'error',
      message: status.ready
        ? 'Media engine ready.'
        : (status.lastError ?? 'Some media tools are still missing.')
    })
    return status
  })

  handle('engine:pickTool', async (name) => {
    const label = name === 'yt-dlp' ? 'yt-dlp' : name
    const result = await dialog.showOpenDialog({
      title: `Select the ${label} executable`,
      properties: ['openFile'],
      filters:
        process.platform === 'win32'
          ? [{ name: 'Executables', extensions: ['exe'] }]
          : [{ name: 'All files', extensions: ['*'] }]
    })

    if (result.canceled || result.filePaths.length === 0) return null
    const chosen = result.filePaths[0]

    if (name === 'yt-dlp') settingsService.patch({ ytdlpPath: chosen })
    if (name === 'ffmpeg') settingsService.patch({ ffmpegPath: chosen })
    if (name === 'ffprobe') settingsService.patch({ ffprobePath: chosen })

    engineService.invalidate()
    const status = await engineService.status(true)
    broadcast('engine:status', status)
    return chosen
  })

  // ------------------------------------------------------------- settings
  handle('settings:get', () => settingsService.get())

  handle('settings:patch', (patch) => {
    const before = settingsService.get()
    const next = settingsService.patch(patch)

    if (before.rescanIntervalMs !== next.rescanIntervalMs) {
      libraryService.scheduleRescan(next.rescanIntervalMs)
    }
    if (
      before.ytdlpPath !== next.ytdlpPath ||
      before.ffmpegPath !== next.ffmpegPath ||
      before.ffprobePath !== next.ffprobePath
    ) {
      engineService.invalidate()
    }
    if (next.concurrency !== queueService.snapshot().concurrency) {
      queueService.setConcurrency(next.concurrency)
    }

    syncWindowTheme()
    return next
  })

  handle('settings:chooseDir', async () => {
    const result = await dialog.showOpenDialog({
      title: 'Choose where Sonic saves your beats',
      defaultPath: settingsService.get().downloadDir || defaultDownloadDir(),
      properties: ['openDirectory', 'createDirectory']
    })
    if (result.canceled || result.filePaths.length === 0) return null
    return result.filePaths[0]
  })

  handle('settings:previewTemplate', (template, presetId) =>
    renderTemplate(template, {
      metadata: SAMPLE_METADATA,
      presetId,
      sourceKind: 'youtube',
      index: 1,
      durationSec: 214
    })
  )

  // ---------------------------------------------------------------- probe
  handle('probe:url', (url) => probeUrl(url))
  handle('playlist:inspect', (url, requestId) => inspectPlaylist(url, requestId))
  handle('playlist:cancel', requestId => cancelPlaylist(requestId))

  // ---------------------------------------------------------------- queue
  handle('queue:snapshot', () => queueService.snapshot())
  handle('queue:add', (urls) => queueService.add(urls))
  handle('queue:remove', (id) => queueService.remove(id))
  handle('queue:start', (ids) => queueService.start(ids))
  handle('queue:cancel', (id) => queueService.cancel(id))
  handle('queue:retry', (id) => queueService.retry(id))
  handle('queue:setPaused', (paused) => queueService.setPaused(paused))
  handle('queue:setConcurrency', (value) => queueService.setConcurrency(value))
  handle('queue:reorder', (ids) => queueService.reorder(ids))
  handle('queue:updateJob', (id, patch) => queueService.updateJob(id, patch))
  handle('queue:clearFinished', () => queueService.clearFinished())
  handle('queue:retryFailed', () => {
    for (const job of queueService.snapshot().jobs) {
      if (job.stage === 'failed') queueService.retry(job.id)
    }
    return queueService.snapshot()
  })
  // A library rename or removal outdates the job's recorded path; the record is authoritative.
  const jobOutput = (id: string): string | null => {
    const job = queueService.getJob(id)
    if (!job) return null
    return (job.libraryId ? libraryService.get(job.libraryId)?.filePath : null) ?? job.outputPath
  }
  handle('queue:revealOutput', async (id) => {
    const target = jobOutput(id)
    if (!target || !(await fileExists(target))) return false
    shell.showItemInFolder(target)
    return true
  })
  handle('queue:openOutput', async (id) => {
    const target = jobOutput(id)
    return target && await fileExists(target) ? (await shell.openPath(target)).length === 0 : false
  })

  // -------------------------------------------------------------- library
  handle('library:list', () => libraryService.list())
  const recoveryOwner = (): number => getMainWindow()!.webContents.id
  handle('recovery:chooseFile', async beatId => {
    const owner = recoveryOwner()
    const beat = libraryService.get(beatId)
    if (!beat) throw new Error('This track is no longer in the library.')
    const result = await dialog.showOpenDialog({ title: 'Locate missing audio', properties: ['openFile'],
      filters: [{ name: 'Audio files', extensions: ['mp3', 'wav', 'flac', 'm4a', 'aac', 'ogg', 'opus', 'aif', 'aiff', 'wma'] }, { name: 'All files', extensions: ['*'] }] })
    return { planId: result.canceled || !result.filePaths.length ? null : recoveryService.begin(owner, [beatId], result.filePaths[0], 'file') }
  })
  handle('recovery:chooseFolder', async ids => {
    const owner = recoveryOwner()
    const result = await dialog.showOpenDialog({ title: 'Find missing audio in a moved folder', properties: ['openDirectory'] })
    return { planId: result.canceled || !result.filePaths.length ? null : recoveryService.begin(owner, ids, result.filePaths[0], 'folder') }
  })
  handle('recovery:status', id => recoveryService.status(id, recoveryOwner()))
  handle('recovery:apply', (id, selected) => recoveryService.apply(id, recoveryOwner(), selected))
  handle('recovery:cancel', id => recoveryService.cancel(id, recoveryOwner()))
  handle('organization:snapshot', () => organizationService.snapshot())
  handle('organization:command', command => organizationService.execute(command))
  handle('batch:start', request => batchOperations.start(request))
  handle('batch:status', id => batchOperations.status(id))
  handle('batch:cancel', id => batchOperations.cancel(id))
  handle('batch:retry', id => batchOperations.retry(id))
  handle('import:chooseFiles', async () => {
    const result = await dialog.showOpenDialog({
      title: 'Choose audio to import into Sonic',
      properties: ['openFile', 'multiSelections'],
      filters: [
        { name: 'Audio files', extensions: ['mp3', 'wav', 'flac', 'm4a', 'aac', 'ogg', 'opus', 'aif', 'aiff', 'wma'] },
        { name: 'All files', extensions: ['*'] }
      ]
    })
    return { sessionId: result.canceled || !result.filePaths.length ? null : localImportService.begin(result.filePaths, 'files', false) }
  })
  handle('import:chooseFolder', async (recursive) => {
    const result = await dialog.showOpenDialog({ title: 'Choose an audio folder to import', properties: ['openDirectory'] })
    return { sessionId: result.canceled || !result.filePaths.length ? null : localImportService.begin(result.filePaths, 'folder', recursive) }
  })
  handle('import:status', (sessionId) => localImportService.status(sessionId))
  handle('import:confirm', (sessionId, selectedIds) => localImportService.confirm(sessionId, selectedIds))
  handle('import:cancel', (sessionId) => localImportService.cancel(sessionId))
  handle('library:openSource', async (id) => {
    const url = libraryService.get(id)?.sourceUrl
    if (!url) return false
    // A saved link was admitted at download time; reopening it is not gated by
    // "Allow other sites", but it must still be a clean https URL.
    const parsed = parseVideoUrl(url, { allowOtherSites: true })
    if (!parsed.ok || !parsed.normalized) return false
    await shell.openExternal(parsed.normalized)
    return true
  })
  handle('library:refreshSource', async (id) => {
    const beat = libraryService.get(id)
    if (!beat?.sourceUrl) throw new Error('This beat has no saved source link.')
    const result = await probeUrl(beat.sourceUrl)
    if (result.error || !result.uploader) throw new Error(result.error || 'The source did not return a channel name.')
    libraryService.update(id, { sourceChannel: result.uploader, thumbnail: result.thumbnail })
    if (beat.sidecarPath) await libraryService.retrySidecar(id)
    return libraryService.get(id) ?? null
  })
  handle('library:revealFile', async (id) => {
    const target = libraryService.get(id)?.filePath
    if (!target || !(await fileExists(target))) return false
    shell.showItemInFolder(target)
    return true
  })
  handle('library:openFile', async (id) => {
    const target = libraryService.get(id)?.filePath
    return target && await fileExists(target) ? (await shell.openPath(target)).length === 0 : false
  })
  handle('library:openSidecarFile', async (id) => {
    const target = libraryService.get(id)?.sidecarPath
    return target && await fileExists(target) ? (await shell.openPath(target)).length === 0 : false
  })

  // Returning the whole library here cost about a second per edit at 20,000
  // tracks; the window already receives the change as a delta.
  handle('library:updateMetadata', async (id, patch, clearOverrides) => {
    await libraryService.updateMetadata(id, patch, clearOverrides ?? [])
    return libraryService.get(id) ?? null
  })

  handle('library:remove', async (id, deleteFiles, expected) => {
    const current = libraryService.get(id)
    if (expected && (!current || current.filePath !== expected.filePath || current.fingerprint !== expected.fingerprint)) throw new Error('This export changed after confirmation opened. Review it and try again.')
    libraryAnalysis.cancel(id)
    const result = await libraryService.remove(id, deleteFiles)
    if (!result.ok && result.reason) {
      throw new Error(result.reason)
    }
    return { ok: true as const }
  })

  handle('library:rescan', async () => ({ count: (await libraryService.rescan()).length }))
  handle('library:startDrag', ids => startLibraryDrag(getMainWindow()!.webContents, ids))
  handle('library:exportList', ids => exportLibraryList(ids))
  handle('library:resolveDuplicates', async (keepId, removeIds) => {
    try { return await resolveDuplicates(keepId, removeIds) }
    finally {
      // As for a single removal: stop analysis of every record that actually left.
      for (const id of removeIds) if (id !== keepId && !libraryService.get(id)) libraryAnalysis.cancel(id)
    }
  })

  handle('library:reexport', async (id, presetId) => reexportBeat(id, presetId))

  // ------------------------------------------------------------- metadata
  handle('metadata:parse', (sources) => {
    const { values, evidence, bySource } = parseDeclared(sources)
    return createDraft({ declared: values, evidence, sources: bySource })
  })

  // ------------------------------------------------------------- analysis
  handle('analysis:beat', (id, force) => libraryAnalysis.analyze(id, { force }))

  handle('analysis:cancel', (beatId) => {
    libraryAnalysis.cancel(beatId)
  })

  handle('analysis:queueMissing', () => {
    const pending = libraryService.listNeedingAnalysis()
    const queued = libraryAnalysis.queue(pending.map((beat) => beat.id))
    return { queued }
  })

  handle('analysis:clearCache', () => ({ cleared: libraryAnalysis.clearCache() }))

  handle('analysis:status', () => libraryAnalysis.status())
}

/** Subscribes the renderer to service events. */
export function wireServiceEvents(): void {
  storageEvents.on('changed', () => broadcast('storage:changed', storageStatus()))
  libraryService.on('storage-error', (error: string) => broadcast('app:notice', { kind: 'error', message: error }))
  libraryAnalysis.on('storage-error', (error: string) => broadcast('app:notice', { kind: 'error', message: error }))
  queueService.on('persistence-error', (error: string) => broadcast('app:notice', {
    kind: 'error', message: `Queue changes could not be saved to disk: ${error}`
  }))
  queueService.on('changed', (snapshot) => broadcast('queue:changed', snapshot))
  libraryService.on('changed', (beats) => broadcast('library:changed', beats))
  organizationService.on('changed', (snapshot) => broadcast('organization:changed', snapshot))
  engineService.on('progress', (progress) => broadcast('engine:progress', progress))
  libraryAnalysis.on('progress', (progress) => broadcast('analysis:progress', progress))
  settingsService.on('changed', (settings) => {
    libraryService.scheduleRescan(settings.rescanIntervalMs)
    broadcast('settings:changed', settings)
    syncWindowTheme()
  })
}
