import { useCallback, type Dispatch, type SetStateAction } from 'react'
import { create } from 'zustand'
import type { FileFilter, LibrarySort, ReviewFilter } from '../features/library/librarySearch'

/** Renderer-session browsing context. Never contains playback or pending operations. */
interface LibraryWorkspace {
  query: string
  layout: 'grid' | 'list'
  sort: LibrarySort
  bands: Set<string>
  formats: Set<string>
  fileFilter: FileFilter
  reviewFilter: ReviewFilter
  bpmFilter: string
  bpmTolerance: number
  includeHalfDouble: boolean
  keyFilter: string
  selectedId: string | null
  selectedIds: Set<string>
  selectionAnchor: string | null
  selectionScope: string | null
  showFilters: boolean
  scrollTop: number
}

export const useLibraryWorkspace = create<LibraryWorkspace>(() => ({
  query: '', layout: 'list', sort: 'newest', bands: new Set(), formats: new Set(),
  fileFilter: 'all', reviewFilter: 'all', bpmFilter: '', bpmTolerance: 3,
  includeHalfDouble: false, keyFilter: '', selectedId: null, selectedIds: new Set(),
  selectionAnchor: null, selectionScope: null, showFilters: false, scrollTop: 0
}))

export function useWorkspaceField<K extends keyof LibraryWorkspace>(key: K):
  [LibraryWorkspace[K], Dispatch<SetStateAction<LibraryWorkspace[K]>>] {
  const value = useLibraryWorkspace(state => state[key])
  const setValue = useCallback((next: SetStateAction<LibraryWorkspace[K]>) => {
    useLibraryWorkspace.setState(state => {
      const value = typeof next === 'function' ? next(state[key]) : next
      return Object.is(value, state[key]) ? state : { ...state, [key]: value }
    })
  }, [key])
  return [value, setValue]
}

/** Call only after the collection snapshot is loaded, never against an interim all-audio view. */
export function reconcileWorkspace(scope: string, visibleIds: string[], libraryIds: string[]): void {
  useLibraryWorkspace.setState(state => {
    const changedScope = state.selectionScope !== null && state.selectionScope !== scope
    const matching = new Set(visibleIds)
    const selectedIds = changedScope ? new Set<string>() :
      new Set([...state.selectedIds].filter(id => matching.has(id)))
    const selectionAnchor = !changedScope && state.selectionAnchor && matching.has(state.selectionAnchor)
      ? state.selectionAnchor : null
    const selectedId = state.selectedId && libraryIds.includes(state.selectedId) ? state.selectedId : null
    if (state.selectionScope === scope && selectedIds.size === state.selectedIds.size &&
      selectionAnchor === state.selectionAnchor && selectedId === state.selectedId) return state
    return { selectionScope: scope, selectedIds, selectionAnchor, selectedId,
      scrollTop: changedScope ? 0 : state.scrollTop }
  })
}
