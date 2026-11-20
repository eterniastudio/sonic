import { useEffect, useState, type ReactNode } from 'react'
import { ProvenanceLegend } from '@/components/audio/Provenance'
import type { LibraryBeat, PresetId } from '@shared/domain'
import { FAVORITES_COLLECTION_ID, type LibraryCollection, type OrganizationCommand, type OrganizationSnapshot, type SmartCollectionRule } from '@shared/organization'
import type { BatchSession } from '@shared/batch'
import { PRESETS } from '@shared/presets'
import { ALL_PROVIDERS } from '@shared/providers'
import { DUPLICATES_VIEW_ID, NEEDS_REVIEW_VIEW_ID, RECENT_VIEW_ID, RECENT_WINDOW_DAYS } from '@shared/libraryTools'
import { ipc } from '@/lib/ipc'
import { Button, IconButton } from '@/components/ui/Button'
import { Dropdown, DropdownItem } from '@/components/ui/Dropdown'
import { CheckSquare2, Download, Folder, FolderMinus, FolderPlus, Library, MoreHorizontal, Play, Plus, Sparkles, Star, StarOff, Tag, Tags, X } from 'lucide-react'
import { Input } from '@/components/ui/Input'
import { Modal } from '@/components/ui/Modal'
import { toast } from '@/components/ui/Toaster'

type Mode = 'create-manual' | 'create-smart' | 'edit-smart' | 'rename' | 'delete' | 'tag-add' | 'tag-remove' | 'add-members' | 'export' | null
const EMPTY_RULE: SmartCollectionRule = { version: 1 }
/** Computed views, always present beside Favorites. */
const BUILT_IN_VIEWS = [
  { id: RECENT_VIEW_ID, label: 'Recently added', title: `Added in the last ${RECENT_WINDOW_DAYS} days` },
  { id: NEEDS_REVIEW_VIEW_ID, label: 'Needs review', title: 'No BPM or key yet, or the source disagrees with the audio' },
  { id: DUPLICATES_VIEW_ID, label: 'Duplicates', title: 'Records that share a source link or identical audio' }
] as const

