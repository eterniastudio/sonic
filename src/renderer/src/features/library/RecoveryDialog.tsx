import { useEffect, useRef, useState, type ReactNode } from 'react'
import type { RecoveryItemStatus, RecoveryReview } from '@shared/recovery'
import { ipc } from '@/lib/ipc'
import { useApp } from '@/store/app'
import { Button } from '@/components/ui/Button'
import { Modal } from '@/components/ui/Modal'

const labels: Record<RecoveryItemStatus, string> = {
  matched: 'One verified match', ambiguous: 'Choose a matching location', 'not-found': 'No verified match',
  unverifiable: 'Identity unavailable', error: 'Access or scan error', reconnected: 'Reconnected', invalid: 'Cannot reconnect'
}

/** Progress and review choices stay local; scanning never publishes library snapshots. */
export function RecoveryDialog({ planId, onClose }: { planId: string; onClose: () => void }): ReactNode {
  const [review, setReview] = useState<RecoveryReview | null>(null)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const [choices, setChoices] = useState<Record<string, string>>({})
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [page, setPage] = useState(0)
  const initialized = useRef(false)
  const submitting = useRef(false)
  const live = useRef(true)
  const setLibrarySnapshot = useApp(state => state.setLibrarySnapshot)
  const refresh = async (): Promise<RecoveryReview> => {
    const next = await ipc.invoke('recovery:status', planId)
    if (live.current) setReview(next)
    return next
  }

  useEffect(() => {
    live.current = true
    let timer: ReturnType<typeof setTimeout> | undefined
    const poll = async (): Promise<void> => {
      try {
        const next = await refresh()
        if (live.current && ['scanning', 'applying', 'pending-save'].includes(next.phase)) timer = setTimeout(() => void poll(), 300)
      } catch (failure) { if (live.current) setError(String(failure)) }
    }
    void poll()
    return () => { live.current = false; if (timer) clearTimeout(timer) }
  }, [planId])

  useEffect(() => {
    if (review?.phase !== 'pending-save') return
    const timer = setInterval(() => { void refresh().catch(failure => { if (live.current) setError(String(failure)) }) }, 300)
    return () => clearInterval(timer)
  }, [review?.phase, planId])

  useEffect(() => () => {
    // Navigating away closes the preview; an already committed revision wins.
    void ipc.invoke('recovery:cancel', planId).catch(() => undefined)
  }, [planId])

  useEffect(() => {
    if (!review || review.phase !== 'ready' || initialized.current) return
    initialized.current = true
    const defaults: Record<string, string> = {}, accepted = new Set<string>()
    for (const item of review.items) {
      if (item.candidates.length !== 1) continue
      defaults[item.beatId] = item.candidates[0].id
      if (review.completeSearch && item.status === 'matched') accepted.add(item.beatId)
    }
    setChoices(defaults); setSelected(accepted)
  }, [review])

  const apply = async (): Promise<void> => {
    if (submitting.current || !selected.size) return
    submitting.current = true; setBusy(true); setError('')
    try {
      const next = await ipc.invoke('recovery:apply', planId, [...selected].map(beatId => ({ beatId, candidateId: choices[beatId] })))
      if (live.current) setReview(next)
      if (next.phase === 'complete' && next.committedIds.length) setLibrarySnapshot(await ipc.invoke('library:list'))
    } catch (failure) { if (live.current) setError(String(failure)) }
    finally { submitting.current = false; if (live.current) setBusy(false) }
  }
  const close = async (): Promise<void> => {
    if (review?.phase === 'complete' || review?.phase === 'cancelled') { onClose(); return }
    try {
      const next = await ipc.invoke('recovery:cancel', planId)
      if (next.phase === 'complete') { setReview(next); setLibrarySnapshot(await ipc.invoke('library:list')); return }
      onClose()
    } catch (failure) { setError(String(failure)) }
  }
  const retry = async (): Promise<void> => {
    if (submitting.current) return
    submitting.current = true; setBusy(true); setError('')
    try {
      await ipc.invoke('storage:retry')
      await refresh()
      setLibrarySnapshot(await ipc.invoke('library:list'))
    } catch (failure) { setError(String(failure)) }
    finally { submitting.current = false; setBusy(false) }
  }

  const terminal = review?.phase === 'complete' || review?.phase === 'cancelled'
  const count = selected.size
  const rows = review?.items.slice(page * 50, (page + 1) * 50) ?? []
  const pages = Math.ceil((review?.items.length ?? 0) / 50)
  return <Modal open onClose={() => void close()} size="lg" title={review?.kind === 'folder' ? 'Find missing files' : 'Locate missing file'}
    description="Reconnect the same audio to its existing library entry. Metadata, collections, and listening history stay with the track. Audio files are never changed by recovery."
    footer={<>
      <Button variant="ghost" onClick={() => void close()}>{terminal ? 'Close' : 'Cancel'}</Button>
      {review?.phase === 'pending-save' ? <Button disabled={busy} onClick={() => void retry()}>Retry saving</Button> : null}
      {!terminal && review?.phase !== 'pending-save' ? <Button disabled={busy || review?.phase !== 'ready' || count === 0} onClick={() => void apply()}>
        {busy ? 'Verifying…' : `Reconnect ${count} ${count === 1 ? 'track' : 'tracks'}`}
      </Button> : null}
    </>}>
    <div className="space-y-3">
      <div role="status" aria-live="polite" className="text-[12px] text-fg-muted">
        {!review || review.phase === 'scanning' ? `Scanning selected location… ${review?.stats.visited ?? 0} entries checked; ${review?.stats.hashed ?? 0} files verified.` :
          review.phase === 'applying' || busy ? 'Rechecking selected files before saving…' :
          review.phase === 'complete' ? `${review.committedIds.length} ${review.committedIds.length === 1 ? 'track' : 'tracks'} reconnected` :
          review.phase === 'cancelled' ? 'Recovery cancelled; no pending paths will be applied.' :
          review.phase === 'ready' ? `${count} of ${review.requestedCount} tracks selected for reconnection` : ''}
      </div>
      {(error || review?.error) ? <p role="alert" className="break-words rounded-md border border-line bg-surface-2 p-3 text-[12px] text-danger">{error || review?.error}</p> : null}
      {review && !review.completeSearch && review.phase === 'ready' ? <p className="text-[12px] text-warning">The scan was incomplete. Review the errors and explicitly choose any verified files to reconnect.</p> : null}
      {review?.phase === 'complete' && review.items.some(item => item.status === 'invalid') ? <p className="text-[12px] text-warning">Some selected files could not be reconnected. Their original records are unchanged; review the reasons below.</p> : null}
      <div className="max-h-[min(44dvh,340px)] space-y-2 overflow-y-auto overscroll-contain pr-1" aria-label="Recovery matches" tabIndex={0}>
        {rows.map(item => <article key={item.beatId} data-recovery-beat-id={item.beatId} className="min-w-0 rounded-lg border border-line bg-surface-2/40 p-3">
          <div className="flex items-start gap-2">
            {!terminal ? <input type="checkbox" aria-label={`Reconnect ${item.title}`} checked={selected.has(item.beatId)}
              disabled={review?.phase !== 'ready' || !choices[item.beatId]} className="mt-1 shrink-0 accent-[var(--sonic-accent)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2"
              onChange={event => setSelected(current => { const next = new Set(current); event.target.checked ? next.add(item.beatId) : next.delete(item.beatId); return next })} /> : null}
            <div className="min-w-0 flex-1"><h3 className="break-words text-[13.5px] font-medium text-fg">{item.title}</h3>
              <p className="mt-0.5 text-[12px] text-fg-muted">{labels[item.status]}</p></div>
          </div>
          <p className="mt-2 text-[12px] font-bold text-fg-subtle">Last known location</p>
          <p className="select-text break-all font-mono text-[12px] text-fg-muted" title={item.oldPath}>{item.oldPath}</p>
          {item.error ? <p role="alert" className="mt-2 break-words text-[12px] text-warning">{item.error}</p> : null}
          {item.candidates.map(candidate => <div key={candidate.id} className="mt-2 rounded-md border border-line p-2">
            <label className="flex items-start gap-2 text-[12px] text-fg">
              {!terminal ? <input type="radio" name={`candidate-${item.beatId}`} aria-label={candidate.path}
                checked={choices[item.beatId] === candidate.id} disabled={review?.phase !== 'ready'} className="mt-0.5 shrink-0 accent-[var(--sonic-accent)] focus-visible:outline focus-visible:outline-2"
                onChange={() => { setChoices(current => ({ ...current, [item.beatId]: candidate.id })); setSelected(current => new Set([...current, item.beatId])) }} /> : null}
              <span className="min-w-0 select-text break-all font-mono" title={candidate.path}>{candidate.path}</span>
            </label>
            <p className="mt-1 text-[12px] text-fg-muted">{candidate.ownership === 'retained' ? 'Sonic file ownership verified' : 'Read-only at this location'}</p>
            {candidate.note ? <p className="mt-1 break-words text-[12px] leading-relaxed text-fg-muted">{candidate.note}</p> : null}
          </div>)}
        </article>)}
        {review?.errors.length ? <div className="rounded-lg border border-line p-3"><h3 className="text-[12px] font-medium text-warning">Access and scan errors</h3>
          {review.errors.map((entry, index) => <p key={index} className="mt-2 break-all text-[12px] text-fg-muted" title={entry.path}>{entry.path}: {entry.message}</p>)}
        </div> : null}
      </div>
      {pages > 1 ? <div className="flex items-center justify-between text-[12px] text-fg-muted"><Button size="sm" variant="ghost" disabled={page === 0} onClick={() => setPage(value => value - 1)}>Previous results</Button>
        <span>Page {page + 1} of {pages}</span><Button size="sm" variant="ghost" disabled={page + 1 >= pages} onClick={() => setPage(value => value + 1)}>Next results</Button></div> : null}
    </div>
  </Modal>
}
