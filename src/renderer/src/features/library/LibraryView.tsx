import { memo, useCallback, useDeferredValue, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode, type RefObject } from 'react'
import { createPortal } from 'react-dom'
import {
  ArrowDownUp,
  FileSpreadsheet,
  LayoutGrid,
  List,
  Music4,
  RefreshCw,
  Search,
  SlidersHorizontal,
  Sparkles,
  TriangleAlert,
  X
} from 'lucide-react'
import type { DragEvent as ReactDragEvent, FocusEvent as ReactFocusEvent, MouseEvent as ReactMouseEvent, KeyboardEvent as ReactKeyboardEvent } from 'react'
import type { LibraryBeat, PresetId } from '@shared/domain'
import { needsAnalysisRefresh } from '@shared/analysis'
import { FAVORITES_COLLECTION_ID, type OrganizationCommand, type OrganizationSnapshot } from '@shared/organization'
import type { BatchSession } from '@shared/batch'
import { PRESETS } from '@shared/presets'
import { providerById } from '@shared/providers'
import { cn } from '@/lib/cn'
import { useReducedMotion } from '@/lib/theme'
import { useApp } from '@/store/app'
import { reconcileWorkspace, useLibraryWorkspace, useWorkspaceField } from '@/store/libraryWorkspace'
import { Badge } from '@/components/ui/Badge'
import { Button, IconButton } from '@/components/ui/Button'
import { ConfirmDialog, Modal } from '@/components/ui/Modal'
import { overlayRoot } from '@/components/motion/overlay'
import { ipc } from '@/lib/ipc'
import { Dropdown, DropdownItem, DropdownLabel } from '@/components/ui/Dropdown'
import { Input } from '@/components/ui/Input'
import { Segmented } from '@/components/ui/Segmented'
import { Switch } from '@/components/ui/Switch'
import { toast } from '@/components/ui/Toaster'
import { LibraryBeatRow } from './LibraryBeatRow'
import { PreviewTransport } from './PreviewTransport'
import { ImportAudio } from './ImportAudio'
import { RecoveryDialog } from './RecoveryDialog'
import { createLibraryIndex, searchLibrary, searchSmartCollection, type LibraryIndex, type LibrarySort } from './librarySearch'
import { CollectionWorkspace } from './CollectionWorkspace'
import { AnnotationEditor } from './AnnotationEditor'
import { DuplicatesPanel } from './DuplicatesPanel'
import { CompatibleBanner, type CompatibleState } from './CompatibleBanner'
import {
  compatibilityCriteria,
  DUPLICATES_VIEW_ID,
  findDuplicateGroups,
  isCompatible,
  isRecentlyAdded,
  needsReview,
  NEEDS_REVIEW_VIEW_ID,
  RECENT_VIEW_ID
} from '@shared/libraryTools'
import { usePlaybackActions, usePlaybackIdentity } from '@/features/playback/playbackSession'
import { useVirtualRows, withPinned } from '@/lib/virtualRows'

const SORTS: { key: LibrarySort; label: string }[] = [
  { key: 'manual', label: 'Collection order' },
  { key: 'relevance', label: 'Relevance' },
  { key: 'newest', label: 'Newest first' },
  { key: 'oldest', label: 'Oldest first' },
  { key: 'bpm-asc', label: 'Tempo: low → high' },
  { key: 'bpm-desc', label: 'Tempo: high → low' },
  { key: 'title', label: 'Title A → Z' },
  { key: 'producer', label: 'Producer A → Z' }
]

/** Below this many results every row is mounted; above it only the visible window is. */
const VIRTUALIZE_AFTER = 150
const LIST_ROW_PX = 52
const GRID_CARD_PX = 112
const GRID_GAP_PX = 8
const GRID_MIN_COLUMN_PX = 210
/** Remembered across remounts so a restored grid scroll position has its real height. */
let lastResultsWidth = 0

const TEMPO_BANDS: { id: string; label: string }[] = [
  { id: 'slow', label: '< 90' },
  { id: 'mid', label: '90–120' },
  { id: 'trap', label: '120–150' },
  { id: 'fast', label: '150+' }
]

const BUILT_IN_VIEW_LABELS: Record<string, string> = {
  [FAVORITES_COLLECTION_ID]: 'Favorites',
  [RECENT_VIEW_ID]: 'Recently added',
  [NEEDS_REVIEW_VIEW_ID]: 'Needs review',
  [DUPLICATES_VIEW_ID]: 'Duplicates'
}

/** Typing in a field never triggers a list shortcut. */
const isTextEntry = (target: EventTarget | null): boolean =>
  target instanceof HTMLElement && (target.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName))

