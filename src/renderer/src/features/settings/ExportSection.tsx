import { useEffect, useState, type ReactNode } from 'react'
import { ChevronDown, FolderOpen } from 'lucide-react'
import type { ChannelMode, PresetId } from '@shared/domain'
import { PRESETS } from '@shared/presets'
import { TEMPLATE_TOKEN_HELP, TEMPLATE_TOKENS } from '@shared/template'
import { ipc } from '@/lib/ipc'
import { useDebounced } from '@/lib/hooks'
import { useApp } from '@/store/app'
import { Badge } from '@/components/ui/Badge'
import { Button } from '@/components/ui/Button'
import { Dropdown, DropdownItem } from '@/components/ui/Dropdown'
import { Field, Input } from '@/components/ui/Input'
import { Segmented } from '@/components/ui/Segmented'
import { SwitchRow } from '@/components/ui/Switch'
import { Accordion } from '@/components/ui/Accordion'
import { SettingsPanel } from './SettingsPanel'

export function ExportSection(): ReactNode {
  const settings = useApp((state) => state.settings)
  const patchSettings = useApp((state) => state.patchSettings)
  const chooseDownloadDir = useApp((state) => state.chooseDownloadDir)

  const [template, setTemplate] = useState(settings.namingTemplate)
  const [preview, setPreview] = useState<{ rendered: string; unknownTokens: string[] } | null>(null)
  const debounced = useDebounced(template, 220)

  useEffect(() => {
    setTemplate(settings.namingTemplate)
  }, [settings.namingTemplate])

  // Preview through the main process so Settings shows exactly what the
  // exporter will produce, using the same renderer function.
  useEffect(() => {
    let cancelled = false
    void ipc
      .invoke('settings:previewTemplate', debounced, settings.defaultPresetId)
      .then((result) => {
        if (!cancelled) setPreview({ rendered: result.rendered, unknownTokens: result.unknownTokens })
      })
    return () => {
      cancelled = true
    }
  }, [debounced, settings.defaultPresetId])

  const preset = PRESETS.find((entry) => entry.id === settings.defaultPresetId) ?? PRESETS[0]

  return (
    <div>
      <SettingsPanel title="Destination">
        <Field label="Export folder" htmlFor="settings-export-folder" hint="Where finished beats are published" className="[&>div>span]:text-[12px]">
          <div className="flex gap-2">
            <div className="min-w-0 flex-1">
              <Input
                id="settings-export-folder"
                value={settings.downloadDir}
                readOnly
                className="font-mono text-[12px] text-ellipsis"
                leading={<FolderOpen />}
              />
            </div>
            <Button variant="secondary" onClick={() => void chooseDownloadDir()}>
              Change
            </Button>
          </div>
        </Field>
      </SettingsPanel>

      <SettingsPanel title="Naming" bodyClassName="space-y-3">
        <Field
          label="File name template"
          className="[&>div>span]:text-[12px] [&>div:last-child]:text-[12px]"
          htmlFor="settings-naming-template"
          hint={`${TEMPLATE_TOKENS.length} tokens available`}
          note={
            preview?.unknownTokens.length
              ? `Unknown token: ${preview.unknownTokens.join(', ')}`
              : undefined
          }
        >
          <Input
            id="settings-naming-template"
            value={template}
            spellCheck={false}
            className="font-mono text-[12px]"
            onChange={(event) => setTemplate(event.target.value)}
            onBlur={() => void patchSettings({ namingTemplate: template })}
            onKeyDown={(event) => {
              if (event.key === 'Enter') void patchSettings({ namingTemplate: template })
            }}
          />
        </Field>

        <div className="flex items-baseline gap-3 text-[12px]">
          <span className="shrink-0 text-fg-subtle">Preview</span>
          <div className="min-w-0 font-mono break-all text-fg-muted">
            {preview?.rendered || 'untitled'}.{preset.extension}
          </div>
        </div>

        <Accordion title="Available tokens" summary={`${TEMPLATE_TOKEN_HELP.length}`} bare className="[&>button]:px-0 [&>button]:py-2">
          <ul className="grid grid-cols-2 gap-x-4 gap-y-1.5">
            {TEMPLATE_TOKEN_HELP.map((entry) => (
              <li key={entry.token} className="flex items-baseline gap-2">
                <code className="shrink-0 rounded-[2px] bg-surface-3 px-1 py-0.5 font-mono text-[12px] text-fg">
                  {`{${entry.token}}`}
                </code>
                <span className="truncate text-[12px] text-fg-muted">{entry.description}</span>
              </li>
            ))}
          </ul>
        </Accordion>
      </SettingsPanel>

      <SettingsPanel title="Default recipe" description="Applied to new downloads." bodyClassName="space-y-3">
        <div className="grid grid-cols-2 gap-4">
          <Field label="Format for new downloads">
            <Dropdown
              width="trigger"
              className="w-full"
              trigger={({ toggle }) => (
                <Button variant="secondary" className="w-full justify-between" trailing={<ChevronDown />} onClick={toggle}>
                  {preset.label}
                </Button>
              )}
            >
              {(close) => (
                <>
                  {PRESETS.map((entry) => (
                    <DropdownItem
                      key={entry.id}
                      selected={entry.id === settings.defaultPresetId}
                      hint={entry.short}
                      onSelect={async () => {
                        await patchSettings({ defaultPresetId: entry.id as PresetId })
                        close()
                      }}
                    >
                      {entry.label}
                    </DropdownItem>
                  ))}
                </>
              )}
            </Dropdown>
          </Field>

          <Field label="Channels">
            <Segmented
              value={settings.channelMode}
              onChange={(next: ChannelMode) => void patchSettings({ channelMode: next })}
              ariaLabel="Channel mode"
              options={[
                { value: 'preserve', label: 'Keep' },
                { value: 'stereo', label: 'Stereo' },
                { value: 'mono', label: 'Mono' }
              ]}
            />
          </Field>
        </div>

        <p className="text-[12px] leading-relaxed text-fg-subtle">{preset.description}</p>

        <Field
          label="Loudness normalisation"
          className="[&>div>span]:text-[12px] [&>div:last-child]:text-[12px]"
          hint="Off by default — on changes the audio"
          note="Leave this off unless your destination asks for a specific loudness target."
        >
          <div className="flex flex-wrap items-center gap-3">
            <Segmented
              value={settings.normalizeLufs == null ? 'off' : 'on'}
              onChange={(next) =>
                void patchSettings({ normalizeLufs: next === 'off' ? null : (settings.normalizeLufs ?? -14) })
              }
              options={[
                { value: 'off', label: 'Off' },
                { value: 'on', label: 'Target' }
              ]}
              size="sm"
            />
            {settings.normalizeLufs != null ? (
              <div className="flex items-center gap-1.5">
                <input
                  aria-label="Loudness target"
                  type="range"
                  min={-24}
                  max={-8}
                  step={1}
                  value={settings.normalizeLufs}
                  onChange={(event) => void patchSettings({ normalizeLufs: Number(event.target.value) })}
                  className="w-32 accent-[var(--sonic-accent)]"
                />
                <Badge tone="neutral" size="sm" className="h-6 text-[12px]">
                  {settings.normalizeLufs} LUFS
                </Badge>
              </div>
            ) : null}
          </div>
        </Field>
      </SettingsPanel>

      <SettingsPanel title="Audio analysis">
        <div className="divide-y divide-[var(--sonic-border)]">
          <SwitchRow
            className="pt-0 pb-3"
            title="Analyze downloaded audio automatically"
            description="Estimates tempo and key from the audio itself and fills any field the source did not state. Works locally; nothing is uploaded."
            checked={settings.analyzeOnDownload}
            onChange={(next) => void patchSettings({ analyzeOnDownload: next })}
          />
        </div>

        <div className="flex items-center gap-3 border-t border-line py-3">
          <span className="flex-1 text-[13.5px] text-fg-muted">
            Concurrent analyses
            <span className="mt-0.5 block text-[12px] text-fg-subtle">
              One at a time keeps your workspace responsive.
            </span>
          </span>
          <Segmented
            value={String(settings.analysisConcurrency)}
            onChange={(next) => void patchSettings({ analysisConcurrency: Number(next) })}
            ariaLabel="Concurrent analyses"
            size="sm"
            options={[
              { value: '1', label: '1' },
              { value: '2', label: '2' },
              { value: '3', label: '3' },
              { value: '4', label: '4' }
            ]}
          />
        </div>

        <p className="text-[12px] leading-relaxed text-fg-subtle">
          Source metadata takes priority. Estimates fill missing fields; disagreements stay visible
          in the metadata inspector.
        </p>
      </SettingsPanel>

      <SettingsPanel title="Tagging and sidecars">
        <div className="divide-y divide-[var(--sonic-border)] [&>div]:py-2.5 [&>div:first-child]:pt-0 [&>div:last-child]:pb-0">
          <SwitchRow
            title="Embed metadata in the file"
            description="Writes title, producer, tempo, key and genre into the container tags."
            checked={settings.embedTags}
            onChange={(next) => void patchSettings({ embedTags: next })}
          />
          <SwitchRow
            title="Embed cover art"
            description="Uses the source thumbnail as the file's artwork where the format supports it."
            checked={settings.embedThumbnail}
            onChange={(next) => void patchSettings({ embedThumbnail: next })}
          />
          <SwitchRow
            title="Write a .sonic.json sidecar"
            description="Records the source, final metadata, evidence and output fingerprint next to every export."
            checked={settings.writeSidecar}
            onChange={(next) => void patchSettings({ writeSidecar: next })}
          />
          <SwitchRow
            title="Keep sidecars in a .json subfolder"
            description="Keeps the main export folder free of sidecar clutter."
            checked={settings.sidecarInSubfolder}
            disabled={!settings.writeSidecar}
            onChange={(next) => void patchSettings({ sidecarInSubfolder: next })}
          />
          <SwitchRow
            title="Rewrite audio file tags when metadata is corrected"
            description="Not available yet. Corrections update the library and sidecar; re-export to write corrected audio tags."
            checked={false}
            disabled
            onChange={(next) => void patchSettings({ rewriteTagsOnEdit: next })}
          />
        </div>
      </SettingsPanel>

      <SettingsPanel title="Queue behaviour">
        <div className="divide-y divide-[var(--sonic-border)] [&>div]:py-2.5 [&>div:first-child]:pt-0">
          <SwitchRow
            title="Start downloads automatically"
            description="Begin exporting as soon as a pasted link has been inspected, instead of waiting for review."
            checked={settings.autoStart}
            onChange={(next) => void patchSettings({ autoStart: next })}
          />
          <SwitchRow
            title="Skip beats already in the library"
            description="If a link's video is already exported, the job completes without downloading it again."
            checked={settings.skipExisting}
            onChange={(next) => void patchSettings({ skipExisting: next })}
          />
        </div>

        <div className="flex items-center gap-3 border-t border-line pt-3">
          <span className="flex-1 text-[13.5px] text-fg-muted">Concurrent downloads</span>
          <Segmented
            value={String(settings.concurrency)}
            onChange={(next) => void patchSettings({ concurrency: Number(next) })}
            ariaLabel="Concurrent downloads"
            size="sm"
            options={[
              { value: '1', label: '1' },
              { value: '2', label: '2' },
              { value: '3', label: '3' }
            ]}
          />
        </div>
      </SettingsPanel>
    </div>
  )
}
