import { useState, type ReactNode } from 'react'
import type { PlaylistTrack } from '@shared/playlist'
import { Button } from '@/components/ui/Button'

export function PlaylistReviewPanel({ tracks, summary, pending, onConfirm, onCancel }: {
  tracks: PlaylistTrack[]
  summary: string
  pending: boolean
  onConfirm: (urls: string[]) => Promise<void>
  onCancel: () => void
}): ReactNode {
  const [selected, setSelected] = useState(() => new Set(tracks.map(track => track.url)))
  const [page, setPage] = useState(0)
  const pageCount = Math.max(1, Math.ceil(tracks.length / 50))
  return (
    <section aria-label="Review playlist tracks" className="mt-3 rounded-lg border border-line bg-surface p-3">
      <h3 className="text-sm font-semibold text-fg">Review playlist tracks</h3>
      <p className="mt-1 text-xs text-fg-muted" role="status">{summary}</p>
      <p className="mt-1 text-xs text-fg-subtle">Tracks are checked individually when queued; some may require access or be unavailable.</p>
      <div className="my-2 flex flex-wrap items-center gap-2">
        <Button size="xs" disabled={pending} onClick={() => setSelected(new Set(tracks.map(track => track.url)))}>Select all</Button>
        <Button size="xs" disabled={pending} onClick={() => setSelected(new Set())}>Select none</Button>
        <span className="text-xs text-fg-muted">{selected.size} selected</span>
      </div>
      <div className="max-h-52 overflow-y-auto">
        {tracks.slice(page * 50, (page + 1) * 50).map(track => (
          <label key={track.url} className="flex cursor-pointer items-center gap-2 rounded px-1 py-1.5 text-xs text-fg hover:bg-surface-2">
            <input type="checkbox" checked={selected.has(track.url)} disabled={pending} onChange={() => setSelected(current => {
              const next = new Set(current)
              if (next.has(track.url)) next.delete(track.url); else next.add(track.url)
              return next
            })} />
            <span className="truncate" title={track.title}>{track.title}</span>
          </label>
        ))}
      </div>
      <div className="mt-2 flex flex-wrap items-center gap-2">
        {pageCount > 1 ? <>
          <Button size="xs" disabled={page === 0} onClick={() => setPage(page - 1)}>Previous tracks</Button>
          <span className="text-xs text-fg-muted">Page {page + 1} of {pageCount}</span>
          <Button size="xs" disabled={page + 1 === pageCount} onClick={() => setPage(page + 1)}>Next tracks</Button>
        </> : null}
        <span className="flex-1" />
        <Button size="xs" disabled={pending} onClick={onCancel}>Cancel review</Button>
        <Button size="xs" disabled={pending || selected.size === 0} onClick={() => void onConfirm(tracks.filter(track => selected.has(track.url)).map(track => track.url)).catch(() => {})}>
          {pending ? 'Queueing…' : `Queue ${selected.size} selected`}
        </Button>
      </div>
    </section>
  )
}
