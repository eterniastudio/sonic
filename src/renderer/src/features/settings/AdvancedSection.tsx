import { useState, type ReactNode } from 'react'
import { FileWarning, FolderOpen, RefreshCw } from 'lucide-react'
import { ipc } from '@/lib/ipc'
import { useApp } from '@/store/app'
import { Button } from '@/components/ui/Button'
import { Field, Input } from '@/components/ui/Input'
import { Switch } from '@/components/ui/Switch'
import { toast } from '@/components/ui/Toaster'
import { SettingsPanel } from './SettingsPanel'

function Row({ label, value, mono }: { label: string; value: string; mono?: boolean }): ReactNode {
  return (
    <div className="flex items-baseline justify-between gap-4 py-2">
      <span className="shrink-0 text-[12px] text-fg-muted">{label}</span>
      <span
        className={`min-w-0 truncate text-right text-[12px] text-fg ${mono ? 'font-mono' : ''}`}
        title={value}
      >
        {value}
      </span>
    </div>
  )
}

/** Diagnostics, library upkeep and where Sonic keeps its data. */
export function AdvancedSection(): ReactNode {
  const info = useApp((state) => state.info)
  const settings = useApp((state) => state.settings)
  const patchSettings = useApp((state) => state.patchSettings)
  const rescanLibrary = useApp((state) => state.rescanLibrary)
  const library = useApp((state) => state.library)

  const [intervalDraft, setIntervalDraft] = useState(String(Math.round(settings.rescanIntervalMs / 1000)))
  const missingCount = library.filter((beat) => beat.missing).length

  return (
    <div>
      <SettingsPanel title="Library upkeep">
        <div className="divide-y divide-[var(--sonic-border)] [&>div:first-child]:pt-0">
          <Row label="Beats in library" value={String(library.length)} />
          <Row label="Records with missing files" value={String(missingCount)} />
        </div>

        <div className="mt-3 flex flex-wrap items-center gap-2">
          <Button
            variant="secondary"
            leading={<RefreshCw />}
            onClick={() => {
              void rescanLibrary()
              toast({ kind: 'info', title: 'Library rescan started' })
            }}
          >
            Rescan now
          </Button>

          <Button
            variant="secondary"
            leading={<FileWarning />}
            disabled={missingCount === 0}
            onClick={() => {
              // Filtering for missing files lives in the Library; send them there.
              useApp.setState({ view: 'library' })
              toast({
                kind: 'info',
                title: `${missingCount} record${missingCount === 1 ? '' : 's'} with missing files`,
                description: 'Enable Filters → Hide missing to see the rest, or use the warning badge.'
              })
            }}
          >
            Review missing ({missingCount})
          </Button>
        </div>

        <Field
          label="Background rescan interval"
          hint="seconds · 0 disables it"
          note="Checks whether recorded files still exist on your device."
          htmlFor="settings-rescan-interval"
          className="mt-4 border-t border-line pt-4 [&>div>span]:text-[12px] [&>div:last-child]:text-[12px]"
        >
          <Input
            type="number"
            id="settings-rescan-interval"
            min={0}
            max={3600}
            value={intervalDraft}
            onChange={(event) => setIntervalDraft(event.target.value)}
            onBlur={() => {
              const seconds = Math.max(0, Math.min(3600, Number(intervalDraft) || 0))
              setIntervalDraft(String(seconds))
              void patchSettings({ rescanIntervalMs: seconds * 1000 })
            }}
            className="w-28 nums"
          />
        </Field>
      </SettingsPanel>

      <SettingsPanel title="Where Sonic keeps your data">
        <div className="divide-y divide-[var(--sonic-border)] [&>div:first-child]:pt-0">
          <Row label="Version" value={info ? `${info.name} ${info.version}` : '—'} />
          <Row label="Electron" value={info?.electron ?? '—'} />
          <Row label="Chromium" value={info?.chrome ?? '—'} />
          <Row label="Node" value={info?.node ?? '—'} />
          <Row label="Platform" value={info?.platform ?? '—'} />
          <Row label="App data" value={info?.userDataDir ?? '—'} mono />
          <Row label="Exports" value={settings.downloadDir || '—'} mono />
        </div>

        <div className="mt-3 flex flex-wrap gap-2">
          <Button
            variant="secondary"
            leading={<FolderOpen />}
            onClick={() => void ipc.invoke('app:openDirectory', 'userData')}
          >
            Open app data folder
          </Button>
          <Button
            variant="ghost"
            leading={<FolderOpen />}
            onClick={() => void ipc.invoke('app:openDirectory', 'downloads')}
          >
            Open export folder
          </Button>
        </div>
      </SettingsPanel>

      <SettingsPanel title="Link intake" description="Off by default. Sonic reads the clipboard only when its window gains focus.">
        <div className="flex items-start gap-3">
          <Switch checked={settings.watchClipboard} onChange={(next) => void patchSettings({ watchClipboard: next })}
            label="Offer links from the clipboard" />
          <div className="min-w-0">
            <p className="text-[13.5px] text-fg">Offer links from the clipboard</p>
            <p className="mt-0.5 text-[12px] leading-relaxed text-fg-muted">
              When you switch back to Sonic with a YouTube or SoundCloud link copied, a small prompt offers to add it to the
              queue. Links already in the queue are skipped, and nothing is added until you choose Add to queue.
            </p>
          </div>
        </div>
      </SettingsPanel>

      <SettingsPanel title="Privacy">
        <div className="space-y-2 text-[12px] leading-relaxed text-fg-muted">
            <p>
              Sonic has no account, no analytics and no conversion backend. Network access happens
              only when you paste a link, when the media engine is installed, when a thumbnail is
              fetched, and when the installed app checks GitHub Releases for an update.
            </p>
            <p>
              Sidecars record the file <span className="text-fg">name</span> rather than its full
              local path, so they stay safe to share.
            </p>
        </div>
      </SettingsPanel>
    </div>
  )
}
