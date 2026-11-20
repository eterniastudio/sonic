import { useState, type ReactNode } from 'react'
import { Play } from 'lucide-react'
import type { LibraryBeat } from '@shared/domain'
import type { DuplicateGroup } from '@shared/libraryTools'
import { formatBpm, formatDuration } from '@shared/format'
import { cn } from '@/lib/cn'
import { Button, IconButton } from '@/components/ui/Button'
import { ConfirmDialog } from '@/components/ui/Modal'

const REASON_TEXT: Record<DuplicateGroup['reasons'][number], string> = {
  source: 'Same source link',
  audio: 'Identical audio'
}

const ownership = (beat: LibraryBeat): string => beat.fileOwnership === 'external' ? 'Imported original' : 'Sonic export'
const added = (beat: LibraryBeat): string => new Date(beat.addedAt).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' })

/**
 * Records that share a source link or identical audio, one group per block.
 * Resolving keeps the chosen record, moves favorites, tags, notes and
 * collection membership onto it, and removes the other records from the
 * library. Audio files on disk are never deleted from here.
 */
export function DuplicatesPanel({ groups, byId, onResolve, onInspect, onPlay }: {
  groups: DuplicateGroup[]
  byId: ReadonlyMap<string, LibraryBeat>
  onResolve: (keepId: string, removeIds: string[]) => Promise<void>
  onInspect: (id: string) => void
  onPlay: (id: string) => void
}): ReactNode {
  const [keep, setKeep] = useState<Record<string, string>>({})
  const [confirm, setConfirm] = useState<{ group: DuplicateGroup; keepId: string } | null>(null)

  if (!groups.length) {
    return <div className="studio-panel grid h-full min-h-[180px] place-items-center px-8 text-center text-[13.5px] text-fg-muted">
      No duplicates. Every record has its own source link and its own audio.
    </div>
  }

  const keepTitle = confirm ? byId.get(confirm.keepId)?.title ?? 'this record' : ''
  const removing = confirm ? confirm.group.beatIds.filter(id => id !== confirm.keepId) : []

  return <div className="space-y-3 pb-2" data-duplicate-groups={groups.length}>
    <p className="max-w-[72ch] text-[12px] leading-relaxed text-fg-muted">
      Choose the record to keep in each group. Its notes, tags, favorite and collections absorb the others&rsquo;,
      and the other records leave the library. Audio files stay on disk.
    </p>
    {groups.map(group => {
      const members = group.beatIds.flatMap(id => byId.has(id) ? [byId.get(id)!] : [])
      const keepId = keep[group.id] && group.beatIds.includes(keep[group.id]) ? keep[group.id] : group.beatIds[0]
      const name = `duplicate-keep-${group.id}`
      return <section key={group.id} aria-label={`Duplicate group: ${members[0]?.title ?? group.id}`} data-duplicate-group={group.id}
        className="rounded-[2px] border border-line bg-surface">
        <header className="flex items-center gap-3 border-b border-line px-3 py-2">
          <span className="min-w-0 flex-1 truncate text-[13.5px] font-semibold text-fg">{members[0]?.title}</span>
          <span className="shrink-0 text-[12px] text-fg-subtle">{group.reasons.map(reason => REASON_TEXT[reason]).join(' and ')}</span>
          <Button size="sm" variant="danger" onClick={() => setConfirm({ group, keepId })}>
            Remove {members.length - 1} other record{members.length === 2 ? '' : 's'}
          </Button>
        </header>
        <div role="radiogroup" aria-label="Record to keep">
          {members.map(beat => <div key={beat.id} data-beat-id={beat.id}
            className={cn('flex h-[52px] items-center gap-3 border-b border-line px-3 last:border-b-0', keepId === beat.id ? 'bg-surface-2' : '')}>
            <input type="radio" name={name} checked={keepId === beat.id} aria-label={`Keep ${beat.title} (${beat.fileName})`}
              onChange={() => setKeep(current => ({ ...current, [group.id]: beat.id }))}
              className="size-4 shrink-0 accent-[var(--sonic-accent)]" />
            <IconButton label={`Play ${beat.title}`} size="icon-sm" disabled={beat.missing || !!beat.fileAccessError} onClick={() => onPlay(beat.id)}><Play /></IconButton>
            <button type="button" onClick={() => onInspect(beat.id)} aria-label={`Open ${beat.fileName} in details`}
              className="min-w-0 flex-1 text-left focus-visible:rounded-[2px] focus-visible:outline-2 focus-visible:outline-accent">
              <span className="block truncate text-[13.5px] text-fg" title={beat.fileName}>{beat.fileName}</span>
              <span className="mt-0.5 block truncate text-[12px] text-fg-subtle">
                {ownership(beat)}, added {added(beat)}{beat.missing ? ', file missing' : ''}
              </span>
            </button>
            <span className="w-14 shrink-0 text-right text-[12px] text-fg-muted nums">{beat.bpm != null ? formatBpm(beat.bpm) : '—'}</span>
            <span className="w-10 shrink-0 text-right text-[12px] text-fg-muted nums">{beat.camelot ?? '—'}</span>
            <span className="w-11 shrink-0 text-right text-[12px] text-fg-subtle nums">{formatDuration(beat.durationSec)}</span>
            <span className="w-14 shrink-0 text-right text-[12px] text-fg-subtle">{keepId === beat.id ? 'Keep' : 'Remove'}</span>
          </div>)}
        </div>
      </section>
    })}

    <ConfirmDialog
      open={confirm != null}
      title={`Keep “${keepTitle}” and remove ${removing.length} record${removing.length === 1 ? '' : 's'}?`}
      description="The other records leave the library. Their notes, tags, favorite and collection places move to the record you keep. No audio file is deleted."
      confirmLabel="Remove other records"
      tone="danger"
      onCancel={() => setConfirm(null)}
      onConfirm={async () => {
        if (!confirm) return
        await onResolve(confirm.keepId, removing)
        setConfirm(null)
      }}
    >
      <ul className="space-y-1 text-[12px] text-fg-subtle">
        {removing.map(id => <li key={id} className="break-all">{byId.get(id)?.fileName ?? id}</li>)}
      </ul>
    </ConfirmDialog>
  </div>
}