/** Searchable archive of imported audio and Sonic-created exports. */
export function LibraryView(): ReactNode {
  const reducedMotion = useReducedMotion()
  const { playOne, playQueue } = usePlaybackActions()
  const library = useApp((state) => state.library)
  const rescanLibrary = useApp((state) => state.rescanLibrary)
  const removeBeat = useApp((state) => state.removeBeat)
  const updateBeatMetadata = useApp((state) => state.updateBeatMetadata)
  const reexportBeat = useApp((state) => state.reexportBeat)
  const defaultPresetId = useApp((state) => state.settings.defaultPresetId)
  const analyzeMissing = useApp((state) => state.analyzeMissing)
  const focusId = useApp((state) => state.libraryFocusId)
  const setLibraryFocus = useApp((state) => state.setLibraryFocus)

  const [query, setQuery] = useWorkspaceField('query')
  const [layout, setLayout] = useWorkspaceField('layout')
  const [sort, setSort] = useWorkspaceField('sort')
  const [bands, setBands] = useWorkspaceField('bands')
  const [formats, setFormats] = useWorkspaceField('formats')
  const [fileFilter, setFileFilter] = useWorkspaceField('fileFilter')
  const [reviewFilter, setReviewFilter] = useWorkspaceField('reviewFilter')
  const [bpmFilter, setBpmFilter] = useWorkspaceField('bpmFilter')
  const [bpmTolerance, setBpmTolerance] = useWorkspaceField('bpmTolerance')
  const [includeHalfDouble, setIncludeHalfDouble] = useWorkspaceField('includeHalfDouble')
  const [keyFilter, setKeyFilter] = useWorkspaceField('keyFilter')
  // Search runs against a deferred query so typing never waits on a full re-filter.
  const searchQuery = useDeferredValue(query)
  // Relevance applies only while a query exists and is never saved, so the
  // collection's saved order returns once the search is cleared.
  const [querySort, setQuerySort] = useState<LibrarySort>('relevance')
  const hasQuery = query.trim().length > 0
  const effectiveSort: LibrarySort = hasQuery && querySort === 'relevance' ? 'relevance' : sort
  const [selectedId, setSelectedId] = useWorkspaceField('selectedId')
  const [selectedIds, setSelectedIds] = useWorkspaceField('selectedIds')
  const [, setSelectionAnchor] = useWorkspaceField('selectionAnchor')
  const [organization, setOrganization] = useState<OrganizationSnapshot | null>(null)
  const [organizationError, setOrganizationError] = useState(false)
  const [organizationAttempt, setOrganizationAttempt] = useState(0)
  const [batch, setBatch] = useState<BatchSession | null>(null)
  const [deleteTarget, setDeleteTarget] = useState<LibraryBeat | null>(null)
  const [alsoDeleteFiles, setAlsoDeleteFiles] = useState(true)
  const [showFilters, setShowFilters] = useWorkspaceField('showFilters')
  const [menu, setMenu] = useState<{ id: string; x: number; y: number } | null>(null)
  const [renameTarget, setRenameTarget] = useState<LibraryBeat | null>(null)
  const [renameTitle, setRenameTitle] = useState('')
  const [renaming, setRenaming] = useState(false)
  const [renameError, setRenameError] = useState('')
  const [exportTarget, setExportTarget] = useState<LibraryBeat | null>(null)
  const [exportPresetId, setExportPresetId] = useState<PresetId>('wav-44100-24')
  const [exporting, setExporting] = useState(false)
  const [exportError, setExportError] = useState('')
  const menuRef = useRef<HTMLDivElement>(null)
  const [compatible, setCompatible] = useState<CompatibleState | null>(null)
  const [exportingList, setExportingList] = useState(false)
  const [recoveryPlanId, setRecoveryPlanId] = useState<string | null>(null)
  const [pickingRecovery, setPickingRecovery] = useState(false)
  const recoveryPicker = useRef(false)
  const locateFile = async (beatId: string): Promise<void> => {
    if (recoveryPicker.current) return
    recoveryPicker.current = true; setPickingRecovery(true)
    try { const result = await ipc.invoke('recovery:chooseFile', beatId); if (result.planId) setRecoveryPlanId(result.planId) }
    catch (error) { toast({ kind: 'error', title: 'Could not locate audio', description: String(error) }) }
    finally { recoveryPicker.current = false; setPickingRecovery(false) }
  }

  useEffect(() => {
    let live = true
    setOrganizationError(false)
    void ipc.invoke('organization:snapshot').then(snapshot => {
      if (!live) return
      setOrganization(snapshot)
      setLayout(snapshot.view.layout)
      setSort(snapshot.view.sort)
    }).catch(error => {
      if (!live) return
      setOrganizationError(true)
      toast({ kind: 'error', title: 'Collections unavailable', description: String(error) })
    })
    const off = ipc.on('organization:changed', snapshot => { if (live) setOrganization(snapshot) })
    return () => { live = false; off() }
  }, [organizationAttempt, setLayout, setSort])
  useEffect(() => {
    if (!organization) return
    setLayout(organization.view.layout)
    setSort(organization.view.sort)
  }, [organization?.view.layout, organization?.view.sort])
  useEffect(() => {
    const id = window.sessionStorage.getItem('sonic:library-batch-session')
    if (!id) return
    void ipc.invoke('batch:status', id).then(result => {
      if (result) setBatch(result)
      else window.sessionStorage.removeItem('sonic:library-batch-session')
    }).catch(() => window.sessionStorage.removeItem('sonic:library-batch-session'))
  }, [])
  useEffect(() => {
    if (batch) window.sessionStorage.setItem('sonic:library-batch-session', batch.id)
    else window.sessionStorage.removeItem('sonic:library-batch-session')
  }, [batch?.id])

  const executeOrganization = async (command: OrganizationCommand): Promise<OrganizationSnapshot> => {
    const next = await ipc.invoke('organization:command', command)
    setOrganization(next)
    return next
  }

  const activeCollection = organization?.collections.find(item => item.id === organization.view.activeCollectionId) ?? null
  const activeScope = organization?.view.activeCollectionId ?? 'all'
  // A view change saves layout and sort together. Read the other setting from
  // the latest request or the store, never from this render's closure, so two
  // quick changes cannot save a stale value over each other.
  const requestedView = useRef<{ layout: 'grid' | 'list'; sort: LibrarySort } | null>(null)
  const currentView = (): { layout: 'grid' | 'list'; sort: LibrarySort } => {
    const workspace = useLibraryWorkspace.getState()
    return requestedView.current ?? { layout: workspace.layout, sort: workspace.sort }
  }
  const saveView = (activeCollectionId: string | null, view: { layout: 'grid' | 'list'; sort: LibrarySort }): Promise<OrganizationSnapshot> => {
    requestedView.current = view
    return executeOrganization({ type: 'set-view', activeCollectionId, ...view }).then(snapshot => {
      setLayout(view.layout)
      setSort(view.sort)
      return snapshot
    }).finally(() => { if (requestedView.current === view) requestedView.current = null })
  }

  const changeScope = async (id: string | null): Promise<void> => {
    if (!organization || organization.view.activeCollectionId === id) return
    const view = currentView()
    const nextSort = organization.collections.some(item => item.id === id && item.type === 'manual')
      ? 'manual' : view.sort === 'manual' ? 'newest' : view.sort
    await saveView(id, { layout: view.layout, sort: nextSort })
    setSelectedIds(new Set())
    setSelectionAnchor(null)
  }

  const changeLayout = (next: 'grid' | 'list'): void => {
    if (!organization) return
    void saveView(organization.view.activeCollectionId, { ...currentView(), layout: next })
      .catch(error => toast({ kind: 'error', title: 'Layout was not saved', description: String(error) }))
  }

  const changeSort = (next: LibrarySort): void => {
    if (!organization) return
    // Relevance belongs to the current search, never to the saved view.
    if (hasQuery) setQuerySort(next)
    if (next === 'relevance') return
    void saveView(organization.view.activeCollectionId, { ...currentView(), sort: next })
      .catch(error => toast({ kind: 'error', title: 'Sort was not saved', description: String(error) }))
  }

  useEffect(() => {
    if (!menu) return
    const dismiss = (event: PointerEvent): void => {
      if (!menuRef.current?.contains(event.target as Node)) setMenu(null)
    }
    const keydown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') setMenu(null)
    }
    document.addEventListener('pointerdown', dismiss, true)
    document.addEventListener('keydown', keydown)
    menuRef.current?.querySelector<HTMLButtonElement>('button:not(:disabled)')?.focus()
    return () => { document.removeEventListener('pointerdown', dismiss, true); document.removeEventListener('keydown', keydown) }
  }, [menu])

  const openMenu = useCallback((event: React.MouseEvent, beat: LibraryBeat): void => {
    event.preventDefault()
    event.stopPropagation()
    if (!useLibraryWorkspace.getState().selectedIds.has(beat.id)) { setSelectedIds(new Set([beat.id])); setSelectionAnchor(beat.id) }
    setMenu({ id: beat.id, x: Math.max(8, Math.min(event.clientX, window.innerWidth - 220)),
      y: Math.max(8, Math.min(event.clientY, window.innerHeight - 252)) })
  }, [setSelectedIds, setSelectionAnchor])

  const cardRefs = useRef(new Map<string, HTMLDivElement>())
  const registerCard = useCallback((id: string, node: HTMLDivElement | null): void => {
    if (node) cardRefs.current.set(id, node)
    else cardRefs.current.delete(id)
  }, [])

  const indexCache = useRef<LibraryIndex | undefined>(undefined)
  const index = useMemo(() => {
    const next = createLibraryIndex(library, indexCache.current)
    indexCache.current = next
    return next
  }, [library])

  const availableFormats = useMemo(
    () => [...new Set(library.map((beat) => beat.format))].sort(),
    [library]
  )

  const duplicateGroups = useMemo(() => findDuplicateGroups(library), [library])
  // "Recently added" is relative to when the library last changed, not every render.
  const recentSince = useMemo(() => Date.now(), [library])
  const viewCounts = useMemo(() => ({
    [RECENT_VIEW_ID]: library.filter(beat => isRecentlyAdded(beat, recentSince)).length,
    [NEEDS_REVIEW_VIEW_ID]: library.filter(needsReview).length,
    [DUPLICATES_VIEW_ID]: duplicateGroups.length
  }), [library, recentSince, duplicateGroups])
  const compatibleSeed = useMemo(() => compatible ? library.find(beat => beat.id === compatible.seedId) ?? null : null, [library, compatible])
  const compatibleCriteria = useMemo(() => compatibleSeed && compatible
    ? compatibilityCriteria(compatibleSeed, { bpmTolerance: compatible.bpmTolerance, includeHalfDouble: compatible.includeHalfDouble })
    : null, [compatibleSeed, compatible])
  // A seed that was deleted, or lost its BPM and key, ends the compatible view.
  useEffect(() => { if (compatible && !compatibleCriteria) setCompatible(null) }, [compatible, compatibleCriteria])

  const visible = useMemo(() => {
    let scope = library
    if (activeCollection?.type === 'manual') {
      const byId = new Map(library.map(beat => [beat.id, beat]))
      scope = activeCollection.beatIds.flatMap(id => byId.get(id) ? [byId.get(id)!] : [])
    } else if (activeCollection?.type === 'smart' && organization) {
      scope = searchSmartCollection(library, index, activeCollection.rules, organization.annotations, effectiveSort)
    } else if (activeScope === FAVORITES_COLLECTION_ID) {
      scope = library.filter(beat => organization && Object.prototype.hasOwnProperty.call(organization.annotations, beat.id) && organization.annotations[beat.id].favorite)
    } else if (activeScope === RECENT_VIEW_ID) {
      scope = library.filter(beat => isRecentlyAdded(beat, recentSince))
    } else if (activeScope === NEEDS_REVIEW_VIEW_ID) {
      scope = library.filter(needsReview)
    } else if (activeScope === DUPLICATES_VIEW_ID) {
      const members = new Set(duplicateGroups.flatMap(group => group.beatIds))
      scope = library.filter(beat => members.has(beat.id))
    }
    let rows = searchLibrary(scope, index, {
      query: searchQuery, sort: effectiveSort, bands, formats, fileFilter, reviewFilter, bpm: bpmFilter,
      bpmTolerance, includeHalfDouble, key: keyFilter
    })
    if (activeCollection?.type === 'manual' && effectiveSort === 'manual') {
      const positions = new Map(activeCollection.beatIds.map((id, position) => [id, position]))
      rows.sort((a, b) => (positions.get(a.id) ?? Infinity) - (positions.get(b.id) ?? Infinity))
    }
    if (compatibleCriteria && compatibleSeed) {
      // The seed always leads, even when a search or filter would hide it.
      rows = [compatibleSeed, ...rows.filter(beat => beat.id !== compatibleSeed.id && isCompatible(beat, compatibleCriteria))]
    }
    return rows
  }, [library, index, organization, activeScope, activeCollection, searchQuery, effectiveSort, bands, formats, fileFilter, reviewFilter, bpmFilter, bpmTolerance, includeHalfDouble, keyFilter, recentSince, duplicateGroups, compatibleCriteria, compatibleSeed])

  const auditionLabel = compatibleSeed ? `Compatible with ${compatibleSeed.title}` : activeCollection?.name ?? BUILT_IN_VIEW_LABELS[activeScope] ?? 'All audio'
  const visibleRef = useRef(visible)
  useLayoutEffect(() => { visibleRef.current = visible }, [visible])
  const playDisplayed = (): void => {
    const ids = visible.map(beat => beat.id)
    if (ids.length) playQueue(ids, ids[0], auditionLabel)
  }
  const playSelected = (): void => {
    const ids = visible.filter(beat => selectedIds.has(beat.id)).map(beat => beat.id)
    if (ids.length) playQueue(ids, ids[0], `${auditionLabel} shortlist`)
  }

  // Keyed by the typed query, not the deferred one, so a search change clears the
  // selection in the same commit as the keystroke rather than a render later.
  const selectionScope = `${activeScope}\u0000${activeCollection?.type === 'smart' ? JSON.stringify(activeCollection.rules) : ''}\u0000${query}\u0000${[...bands].sort()}\u0000${[...formats].sort()}\u0000${fileFilter}\u0000${reviewFilter}\u0000${bpmFilter}\u0000${bpmTolerance}\u0000${includeHalfDouble}\u0000${keyFilter}\u0000${compatible ? `${compatible.seedId}:${compatible.bpmTolerance}:${compatible.includeHalfDouble}` : ''}`
  const scrollRef = useRef<HTMLDivElement>(null)
  const restoredScroll = useRef(false)
  useLayoutEffect(() => {
    if (!organization) return
    const previousScope = useLibraryWorkspace.getState().selectionScope
    reconcileWorkspace(selectionScope, visible.map(beat => beat.id), library.map(beat => beat.id))
    const node = scrollRef.current
    if (node && (!restoredScroll.current || previousScope !== selectionScope)) {
      node.scrollTop = useLibraryWorkspace.getState().scrollTop
      restoredScroll.current = true
    }
  }, [organization, selectionScope, visible, library])
  useLayoutEffect(() => {
    const node = scrollRef.current
    return () => {
      if (node && restoredScroll.current) useLibraryWorkspace.setState({ scrollTop: node.scrollTop })
    }
  }, [])

  const toggleSelectedId = useCallback((id: string): void => {
    setSelectedIds(previous => {
      const next = new Set(previous)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
    setSelectionAnchor(id)
  }, [setSelectedIds, setSelectionAnchor])

  const selectCard = useCallback((event: ReactMouseEvent | ReactKeyboardEvent, beat: LibraryBeat): void => {
    const { selectedId, selectionAnchor } = useLibraryWorkspace.getState()
    if (event.shiftKey) {
      const ids = visibleRef.current.map(item => item.id)
      const anchor = ids.indexOf(selectionAnchor ?? beat.id)
      const end = ids.indexOf(beat.id)
      if (anchor >= 0 && end >= 0) setSelectedIds(previous => new Set([...previous, ...ids.slice(Math.min(anchor, end), Math.max(anchor, end) + 1)]))
      return
    }
    if (event.ctrlKey || event.metaKey) { toggleSelectedId(beat.id); return }
    setSelectedId(selectedId === beat.id ? null : beat.id)
    setSelectionAnchor(beat.id)
  }, [setSelectedIds, setSelectedId, setSelectionAnchor, toggleSelectedId])

  const selected = useMemo(
    () => library.find((beat) => beat.id === selectedId) ?? null,
    [library, selectedId]
  )

  const revealingScope = useRef(false)
  // A displayed row outside the rendered window is mounted on request, by index.
  const [revealId, setRevealId] = useState<string | null>(null)
  // A global search result must become visible even when a retained collection
  // or filter excludes it. Consume the request only after its row is mounted.
  useEffect(() => {
    if (!focusId || !organization) return
    if (!library.some(beat => beat.id === focusId)) { setLibraryFocus(null); return }
    const node = cardRefs.current.get(focusId)
    if (node) {
      setSelectedId(focusId)
      node.scrollIntoView({ block: 'center', behavior: reducedMotion ? 'instant' : 'smooth' })
      node.querySelector<HTMLButtonElement>('button[aria-label^="Preview "]')?.focus({ preventScroll: true })
      setLibraryFocus(null)
      setRevealId(null)
      return
    }
    // The Duplicates view lists groups, not cards: reveal in All audio instead.
    if (activeScope !== DUPLICATES_VIEW_ID && visible.some(beat => beat.id === focusId)) {
      // Displayed but outside the rendered window: mount it, then this effect reruns.
      if (revealId !== focusId) setRevealId(focusId)
      return
    }
    const workspace = useLibraryWorkspace.getState()
    if (workspace.query || workspace.bands.size || workspace.formats.size || workspace.fileFilter !== 'all' || workspace.reviewFilter !== 'all' || workspace.bpmFilter || workspace.keyFilter) {
      useLibraryWorkspace.setState({ query: '', bands: new Set(), formats: new Set(), fileFilter: 'all',
        reviewFilter: 'all', bpmFilter: '', keyFilter: '', selectedIds: new Set(), selectionAnchor: null })
    }
    setCompatible(null)
    if (organization.view.activeCollectionId !== null && !revealingScope.current) {
      revealingScope.current = true
      void changeScope(null).catch(error => {
        if (useApp.getState().libraryFocusId === focusId) setLibraryFocus(null)
        toast({ kind: 'error', title: 'Could not reveal this beat', description: String(error) })
      }).finally(() => { revealingScope.current = false })
    }
  }, [focusId, setLibraryFocus, setSelectedId, organization, reducedMotion, visible, library, revealId])

  const totals = useMemo(
    () => ({
      missing: library.filter((beat) => beat.missing).length
    }),
    [library]
  )

  const toggle = (set: Set<string>, value: string, apply: (next: Set<string>) => void): void => {
    const next = new Set(set)
    if (next.has(value)) next.delete(value)
    else next.add(value)
    apply(next)
  }

  const activeFilterCount = bands.size + formats.size + (fileFilter === 'all' ? 0 : 1) +
    (reviewFilter === 'all' ? 0 : 1) + (bpmFilter.trim() ? 1 : 0) + (keyFilter.trim() ? 1 : 0)

  const needsAnalysis = useMemo(() => library.filter(beat => !beat.missing && !beat.fileAccessError && needsAnalysisRefresh(beat)).length, [library])
  const recoverable = visible.filter(beat => (beat.missing || beat.fileAccessError) && (selectedIds.size === 0 || selectedIds.has(beat.id)))
  const findMissingFiles = async (): Promise<void> => {
    if (recoveryPicker.current || !recoverable.length) return
    recoveryPicker.current = true; setPickingRecovery(true)
    try { const result = await ipc.invoke('recovery:chooseFolder', recoverable.map(beat => beat.id)); if (result.planId) setRecoveryPlanId(result.planId) }
    catch (error) { toast({ kind: 'error', title: 'Could not scan for audio', description: String(error) }) }
    finally { recoveryPicker.current = false; setPickingRecovery(false) }
  }

  const findCompatible = (beat: LibraryBeat): void => {
    if (!compatibilityCriteria(beat, { bpmTolerance: 4, includeHalfDouble: true })) {
      toast({ kind: 'info', title: 'Nothing to match yet', description: 'This track has no BPM or key. Analyze it or enter them first.' })
      return
    }
    setCompatible({ seedId: beat.id, bpmTolerance: 4, includeHalfDouble: true })
    setSelectedId(beat.id)
  }

  const toggleFavorite = (ids: string[]): void => {
    if (!organization || !ids.length) return
    const annotations = organization.annotations
    const allFavorite = ids.every(id => Object.prototype.hasOwnProperty.call(annotations, id) && annotations[id].favorite)
    const many = ids.length === 1 ? '' : `${ids.length} tracks `
    void executeOrganization({ type: 'batch-annotation', beatIds: ids.slice(0, 5000), favorite: !allFavorite })
      .then(() => toast({ kind: 'success', title: allFavorite ? `Removed ${many}from favorites` : `Added ${many}to favorites` }))
      .catch(error => toast({ kind: 'error', title: 'Favorite was not saved', description: String(error) }))
  }

  /** The tracks a shortcut acts on: the batch selection, else the focused row, else the inspected one. */
  const shortcutTargets = (target: EventTarget | null): string[] => {
    const { selectedIds: batch, selectedId: inspected } = useLibraryWorkspace.getState()
    if (batch.size) return [...batch]
    const row = target instanceof HTMLElement ? target.closest<HTMLElement>('[data-beat-id]')?.dataset.beatId : undefined
    return row ? [row] : inspected ? [inspected] : []
  }
  const listShortcuts = (event: ReactKeyboardEvent<HTMLDivElement>): void => {
    if (event.ctrlKey || event.metaKey || event.altKey || isTextEntry(event.target)) return
    const key = event.key.toLowerCase()
    if (key === 'f') {
      const ids = shortcutTargets(event.target)
      if (!ids.length) return
      event.preventDefault()
      toggleFavorite(ids)
    } else if (key === 'c') {
      const [id] = shortcutTargets(event.target)
      const beat = id ? library.find(item => item.id === id) : undefined
      if (!beat) return
      event.preventDefault()
      findCompatible(beat)
    }
  }

  /** Drag rows out to a DAW or Explorer. Main resolves the files; the renderer only names records. */
  const dragOut = (event: ReactDragEvent<HTMLDivElement>): void => {
    const id = (event.target as HTMLElement | null)?.closest<HTMLElement>('[data-beat-id]')?.dataset.beatId
    if (!id) return
    event.preventDefault()
    const batch = useLibraryWorkspace.getState().selectedIds
    const ids = batch.has(id) ? [id, ...[...batch].filter(other => other !== id)].slice(0, 100) : [id]
    void ipc.invoke('library:startDrag', ids).then(result => {
      if (!result.started) toast({ kind: 'error', title: 'Nothing to drag', description: 'The audio file is missing or unavailable.' })
    }).catch(error => toast({ kind: 'error', title: 'Could not start the drag', description: String(error) }))
  }

  const exportList = (): void => {
    const ids = selectedIds.size ? visible.filter(beat => selectedIds.has(beat.id)).map(beat => beat.id) : visible.map(beat => beat.id)
    if (!ids.length || exportingList) return
    setExportingList(true)
    void ipc.invoke('library:exportList', ids).then(result => {
      if (result.saved) toast({ kind: 'success', title: `Exported ${result.count} track${result.count === 1 ? '' : 's'}`, description: result.fileName ?? undefined })
    }).catch(error => toast({ kind: 'error', title: 'Track list was not exported', description: String(error) }))
      .finally(() => setExportingList(false))
  }

  const resolveDuplicates = async (keepId: string, removeIds: string[]): Promise<void> => {
    const next = await ipc.invoke('library:resolveDuplicates', keepId, removeIds)
    useApp.getState().setLibrarySnapshot(next)
    setSelectedId(current => current && removeIds.includes(current) ? keepId : current)
    toast({ kind: 'success', title: `Removed ${removeIds.length} duplicate record${removeIds.length === 1 ? '' : 's'}`, description: 'Audio files were left on disk.' })
  }
  const visibleGroups = useMemo(() => {
    const shown = new Set(visible.map(beat => beat.id))
    return duplicateGroups.filter(group => group.beatIds.some(id => shown.has(id)))
  }, [duplicateGroups, visible])
  const byId = useMemo(() => new Map(library.map(beat => [beat.id, beat])), [library])

  return (
    <div className="workspace-page flex h-full min-h-0 flex-col gap-3">
      <header className="page-header flex shrink-0 items-center justify-between gap-4">
        <div className="min-w-0">
          <h1 className="page-title">Library<span className="ml-2.5 align-middle text-[12px] font-normal tracking-normal text-fg-subtle nums">{library.length}</span></h1>
        </div>
        <div className="flex shrink-0 items-center gap-2.5">
          {needsAnalysis > 0 ? <Button variant="ghost" size="md" aria-label="Analyze now" leading={<Sparkles />}
            title={`${needsAnalysis} tracks with missing or outdated BPM and key analysis`} onClick={() => {
              void analyzeMissing().then(queued => toast({ kind: 'info', title: `Analyzing ${queued} track${queued === 1 ? '' : 's'}`,
                description: 'Working from the files on disk — nothing is re-downloaded.' }))
            }}>Analyze <span className="ml-1 text-fg-subtle nums">{needsAnalysis}</span></Button> : null}
          <Button variant="ghost" size="md" aria-label="Export track list" leading={<FileSpreadsheet />}
            disabled={!visible.length || exportingList}
            title={selectedIds.size ? `Save the ${selectedIds.size} selected tracks as CSV or JSON` : `Save the ${visible.length} displayed tracks as CSV or JSON`}
            onClick={exportList}>Export list</Button>
          <ImportAudio />
        </div>
      </header>

      <div className="flex min-h-0 shrink-0 flex-col gap-3">
        <div className="flex items-center gap-2">
          <div className="min-w-[160px] max-w-[340px] flex-1">
            <Input
              value={query}
              onChange={(event) => {
                // A new search starts in relevance order; nothing is saved.
                if (!query.trim() && event.target.value.trim()) setQuerySort('relevance')
                setQuery(event.target.value)
              }}
              placeholder="Search title, producer, BPM, key…"
              leading={<Search />}
              trailing={
                query.length > 0 ? (
                  <IconButton label="Clear search" size="icon-xs" onClick={() => setQuery('')}>
                    <X />
                  </IconButton>
                ) : null
              }
            />
          </div>
          <Button
            variant={showFilters ? 'quiet' : 'ghost'}
            size="md"
            leading={<SlidersHorizontal />}
            aria-expanded={showFilters}
            onClick={() => setShowFilters((value) => !value)}
          >
            Filters{activeFilterCount > 0 ? ` (${activeFilterCount})` : ''}
          </Button>

          <Dropdown
            align="end"
            trigger={({ toggle: open }) => (
              <Button variant="ghost" size="md" leading={<ArrowDownUp />} onClick={open}>
                {SORTS.find((entry) => entry.key === effectiveSort)?.label ?? 'Sort'}
              </Button>
            )}
          >
            {(close) => (
              <>
                <DropdownLabel>Sort by</DropdownLabel>
                {SORTS.filter(entry => (entry.key !== 'manual' || activeCollection?.type === 'manual') &&
                  (entry.key !== 'relevance' || hasQuery || sort === 'relevance')).map((entry) => (
                  <DropdownItem
                    key={entry.key}
                    selected={entry.key === effectiveSort}
                    onSelect={() => {
                      changeSort(entry.key)
                      close()
                    }}
                  >
                    {entry.label}
                  </DropdownItem>
                ))}
              </>
            )}
          </Dropdown>

          <span className="flex-1" />
          {recoverable.length > 0 ? <Button variant="ghost" size="sm" disabled={pickingRecovery} onClick={() => void findMissingFiles()}>Find missing files…</Button> : null}
          <Segmented
            value={layout}
            onChange={changeLayout}
            ariaLabel="Layout"
            size="sm"
            options={[
              { value: 'grid', label: '', icon: <LayoutGrid /> },
              { value: 'list', label: '', icon: <List /> }
            ]}
          />

          <IconButton
            label="Rescan the library"
            variant="ghost"
            onClick={() => {
              void rescanLibrary()
              toast({ kind: 'info', title: 'Rescanning the library' })
            }}
          >
            <RefreshCw />
          </IconButton>
        </div>

        {showFilters ? (
          <div className="flex max-h-[148px] flex-wrap items-center gap-x-5 gap-y-3 overflow-y-auto border-y border-line py-3">
            <label className="flex items-center gap-1.5 text-[12px] font-medium text-fg-subtle">
              BPM
              <Input type="number" min="1" max="999" step="any" inputMode="decimal"
                aria-label="Target BPM" value={bpmFilter} onChange={(event) => setBpmFilter(event.target.value)}
                placeholder="e.g. 140" className="w-[90px]" />
              ±
              <Input type="number" min="0" max="20" step="0.5" aria-label="BPM tolerance"
                value={bpmTolerance} onChange={(event) => setBpmTolerance(Math.min(20, Math.max(0, Number(event.target.value) || 0)))}
                className="w-[65px]" />
            </label>
            <div className="flex items-center gap-2">
              <Switch checked={includeHalfDouble} onChange={setIncludeHalfDouble} label="Include half and double time" />
              <span className="text-[12px] text-fg-muted">Half/double time</span>
            </div>
            <label className="flex items-center gap-1.5 text-[12px] font-medium text-fg-subtle">
              Key / Camelot
              <Input aria-label="Key or Camelot" value={keyFilter} onChange={(event) => setKeyFilter(event.target.value)}
                placeholder="e.g. 8A" className="w-[90px]" />
            </label>
            <div className="flex items-center gap-1.5">
              <span className="text-[12px] font-medium text-fg-subtle">Tempo</span>
              {TEMPO_BANDS.map((band) => (
                <button
                  key={band.id}
                  type="button"
                  onClick={() => toggle(bands, band.id, setBands)}
                  aria-pressed={bands.has(band.id)}
                  className={cn(
                    'rounded-[2px] border px-2 py-1 text-[12px] transition-colors duration-[var(--duration-quick)]',
                    bands.has(band.id)
                      ? 'border-[var(--sonic-accent-line)] bg-accent-soft text-accent'
                      : 'border-line text-fg-muted hover:border-line-strong hover:text-fg'
                  )}
                >
                  {band.label}
                </button>
              ))}
            </div>

            <div className="flex items-center gap-1.5">
              <span className="text-[12px] font-medium text-fg-subtle">Format</span>
              {availableFormats.map((format) => (
                <button
                  key={format}
                  type="button"
                  onClick={() => toggle(formats, format, setFormats)}
                  aria-pressed={formats.has(format)}
                  className={cn(
                    'rounded-[2px] border px-2 py-1 text-[12px] uppercase transition-colors duration-[var(--duration-quick)]',
                    formats.has(format)
                      ? 'border-[var(--sonic-accent-line)] bg-accent-soft text-accent'
                      : 'border-line text-fg-muted hover:border-line-strong hover:text-fg'
                  )}
                >
                  {format}
                </button>
              ))}
            </div>

            <div className="flex items-center gap-1.5">
              <span className="text-[12px] font-medium text-fg-subtle">Files</span>
              {(['all', 'present', 'missing'] as const).map((value) => (
                <button key={value} type="button" onClick={() => setFileFilter(value)}
                  aria-pressed={fileFilter === value}
                  className={cn('rounded-[2px] border px-2 py-1 text-[12px] capitalize transition-colors',
                    fileFilter === value ? 'border-[var(--sonic-accent-line)] bg-accent-soft text-accent' : 'border-line text-fg-muted hover:border-line-strong hover:text-fg')}>
                  {value}
                </button>
              ))}
            </div>
            <div className="flex items-center gap-1.5">
              <span className="text-[12px] font-medium text-fg-subtle">Review</span>
              {(['all', 'incomplete', 'disagreement'] as const).map((value) => (
                <button key={value} type="button" onClick={() => setReviewFilter(value)}
                  aria-pressed={reviewFilter === value}
                  className={cn('rounded-[2px] border px-2 py-1 text-[12px] capitalize transition-colors',
                    reviewFilter === value ? 'border-[var(--sonic-accent-line)] bg-accent-soft text-accent' : 'border-line text-fg-muted hover:border-line-strong hover:text-fg')}>
                  {value}
                </button>
              ))}
            </div>

            {totals.missing > 0 ? (
              <Badge tone="warning" size="sm" icon={<TriangleAlert />}>
                {totals.missing} missing
              </Badge>
            ) : null}

            <span className="flex-1" />

            {activeFilterCount > 0 ? (
              <Button
                variant="ghost"
                size="sm"
                onClick={() => {
                  setBands(new Set())
                  setFormats(new Set())
                  setFileFilter('all')
                  setReviewFilter('all')
                  setBpmFilter('')
                  setKeyFilter('')
                  setIncludeHalfDouble(false)
                  setBpmTolerance(3)
                }}
              >
                Reset filters
              </Button>
            ) : null}
          </div>
        ) : null}
      </div>

      {organization ? <CollectionWorkspace organization={organization} activeId={organization.view.activeCollectionId}
        library={library} visible={visible} selectedIds={selectedIds}
        clearSelection={() => { setSelectedIds(new Set()); setSelectionAnchor(null) }}
        selectAll={() => { setSelectedIds(new Set(visible.map(beat => beat.id))); setSelectionAnchor(visible[0]?.id ?? null) }}
        onPlayDisplayed={playDisplayed}
        onPlaySelected={playSelected}
        onScope={changeScope} command={executeOrganization} batch={batch} setBatch={setBatch}
        defaultPresetId={defaultPresetId} manualSort={effectiveSort === 'manual'} viewCounts={viewCounts} /> : null}

      {compatibleSeed && compatibleCriteria && compatible ? <CompatibleBanner seed={compatibleSeed} criteria={compatibleCriteria}
        state={compatible} count={visible.length} onChange={setCompatible} onClear={() => setCompatible(null)} /> : null}

      <div className="flex min-h-0 flex-1 gap-4">
      <div ref={scrollRef} data-library-scroll className="min-h-0 min-w-0 flex-1 overflow-y-auto pr-0.5"
        onKeyDown={listShortcuts} onDragStart={dragOut}
        onScroll={event => {
          if (restoredScroll.current) useLibraryWorkspace.setState({ scrollTop: event.currentTarget.scrollTop })
        }}>
        {!organization ? (
          <div className="p-3 text-fg-subtle">
            {organizationError ? <>
              <p>Library workspace could not be loaded.</p>
              <Button variant="secondary" onClick={() => setOrganizationAttempt(value => value + 1)}>Retry</Button>
            </> : 'Loading Library workspace…'}
          </div>
        ) : library.length === 0 ? (
          <div className="studio-panel grid h-full min-h-[230px] place-items-center px-6 py-8">
            <div className="max-w-[360px] text-center">
              <Music4 className="mx-auto mb-4 size-6 text-fg-subtle" strokeWidth={1.4} />
              <h2 className="label-type text-[20px] text-fg">Your library is empty</h2>
              <p className="mt-2 text-[12px] leading-relaxed text-fg-muted">Import audio from your computer, or add a link in Downloads.</p>
              <p className="mt-5 text-[12px] text-fg-subtle">WAV · FLAC · MP3 · M4A · OGG</p>
            </div>
          </div>
        ) : activeScope === DUPLICATES_VIEW_ID ? (
          <DuplicatesPanel groups={visibleGroups} byId={byId} onResolve={resolveDuplicates}
            onInspect={id => setSelectedId(id)} onPlay={playOne} />
        ) : visible.length === 0 ? (
          <div className="studio-panel grid h-full min-h-[180px] place-items-center px-8 text-center text-[13.5px] text-fg-muted">
            {activeCollection?.type === 'manual' && activeCollection.beatIds.length === 0
              ? 'This collection is empty. Select beats and use Add to collection.'
              : activeScope === FAVORITES_COLLECTION_ID && !library.some(beat => organization && Object.prototype.hasOwnProperty.call(organization.annotations, beat.id) && organization.annotations[beat.id].favorite)
                ? 'No favorites yet. Open a beat and mark it as a favorite.'
                : activeCollection?.type === 'smart'
                  ? 'No beats currently match this smart collection’s rules.'
                  : activeScope === RECENT_VIEW_ID && viewCounts[RECENT_VIEW_ID] === 0
                    ? 'Nothing added in the last 14 days. New downloads and imports appear here first.'
                    : activeScope === NEEDS_REVIEW_VIEW_ID && viewCounts[NEEDS_REVIEW_VIEW_ID] === 0
                      ? 'Nothing to review. Every track has a BPM and key, and no source disagrees with its audio.'
                      : 'No beats match those filters.'}
          </div>
        ) : (
          <LibraryResults visible={visible} layout={layout} selectedId={selectedId} selectedIds={selectedIds}
            revealId={revealId} scrollRef={scrollRef} onToggleSelection={toggleSelectedId} onSelect={selectCard}
            onPlay={playOne} onContextMenu={openMenu} registerCard={registerCard} />
        )}
      </div>

      {selected ? (
        <aside aria-label="Beat inspector" className="min-h-0 w-[300px] max-w-[39%] shrink-0 overflow-y-auto rounded-[2px] bg-surface">
          <PreviewTransport
          key={`preview-${selected.id}`}
          beat={selected}
          onLocateFile={() => void locateFile(selected.id)}
          onClose={() => setSelectedId(null)}
          onRequestDelete={() => {
            setAlsoDeleteFiles(selected.fileOwnership === 'sonic-export')
            setDeleteTarget(selected)
          }}
          onRequestExport={() => {
            setExportTarget(selected)
            setExportPresetId(defaultPresetId === 'original' ? 'wav-44100-24' : defaultPresetId)
            setExportError('')
          }}
        />
        {organization ? <AnnotationEditor key={`annotations-${selected.id}`} beat={selected} annotation={Object.prototype.hasOwnProperty.call(organization.annotations, selected.id) ? organization.annotations[selected.id] : undefined} command={executeOrganization} /> : null}
        </aside>
      ) : null}
      </div>

      {menu && library.some(beat => beat.id === menu.id) ? createPortal(
        <div ref={menuRef} role="menu" aria-label="Beat actions" tabIndex={-1}
          className="fixed z-[420] w-[208px] rounded-[2px] border border-line bg-surface p-1 shadow-pop"
          style={{ left: menu.x, top: menu.y }}
          onKeyDown={event => {
            const items = [...(menuRef.current?.querySelectorAll<HTMLButtonElement>('button:not(:disabled)') ?? [])]
            const index = items.indexOf(document.activeElement as HTMLButtonElement)
            if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
              event.preventDefault()
              items[(index + (event.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length]?.focus()
            }
          }}>
          {(() => {
            const beat = library.find(item => item.id === menu.id)!
            const item = (label: string, action: () => void | Promise<void>, disabled = false): ReactNode => (
              <button type="button" role="menuitem" disabled={disabled} key={label}
                className="flex w-full rounded-[2px] px-2.5 py-2 text-left text-[13.5px] text-fg hover:bg-surface-2 focus:bg-surface-2 focus:outline-none disabled:opacity-40"
                onClick={() => { setMenu(null); void Promise.resolve(action()).catch(error => toast({ kind: 'error', title: label, description: String(error) })) }}>
                {label}
              </button>
            )
            return <>
              {item('Play this beat', () => playOne(beat.id), beat.missing)}
              {item('Find compatible tracks', () => findCompatible(beat), beat.bpm == null && !beat.key && !beat.camelot)}
              {beat.missing || beat.fileAccessError ? item('Locate file…', () => locateFile(beat.id), pickingRecovery) : null}
              {providerById(beat.sourceKind) && beat.sourceUrl ? <>
                {item(providerById(beat.sourceKind)!.openLabel, async () => { if (!await ipc.invoke('library:openSource', beat.id)) throw new Error('No valid source link is saved for this beat.') })}
                {item('Refresh channel name', async () => { await ipc.invoke('library:refreshSource', beat.id) })}
              </> : null}
              {item(beat.fileOwnership === 'external' ? 'Rename in library…' : 'Rename beat and file…', () => { setRenameTarget(beat); setRenameTitle(beat.title); setRenameError('') })}
              {beat.fileOwnership === 'external' ? item('Export prepared copy…', () => {
                setExportTarget(beat); setExportPresetId(defaultPresetId === 'original' ? 'wav-44100-24' : defaultPresetId); setExportError('')
              }, beat.missing) : null}
              {item('Show file in folder', async () => { if (!await ipc.invoke('library:revealFile', beat.id)) throw new Error('File is unavailable.') }, beat.missing)}
              <div role="separator" className="my-1 border-t border-line" />
              {item(beat.fileOwnership === 'external' ? 'Remove from library…' : 'Delete beat…', () => {
                setAlsoDeleteFiles(beat.fileOwnership === 'sonic-export'); setDeleteTarget(beat)
              })}
            </>
          })()}
        </div>, overlayRoot()) : null}

      <Modal open={renameTarget != null} onClose={() => !renaming && setRenameTarget(null)}
        title={renameTarget?.fileOwnership === 'external' ? 'Rename in library' : 'Rename beat and file'} size="sm" blocking={renaming}
        description={renameTarget?.fileOwnership === 'external'
          ? 'This changes only Sonic’s library record. The original filename and audio tags stay untouched.'
          : 'The audio filename and sidecar will follow the saved BPM and key. Audio tags are updated when you re-export.'}
        footer={<>
          <Button variant="secondary" onClick={() => setRenameTarget(null)} disabled={renaming}>Cancel</Button>
          <Button onClick={() => {
            if (!renameTarget || renaming) return
            const title = renameTitle.trim()
            if (!title) { setRenameError('Enter a beat title.'); return }
            setRenaming(true); setRenameError('')
            void updateBeatMetadata(renameTarget.id, { title })
              .then(() => { setRenameTarget(null); toast({ kind: 'success', title: renameTarget.fileOwnership === 'external' ? 'Library name saved' : 'Beat and file renamed' }) })
              .catch(error => setRenameError(String(error)))
              .finally(() => setRenaming(false))
          }} disabled={renaming}>Save name</Button>
        </>}>
        <Input value={renameTitle} onChange={event => setRenameTitle(event.target.value)} placeholder="Beat title" />
        {renameError ? <p role="alert" className="mt-2 text-[12px] text-danger">{renameError}</p> : null}
      </Modal>

      <Modal open={exportTarget != null} onClose={() => !exporting && setExportTarget(null)}
        title="Export prepared copy" size="sm" blocking={exporting}
        description="Sonic creates a new file with your current library metadata. The imported original stays untouched."
        footer={<>
          <Button variant="secondary" onClick={() => setExportTarget(null)} disabled={exporting}>Cancel</Button>
          <Button disabled={exporting || exportTarget?.missing} onClick={() => {
            if (!exportTarget || exporting) return
            setExporting(true); setExportError('')
            void reexportBeat(exportTarget.id, exportPresetId)
              .then(result => {
                if (!result.ok) throw new Error(result.error || 'Export failed.')
                setExportTarget(null)
                toast({ kind: 'success', title: 'Prepared copy exported' })
              })
              .catch(failure => setExportError(failure instanceof Error ? failure.message : String(failure)))
              .finally(() => setExporting(false))
          }}>{exporting ? 'Exporting…' : 'Export copy'}</Button>
        </>}>
        <label className="block text-[12px] font-medium text-fg-muted" htmlFor="local-export-preset">Audio format</label>
        <select id="local-export-preset" value={exportPresetId}
          onChange={event => setExportPresetId(event.target.value as PresetId)}
          className="mt-1.5 h-9 w-full rounded-[2px] border border-line bg-surface-2 px-2.5 text-[13.5px] text-fg">
          {PRESETS.filter(preset => preset.id !== 'original').map(preset =>
            <option key={preset.id} value={preset.id}>{preset.label}</option>)}
        </select>
        {exportError ? <p role="alert" className="mt-2 text-[12px] text-danger">{exportError}</p> : null}
      </Modal>

      <ConfirmDialog
        open={deleteTarget != null}
        title={`${deleteTarget?.fileOwnership === 'external' ? 'Remove from library' : 'Remove'} “${deleteTarget?.title ?? 'beat'}”?`}
        description={
          deleteTarget?.fileOwnership === 'external'
            ? 'Only the library record is removed. The imported original remains in its folder, unchanged.'
            : alsoDeleteFiles
            ? 'The audio file and its sidecar will be removed from disk. This cannot be undone.'
            : 'Only the library record is removed. The audio stays on disk.'
        }
        confirmLabel={deleteTarget?.fileOwnership === 'external' ? 'Remove from library' : alsoDeleteFiles ? 'Delete files' : 'Remove record'}
        tone="danger"
        onCancel={() => setDeleteTarget(null)}
        onConfirm={async () => {
          if (!deleteTarget) return
          const id = deleteTarget.id
          await removeBeat(id, deleteTarget.fileOwnership === 'sonic-export' && alsoDeleteFiles,
            { filePath: deleteTarget.filePath, fingerprint: deleteTarget.fingerprint })
          setSelectedId(current => current === id ? null : current)
          setDeleteTarget(null)
        }}
      >
        {deleteTarget?.fileOwnership !== 'external' ? <div className="flex items-center gap-2.5 rounded-[2px] border border-line bg-surface-2 px-3 py-2.5">
          <Switch checked={alsoDeleteFiles} onChange={setAlsoDeleteFiles} label="Also delete the files" />
          <span className="text-[13.5px] text-fg-muted">Also delete the audio and sidecar</span>
        </div> : null}
        {deleteTarget ? (
          <p className="mt-2 font-mono text-[12px] break-all text-fg-subtle">{deleteTarget.fileName}</p>
        ) : null}
      </ConfirmDialog>
      {recoveryPlanId ? <RecoveryDialog planId={recoveryPlanId} onClose={() => setRecoveryPlanId(null)} /> : null}
    </div>
  )
}

interface LibraryResultsProps {
  visible: LibraryBeat[]
  layout: 'grid' | 'list'
  selectedId: string | null
  selectedIds: Set<string>
  /** A displayed row to keep mounted even outside the rendered window. */
  revealId: string | null
  scrollRef: RefObject<HTMLDivElement | null>
  onToggleSelection: (id: string) => void
  onSelect: (event: ReactMouseEvent | ReactKeyboardEvent, beat: LibraryBeat) => void
  onPlay: (id: string) => void
  onContextMenu: (event: ReactMouseEvent, beat: LibraryBeat) => void
  registerCard: (id: string, node: HTMLDivElement | null) => void
}

/**
 * The result rows. Only this subtree follows playback status, so a status change
 * renders the rows instead of the whole Library page. Large result sets are
 * windowed: only rows in view, plus the row holding keyboard focus or a requested
 * reveal, are mounted, each positioned by its index.
 */
const LibraryResults = memo(function LibraryResults({ visible, layout, selectedId, selectedIds, revealId, scrollRef,
  onToggleSelection, onSelect, onPlay, onContextMenu, registerCard }: LibraryResultsProps): ReactNode {
  const { beatId: playbackBeatId, status: playbackStatus } = usePlaybackIdentity()
  const virtual = visible.length > VIRTUALIZE_AFTER
  const grid = layout === 'grid'
  const contentRef = useRef<HTMLDivElement>(null)
  const [focusedId, setFocusedId] = useState<string | null>(null)
  // The CSS row height is the default; a mounted row's real height wins (zoom, fonts).
  const [measured, setMeasured] = useState<{ layout: string; height: number } | null>(null)
  const rowHeight = measured?.layout === layout ? measured.height : grid ? GRID_CARD_PX : LIST_ROW_PX
  const pitch = rowHeight + (grid ? GRID_GAP_PX : 0)
  useLayoutEffect(() => {
    if (!virtual) return
    const height = contentRef.current?.firstElementChild?.getBoundingClientRect().height ?? 0
    if (height > 0 && Math.abs(height - rowHeight) > 0.5) setMeasured({ layout, height })
  })
  const windowed = useVirtualRows({ scrollRef, contentRef, items: visible.length, rowHeight: pitch,
    minColumnWidth: grid ? GRID_MIN_COLUMN_PX : 0, gap: grid ? GRID_GAP_PX : 0, initialWidth: lastResultsWidth, enabled: virtual })
  useEffect(() => { if (virtual && windowed.width > 0) lastResultsWidth = windowed.width }, [virtual, windowed.width])

  const row = (beat: LibraryBeat): ReactNode => (
    <LibraryBeatRow
      key={beat.id}
      beat={beat}
      layout={layout}
      playbackState={playbackBeatId === beat.id ? playbackStatus : undefined}
      selected={selectedId === beat.id}
      batchSelected={selectedIds.has(beat.id)}
      onToggleSelection={onToggleSelection}
      onSelect={onSelect}
      onPlay={onPlay}
      onContextMenu={onContextMenu}
      registerCard={registerCard}
    />
  )
  const header = (
    <div aria-hidden="true" className="mb-1 flex h-8 items-center gap-3 border-b border-line px-2 text-[12px] text-fg-subtle">
      <span className="w-[64px] shrink-0" />
      <span className="min-w-0 flex-1">Track</span>
      <span className="hidden w-14 shrink-0 text-right @min-[340px]:block">BPM</span>
      <span className="hidden w-14 shrink-0 text-right @min-[380px]:block">Key</span>
      <span className="hidden w-11 shrink-0 text-right @min-[480px]:block">Time</span>
      <span className="hidden w-12 shrink-0 text-right @min-[620px]:block">Format</span>
    </div>
  )

  if (!virtual) {
    return grid ? (
      <div className="grid grid-cols-[repeat(auto-fill,minmax(210px,1fr))] gap-2 pb-1">{visible.map(row)}</div>
    ) : (
      <div className="@container overflow-hidden">{header}{visible.map(row)}</div>
    )
  }

  const { columns } = windowed
  const pinned = [focusedId, revealId].flatMap(id => {
    const index = id ? visible.findIndex(beat => beat.id === id) : -1
    return index >= 0 ? [Math.floor(index / columns)] : []
  })
  const trackFocus = (event: ReactFocusEvent<HTMLDivElement>): void => {
    const id = (event.target as HTMLElement).closest<HTMLElement>('[data-beat-id]')?.dataset.beatId ?? null
    if (id !== focusedId) setFocusedId(id)
  }
  const releaseFocus = (event: ReactFocusEvent<HTMLDivElement>): void => {
    if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setFocusedId(null)
  }
  const body = (
    <div ref={contentRef} data-virtual-rows={visible.length} onFocus={trackFocus} onBlur={releaseFocus}
      className="relative" style={{ height: Math.max(0, windowed.rows * pitch - (grid ? GRID_GAP_PX : 0)) }}>
      {withPinned(windowed, pinned, windowed.rows).map(index => grid ? (
        <div key={`row-${index}`} className="absolute inset-x-0 grid gap-2"
          style={{ top: index * pitch, gridTemplateColumns: `repeat(${columns}, minmax(0, 1fr))` }}>
          {visible.slice(index * columns, index * columns + columns).map(row)}
        </div>
      ) : (
        <div key={visible[index].id} className="absolute inset-x-0" style={{ top: index * pitch }}>{row(visible[index])}</div>
      ))}
    </div>
  )
  return grid ? <div className="pb-1">{body}</div> : <div className="@container overflow-hidden">{header}{body}</div>
})
