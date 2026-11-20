import { EventEmitter } from 'node:events'
import type { AccentId, ChannelMode, PresetId, ReduceMotionPreference, Settings, ThemeMode } from '@shared/domain'
import { PRESET_MAP, DEFAULT_PRESET_ID } from '@shared/presets'
import { DEFAULT_NAMING_TEMPLATE } from '@shared/template'
import { JsonStore } from '../lib/jsonStore'
import { clamp } from '@shared/format'
import { defaultDownloadDir, settingsFile } from './paths'

const THEMES: ThemeMode[] = ['dark', 'light', 'system']
const ACCENTS: AccentId[] = ['violet', 'cyan', 'emerald', 'amber', 'rose']
const CHANNEL_MODES: ChannelMode[] = ['preserve', 'stereo', 'mono']
const REDUCE_MOTION: ReduceMotionPreference[] = ['system', 'on', 'off']
const BROWSERS = ['none', 'chrome', 'edge', 'firefox', 'brave', 'opera', 'vivaldi'] as const

export function defaultSettings(): Settings {
  return {
    theme: 'dark',
    accent: 'violet',
    reduceMotion: 'system',

    downloadDir: defaultDownloadDir(),
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
}

/** Coerces anything read off disk into a valid Settings object. */
function normalizeSettings(raw: unknown): Settings {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('Invalid settings record')
  const source = (raw ?? {}) as Partial<Settings>
  const base = defaultSettings()

  const presetId =
    source.defaultPresetId && source.defaultPresetId in PRESET_MAP
      ? (source.defaultPresetId as PresetId)
      : base.defaultPresetId

  return {
    theme: THEMES.includes(source.theme as ThemeMode) ? (source.theme as ThemeMode) : base.theme,
    accent: ACCENTS.includes(source.accent as AccentId) ? (source.accent as AccentId) : base.accent,
    reduceMotion: REDUCE_MOTION.includes(source.reduceMotion as ReduceMotionPreference)
      ? (source.reduceMotion as ReduceMotionPreference)
      : base.reduceMotion,

    downloadDir:
      typeof source.downloadDir === 'string' && source.downloadDir.trim().length > 0
        ? source.downloadDir
        : base.downloadDir,
    defaultPresetId: presetId,
    namingTemplate:
      typeof source.namingTemplate === 'string' && source.namingTemplate.trim().length > 0
        ? source.namingTemplate
        : base.namingTemplate,
    concurrency: clamp(Math.round(Number(source.concurrency ?? base.concurrency)) || 1, 1, 3),
    autoStart: source.autoStart !== false,
    channelMode: CHANNEL_MODES.includes(source.channelMode as ChannelMode)
      ? (source.channelMode as ChannelMode)
      : base.channelMode,
    normalizeLufs:
      source.normalizeLufs == null
        ? null
        : clamp(Number(source.normalizeLufs), -24, -8) || null,
    embedTags: source.embedTags !== false,
    writeSidecar: source.writeSidecar !== false,
    sidecarInSubfolder: source.sidecarInSubfolder !== false,
    embedThumbnail: source.embedThumbnail !== false,

    analyzeOnDownload: source.analyzeOnDownload !== false,
    analysisConcurrency: clamp(Math.round(Number(source.analysisConcurrency ?? base.analysisConcurrency)) || 1, 1, 4),
    rewriteTagsOnEdit: source.rewriteTagsOnEdit === true,

    ytdlpPath: typeof source.ytdlpPath === 'string' && source.ytdlpPath.length > 0 ? source.ytdlpPath : null,
    ffmpegPath:
      typeof source.ffmpegPath === 'string' && source.ffmpegPath.length > 0 ? source.ffmpegPath : null,
    ffprobePath:
      typeof source.ffprobePath === 'string' && source.ffprobePath.length > 0 ? source.ffprobePath : null,

    maxDurationSec: clamp(Math.round(Number(source.maxDurationSec ?? base.maxDurationSec)) || 0, 0, 24 * 3600),
    skipExisting: source.skipExisting !== false,
    cookiesFromBrowser: BROWSERS.includes(source.cookiesFromBrowser as (typeof BROWSERS)[number])
      ? (source.cookiesFromBrowser as Settings['cookiesFromBrowser'])
      : 'none',
    // Settings files written before this option existed have no field; they
    // migrate to the safe default (registry sites only).
    allowOtherSites: source.allowOtherSites === true,

    rescanIntervalMs: clamp(Math.round(Number(source.rescanIntervalMs ?? base.rescanIntervalMs)) || 0, 0, 3_600_000),

    // Older settings files have no value: the watch stays off until chosen.
    watchClipboard: source.watchClipboard === true
  }
}

class SettingsService extends EventEmitter {
  private store: JsonStore<Settings>

  constructor() {
    super()
    this.store = new JsonStore<Settings>(settingsFile(), defaultSettings(), normalizeSettings)
  }

  get(): Settings {
    return this.store.read()
  }

  patch(patch: Partial<Settings>): Settings {
    const next = normalizeSettings({ ...this.get(), ...patch })
    const written = this.store.write(next)
    this.emit('changed', written)
    return written
  }

  /** Resets every field to its factory value, keeping explicit tool paths. */
  reset(): Settings {
    const current = this.get()
    const next = normalizeSettings({
      ...defaultSettings(),
      ytdlpPath: current.ytdlpPath,
      ffmpegPath: current.ffmpegPath,
      ffprobePath: current.ffprobePath
    })
    const written = this.store.write(next)
    this.emit('changed', written)
    return written
  }
}

export const settingsService = new SettingsService()
