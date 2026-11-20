import type { ReactNode } from 'react'
import { X } from 'lucide-react'
import type { LibraryBeat } from '@shared/domain'
import type { CompatibilityCriteria } from '@shared/libraryTools'
import { formatBpm } from '@shared/format'
import { Button } from '@/components/ui/Button'
import { Segmented } from '@/components/ui/Segmented'
import { Switch } from '@/components/ui/Switch'

export interface CompatibleState {
  seedId: string
  bpmTolerance: number
  includeHalfDouble: boolean
}

export const COMPATIBLE_TOLERANCES = ['2', '4', '8'] as const

/** States what "compatible" means right now, so the filtered list is never a mystery. */
export function CompatibleBanner({ seed, criteria, state, count, onChange, onClear }: {
  seed: LibraryBeat
  criteria: CompatibilityCriteria
  state: CompatibleState
  count: number
  onChange: (next: CompatibleState) => void
  onClear: () => void
}): ReactNode {
  const keys = criteria.camelots ? criteria.camelots.join(', ') : 'any key (this track has none)'
  const tempo = criteria.tempoRanges
    ? criteria.tempoRanges.map(range => `${formatBpm(range.min)}–${formatBpm(range.max)}`).join(' or ')
    : 'any tempo (this track has none)'
  return <div role="status" aria-label="Compatible tracks" className="flex flex-wrap items-center gap-x-4 gap-y-2 rounded-[2px] border border-line bg-surface px-3 py-2">
    <div className="min-w-0 flex-1">
      <p className="truncate text-[13.5px] text-fg">
        <span className="font-semibold">{count - 1} compatible with</span> {seed.title}
      </p>
      <p className="mt-0.5 text-[12px] text-fg-muted">
        Keys <span className="text-fg nums">{keys}</span>, tempo <span className="text-fg nums">{tempo}</span> BPM
      </p>
    </div>
    {criteria.tempoRanges ? <>
      <div className="flex items-center gap-1.5">
        <span className="text-[12px] text-fg-subtle">BPM ±</span>
        <Segmented size="sm" ariaLabel="Compatible BPM tolerance" value={String(state.bpmTolerance)}
          onChange={next => onChange({ ...state, bpmTolerance: Number(next) })}
          options={COMPATIBLE_TOLERANCES.map(value => ({ value, label: value }))} />
      </div>
      <div className="flex items-center gap-2">
        <Switch checked={state.includeHalfDouble} label="Compatible half and double time"
          onChange={next => onChange({ ...state, includeHalfDouble: next })} />
        <span className="text-[12px] text-fg-muted">Half/double time</span>
      </div>
    </> : null}
    <Button size="sm" variant="ghost" leading={<X />} onClick={onClear}>Show all tracks</Button>
  </div>
}
