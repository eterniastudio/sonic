import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { ArrowRight, ChevronDown, ClipboardPaste, TriangleAlert, X } from 'lucide-react'
import { extractIntakeUrls } from '@shared/url'
import type { PlaylistTrack } from '@shared/playlist'
import { PlaylistReviewPanel } from './PlaylistReviewPanel'
import { PRESETS } from '@shared/presets'
import { cn } from '@/lib/cn'
import { ipc } from '@/lib/ipc'
import { useApp } from '@/store/app'
import { Button } from '@/components/ui/Button'
import { Textarea } from '@/components/ui/Input'
import { StatefulButton } from '@/components/aceternity/StatefulButton'
import { Switch } from '@/components/ui/Switch'
import { Dropdown, DropdownItem, DropdownLabel } from '@/components/ui/Dropdown'
import { toast } from '@/components/ui/Toaster'

const QUEUE_ADD_LIMIT = 1000

/** Link composer with a single queue action and persistent export defaults. */
export function IntakePanel(): ReactNode {
  const [text, setText] = useState('')
  const [dragging, setDragging] = useState(false)
  const [shakeKey, setShakeKey] = useState(0)
  const [pending, setPending] = useState(false)
  const submitting = useRef(false)
  const requestId = useRef<string | null>(null)
  const [reading, setReading] = useState(false)
  const [review, setReview] = useState<{ tracks: PlaylistTrack[]; summary: string; text: string } | null>(null)
  useEffect(() => () => {
    if (requestId.current) void ipc.invoke('playlist:cancel', requestId.current).catch(() => {})
    requestId.current = null
  }, [])
  const addUrls = useApp((state) => state.addUrls)
  const settings = useApp((state) => state.settings)
  const patchSettings = useApp((state) => state.patchSettings)
  const allowOtherSites = settings.allowOtherSites === true
  const parsed = useMemo(() => extractIntakeUrls(text, { allowOtherSites }), [text, allowOtherSites])
  const acceptedCount = parsed.tracks.length + parsed.playlists.length
  const preset = PRESETS.find((entry) => entry.id === settings.defaultPresetId) ?? PRESETS[0]

  const submit = async (): Promise<void> => {
    if (submitting.current || review) return
    if (acceptedCount === 0) {
      setShakeKey((value) => value + 1)
      return
    }
    const submittedText = text
    const autoStart = settings.autoStart
    submitting.current = true
    setPending(true)
    try {
      if (parsed.playlists.length) {
        setReading(true)
        const id = crypto.randomUUID()
        requestId.current = id
        if (parsed.playlists.length > 5) throw new Error('Review up to five playlists at a time.')
        const tracks = new Map<string, PlaylistTrack>(parsed.tracks.map(track => [track.normalized!, { url: track.normalized!, title: track.normalized! }]))
        const summaries: string[] = []
        for (const url of parsed.playlists) {
          const result = await ipc.invoke('playlist:inspect', url, id)
          if (requestId.current !== id) return
          for (const track of result.tracks) tracks.set(track.url, track)
          summaries.push(`${result.title}: ${result.tracks.length} tracks${result.skipped ? `, ${result.skipped} unavailable or duplicate entries skipped` : ''}${result.limited ? ' (first 500 entries only)' : ''}`)
        }
        if (!tracks.size) throw new Error('No available tracks were found in these playlists.')
        if (tracks.size > 1000) throw new Error('This batch has more than 1,000 tracks. Review fewer playlists at a time.')
        setReview({ tracks: [...tracks.values()], summary: summaries.join(' · '), text: submittedText })
        return
      }
      // Send the parsed links, never the raw paste: main caps each entry at 4,096
      // characters and each call at 1,000 entries.
      const urls = parsed.tracks.flatMap(track => track.normalized ? [track.normalized] : [])
      const before = new Set(useApp.getState().queue.jobs.map(job => job.id))
      for (let index = 0; index < urls.length; index += QUEUE_ADD_LIMIT) await addUrls(urls.slice(index, index + QUEUE_ADD_LIMIT))
      const added = useApp.getState().queue.jobs.filter(job => !before.has(job.id)).length
      const skipped = urls.length - added
      toast({
        kind: added ? 'success' : 'info',
        title: added ? `Queued ${added} link${added === 1 ? '' : 's'}` : 'Already in the queue',
        description: `${skipped > 0 ? `${skipped} link${skipped === 1 ? ' was' : 's were'} already queued. ` : ''}${added === 0 ? '' : autoStart
          ? 'Inspecting and downloading now.'
          : 'Review the metadata, then start the download.'}`.trim()
      })
      // A slow queue request must not discard the user's next batch of links.
      setText((current) => current === submittedText ? '' : current)
    } catch (error) {
      if (parsed.playlists.length && requestId.current === null) return
      toast({ kind: 'error', title: 'Could not queue links', description: error instanceof Error ? error.message : String(error) })
      throw error
    } finally {
      submitting.current = false
      setPending(false)
      setReading(false)
      requestId.current = null
    }
  }

  const confirmPlaylist = async (urls: string[]): Promise<void> => {
    if (submitting.current || !review) return
    submitting.current = true
    setPending(true)
    try {
      await addUrls(urls)
      setText(current => current === review.text ? '' : current)
      setReview(null)
      toast({ kind: 'success', title: `Submitted ${urls.length} tracks`, description: 'Tracks already active in the queue are skipped.' })
    } catch (error) {
      toast({ kind: 'error', title: 'Could not queue playlist tracks', description: String(error) })
    } finally { submitting.current = false; setPending(false) }
  }

  const onDrop = (event: React.DragEvent): void => {
    event.preventDefault()
    setDragging(false)
    const dropped =
      event.dataTransfer.getData('text/uri-list') || event.dataTransfer.getData('text/plain')
    if (dropped) setText((current) => (current.length > 0 ? `${current}\n${dropped}` : dropped))
  }

  return (
    <section className="shrink-0" aria-labelledby="intake-heading">
      <h2 id="intake-heading" className="sr-only">Add beats</h2>
      <div>
        <div
          onDragOver={(event) => {
            event.preventDefault()
            setDragging(true)
          }}
          onDragLeave={() => setDragging(false)}
          onDrop={onDrop}
          className={cn(
            'relative rounded-[2px] border border-line bg-surface transition-colors focus-within:border-line-strong',
            dragging && 'border-line-strong bg-surface-2'
          )}
        >
          <Textarea
            key={shakeKey}
            aria-label="YouTube or SoundCloud beat links"
            value={text}
            onChange={(event) => setText(event.target.value)}
            onKeyDown={(event) => {
              if ((event.ctrlKey || event.metaKey) && event.key === 'Enter') {
                event.preventDefault()
                if (!event.repeat) void submit().catch(() => {})
              }
            }}
            rows={2}
            spellCheck={false}
            placeholder="Paste links from YouTube, SoundCloud, Bandcamp, Vimeo, Mixcloud and more, or a direct audio file."
            className={cn(
              'min-h-[54px] rounded-none border-0 bg-transparent px-3 pt-3 pb-1 text-[13.5px] leading-relaxed focus:bg-transparent focus:shadow-none',
              shakeKey > 0 && acceptedCount === 0 && 't-input is-shaking is-error'
            )}
          />
          <div className="flex items-center gap-0.5 px-1.5 pb-1.5">
            <Button
              variant="ghost"
              size="xs"
              leading={<ClipboardPaste />}
              onClick={() => void ipc.invoke('app:readClipboard').then((value) => value && setText(value)).catch(error => toast({ kind: 'error', title: 'Could not paste', description: String(error) }))}
            >
              Paste
            </Button>
            {text.length > 0 ? (
              <Button variant="ghost" size="xs" leading={<X />} onClick={() => setText('')}>Clear</Button>
            ) : null}
            <span className="flex-1" />
            <span className="mr-2 hidden text-[12px] text-fg-subtle min-[1350px]:block" aria-hidden>
              <kbd className="font-sans">Ctrl</kbd> + <kbd className="font-sans">Enter</kbd>
            </span>
            <StatefulButton
              onAction={submit}
              disabled={acceptedCount === 0 || pending || !!review}
              icon={<ArrowRight className="size-3.5" />}
              loadingLabel={parsed.playlists.length ? 'Reading playlists…' : 'Queueing…'}
              successLabel={parsed.playlists.length ? 'Ready to review' : 'Queued'}
              size="sm"
              className="h-7 rounded-[2px] px-2.5 text-[12px] shadow-none"
            >
              {parsed.playlists.length ? 'Review playlists' : 'Add to queue'}
            </StatefulButton>
          </div>
          {dragging ? (
            <div className="pointer-events-none absolute inset-0 grid place-items-center rounded-[2px] bg-surface/95 text-[13.5px] font-medium text-fg">Drop links here</div>
          ) : null}
        </div>

        {parsed.rejected.length > 0 ? (
          <div className="mt-2.5 flex flex-wrap items-center gap-1.5" role="status">
            <TriangleAlert className="size-3.5 shrink-0 text-warning" />
            <span className="text-[12px] text-fg-muted">Skipped:</span>
            {parsed.rejected.slice(0, 4).map((token) => (
              <span key={token} className="max-w-[190px] truncate rounded bg-surface-3 px-1.5 py-0.5 font-mono text-[12px] text-fg-subtle" title={token}>{token}</span>
            ))}
            {parsed.rejected.length > 4 ? <span className="text-[12px] text-fg-subtle">+{parsed.rejected.length - 4} more</span> : null}
          </div>
        ) : null}
      </div>

      {reading ? <div className="mt-2 flex items-center gap-2" role="status">
        <span className="text-xs text-fg-muted">Reading playlist tracks…</span>
        <Button size="xs" onClick={() => {
          const id = requestId.current
          requestId.current = null
          if (id) void ipc.invoke('playlist:cancel', id).catch(() => {})
        }}>Cancel reading</Button>
      </div> : null}
      {review ? <PlaylistReviewPanel tracks={review.tracks} summary={review.summary} pending={pending} onConfirm={confirmPlaylist} onCancel={() => setReview(null)} /> : null}

      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 pt-1.5">
        <div className="flex items-center gap-1">
          <span className="text-[12px] text-fg-subtle">Export as</span>
          <Dropdown
            align="start"
            trigger={({ toggle }) => (
              <Button variant="ghost" size="xs" onClick={toggle} title="Default export format" trailing={<ChevronDown />} className="h-6 px-1.5 text-[12px] text-fg-muted">
                {preset.label}
              </Button>
            )}
          >
            {(close) => (
              <>
                <DropdownLabel>Default export format</DropdownLabel>
                {PRESETS.map((entry) => (
                  <DropdownItem
                    key={entry.id}
                    selected={entry.id === settings.defaultPresetId}
                    hint={entry.short}
                    onSelect={async () => {
                      await patchSettings({ defaultPresetId: entry.id })
                      close()
                    }}
                  >{entry.label}</DropdownItem>
                ))}
              </>
            )}
          </Dropdown>
        </div>
        {acceptedCount > 0 ? <span className="text-[12px] text-fg-subtle" role="status">{acceptedCount} ready</span> : null}
        <div className="ml-auto flex items-center gap-2">
          <span className="text-[12px] text-fg-subtle">Auto-start</span>
          <Switch checked={settings.autoStart} onChange={(next) => void patchSettings({ autoStart: next })} label="Start downloads automatically" />
        </div>
      </div>
    </section>
  )
}
