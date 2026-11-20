import type { ReactNode } from 'react'
import { CircleAlert } from 'lucide-react'
import { formatBytes } from '@shared/format'
import { useApp } from '@/store/app'
import { Button } from '@/components/ui/Button'
import { ProgressBar } from '@/components/ui/Progress'

/** Inline setup status and repair action, shown only while the engine is incomplete. */
export function EngineBanner(): ReactNode {
  const engine = useApp((state) => state.engine)
  const progress = useApp((state) => state.engineProgress)
  const setupEngine = useApp((state) => state.setupEngine)
  const setupRunning = engine?.setupRunning ?? false

  if (!engine || engine.ready) return null

  const missing = engine.components.filter((component) => !component.available)
  const error = engine.lastError ?? (progress?.phase === 'error' ? progress.message : null)

  return (
    <section className="shrink-0" aria-label="Media engine setup">
      <div className="flex min-h-6 items-center gap-2">
        <CircleAlert className="size-3.5 shrink-0 text-fg-subtle" />
        <h2 className="min-w-0 flex-1 truncate text-[12px] font-normal text-fg-muted" title={`Missing: ${missing.map((component) => component.name).join(', ')}`}>
          {setupRunning ? 'Setting up the media engine' : 'Media engine setup required'}
        </h2>
        <Button variant="ghost" size="xs" busy={setupRunning} onClick={() => void setupEngine()} className="h-6 px-1.5 text-[12px] text-fg">
          {setupRunning ? 'Setting up…' : 'Set up now'}
        </Button>
      </div>
      {progress && progress.phase !== 'idle' && progress.phase !== 'done' && progress.phase !== 'error' ? (
        <div className="mt-1.5 space-y-1.5">
          <div className="flex items-center justify-between gap-3 text-[12px] text-fg-subtle">
            <span className="truncate">{progress.message}</span>
            {progress.totalBytes ? <span className="shrink-0 nums">{formatBytes(progress.receivedBytes)} / {formatBytes(progress.totalBytes)}</span> : null}
          </div>
          <ProgressBar value={progress.percent} className="h-0.5 rounded-none [&>span]:rounded-none [&>span]:bg-fg-muted" />
        </div>
      ) : null}
      {error ? <p className="mt-1 text-[12px] leading-relaxed text-danger">{error}</p> : null}
    </section>
  )
}
