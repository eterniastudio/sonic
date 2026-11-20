import type { SourceKind } from './domain'
import { isProviderId } from './providers'

/** Producer-owned organization, separate from acoustic and source metadata. */
export type LibrarySort = 'manual' | 'relevance' | 'newest' | 'oldest' | 'bpm-asc' | 'bpm-desc' | 'title' | 'producer'
export const FAVORITES_COLLECTION_ID = 'favorites'

export interface UserAnnotation {
  favorite: boolean
  tags: string[]
  notes: string
}

export interface SmartCollectionRule {
  version: 1
  query?: string
  favorite?: boolean
  tags?: string[]
  bpmMin?: number
  bpmMax?: number
  key?: string
  sourceKind?: SourceKind
  fileOwnership?: 'external' | 'sonic-export'
  reviewState?: 'all' | 'incomplete' | 'disagreement'
  fileState?: 'all' | 'present' | 'missing'
}

export type LibraryCollection =
  | { id: string; type: 'manual'; name: string; beatIds: string[] }
  | { id: string; type: 'smart'; name: string; rules: SmartCollectionRule }

export interface OrganizationSnapshot {
  schemaVersion: 1
  annotations: Record<string, UserAnnotation>
  collections: LibraryCollection[]
  view: { activeCollectionId: string | null; layout: 'grid' | 'list'; sort: LibrarySort }
}

export type OrganizationCommand =
  | { type: 'create-manual'; name: string; beatIds?: string[] }
  | { type: 'create-smart'; name: string; rules: SmartCollectionRule }
  | { type: 'update-smart'; id: string; rules: SmartCollectionRule }
  | { type: 'rename'; id: string; name: string }
  | { type: 'delete'; id: string }
  | { type: 'add-members'; id: string; beatIds: string[] }
  | { type: 'remove-members'; id: string; beatIds: string[] }
  | { type: 'reorder-members'; id: string; beatIds: string[] }
  | { type: 'set-annotation'; beatId: string; favorite?: boolean; tags?: string[]; notes?: string }
  | { type: 'batch-annotation'; beatIds: string[]; favorite?: boolean; tagsAdd?: string[]; tagsRemove?: string[] }
  | { type: 'set-view'; activeCollectionId: string | null; layout: 'grid' | 'list'; sort: LibrarySort }

export const ORGANIZATION_SORTS: readonly LibrarySort[] = ['manual', 'relevance', 'newest', 'oldest', 'bpm-asc', 'bpm-desc', 'title', 'producer']

const object = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value)
const keysOnly = (value: Record<string, unknown>, keys: readonly string[]): boolean => Object.keys(value).every(key => keys.includes(key))
const text = (value: unknown, limit: number): value is string => typeof value === 'string' && value.length <= limit && !/[\u0000-\u001f\u007f]/u.test(value)
const notes = (value: unknown): value is string => typeof value === 'string' && value.length <= 4000 && !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(value)
const id = (value: unknown): value is string => text(value, 120) && value.length > 0
const ids = (value: unknown): value is string[] => Array.isArray(value) && value.length <= 10_000 && value.every(id)
const tags = (value: unknown): value is string[] => Array.isArray(value) && value.length <= 24 && value.every(tag => text(tag, 40) && tag.trim().length > 0)
const name = (value: unknown): value is string => text(value, 80) && value.trim().length > 0

/** Any registry provider id, plus the 'local' and 'unknown' kinds stored before the registry existed. */
export function isSourceKind(value: unknown): value is SourceKind {
  return value === 'local' || value === 'unknown' || isProviderId(value)
}

