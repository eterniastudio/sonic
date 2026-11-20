import { useState, type ReactNode } from 'react'
import { Bug, CheckCircle2, CircleAlert, Download, ExternalLink, FileText, FolderOpen, RefreshCw, RotateCw } from 'lucide-react'
import type { UpdateStatus } from '@shared/update'
import { ISSUES_URL, RELEASES_URL } from '@shared/update'
import { ipc } from '@/lib/ipc'
import { useApp } from '@/store/app'
import { Badge } from '@/components/ui/Badge'
import { Button } from '@/components/ui/Button'
import { ProgressBar } from '@/components/ui/Progress'
import { toast } from '@/components/ui/Toaster'
import { SettingsPanel } from './SettingsPanel'

function describe(update: UpdateStatus | null): string {
  if (!update) return 'Checking update status…'
  switch (update.phase) {
    case 'disabled': return update.message ?? 'Automatic updates are off for this build.'
    case 'idle': return 'Sonic checks for updates shortly after it starts and every few hours.'
    case 'checking': return 'Checking GitHub for a newer version…'
    case 'downloading': return `Downloading Sonic ${update.availableVersion ?? ''}…`.replace('  ', ' ')
    case 'ready': return `Sonic ${update.availableVersion} is downloaded. Restart to install it, or it installs the next time you close Sonic.`
    case 'up-to-date': return 'You have the latest version.'
    case 'error': return update.message ?? 'The last update check failed.'
  }
}

function lastChecked(at: number | null): string | null {
  if (!at) return null
  return `Last checked ${new Date(at).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })}`
}

function ExternalLinkButton({ href, icon, children }: { href: string; icon: ReactNode; children: ReactNode }): ReactNode {
  // target=_blank goes through the main process window-open handler, which opens the system browser.
  return (
    <a
      href={href}
      target="_blank"
      rel="noreferrer"
      className="inline-flex h-8 items-center gap-1.5 rounded-[2px] px-3 text-[13.5px] text-fg-muted transition-colors hover:bg-surface-2 hover:text-fg [&_svg]:size-4"
    >
      {icon}
      {children}
      <ExternalLink aria-hidden className="!size-3 text-fg-subtle" />
    </a>
  )
}

/** Version, self-update controls and where to get help. */
export function AboutSection(): ReactNode {
  const info = useApp((state) => state.info)
  const update = useApp((state) => state.update)
  const [checking, setChecking] = useState(false)

  const phase = update?.phase ?? 'disabled'
  const canCheck = phase !== 'disabled' && phase !== 'downloading' && phase !== 'ready' && phase !== 'checking'
  const checked = lastChecked(update?.checkedAt ?? null)

  const badge = phase === 'ready'
    ? <Badge tone="accent" size="sm" className="h-6 text-[12px]" icon={<Download />}>Update ready</Badge>
    : phase === 'up-to-date'
      ? <Badge tone="success" size="sm" className="h-6 text-[12px]" icon={<CheckCircle2 />}>Up to date</Badge>
      : phase === 'error'
        ? <Badge tone="warning" size="sm" className="h-6 text-[12px]" icon={<CircleAlert />}>Check failed</Badge>
        : null

  return (
    <div>
      <SettingsPanel title="Sonic" description={info ? `Version ${info.version}` : undefined}>
        <p className="text-[12px] leading-relaxed text-fg-muted">
          A beat downloader and audio library for music producers. No account, no analytics; your library stays on this
          device.
        </p>
        <div className="mt-3 flex flex-wrap gap-1">
          <ExternalLinkButton href={RELEASES_URL} icon={<FileText />}>Release notes</ExternalLinkButton>
          <ExternalLinkButton href={ISSUES_URL} icon={<Bug />}>Report a problem</ExternalLinkButton>
        </div>
      </SettingsPanel>

      <SettingsPanel title="Updates" description="Delivered from GitHub Releases." accessory={badge} bodyClassName="space-y-3">
        <p role="status" className="text-[12px] leading-relaxed text-fg-muted">{describe(update)}</p>
        {phase === 'downloading' ? <ProgressBar value={update?.percent ?? null} active /> : null}
        {checked && phase !== 'downloading' ? <p className="text-[12px] text-fg-subtle">{checked}</p> : null}

        <div className="flex flex-wrap items-center gap-2">
          {phase === 'ready' ? (
            <Button
              variant="primary"
              leading={<RotateCw />}
              onClick={() => {
                void ipc.invoke('update:install').then((started) => {
                  if (!started) toast({ kind: 'error', title: 'The update is not ready to install yet.' })
                })
              }}
            >
              Restart and update
            </Button>
          ) : null}
          <Button
            variant="secondary"
            leading={<RefreshCw />}
            busy={checking || phase === 'checking'}
            disabled={!canCheck}
            onClick={() => {
              setChecking(true)
              void ipc.invoke('update:check')
                .then((next) => useApp.setState({ update: next }))
                .catch((error) => toast({ kind: 'error', title: 'Update check failed', description: String(error) }))
                .finally(() => setChecking(false))
            }}
          >
            Check for updates
          </Button>
        </div>
      </SettingsPanel>

      <SettingsPanel title="Troubleshooting" description="Useful when you report a problem.">
        <p className="text-[12px] leading-relaxed text-fg-muted">
          The app data folder holds <span className="font-mono text-fg">persistence.jsonl</span> and the{' '}
          <span className="font-mono text-fg">logs</span> folder. Attach them to a report; they contain file names but no
          audio.
        </p>
        <div className="mt-3 flex flex-wrap gap-2">
          <Button variant="secondary" leading={<FolderOpen />} onClick={() => void ipc.invoke('app:openDirectory', 'userData')}>
            Open app data folder
          </Button>
        </div>
      </SettingsPanel>
    </div>
  )
}
