import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { FileAudio2, FolderOpen, Import, TriangleAlert } from 'lucide-react'
import type { LocalImportItem, LocalImportReview } from '@shared/domain'
import { Button } from '@/components/ui/Button'
import { Modal } from '@/components/ui/Modal'
import { Switch } from '@/components/ui/Switch'
import { toast } from '@/components/ui/Toaster'
import { ipc } from '@/lib/ipc'
import { useApp } from '@/store/app'

function statusLabel(item: LocalImportItem): string {
  if (item.status === 'ready') return item.duplicateOf ? 'Possible duplicate' : 'Ready'
  if (item.status === 'already-indexed') return 'Already in library'
  if (item.status === 'unsupported') return 'Unsupported format'
  if (item.status === 'unreadable') return 'Unreadable'
  if (item.status === 'imported') return 'Imported'
  if (item.status === 'skipped') return 'Skipped'
  return 'Failed'
}

function count(items: LocalImportItem[], status: LocalImportItem['status']): number {
  return items.filter(item => item.status === status).length
}

/** Native picker and review for files referenced in place by the library. */
export function ImportAudio(): ReactNode {
  const [open, setOpen] = useState(false)
  const [recursive, setRecursive] = useState(false)
  const [review, setReview] = useState<LocalImportReview | null>(null)
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set())
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [page, setPage] = useState(0)
  const reportedSession = useRef<string | null>(null)
  const reviewRef = useRef<LocalImportReview | null>(null)
  const confirmingRef = useRef(false)
  const mountedRef = useRef(true)
  reviewRef.current = review
  const sessionId = review?.sessionId ?? null
  const phase = review?.phase
  const pageSize = 200
  const pageCount = Math.max(1, Math.ceil((review?.items.length ?? 0) / pageSize))
  const visibleItems = review?.items.slice(page * pageSize, (page + 1) * pageSize) ?? []

  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
      const abandoned = reviewRef.current
      // A confirmation already writing records must settle and keep its outcome.
      if (!confirmingRef.current && abandoned &&
        (abandoned.phase === 'scanning' || abandoned.phase === 'ready' || abandoned.phase === 'error')) {
        void ipc.invoke('import:cancel', abandoned.sessionId).catch(() => undefined)
      }
    }
  }, [])

  useEffect(() => {
    if (!sessionId || (phase !== 'scanning' && phase !== 'importing')) return
    let disposed = false
    let timer: ReturnType<typeof setTimeout> | null = null
    const poll = async (): Promise<void> => {
      try {
        const latest = await ipc.invoke('import:status', sessionId)
        if (!disposed && latest) setReview(latest)
        if (!disposed && !latest) setError('The import session is no longer available.')
      } catch (failure) {
        if (!disposed) setError(failure instanceof Error ? failure.message : String(failure))
      } finally {
        if (!disposed) timer = setTimeout(() => { void poll() }, 400)
      }
    }
    timer = setTimeout(() => { void poll() }, 250)
    return () => { disposed = true; if (timer) clearTimeout(timer) }
  }, [sessionId, phase])

  useEffect(() => {
    if (!review || (phase !== 'done' && phase !== 'cancelled' && phase !== 'error')) return
    const reportKey = `${review.sessionId}:${phase}`
    if (reportedSession.current === reportKey) return
    reportedSession.current = reportKey
    void ipc.invoke('library:list').then(library => useApp.getState().setLibrarySnapshot(library))
      .catch(failure => setError(failure instanceof Error ? failure.message : String(failure)))
    const imported = count(review.items, 'imported')
    const failed = review.items.filter(item => item.status === 'failed' || item.status === 'unreadable').length
    if (imported > 0) toast({ kind: phase === 'error' ? 'error' : failed > 0 ? 'info' : 'success',
      title: `${imported} audio file${imported === 1 ? '' : 's'} added to the library`,
      description: failed > 0 ? `${failed} file${failed === 1 ? '' : 's'} could not be added. Review the results.`
        : 'Acoustic analysis may continue in the background.' })
  }, [phase, review?.sessionId])

  // Ready items are selected by default. A content match remains an explicit opt-in.
  useEffect(() => {
    if (phase !== 'ready' || !review) return
    setSelectedIds(previous => {
      const ready = new Set(review.items.filter(item => item.status === 'ready' && !item.duplicateOf).map(item => item.id))
      if (previous.size === 0) return ready
      return new Set([...previous].filter(id => review.items.some(item => item.id === id && item.status === 'ready')))
    })
  }, [phase, review?.sessionId])

  const totals = useMemo(() => {
    const items = review?.items ?? []
    return {
      ready: count(items, 'ready'),
      imported: count(items, 'imported'),
      indexed: count(items, 'already-indexed'),
      skipped: count(items, 'skipped'),
      failed: count(items, 'failed') + count(items, 'unreadable') + count(items, 'unsupported'),
      duplicate: items.filter(item => item.status === 'ready' && item.duplicateOf).length
    }
  }, [review])

  const begin = async (kind: 'files' | 'folder'): Promise<void> => {
    if (busy) return
    setBusy(true)
    setError('')
    setReview(null)
    setSelectedIds(new Set())
    setPage(0)
    try {
      const result = kind === 'files'
        ? await ipc.invoke('import:chooseFiles')
        : await ipc.invoke('import:chooseFolder', recursive)
      if (!result.sessionId) return
      if (!mountedRef.current) {
        await ipc.invoke('import:cancel', result.sessionId)
        return
      }
      const latest = await ipc.invoke('import:status', result.sessionId)
      if (!latest) throw new Error('The import review could not be loaded.')
      if (!mountedRef.current) {
        if (latest.phase !== 'importing') await ipc.invoke('import:cancel', result.sessionId)
        return
      }
      setReview(latest)
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : String(failure))
    } finally {
      setBusy(false)
    }
  }

  const cancel = async (): Promise<void> => {
    if (!review || busy) return
    setBusy(true)
    setError('')
    try {
      const latest = await ipc.invoke('import:cancel', review.sessionId)
      if (latest) setReview(latest)
      else setReview(null)
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : String(failure))
    } finally {
      setBusy(false)
    }
  }

  const confirm = async (): Promise<void> => {
    if (!review || busy || selectedIds.size === 0) return
    confirmingRef.current = true
    setBusy(true)
    setError('')
    try {
      const latest = await ipc.invoke('import:confirm', review.sessionId, [...selectedIds])
      setReview(latest)
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : String(failure))
      const latest = await ipc.invoke('import:status', review.sessionId).catch(() => null)
      if (latest) setReview(latest)
    } finally {
      confirmingRef.current = false
      setBusy(false)
    }
  }

  const retrySave = async (): Promise<void> => {
    if (!review || busy) return
    setBusy(true)
    setError('')
    try {
      const stores = await ipc.invoke('storage:retry')
      const latest = await ipc.invoke('import:status', review.sessionId)
      if (latest) setReview(latest)
      const failed = stores.find(store => /[\\/]library\.json$/i.test(store.file) && store.error)
      if (failed) setError(failed.error || 'The library save still needs attention.')
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : String(failure))
    } finally {
      setBusy(false)
    }
  }

  const dismiss = async (reset: boolean): Promise<void> => {
    if (busy || phase === 'scanning' || phase === 'importing') return
    setBusy(true)
    try {
      if (review) await ipc.invoke('import:cancel', review.sessionId)
      setReview(null)
      setSelectedIds(new Set())
      setPage(0)
      setError('')
      if (!reset) setOpen(false)
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : String(failure))
    } finally {
      setBusy(false)
    }
  }

  const close = (): void => { void dismiss(false) }

  return <>
    <Button variant="primary" size="md" leading={<Import />} onClick={() => setOpen(true)}>
      Import audio
    </Button>
    <Modal open={open} onClose={close} blocking={busy || phase === 'scanning' || phase === 'importing'}
      title="Import audio" size="lg"
      description="Add existing files to your library without moving, renaming, retagging, or deleting the originals."
      footer={<>
        {review && (phase === 'scanning' || phase === 'ready' || phase === 'importing') ?
          <Button variant="secondary" onClick={() => { void cancel() }} disabled={busy}>Cancel import</Button> : null}
        {phase === 'ready' ?
          <Button onClick={() => { void confirm() }} disabled={busy || selectedIds.size === 0}>
            Add {selectedIds.size} selected
          </Button> :
          <Button variant="secondary" onClick={close} disabled={busy || phase === 'scanning' || phase === 'importing'}>Close</Button>}
      </>}>
      <div className="space-y-3">
        {!review ? <>
          <div className="flex flex-wrap gap-2">
            <Button leading={<FileAudio2 />} onClick={() => { void begin('files') }} disabled={busy}>Choose files</Button>
            <Button variant="secondary" leading={<FolderOpen />} onClick={() => { void begin('folder') }} disabled={busy}>Choose folder</Button>
          </div>
          <div className="flex items-center gap-2 text-[13.5px] text-fg-muted">
            <Switch checked={recursive} onChange={setRecursive} label="Include subfolders" />
            Include subfolders when importing a folder
          </div>
          <p className="text-[12px] leading-relaxed text-fg-subtle">
            Sonic references these files in place. Metadata edits stay in Sonic; use Export prepared copy to create a new audio file with the corrected name and tags.
          </p>
        </> : <>
          <div aria-live="polite" className="text-[13.5px] text-fg-muted">
            {phase === 'scanning' ? `Scanning ${review.scanned} file${review.scanned === 1 ? '' : 's'}…` :
              phase === 'importing' ? `Adding selected audio… ${totals.imported} completed` :
              phase === 'ready' ? `${totals.ready} ready · ${totals.indexed} already indexed · ${totals.failed} unavailable` :
              `${totals.imported} imported · ${totals.skipped + totals.indexed} skipped · ${totals.failed} unavailable`}
          </div>
          {totals.duplicate > 0 && phase === 'ready' ?
            <p className="flex items-center gap-1.5 text-[12px] text-warning"><TriangleAlert className="size-3.5" />
              {totals.duplicate} possible content duplicate{totals.duplicate === 1 ? '' : 's'} left unselected. You can choose to keep separate records.
            </p> : null}
          <div className="max-h-[330px] space-y-1 overflow-y-auto rounded-[2px] border border-line bg-surface-2 p-2">
            {review.items.length === 0 ? <p className="px-2 py-3 text-[12px] text-fg-subtle">No audio candidates found yet.</p> :
              visibleItems.map(item => <label key={item.id} className="flex items-start gap-2.5 rounded-[2px] px-2 py-2 hover:bg-surface-3">
                {phase === 'ready' && item.status === 'ready' ?
                  <input type="checkbox" className="mt-0.5 accent-[var(--sonic-accent)]"
                    checked={selectedIds.has(item.id)} onChange={() => setSelectedIds(previous => {
                      const next = new Set(previous)
                      if (next.has(item.id)) next.delete(item.id)
                      else next.add(item.id)
                      return next
                    })} /> :
                  <span className="mt-0.5 size-4 shrink-0" />}
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-[13.5px] text-fg" title={item.filePath}>{item.fileName}</span>
                  <span className="block text-[12px] text-fg-subtle">
                    {item.bpm != null ? `${item.bpm} BPM` : 'BPM unknown'} · {item.key ?? 'key unknown'}
                    {item.error ? ` · ${item.error}` : ''}
                  </span>
                </span>
                <span className="shrink-0 text-[12px] text-fg-muted">{statusLabel(item)}</span>
              </label>)}
          </div>
          {review.items.length > pageSize ? <div className="flex items-center justify-between gap-2 text-[12px] text-fg-subtle">
            <span>Showing {page * pageSize + 1}–{Math.min(review.items.length, (page + 1) * pageSize)} of {review.items.length}</span>
            <div className="flex gap-1.5">
              <Button variant="secondary" size="sm" disabled={page === 0} onClick={() => setPage(value => Math.max(0, value - 1))}>Previous</Button>
              <Button variant="secondary" size="sm" disabled={page + 1 >= pageCount} onClick={() => setPage(value => Math.min(pageCount - 1, value + 1))}>Next</Button>
            </div>
          </div> : null}
          {phase === 'done' || phase === 'cancelled' || phase === 'error' ?
            <>
              {totals.imported > 0 ? <p className="text-[12px] text-fg-subtle">
                Imported records are ready to preview. BPM/key analysis may continue in the background; use the library controls to cancel or retry it.
              </p> : null}
              {phase === 'error' && review.error?.startsWith('Library save is pending:') ?
                <Button variant="secondary" size="sm" disabled={busy} onClick={() => { void retrySave() }}>Retry library save</Button> : null}
              <Button variant="secondary" size="sm" disabled={busy} onClick={() => { void dismiss(true) }}>Import more</Button>
            </> : null}
        </>}
        {review?.error || error ? <p role="alert" className="text-[12px] text-danger">{error || review?.error}</p> : null}
      </div>
    </Modal>
  </>
}
