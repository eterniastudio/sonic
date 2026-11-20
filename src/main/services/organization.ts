import { randomUUID } from 'node:crypto'
import { EventEmitter } from 'node:events'
import { JsonStore } from '../lib/jsonStore'
import { isStopping } from '../lifecycle'
import { libraryService } from './library'
import { organizationFile } from './paths'
import { parseKeyString } from '@shared/music'
import { BUILT_IN_VIEW_IDS } from '@shared/libraryTools'
import {
  ORGANIZATION_SORTS,
  FAVORITES_COLLECTION_ID,
  validateOrganizationCommand,
  validateSmartCollectionRule,
  type LibraryCollection,
  type OrganizationCommand,
  type OrganizationSnapshot,
  type SmartCollectionRule,
  type UserAnnotation
} from '@shared/organization'

const DEFAULTS: OrganizationSnapshot = {
  schemaVersion: 1,
  annotations: {},
  collections: [],
  view: { activeCollectionId: null, layout: 'list', sort: 'newest' }
}

const record = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value)
const MAX_COLLECTIONS = 100
const MAX_MEMBERS = 10_000
/** Favorites and the computed views (Recently added, Needs review, Duplicates) are always selectable. */
const isBuiltInView = (id: string): boolean => id === FAVORITES_COLLECTION_ID || BUILT_IN_VIEW_IDS.includes(id)
const emptyAnnotation = (): UserAnnotation => ({ favorite: false, tags: [], notes: '' })
const annotationAt = (annotations: Record<string, UserAnnotation>, id: string): UserAnnotation =>
  Object.hasOwn(annotations, id) ? annotations[id] : emptyAnnotation()
function putAnnotation(annotations: Record<string, UserAnnotation>, id: string, value: UserAnnotation): void {
  Object.defineProperty(annotations, id, { value, enumerable: true, configurable: true, writable: true })
}

function normalizedTags(values: string[]): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const value of values) {
    const display = value.trim().replace(/\s+/gu, ' ')
    const key = display.toLocaleLowerCase()
    if (display && !seen.has(key)) { seen.add(key); out.push(display) }
  }
  if (out.length > 24 || out.some(tag => tag.length > 40)) throw new Error('Use at most 24 tags, each up to 40 characters.')
  return out
}

function normalizedRule(rule: SmartCollectionRule): SmartCollectionRule {
  if (!validateSmartCollectionRule(rule)) throw new Error('Invalid smart collection rules.')
  if (rule.key && !parseKeyString(rule.key)) throw new Error('Enter a recognized key or Camelot code.')
  return {
    version: 1,
    ...(rule.query?.trim() ? { query: rule.query.trim() } : {}),
    ...(rule.favorite !== undefined ? { favorite: rule.favorite } : {}),
    ...(rule.tags?.length ? { tags: normalizedTags(rule.tags) } : {}),
    ...(rule.bpmMin !== undefined ? { bpmMin: rule.bpmMin } : {}),
    ...(rule.bpmMax !== undefined ? { bpmMax: rule.bpmMax } : {}),
    ...(rule.key ? { key: parseKeyString(rule.key)!.key } : {}),
    ...(rule.sourceKind ? { sourceKind: rule.sourceKind } : {}),
    ...(rule.fileOwnership ? { fileOwnership: rule.fileOwnership } : {}),
    ...(rule.reviewState ? { reviewState: rule.reviewState } : {}),
    ...(rule.fileState ? { fileState: rule.fileState } : {})
  }
}

