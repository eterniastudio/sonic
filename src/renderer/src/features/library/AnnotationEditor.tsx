import { useEffect, useRef, useState, type ReactNode } from 'react'
import { Star } from 'lucide-react'
import type { LibraryBeat } from '@shared/domain'
import type { OrganizationCommand, OrganizationSnapshot, UserAnnotation } from '@shared/organization'
import { Button } from '@/components/ui/Button'
import { Input } from '@/components/ui/Input'
import { toast } from '@/components/ui/Toaster'

const EMPTY: UserAnnotation = { favorite: false, tags: [], notes: '' }
type Draft = { tags: string | null; notes: string | null }

function draftPatch(draft: Draft): { tags?: string[]; notes?: string } {
  return {
    ...(draft.tags !== null ? { tags: draft.tags.split(',').map(item => item.trim()).filter(Boolean) } : {}),
    ...(draft.notes !== null ? { notes: draft.notes } : {})
  }
}

/** Producer annotations are library-only; saving never changes the audio or tags. */
export function AnnotationEditor({ beat, annotation, command }: {
  beat: LibraryBeat
  annotation?: UserAnnotation
  command: (command: OrganizationCommand) => Promise<OrganizationSnapshot>
}): ReactNode {
  const current = annotation ?? EMPTY
  // Null means untouched. An empty string means the producer deliberately cleared it.
  const [draft, setDraft] = useState<Draft>({ tags: null, notes: null })
  const tags = draft.tags ?? current.tags.join(', ')
  const notes = draft.notes ?? current.notes
  const [pending, setPending] = useState(false)
  const [error, setError] = useState('')
  const pendingRef = useRef(false)
  const mounted = useRef(true)
  const latest = useRef({ draft, command })
  useEffect(() => { latest.current = { draft, command } })
  useEffect(() => {
    mounted.current = true
    setDraft({ tags: null, notes: null }); setError('')
    const beatId = beat.id
    // Leaving the track (another selection, closing the inspector) saves an
    // unsaved draft instead of dropping it. An in-flight save already holds it.
    return () => {
      mounted.current = false
      const { draft: unsaved, command: run } = latest.current
      if (pendingRef.current || (unsaved.tags === null && unsaved.notes === null)) return
      latest.current = { ...latest.current, draft: { tags: null, notes: null } }
      void run({ type: 'set-annotation', beatId, ...draftPatch(unsaved) })
        .catch(failure => toast({ kind: 'error', title: 'Notes and tags were not saved', description: String(failure) }))
    }
  }, [beat.id])
  const save = async (patch: { favorite?: boolean; tags?: string[]; notes?: string }, submitted?: Draft): Promise<void> => {
    if (pendingRef.current) return
    pendingRef.current = true
    setPending(true); setError('')
    try {
      await command({ type: 'set-annotation', beatId: beat.id, ...patch })
      if (submitted) setDraft(previous => ({
        tags: submitted.tags !== null && previous.tags === submitted.tags ? null : previous.tags,
        notes: submitted.notes !== null && previous.notes === submitted.notes ? null : previous.notes
      }))
    } catch (failure) {
      const message = failure instanceof Error ? failure.message : String(failure)
      if (mounted.current) setError(message)
      else toast({ kind: 'error', title: 'Notes and tags were not saved', description: message })
    } finally { pendingRef.current = false; setPending(false) }
  }
  const saveDraft = (): void => {
    if (draft.tags === null && draft.notes === null) return
    const submitted = { ...draft }
    void save(draftPatch(submitted), submitted)
  }
  return <section aria-label="Your annotations" onBlur={event => {
    if (!event.currentTarget.contains(event.relatedTarget as Node | null)) saveDraft()
  }} className="border-t border-line px-4 py-4 text-[12px] text-fg-muted">
    <div className="flex items-center gap-2">
      <strong className="section-label">Notes &amp; tags</strong>
      <span className="flex-1" />
      <button type="button" aria-label={current.favorite ? `Unfavorite ${beat.title}` : `Favorite ${beat.title}`}
        aria-pressed={current.favorite} disabled={pending} onClick={() => void save({ favorite: !current.favorite })}
        className="flex items-center gap-1.5 rounded-[2px] px-1.5 py-1 text-[12px] text-fg-muted transition-colors hover:bg-surface-2 hover:text-fg"><Star className="size-3.5" fill={current.favorite ? 'currentColor' : 'none'} />Favorite</button>
    </div>
    <div className="mt-3 grid gap-3">
      <label className="text-[12px] text-fg-muted"><span className="mb-1.5 block">User tags</span><Input aria-label="User tags" value={tags} maxLength={1200} disabled={pending} onChange={event => setDraft(previous => ({ ...previous, tags: event.target.value }))} placeholder="dark, good for vocals" /></label>
      <label className="text-[12px] text-fg-muted">Notes<textarea aria-label="Notes" value={notes} maxLength={4000} disabled={pending} onChange={event => setDraft(previous => ({ ...previous, notes: event.target.value }))} placeholder="Good hook section at 0:48"
        className="mt-1.5 block min-h-[64px] w-full resize-y rounded-[2px] border border-line-strong/60 bg-transparent px-2.5 py-2 text-[12px] leading-relaxed text-fg placeholder:text-fg-subtle focus:border-accent" /></label>
    </div>
    <div className="mt-3 space-y-2">
      <Button size="sm" variant="secondary" className="w-full" disabled={pending || (draft.tags === null && draft.notes === null)} onClick={saveDraft}>Save annotations</Button>
      <p className="text-center text-[12px] text-fg-subtle">Saved in Sonic’s library only, also when you leave this track.</p>
    </div>
    {error ? <p role="alert" className="mt-2 text-danger">{error}</p> : null}
  </section>
}
