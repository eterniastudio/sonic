import { useCallback, useLayoutEffect, useRef, useState, type ReactNode, type RefObject } from 'react'
import { Download, ListChecks, Pause, Play, RotateCcw } from 'lucide-react'
import type { Job } from '@shared/domain'
import { useApp } from '@/store/app'
import { ipc } from '@/lib/ipc'
import { toast } from '@/components/ui/Toaster'
import { Button } from '@/components/ui/Button'
import { Segmented } from '@/components/ui/Segmented'
import { useVirtualRows, withPinned } from '@/lib/virtualRows'
import { JobRow, QueueEmptyState } from './JobRow'

const TERMINAL = new Set(['complete', 'failed', 'cancelled'])
/** Below this many jobs every row is mounted; above it only the visible window is. */
const VIRTUALIZE_AFTER = 150
/** `min-h-[68px]` plus the 1px divider. A mounted row's real height wins. */
const JOB_ROW_PX = 69

/** A dedicated queue with task controls separated from its transport settings. */
export function QueueList(): ReactNode {
  const jobs = useApp((state) => state.queue.jobs)
  const paused = useApp((state) => state.queue.paused)
  const concurrency = useApp((state) => state.queue.concurrency)
  const selectedJobId = useApp((state) => state.selectedJobId)
  const setSelectedJob = useApp((state) => state.setSelectedJob)
  const startJobs = useApp((state) => state.startJobs)
  const setPaused = useApp((state) => state.setPaused)
  const setConcurrency = useApp((state) => state.setConcurrency)
  const clearFinished = useApp((state) => state.clearFinished)
  const selectJob = useCallback((id: string): void => {
    setSelectedJob(useApp.getState().selectedJobId === id ? null : id)
  }, [setSelectedJob])
  const scrollRef = useRef<HTMLDivElement>(null)
  const readyCount = jobs.filter((job) => job.stage === 'ready').length
  const activeCount = jobs.filter((job) => !TERMINAL.has(job.stage)).length
  const finishedCount = jobs.filter((job) => job.stage === 'complete' || job.stage === 'cancelled').length
  const failedCount = jobs.filter((job) => job.stage === 'failed').length
  const retryFailed = (): void => {
    void ipc.invoke('queue:retryFailed').then((queue) => useApp.getState().setQueueSnapshot(queue))
      .catch((error) => toast({ kind: 'error', title: 'Could not retry failed downloads', description: String(error) }))
  }

  return (
    <section className="flex min-h-[180px] flex-1 flex-col overflow-hidden" aria-labelledby="queue-heading">
      <div className="flex shrink-0 flex-wrap items-center gap-2 border-t border-line py-2">
        <h2 id="queue-heading" className="text-[13.5px] font-medium text-fg">Queue</h2>
        <span className="text-[12px] text-fg-subtle nums">{jobs.length}</span>
        <span className="flex-1" />
        {failedCount > 0 ? <Button variant="ghost" size="xs" leading={<RotateCcw />} onClick={retryFailed} className="h-6 px-1.5 text-[12px]">Retry failed ({failedCount})</Button> : null}
        <Button variant="ghost" size="xs" leading={<ListChecks />} disabled={finishedCount === 0} onClick={() => void clearFinished()} className="h-6 px-1.5 text-[12px]">Clear done</Button>
        <Button variant="primary" size="xs" leading={<Download />} disabled={readyCount === 0} onClick={() => void startJobs(null)} className="h-6 rounded-[2px] px-2 text-[12px] shadow-none">
          Download all{readyCount > 0 ? ` (${readyCount})` : ''}
        </Button>
      </div>

      <div className="flex shrink-0 flex-wrap items-center gap-x-3 gap-y-1 border-b border-line pb-1.5">
        <div className="text-[12px] text-fg-subtle">
          {paused ? 'Paused' : activeCount > 0 ? `${activeCount} active` : 'Idle'}
        </div>
        <span className="flex-1" />
        <div className="flex items-center gap-1.5">
          <span className="text-[12px] text-fg-subtle">Parallel</span>
          <Segmented size="sm" value={String(concurrency)} onChange={(next) => void setConcurrency(Number(next))} ariaLabel="Concurrent downloads" options={[{ value: '1', label: '1' }, { value: '2', label: '2' }, { value: '3', label: '3' }]} />
        </div>
        <Button variant="ghost" size="xs" onClick={() => void setPaused(!paused)} leading={paused ? <Play /> : <Pause />} className="h-6 px-1.5 text-[12px]">
          {paused ? 'Resume' : 'Pause'}
        </Button>
      </div>

      <div ref={scrollRef} className="min-h-0 flex-1 overflow-y-auto">
        {jobs.length === 0 ? (
          <QueueEmptyState>Paste a link above to prepare your first download.</QueueEmptyState>
        ) : jobs.length > VIRTUALIZE_AFTER ? (
          <VirtualJobs jobs={jobs} selectedJobId={selectedJobId} onSelect={selectJob} scrollRef={scrollRef} />
        ) : (
          <div className="divide-y divide-line">
            {jobs.map((job) => (
              <JobRow key={job.id} job={job} selected={selectedJobId === job.id} onSelect={selectJob} />
            ))}
          </div>
        )}
      </div>
    </section>
  )
}

/**
 * Only the jobs in view are mounted, so a long queue holds a bounded number of
 * rows, menus and dialogs. The row that last received focus (including focus in
 * its menu or confirmation, which React routes through the row) stays mounted.
 */
function VirtualJobs({ jobs, selectedJobId, onSelect, scrollRef }: {
  jobs: Job[]
  selectedJobId: string | null
  onSelect: (id: string) => void
  scrollRef: RefObject<HTMLDivElement | null>
}): ReactNode {
  const contentRef = useRef<HTMLDivElement>(null)
  const [focusedId, setFocusedId] = useState<string | null>(null)
  const [pitch, setPitch] = useState(JOB_ROW_PX)
  useLayoutEffect(() => {
    // Rows after the first carry the 1px divider; measure one of those.
    const height = contentRef.current?.children[1]?.getBoundingClientRect().height ?? 0
    if (height > 0 && Math.abs(height - pitch) > 0.5) setPitch(height)
  })
  const windowed = useVirtualRows({ scrollRef, contentRef, items: jobs.length, rowHeight: pitch })
  const focused = focusedId ? jobs.findIndex(job => job.id === focusedId) : -1
  return (
    // Row 0 has no divider, so every later row starts 1px earlier than index * pitch.
    <div ref={contentRef} className="relative" style={{ height: jobs.length * pitch - 1 }}>
      {withPinned(windowed, focused >= 0 ? [focused] : [], jobs.length).map(index => (
        <div key={jobs[index].id} className={index > 0 ? 'absolute inset-x-0 border-t border-line' : 'absolute inset-x-0'}
          style={{ top: index > 0 ? index * pitch - 1 : 0 }} onFocus={() => setFocusedId(jobs[index].id)}>
          <JobRow job={jobs[index]} selected={selectedJobId === jobs[index].id} onSelect={onSelect} />
        </div>
      ))}
    </div>
  )
}