function normalizeStored(raw: unknown): OrganizationSnapshot {
  if (!record(raw) || raw.schemaVersion !== 1 || !record(raw.annotations) || !Array.isArray(raw.collections) || !record(raw.view)) {
    throw new Error('Invalid organization file: expected version 1 records.')
  }
  if (raw.collections.length > MAX_COLLECTIONS || Object.keys(raw.annotations).length > 50_000) throw new Error('Organization file exceeds supported limits.')
  const annotations: Record<string, UserAnnotation> = {}
  for (const [beatId, value] of Object.entries(raw.annotations)) {
    if (!beatId || beatId.length > 120 || !record(value) || typeof value.favorite !== 'boolean' || !Array.isArray(value.tags) ||
      value.tags.length > 24 || !value.tags.every(tag => typeof tag === 'string' && tag.length <= 40) ||
      typeof value.notes !== 'string' || value.notes.length > 4000) throw new Error('Invalid organization annotation.')
    putAnnotation(annotations, beatId, { favorite: value.favorite, tags: normalizedTags(value.tags), notes: value.notes })
  }
  const collectionIds = new Set<string>()
  const collections: LibraryCollection[] = []
  for (const value of raw.collections) {
    if (!record(value) || typeof value.id !== 'string' || !value.id || value.id.length > 120 || value.id === FAVORITES_COLLECTION_ID || collectionIds.has(value.id) ||
      typeof value.name !== 'string' || !value.name.trim() || value.name.length > 80) throw new Error('Invalid organization collection.')
    collectionIds.add(value.id)
    if (value.type === 'manual') {
      if (!Array.isArray(value.beatIds) || value.beatIds.length > MAX_MEMBERS ||
        !value.beatIds.every(id => typeof id === 'string' && id.length > 0 && id.length <= 120) ||
        new Set(value.beatIds).size !== value.beatIds.length) throw new Error('Invalid manual collection membership.')
      collections.push({ id: value.id, type: 'manual', name: value.name.trim(), beatIds: [...value.beatIds] })
    } else if (value.type === 'smart') {
      collections.push({ id: value.id, type: 'smart', name: value.name.trim(), rules: normalizedRule(value.rules as SmartCollectionRule) })
    } else throw new Error('Unknown collection type.')
  }
  const layout = raw.view.layout
  const sort = raw.view.sort
  if (layout !== 'grid' && layout !== 'list') throw new Error('Invalid organization view layout.')
  if (typeof sort !== 'string' || !ORGANIZATION_SORTS.includes(sort as OrganizationSnapshot['view']['sort'])) throw new Error('Invalid organization view sort.')
  const active = raw.view.activeCollectionId
  if (active !== null && typeof active !== 'string') throw new Error('Invalid active collection ID.')
  return {
    schemaVersion: 1, annotations, collections,
    view: { activeCollectionId: active && (isBuiltInView(active) || collectionIds.has(active)) ? active : null, layout, sort: sort as OrganizationSnapshot['view']['sort'] }
  }
}

class OrganizationService extends EventEmitter {
  private readonly store = new JsonStore(organizationFile(), DEFAULTS, normalizeStored)

  /** A fresh copy prevents callers from mutating the committed cache. */
  snapshot(): OrganizationSnapshot { return structuredClone(this.store.read()) }

  execute(command: OrganizationCommand): OrganizationSnapshot {
    if (isStopping()) throw new Error('Sonic is closing. Wait for saving to finish.')
    if (!validateOrganizationCommand(command)) throw new Error('Invalid organization command.')
    const next = this.snapshot()
    const collection = 'id' in command ? next.collections.find(item => item.id === command.id) : undefined
    switch (command.type) {
      case 'create-manual':
      case 'create-smart': {
        if (next.collections.length >= MAX_COLLECTIONS) throw new Error('Collection limit reached.')
        const base = { id: randomUUID(), name: command.name.trim() }
        if (command.type === 'create-manual') this.assertBeats(command.beatIds ?? [])
        next.collections.push(command.type === 'create-manual'
          ? { ...base, type: 'manual', beatIds: [...new Set(command.beatIds ?? [])] }
          : { ...base, type: 'smart', rules: normalizedRule(command.rules) })
        break
      }
      case 'rename':
        if (!collection) throw new Error('Collection no longer exists.')
        collection.name = command.name.trim()
        break
      case 'update-smart':
        if (!collection || collection.type !== 'smart') throw new Error('Only smart collections have editable rules.')
        collection.rules = normalizedRule(command.rules)
        break
      case 'delete':
        if (!collection) throw new Error('Collection no longer exists.')
        next.collections = next.collections.filter(item => item.id !== command.id)
        if (next.view.activeCollectionId === command.id) next.view.activeCollectionId = null
        break
      case 'add-members': {
        if (!collection || collection.type !== 'manual') throw new Error('Only manual collections accept members.')
        this.assertBeats(command.beatIds)
        const existing = new Set(collection.beatIds)
        for (const beatId of command.beatIds) if (!existing.has(beatId)) { collection.beatIds.push(beatId); existing.add(beatId) }
        if (collection.beatIds.length > MAX_MEMBERS) throw new Error('Manual collection member limit reached.')
        break
      }
      case 'remove-members': {
        if (!collection || collection.type !== 'manual') throw new Error('Only manual collections have removable members.')
        const removed = new Set(command.beatIds)
        collection.beatIds = collection.beatIds.filter(id => !removed.has(id))
        break
      }
      case 'reorder-members': {
        if (!collection || collection.type !== 'manual') throw new Error('Only manual collections can be reordered.')
        const existing = new Set(collection.beatIds)
        if (new Set(command.beatIds).size !== command.beatIds.length || command.beatIds.length !== collection.beatIds.length ||
          command.beatIds.some(id => !existing.has(id))) throw new Error('Reorder must include every current member exactly once.')
        collection.beatIds = [...command.beatIds]
        break
      }
      case 'set-annotation': {
        this.assertBeats([command.beatId])
        const existing = annotationAt(next.annotations, command.beatId)
        const annotation = {
          favorite: command.favorite ?? existing.favorite,
          tags: command.tags === undefined ? existing.tags : normalizedTags(command.tags),
          notes: command.notes ?? existing.notes
        }
        if (annotation.favorite || annotation.tags.length || annotation.notes) putAnnotation(next.annotations, command.beatId, annotation)
        else delete next.annotations[command.beatId]
        break
      }
      case 'batch-annotation': {
        this.assertBeats(command.beatIds)
        const add = normalizedTags(command.tagsAdd ?? [])
        const remove = new Set(normalizedTags(command.tagsRemove ?? []).map(tag => tag.toLocaleLowerCase()))
        for (const beatId of new Set(command.beatIds)) {
          const previous = annotationAt(next.annotations, beatId)
          const tags = normalizedTags([...previous.tags.filter(tag => !remove.has(tag.toLocaleLowerCase())), ...add])
          const annotation = { favorite: command.favorite ?? previous.favorite, tags, notes: previous.notes }
          if (annotation.favorite || tags.length || annotation.notes) putAnnotation(next.annotations, beatId, annotation)
          else delete next.annotations[beatId]
        }
        break
      }
      case 'set-view':
        if (command.activeCollectionId && !isBuiltInView(command.activeCollectionId) && !next.collections.some(item => item.id === command.activeCollectionId)) throw new Error('Active collection no longer exists.')
        next.view = { activeCollectionId: command.activeCollectionId, layout: command.layout, sort: command.sort }
        break
    }
    const committed = this.store.write(next)
    const snapshot = structuredClone(committed)
    this.emit('changed', snapshot)
    return snapshot
  }