export function CollectionWorkspace({ organization, activeId, library, visible, selectedIds, clearSelection, selectAll, onPlayDisplayed, onPlaySelected,
  onScope, command, batch, setBatch, defaultPresetId, manualSort, viewCounts = {} }: {
  organization: OrganizationSnapshot | null
  activeId: string | null
  library: LibraryBeat[]
  visible: LibraryBeat[]
  selectedIds: ReadonlySet<string>
  clearSelection: () => void
  selectAll: () => void
  onPlayDisplayed: () => void
  onPlaySelected: () => void
  onScope: (id: string | null) => Promise<void>
  command: (command: OrganizationCommand) => Promise<OrganizationSnapshot>
  batch: BatchSession | null
  setBatch: (batch: BatchSession | null) => void
  defaultPresetId: PresetId
  manualSort: boolean
  /** Track (or group) counts for the computed views, shown beside their names. */
  viewCounts?: Record<string, number>
}): ReactNode {
  const [mode, setMode] = useState<Mode>(null)
  const [name, setName] = useState('')
  const [tag, setTag] = useState('')
  const [rules, setRules] = useState<SmartCollectionRule>(EMPTY_RULE)
  const [targetCollection, setTargetCollection] = useState('')
  const [preset, setPreset] = useState<PresetId>(defaultPresetId === 'original' ? 'wav-44100-24' : defaultPresetId)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const active = organization?.collections.find(item => item.id === activeId)
  const manualCollections = organization?.collections.filter(item => item.type === 'manual') ?? []
  const selected = [...selectedIds]
  const selectedCount = selected.length
  const matchingIds = visible.map(beat => beat.id)

  useEffect(() => {
    if (!batch || batch.status !== 'running') return
    const timer = window.setInterval(() => {
      void ipc.invoke('batch:status', batch.id).then(next => { if (next) setBatch(next) }).catch(error => {
        toast({ kind: 'error', title: 'Batch status unavailable', description: String(error) })
      })
    }, 700)
    return () => window.clearInterval(timer)
  }, [batch?.id, batch?.status, setBatch])

  const open = (next: Mode): void => {
    setMode(next); setError(''); setTag(''); setTargetCollection(manualCollections[0]?.id ?? '')
    setName(active?.name ?? '')
    setRules(active?.type === 'smart' ? { ...active.rules } : EMPTY_RULE)
  }
  const run = async (operation: () => Promise<unknown>, close = true): Promise<void> => {
    setBusy(true); setError('')
    try { await operation(); if (close) setMode(null) }
    catch (failure) {
      const message = failure instanceof Error ? failure.message : String(failure)
      setError(message)
      if (!mode) toast({ kind: 'error', title: 'Collection action failed', description: message })
    }
    finally { setBusy(false) }
  }
  const startBatch = async (action: 'analyze' | 'export'): Promise<void> => {
    const snapshot = [...selected]
    if (!snapshot.length) return
    if (snapshot.length > 1000) throw new Error('Analyze/export supports up to 1,000 selected beats per batch. Narrow the selection first.')
    const next = await ipc.invoke('batch:start', { action, beatIds: snapshot, ...(action === 'export' ? { presetId: preset } : {}) })
    setBatch(next)
    clearSelection()
  }
  const editRules = (patch: Partial<SmartCollectionRule>): void => setRules(current => ({ ...current, ...patch }))
  const counts = batch ? {
    pendingSave: batch.items.filter(item => item.status === 'pending-save').length,
    completed: batch.items.filter(item => item.status === 'completed').length,
    failed: batch.items.filter(item => item.status === 'failed').length,
    skipped: batch.items.filter(item => item.status === 'skipped').length,
    cancelled: batch.items.filter(item => item.status === 'cancelled').length
  } : null

  return <div className="min-w-0 shrink-0 space-y-2">
    <nav aria-label="Library collections" className="flex min-w-0 items-center gap-3 border-b border-line">
      <div className="flex min-w-0 flex-1 items-center gap-4 overflow-x-auto [&_button]:shrink-0">
        <button type="button" aria-label="All audio" aria-current={activeId === null ? 'page' : undefined}
          onClick={() => void run(() => onScope(null), false)} className={`flex h-9 items-center border-b-2 text-[12px] font-medium transition-colors ${activeId === null ? 'border-fg-muted text-fg' : 'border-transparent text-fg-subtle hover:text-fg'}`}>All audio</button>
        <button type="button" aria-label="Favorites" aria-current={activeId === FAVORITES_COLLECTION_ID ? 'page' : undefined}
          onClick={() => void run(() => onScope(FAVORITES_COLLECTION_ID), false)} className={`flex h-9 items-center gap-1.5 border-b-2 text-[12px] font-medium transition-colors ${activeId === FAVORITES_COLLECTION_ID ? 'border-fg-muted text-fg' : 'border-transparent text-fg-subtle hover:text-fg'}`}>Favorites</button>
        {BUILT_IN_VIEWS.map(view => <button key={view.id} type="button" aria-label={view.label} title={view.title}
          aria-current={activeId === view.id ? 'page' : undefined} onClick={() => void run(() => onScope(view.id), false)}
          className={`flex h-9 items-center gap-1.5 border-b-2 text-[12px] font-medium transition-colors ${activeId === view.id ? 'border-fg-muted text-fg' : 'border-transparent text-fg-subtle hover:text-fg'}`}>
          {view.label}{viewCounts[view.id] ? <span aria-hidden="true" className="font-normal text-fg-subtle nums">{viewCounts[view.id]}</span> : null}
        </button>)}
        <span aria-hidden="true" className="h-4 w-px bg-line" />
        {organization?.collections.map(item => <button key={item.id} type="button" aria-label={`Collection: ${item.name}`}
          aria-current={activeId === item.id ? 'page' : undefined} onClick={() => void run(() => onScope(item.id), false)}
          className={`flex h-9 max-w-[190px] items-center gap-1.5 border-b-2 text-[12px] font-medium transition-colors ${activeId === item.id ? 'border-fg-muted text-fg' : 'border-transparent text-fg-subtle hover:text-fg'}`}>
          {item.type === 'smart' ? <Sparkles className="size-3.5 shrink-0" /> : <Folder className="size-3.5 shrink-0" />}<span className="truncate">{item.name}</span>
        </button>)}
      </div>
      <div className="flex shrink-0 items-center gap-1">
        <Button size="sm" variant="ghost" leading={<Plus />} onClick={() => { setName(''); open('create-manual'); setName('') }}>New collection</Button>
        <IconButton label="New smart collection" title="New smart collection" size="icon-sm" onClick={() => { open('create-smart'); setName('') }}><Sparkles /></IconButton>
        {active ? <Dropdown align="end" trigger={({ toggle }) => <IconButton label="Collection options" title="Collection options" size="icon-sm" onClick={toggle}><MoreHorizontal /></IconButton>}>
          {close => <>
            <DropdownItem onSelect={() => { open('rename'); close() }}>Rename</DropdownItem>
            {active.type === 'smart' ? <DropdownItem onSelect={() => { open('edit-smart'); close() }}>Edit rules</DropdownItem> : null}
            <DropdownItem tone="danger" onSelect={() => { open('delete'); close() }}>Delete collection</DropdownItem>
          </>}
        </Dropdown> : null}
      </div>
    </nav>

    {selectedCount ? <div role="toolbar" aria-label="Selected beats" className="flex flex-wrap items-center gap-1.5 rounded-[2px] bg-surface-2 px-2 py-1">
      <strong className="mr-1 shrink-0 text-[12px] font-medium text-fg nums">{selectedCount} selected</strong>
      <Button size="sm" aria-label="Play selected tracks" variant="primary" leading={<Play className="fill-current" />} onClick={onPlaySelected}>Play selected</Button>
      <IconButton label="Play displayed results" title="Play displayed results" size="icon-sm" disabled={!matchingIds.length} onClick={onPlayDisplayed}><Library /></IconButton>
      <span className="mx-1 h-4 w-px bg-line-strong" />
      <IconButton label="Favorite selected" title="Favorite selected" size="icon-sm" disabled={selectedCount > 5000} onClick={() => void run(() => command({ type: 'batch-annotation', beatIds: selected, favorite: true }), false)}><Star /></IconButton>
      <IconButton label="Unfavorite selected" title="Unfavorite selected" size="icon-sm" disabled={selectedCount > 5000} onClick={() => void run(() => command({ type: 'batch-annotation', beatIds: selected, favorite: false }), false)}><StarOff /></IconButton>
      <IconButton label="Add tag to selected" title="Add tag to selected" size="icon-sm" disabled={selectedCount > 5000} onClick={() => open('tag-add')}><Tags /></IconButton>
      <IconButton label="Remove tag from selected" title="Remove tag from selected" size="icon-sm" disabled={selectedCount > 5000} onClick={() => open('tag-remove')}><Tag /></IconButton>
      <Button size="sm" variant="ghost" leading={<FolderPlus />} disabled={!manualCollections.length} onClick={() => open('add-members')}>Add to collection</Button>
      {active?.type === 'manual' ? <IconButton label="Remove from this collection" title="Remove from this collection" size="icon-sm" onClick={() => void run(() => command({ type: 'remove-members', id: active.id, beatIds: selected }), false)}><FolderMinus /></IconButton> : null}
      <IconButton label="Analyze selected" title="Analyze selected" size="icon-sm" disabled={selectedCount > 1000} onClick={() => void run(() => startBatch('analyze'), false)}><Sparkles /></IconButton>
      <IconButton label="Export selected" title="Export selected" size="icon-sm" disabled={selectedCount > 1000} onClick={() => open('export')}><Download /></IconButton>
      <span className="flex-1" />
      {selectedCount !== matchingIds.length ? <IconButton label={`Select all ${matchingIds.length} matching`} title={`Select all ${matchingIds.length} matching`} size="icon-sm" onClick={selectAll}><CheckSquare2 /></IconButton> : null}
      <IconButton label="Clear selection" title="Clear selection" size="icon-sm" onClick={clearSelection}><X /></IconButton>
      {selectedCount > 1000 ? <span className="w-full text-[12px] text-fg-muted">Analyze/export: 1,000 max{selectedCount > 5000 ? '; annotations: 5,000 max' : ''}. Narrow the selection.</span> : null}
    </div> : <div className="flex flex-wrap items-center gap-2 text-[12px] text-fg-subtle">
      <span className="mr-1 text-fg-muted nums">{matchingIds.length} track{matchingIds.length === 1 ? '' : 's'}</span>
      <Button size="sm" variant="ghost" aria-label="Play displayed results" leading={<Play />} disabled={!matchingIds.length} onClick={onPlayDisplayed}>Play all</Button>
      <span className="flex-1" />
      <ProvenanceLegend className="order-last w-full pb-1 pl-1 xl:order-none xl:mr-2 xl:w-auto xl:pb-0" />
      {matchingIds.length ? <Button size="sm" variant="ghost" aria-label={`Select all ${matchingIds.length} matching`} onClick={selectAll}>Select all</Button> : null}
    </div>}
    {active?.type === 'manual' && manualSort && active.beatIds.length > 1 ? <div className="flex flex-wrap items-center gap-2 px-1 text-[12px] text-fg-subtle">
      <span>Collection order</span>
      <Button size="sm" variant="ghost" disabled={selectedCount !== 1 || active.beatIds.indexOf(selected[0]) <= 0}
        onClick={() => void run(() => moveMember(active, selected[0], -1, command), false)}>Move selected up</Button>
      <Button size="sm" variant="ghost" disabled={selectedCount !== 1 || active.beatIds.indexOf(selected[0]) < 0 || active.beatIds.indexOf(selected[0]) >= active.beatIds.length - 1}
        onClick={() => void run(() => moveMember(active, selected[0], 1, command), false)}>Move selected down</Button>
    </div> : null}

    {batch ? <div role="status" className="rounded-[2px] border border-line bg-surface p-3 text-[12px] text-fg-muted">
      <strong className="text-fg">Batch {batch.request.action}: {batch.status}</strong>{' · '}
      {counts?.completed} completed · {counts?.pendingSave} pending save · {counts?.failed} failed · {counts?.skipped} skipped · {counts?.cancelled} cancelled
      <div className="mt-2 flex flex-wrap gap-2">
        {batch.status === 'running' ? <Button size="sm" variant="secondary" onClick={() => void run(async () => { const next = await ipc.invoke('batch:cancel', batch.id); if (next) setBatch(next) }, false)}>Cancel batch</Button> : null}
        {batch.status !== 'running' && (counts!.failed + counts!.skipped + counts!.pendingSave + counts!.cancelled) > 0 ? <Button size="sm" variant="secondary" onClick={() => void run(async () => setBatch(await ipc.invoke('batch:retry', batch.id)), false)}>Retry unfinished items</Button> : null}
        {batch.status !== 'running' ? <Button size="sm" variant="ghost" onClick={() => setBatch(null)}>Dismiss results</Button> : null}
      </div>
      {batch.items.filter(item => item.status === 'pending-save' || item.status === 'failed' || item.status === 'skipped' || item.error).map(item =>
        <p key={item.beatId} className="mt-1 break-all text-danger">
          {library.find(beat => beat.id === item.beatId)?.title ?? item.beatId}: {item.status === 'pending-save' ? 'Audio was prepared, but the library save is pending. Retry will reconcile this output without creating another copy.' : item.status}
          {item.error ? ` — ${item.error}` : ''}
        </p>)}
    </div> : null}

    <Modal open={mode !== null} onClose={() => { if (!busy) setMode(null) }} title={modeTitle(mode)} size="sm" blocking={busy}
      footer={<><Button variant="secondary" disabled={busy} onClick={() => setMode(null)}>Cancel</Button>
        <Button disabled={busy} onClick={() => void run(async () => {
          if (mode === 'create-manual') await command({ type: 'create-manual', name, beatIds: selected })
          if (mode === 'create-smart') await command({ type: 'create-smart', name, rules })
          if (mode === 'edit-smart' && active?.type === 'smart') await command({ type: 'update-smart', id: active.id, rules })
          if (mode === 'rename' && active) await command({ type: 'rename', id: active.id, name })
          if (mode === 'delete' && active) { await command({ type: 'delete', id: active.id }); await onScope(null) }
          if (mode === 'tag-add') await command({ type: 'batch-annotation', beatIds: selected, tagsAdd: [tag] })
          if (mode === 'tag-remove') await command({ type: 'batch-annotation', beatIds: selected, tagsRemove: [tag] })
          if (mode === 'add-members') await command({ type: 'add-members', id: targetCollection, beatIds: selected })
          if (mode === 'export') await startBatch('export')
        })}>{mode === 'delete' ? 'Delete collection only' : mode === 'export' ? 'Start export' : 'Save'}</Button></>}>
      {mode === 'create-manual' || mode === 'create-smart' || mode === 'rename' ? <Input aria-label="Collection name" value={name} onChange={event => setName(event.target.value)} placeholder="Collection name" /> : null}
      {mode === 'delete' ? <p className="text-[12px] text-fg-muted">Delete “{active?.name}”? The library records and audio files remain untouched.</p> : null}
      {mode === 'tag-add' || mode === 'tag-remove' ? <Input aria-label="User tag" value={tag} onChange={event => setTag(event.target.value)} placeholder="Tag, e.g. good for vocals" /> : null}
      {mode === 'add-members' ? <label className="text-[12px] text-fg-muted">Manual collection<select aria-label="Target collection" value={targetCollection} onChange={event => setTargetCollection(event.target.value)} className="mt-1 block w-full rounded border border-line bg-surface p-2">{manualCollections.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label> : null}
      {mode === 'export' ? <label className="text-[12px] text-fg-muted">Export recipe<select aria-label="Batch export recipe" value={preset} onChange={event => setPreset(event.target.value as PresetId)} className="mt-1 block w-full rounded border border-line bg-surface p-2">{PRESETS.filter(item => item.id !== 'original').map(item => <option key={item.id} value={item.id}>{item.label}</option>)}</select><span className="mt-2 block">{selectedCount} selected files will be exported. Imported originals stay untouched.</span></label> : null}
      {mode === 'create-smart' || mode === 'edit-smart' ? <SmartRuleEditor rules={rules} update={editRules} /> : null}
      {error ? <p role="alert" className="mt-2 text-[12px] text-danger">{error}</p> : null}
    </Modal>
  </div>
}

async function moveMember(collection: Extract<LibraryCollection, { type: 'manual' }>, id: string, direction: -1 | 1,
  command: (command: OrganizationCommand) => Promise<OrganizationSnapshot>): Promise<void> {
  const next = [...collection.beatIds]
  const index = next.indexOf(id)
  if (index < 0 || index + direction < 0 || index + direction >= next.length) return
  ;[next[index], next[index + direction]] = [next[index + direction], next[index]]
  await command({ type: 'reorder-members', id: collection.id, beatIds: next })
}

function modeTitle(mode: Mode): string {
  switch (mode) {
    case 'create-manual': return 'New project collection'
    case 'create-smart': return 'New smart collection'
    case 'edit-smart': return 'Edit smart collection rules'
    case 'rename': return 'Rename collection'
    case 'delete': return 'Delete collection'
    case 'tag-add': return 'Add tag to selected'
    case 'tag-remove': return 'Remove tag from selected'
    case 'add-members': return 'Add selected to collection'
    case 'export': return 'Export selected'
    default: return ''
  }
}

function SmartRuleEditor({ rules, update }: { rules: SmartCollectionRule; update: (patch: Partial<SmartCollectionRule>) => void }): ReactNode {
  const number = (text: string): number | undefined => text.trim() ? Number(text) : undefined
  return <div className="mt-3 grid grid-cols-2 gap-2 text-[12px] text-fg-muted">
    <label className="col-span-2">Search text<Input aria-label="Smart search text" value={rules.query ?? ''} onChange={event => update({ query: event.target.value })} /></label>
    <label>Minimum BPM<Input aria-label="Smart minimum BPM" type="number" value={rules.bpmMin ?? ''} onChange={event => update({ bpmMin: number(event.target.value) })} /></label>
    <label>Maximum BPM<Input aria-label="Smart maximum BPM" type="number" value={rules.bpmMax ?? ''} onChange={event => update({ bpmMax: number(event.target.value) })} /></label>
    <label>Key / Camelot<Input aria-label="Smart key" value={rules.key ?? ''} onChange={event => update({ key: event.target.value || undefined })} /></label>
    <label>User tags<Input aria-label="Smart user tags" value={rules.tags?.join(', ') ?? ''} onChange={event => update({ tags: event.target.value.split(',').map(tag => tag.trim()).filter(Boolean) })} placeholder="dark, vocals" /></label>
    <label>Favorite<select aria-label="Smart favorite state" value={rules.favorite == null ? 'any' : String(rules.favorite)} onChange={event => update({ favorite: event.target.value === 'any' ? undefined : event.target.value === 'true' })} className="mt-1 block w-full rounded border border-line bg-surface p-2"><option value="any">Any</option><option value="true">Favorites</option><option value="false">Not favorites</option></select></label>
    <label>Source<select aria-label="Smart source origin" value={rules.sourceKind ?? 'any'} onChange={event => update({ sourceKind: event.target.value === 'any' ? undefined : event.target.value as SmartCollectionRule['sourceKind'] })} className="mt-1 block w-full rounded border border-line bg-surface p-2"><option value="any">Any</option><option value="local">Local source</option>{ALL_PROVIDERS.map(provider => <option key={provider.id} value={provider.id}>{provider.name} source</option>)}<option value="unknown">Unknown</option></select></label>
    <label>File ownership<select aria-label="Smart file ownership" value={rules.fileOwnership ?? 'any'} onChange={event => update({ fileOwnership: event.target.value === 'any' ? undefined : event.target.value as SmartCollectionRule['fileOwnership'] })} className="mt-1 block w-full rounded border border-line bg-surface p-2"><option value="any">Any</option><option value="external">Imported original</option><option value="sonic-export">Sonic export</option></select></label>
    <label>Review<select aria-label="Smart review state" value={rules.reviewState ?? 'all'} onChange={event => update({ reviewState: event.target.value as SmartCollectionRule['reviewState'] })} className="mt-1 block w-full rounded border border-line bg-surface p-2"><option value="all">Any</option><option value="incomplete">Needs review</option><option value="disagreement">Disagreement</option></select></label>
    <label>File<select aria-label="Smart file state" value={rules.fileState ?? 'all'} onChange={event => update({ fileState: event.target.value as SmartCollectionRule['fileState'] })} className="mt-1 block w-full rounded border border-line bg-surface p-2"><option value="all">Any</option><option value="present">Present</option><option value="missing">Missing</option></select></label>
    <p className="col-span-2">Unknown BPM or key does not match a BPM or key rule.</p>
  </div>
}