export function validateSmartCollectionRule(value: unknown): value is SmartCollectionRule {
  if (!object(value) || value.version !== 1 || !keysOnly(value, ['version', 'query', 'favorite', 'tags', 'bpmMin', 'bpmMax', 'key', 'sourceKind', 'fileOwnership', 'reviewState', 'fileState'])) return false
  if (value.query !== undefined && !text(value.query, 160)) return false
  if (value.favorite !== undefined && typeof value.favorite !== 'boolean') return false
  if (value.tags !== undefined && !tags(value.tags)) return false
  if (value.bpmMin !== undefined && (typeof value.bpmMin !== 'number' || !Number.isFinite(value.bpmMin) || value.bpmMin < 20 || value.bpmMin > 400)) return false
  if (value.bpmMax !== undefined && (typeof value.bpmMax !== 'number' || !Number.isFinite(value.bpmMax) || value.bpmMax < 20 || value.bpmMax > 400)) return false
  if (typeof value.bpmMin === 'number' && typeof value.bpmMax === 'number' && value.bpmMin > value.bpmMax) return false
  if (value.key !== undefined && (!text(value.key, 30) || value.key.trim().length === 0)) return false
  if (value.sourceKind !== undefined && !isSourceKind(value.sourceKind)) return false
  if (value.fileOwnership !== undefined && (typeof value.fileOwnership !== 'string' || !['external', 'sonic-export'].includes(value.fileOwnership))) return false
  if (value.reviewState !== undefined && (typeof value.reviewState !== 'string' || !['all', 'incomplete', 'disagreement'].includes(value.reviewState))) return false
  if (value.fileState !== undefined && (typeof value.fileState !== 'string' || !['all', 'present', 'missing'].includes(value.fileState))) return false
  return true
}

/** Runtime validation happens before a renderer command can reach the store. */
export function validateOrganizationCommand(value: unknown): value is OrganizationCommand {
  if (!object(value) || typeof value.type !== 'string') return false
  switch (value.type) {
    case 'create-manual': return keysOnly(value, ['type', 'name', 'beatIds']) && name(value.name) && (value.beatIds === undefined || ids(value.beatIds))
    case 'create-smart': return keysOnly(value, ['type', 'name', 'rules']) && name(value.name) && validateSmartCollectionRule(value.rules)
    case 'update-smart': return keysOnly(value, ['type', 'id', 'rules']) && id(value.id) && validateSmartCollectionRule(value.rules)
    case 'rename': return keysOnly(value, ['type', 'id', 'name']) && id(value.id) && name(value.name)
    case 'delete': return keysOnly(value, ['type', 'id']) && id(value.id)
    case 'add-members':
    case 'remove-members':
    case 'reorder-members': return keysOnly(value, ['type', 'id', 'beatIds']) && id(value.id) && ids(value.beatIds)
    case 'set-annotation': return keysOnly(value, ['type', 'beatId', 'favorite', 'tags', 'notes']) && id(value.beatId) &&
      (value.favorite === undefined || typeof value.favorite === 'boolean') && (value.tags === undefined || tags(value.tags)) &&
      (value.notes === undefined || notes(value.notes)) &&
      (value.favorite !== undefined || value.tags !== undefined || value.notes !== undefined)
    case 'batch-annotation': return keysOnly(value, ['type', 'beatIds', 'favorite', 'tagsAdd', 'tagsRemove']) && ids(value.beatIds) && value.beatIds.length > 0 && value.beatIds.length <= 5000 &&
      (value.favorite === undefined || typeof value.favorite === 'boolean') && (value.tagsAdd === undefined || tags(value.tagsAdd)) &&
      (value.tagsRemove === undefined || tags(value.tagsRemove)) &&
      (value.favorite !== undefined || value.tagsAdd !== undefined || value.tagsRemove !== undefined)
    case 'set-view': return keysOnly(value, ['type', 'activeCollectionId', 'layout', 'sort']) &&
      (value.activeCollectionId === null || id(value.activeCollectionId)) && typeof value.layout === 'string' && ['grid', 'list'].includes(value.layout) && ORGANIZATION_SORTS.includes(value.sort as LibrarySort)
    default: return false
  }
}