  /**
   * Folds the producer's work on duplicate records into the record being kept:
   * favorite is kept if any copy was a favorite, tags are merged, distinct notes
   * are appended, and manual collections reference the kept record instead.
   * The removed records' annotations are dropped. Library records are untouched.
   */
  mergeInto(keepId: string, removeIds: string[]): OrganizationSnapshot {
    if (isStopping()) throw new Error('Sonic is closing. Wait for saving to finish.')
    const removed = new Set(removeIds.filter(id => id !== keepId))
    if (!removed.size) return this.snapshot()
    const next = this.snapshot()
    const kept = annotationAt(next.annotations, keepId)
    const notes = [kept.notes]
    let favorite = kept.favorite
    let tags = [...kept.tags]
    for (const id of removed) {
      if (!Object.hasOwn(next.annotations, id)) continue
      const other = next.annotations[id]
      favorite ||= other.favorite
      tags = [...tags, ...other.tags]
      if (other.notes.trim() && !notes.some(existing => existing.trim() === other.notes.trim())) notes.push(other.notes)
      delete next.annotations[id]
    }
    // Keep the first 24 distinct tags; the kept record's own tags come first.
    const seen = new Set<string>()
    const mergedTags = tags.filter(tag => {
      const key = tag.toLocaleLowerCase()
      if (seen.has(key)) return false
      seen.add(key)
      return true
    }).slice(0, 24)
    const mergedNotes = notes.filter(Boolean).join('\n\n').slice(0, 4000)
    if (favorite || mergedTags.length || mergedNotes) putAnnotation(next.annotations, keepId, { favorite, tags: mergedTags, notes: mergedNotes })
    for (const collection of next.collections) {
      if (collection.type !== 'manual') continue
      const out: string[] = []
      for (const id of collection.beatIds) {
        const target = removed.has(id) ? keepId : id
        if (!out.includes(target)) out.push(target)
      }
      collection.beatIds = out
    }
    const committed = this.store.write(next)
    const snapshot = structuredClone(committed)
    this.emit('changed', snapshot)
    return snapshot
  }

  /** Collection names per beat, for list exports. */
  collectionNamesByBeat(): Map<string, string[]> {
    const out = new Map<string, string[]>()
    for (const collection of this.store.read().collections) {
      if (collection.type !== 'manual') continue
      for (const id of collection.beatIds) out.set(id, [...(out.get(id) ?? []), collection.name])
    }
    return out
  }

  private assertBeats(ids: string[]): void {
    const existing = new Set(libraryService.list().map(beat => beat.id))
    for (const id of ids) if (!existing.has(id)) throw new Error(`Beat ${id} is no longer in the library.`)
  }
}

export const organizationService = new OrganizationService()
export { validateOrganizationCommand } from '@shared/organization'
