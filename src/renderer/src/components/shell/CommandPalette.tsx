import { useMemo, type ReactNode } from 'react'
import {
  Download,
  FolderOpen,
  Library,
  ListChecks,
  Palette,
  Pause,
  Play,
  RefreshCw,
  RotateCcw,
  Settings as SettingsIcon,
  Wand2
} from 'lucide-react'
import { AppleSpotlight, type SpotlightItem } from '@/components/obsidian/AppleSpotlight'
import { PRESETS } from '@shared/presets'
import { formatBpm } from '@shared/format'
import { useApp } from '@/store/app'
import { toast } from '@/components/ui/Toaster'
import { usePlaybackActions } from '@/features/playback/playbackSession'
import type { LibraryBeat } from '@shared/domain'

const NO_BEATS: LibraryBeat[] = []

/** The ⌘K surface: navigation, queue control, appearance and beat search. */
export function CommandPalette(): ReactNode {
  const { playOne } = usePlaybackActions()
  const open = useApp((state) => state.commandOpen)
  const setCommandOpen = useApp((state) => state.setCommandOpen)
  const setView = useApp((state) => state.setView)
  const setLibraryFocus = useApp((state) => state.setLibraryFocus)
  const library = useApp((state) => open ? state.library : NO_BEATS)
  const ready = useApp((state) => open ? state.queue.jobs.reduce((count, job) => count + Number(job.stage === 'ready'), 0) : 0)
  const failed = useApp((state) => open ? state.queue.jobs.reduce((count, job) => count + Number(job.stage === 'failed'), 0) : 0)
  const paused = useApp((state) => state.queue.paused)
  const settings = useApp((state) => state.settings)

  const beatItems = useMemo<SpotlightItem[]>(() => library.flatMap(beat => {
    const meta = [beat.bpm != null ? `${formatBpm(beat.bpm)} BPM` : null, beat.camelot ?? beat.key].filter(Boolean).join(' · ')
    const keywords = `${beat.producer ?? ''} ${beat.sourceChannel ?? ''} ${beat.fileName} ${beat.format} ${beat.bpm ?? ''} ${beat.key ?? ''} ${beat.camelot ?? ''}`
    const entry: SpotlightItem = {
      id: `beat-${beat.id}`, group: 'Beats',
      label: beat.producer ? `${beat.title} — ${beat.producer}` : beat.title,
      hint: meta || undefined, keywords,
      onSelect: () => { setView('library'); setLibraryFocus(beat.id) }
    }
    return beat.missing || beat.fileAccessError ? [entry] : [entry, {
      id: `play-beat-${beat.id}`, group: 'Play beats', label: `Play ${beat.title}`,
      hint: meta || undefined, icon: <Play />, keywords: `${keywords} audition listen`,
      onSelect: () => playOne(beat.id)
    }]
  }), [library, setLibraryFocus, setView, playOne])

  const items = useMemo<SpotlightItem[]>(() => {
    if (!open) return []
    const list: SpotlightItem[] = []

    list.push(
      {
        id: 'nav-download',
        group: 'Navigate',
        label: 'Go to Download',
        icon: <Download />,
        keywords: 'queue intake paste links',
        onSelect: () => setView('download')
      },
      {
        id: 'nav-library',
        group: 'Navigate',
        label: 'Go to Library',
        icon: <Library />,
        keywords: 'beats archive browse search',
        onSelect: () => setView('library')
      },
      {
        id: 'nav-settings',
        group: 'Navigate',
        label: 'Go to Settings',
        icon: <SettingsIcon />,
        keywords: 'preferences engine output appearance',
        onSelect: () => setView('settings')
      }
    )

    if (ready > 0) {
      list.push({
        id: 'queue-start-all',
        group: 'Queue',
        label: `Start ${ready} ready download${ready === 1 ? '' : 's'}`,
        icon: <Play />,
        keywords: 'begin export run',
        onSelect: () => {
          void useApp.getState().startJobs(null)
        }
      })
    }

    if (failed > 0) {
      list.push({
        id: 'queue-retry-failed',
        group: 'Queue',
        label: `Retry ${failed} failed download${failed === 1 ? '' : 's'}`,
        icon: <RotateCcw />,
        keywords: 'again redo error cancelled',
        onSelect: () => {
          void window.sonic.invoke('queue:retryFailed').then(queue => useApp.getState().setQueueSnapshot(queue))
        }
      })
    }

    list.push(
      {
        id: 'queue-pause',
        group: 'Queue',
        label: paused ? 'Resume the queue' : 'Pause the queue',
        icon: paused ? <Play /> : <Pause />,
        keywords: 'halt stop hold continue',
        onSelect: () => {
          void useApp.getState().setPaused(!paused)
        }
      },
      {
        id: 'queue-clear',
        group: 'Queue',
        label: 'Clear finished jobs',
        icon: <ListChecks />,
        keywords: 'tidy cleanup remove completed',
        onSelect: () => {
          void useApp.getState().clearFinished()
        }
      },
      {
        id: 'library-rescan',
        group: 'Library',
        label: 'Rescan the library',
        icon: <RefreshCw />,
        keywords: 'refresh recheck missing files',
        onSelect: () => {
          void useApp.getState().rescanLibrary()
        }
      },
      {
        id: 'library-reveal',
        group: 'Library',
        label: 'Open the export folder',
        icon: <FolderOpen />,
        keywords: 'explorer finder destination downloads',
        onSelect: () => {
          if (settings.downloadDir) void window.sonic.invoke('app:openDirectory', 'downloads')
        }
      },
      {
        id: 'engine-setup',
        group: 'Media engine',
        label: 'Set up the media engine',
        icon: <Wand2 />,
        keywords: 'yt-dlp ffmpeg install repair download tools',
        onSelect: () => {
          void useApp.getState().setupEngine()
        }
      },
      {
        id: 'theme-cycle',
        group: 'Appearance',
        label: `Theme: ${settings.theme} — switch`,
        icon: <Palette />,
        keywords: 'dark light system mode colour color',
        onSelect: () => {
          void useApp.getState().cycleTheme()
        }
      }
    )

    for (const preset of PRESETS) {
      if (preset.id === settings.defaultPresetId) continue
      list.push({
        id: `preset-${preset.id}`,
        group: 'Default format',
        label: `Use ${preset.label} by default`,
        hint: preset.short,
        keywords: `preset format output ${preset.extension}`,
        onSelect: () => {
          void useApp.getState().patchSettings({ defaultPresetId: preset.id }).then(() => {
            toast({ kind: 'success', title: `New downloads will export as ${preset.label}` })
          }).catch(error => toast({ kind: 'error', title: 'Format was not saved', description: String(error) }))
        }
      })
    }

    // The catalog is complete; only the rendered results are capped by Spotlight.
    return list.concat(beatItems)
  }, [open, ready, failed, beatItems, paused, settings.defaultPresetId, settings.downloadDir, settings.theme, setView])

  return (
    <AppleSpotlight
      open={open}
      onClose={() => setCommandOpen(false)}
      items={items}
      placeholder="Search beats, commands and settings…"
      emptyLabel="No beats or commands match that."
    />
  )
}
