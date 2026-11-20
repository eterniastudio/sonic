import MiniSearch from 'minisearch'
import type { LibraryBeat } from '@shared/domain'
import type { OrganizationSnapshot, SmartCollectionRule } from '@shared/organization'
import { parseKeyString } from '@shared/music'

export type LibrarySort = 'manual' | 'relevance' | 'newest' | 'oldest' | 'bpm-asc' | 'bpm-desc' | 'title' | 'producer'
export type FileFilter = 'all' | 'present' | 'missing'
export type ReviewFilter = 'all' | 'incomplete' | 'disagreement'

export interface LibrarySearchOptions {
  query: string
  sort: LibrarySort
  bands: ReadonlySet<string>
  formats: ReadonlySet<string>
  fileFilter: FileFilter
  reviewFilter: ReviewFilter
  bpm: string
  bpmTolerance: number
  includeHalfDouble: boolean
  key: string
}

const TEMPO_BANDS = [
  { id: 'slow', min: 0, max: 90 },
  { id: 'mid', min: 90, max: 120 },
  { id: 'trap', min: 120, max: 150 },
  { id: 'fast', min: 150, max: Number.POSITIVE_INFINITY }
]

const INDEX_FIELDS = ['title', 'producer', 'sourceChannel', 'fileName', 'key', 'camelot', 'format', 'bpm'] as const
type SearchDocument = Pick<LibraryBeat, 'id' | typeof INDEX_FIELDS[number]>

/**
 * The library's full-text index. MiniSearch is only built the first time a
 * query runs against this set of documents, so browsing, filtering and library
 * updates while no search is typed never pay for indexing. A built index is
 * the same as one built eagerly from the same documents.
 */
export class LibraryIndex {
  private index: MiniSearch<SearchDocument> | null = null
  constructor(readonly records: readonly LibraryBeat[], private readonly documents: readonly SearchDocument[]) {}
  get built(): boolean { return this.index !== null }
  search(query: string): ReturnType<MiniSearch<SearchDocument>['search']> {
    return this.build().search(query)
  }
  private build(): MiniSearch<SearchDocument> {
    if (!this.index) {
      this.index = new MiniSearch<SearchDocument>({
        fields: [...INDEX_FIELDS],
        searchOptions: {
          boost: { title: 2, producer: 1.6 },
          fuzzy: 0.2,
          prefix: true,
          combineWith: 'AND'
        }
      })
      this.index.addAll([...this.documents])
    }
    return this.index
  }
  /** Build ahead of the first query once the library has been quiet for a moment,
   * so a burst of updates (a batch analysis) builds nothing it then discards. */
  warmWhenIdle(): void {
    if (typeof requestIdleCallback !== 'function') return
    latestIndex = this
    if (warmTimer) clearTimeout(warmTimer)
    warmTimer = setTimeout(() => {
      warmTimer = null
      requestIdleCallback(() => { if (latestIndex === this) this.build() }, { timeout: 5_000 })
    }, 1_000)
  }
  /** Whether `library` indexes exactly as this index does. */
  matches(library: readonly LibraryBeat[]): boolean {
    if (library.length !== this.documents.length) return false
    for (let position = 0; position < library.length; position++) {
      const beat = library[position]
      // Pushes keep unchanged records as the same object, so most rows stop here.
      if (beat === this.records[position]) continue
      const document = this.documents[position]
      // Spelled out (one per INDEX_FIELDS entry): a dynamic field loop over full
      // library records is several times slower on large libraries.
      if (beat.id !== document.id || !Object.is(beat.title, document.title) || !Object.is(beat.producer, document.producer) ||
        !Object.is(beat.sourceChannel, document.sourceChannel) || !Object.is(beat.fileName, document.fileName) ||
        !Object.is(beat.key, document.key) || !Object.is(beat.camelot, document.camelot) ||
        !Object.is(beat.format, document.format) || !Object.is(beat.bpm, document.bpm)) return false
    }
    return true
  }
}

let latestIndex: LibraryIndex | null = null
let warmTimer: ReturnType<typeof setTimeout> | null = null

/** Analysis, file availability and other unindexed changes do not require rebuilding search. */
export function createLibraryIndex(library: LibraryBeat[], previous?: LibraryIndex): LibraryIndex {
  if (previous && previous.matches(library)) return previous
  const index = new LibraryIndex(library, library.map(beat => ({ id: beat.id, title: beat.title, producer: beat.producer,
    sourceChannel: beat.sourceChannel, fileName: beat.fileName, key: beat.key,
    camelot: beat.camelot, format: beat.format, bpm: beat.bpm })))
  index.warmWhenIdle()
  return index
}

export function searchLibrary(
  library: LibraryBeat[],
  index: LibraryIndex,
  options: LibrarySearchOptions
): LibraryBeat[] {
  const query = options.query.trim()
  const rank = query
    ? new Map(index.search(query).map((hit, position) => [String(hit.id), position]))
    : null
  const bpmText = options.bpm.trim()
  const targetBpm = bpmText === '' ? null : Number(bpmText)
  if (bpmText !== '' && (targetBpm == null || !Number.isFinite(targetBpm) || targetBpm <= 0)) return []
  const keyText = options.key.trim()
  const wantedKey = keyText ? parseKeyString(keyText) : null
  if (keyText && !wantedKey) return []
  // Libraries repeat a few dozen key spellings; parse each once per search.
  type ParsedKey = ReturnType<typeof parseKeyString>
  const parsedKeys = new Map<string | null, ParsedKey>()
  const parseKey = (value: string | null): ParsedKey => {
    if (parsedKeys.has(value)) return parsedKeys.get(value) as ParsedKey
    const parsed = parseKeyString(value)
    parsedKeys.set(value, parsed)
    return parsed
  }
  const candidates = targetBpm == null ? [] : options.includeHalfDouble
    ? [targetBpm, targetBpm / 2, targetBpm * 2] : [targetBpm]

  const rows = library.filter((beat) => {
    if (rank && !rank.has(beat.id)) return false
    if (options.bands.size > 0 && (beat.bpm == null || !TEMPO_BANDS.some(
      (band) => options.bands.has(band.id) && beat.bpm! >= band.min && beat.bpm! < band.max
    ))) return false
    if (options.formats.size > 0 && !options.formats.has(beat.format)) return false
    if (options.fileFilter === 'present' && (beat.missing || beat.fileAccessError)) return false
    if (options.fileFilter === 'missing' && !beat.missing && !beat.fileAccessError) return false
    if (options.reviewFilter === 'incomplete' && beat.analysisStatus === 'estimated') return false
    if (options.reviewFilter === 'disagreement' && !beat.verification?.fields.some(
      (field) => (field.field === 'bpm' || field.field === 'key') && field.verdict === 'mismatch'
    )) return false
    if (targetBpm != null) {
      if (beat.bpm == null) return false
      if (!candidates.some((candidate) => Math.abs(beat.bpm! - candidate) <= options.bpmTolerance)) return false
    }
    if (wantedKey) {
      const actual = parseKey(beat.key ?? beat.camelot)
      if (!actual || (wantedKey.camelot
        ? actual.camelot !== wantedKey.camelot
        : actual.key !== wantedKey.key)) return false
    }
    return true
  })

  const sorted = rows
  switch (options.sort) {
    case 'manual': break
    case 'relevance':
      if (rank) sorted.sort((a, b) => (rank.get(a.id) ?? Infinity) - (rank.get(b.id) ?? Infinity))
      else sorted.sort((a, b) => b.addedAt - a.addedAt)
      break
    case 'oldest': sorted.sort((a, b) => a.addedAt - b.addedAt); break
    case 'bpm-asc': sorted.sort((a, b) => (a.bpm ?? Infinity) - (b.bpm ?? Infinity)); break
    case 'bpm-desc': sorted.sort((a, b) => (b.bpm ?? -1) - (a.bpm ?? -1)); break
    case 'title': sorted.sort((a, b) => a.title.localeCompare(b.title)); break
    case 'producer': sorted.sort((a, b) => (a.producer ?? '').localeCompare(b.producer ?? '')); break
    default: sorted.sort((a, b) => b.addedAt - a.addedAt)
  }
  return sorted
}

/** Smart views use the same search and review predicates as the library filters. */
export function searchSmartCollection(
  library: LibraryBeat[], index: LibraryIndex, rules: SmartCollectionRule,
  annotations: OrganizationSnapshot['annotations'], sort: LibrarySort
): LibraryBeat[] {
  const searched = searchLibrary(library, index, {
    query: rules.query ?? '', sort, bands: new Set(), formats: new Set(),
    fileFilter: rules.fileState ?? 'all', reviewFilter: rules.reviewState ?? 'all',
    bpm: '', bpmTolerance: 0, includeHalfDouble: false, key: rules.key ?? ''
  })
  return searched.filter(beat => {
    const annotation = Object.prototype.hasOwnProperty.call(annotations, beat.id) ? annotations[beat.id] : undefined
    if (rules.favorite != null && Boolean(annotation?.favorite) !== rules.favorite) return false
    if (rules.tags?.length && !rules.tags.every(tag => annotation?.tags.some(value => value.toLocaleLowerCase() === tag.toLocaleLowerCase()))) return false
    if (rules.bpmMin != null && (beat.bpm == null || beat.bpm < rules.bpmMin)) return false
    if (rules.bpmMax != null && (beat.bpm == null || beat.bpm > rules.bpmMax)) return false
    if (rules.sourceKind && beat.sourceKind !== rules.sourceKind) return false
    if (rules.fileOwnership && beat.fileOwnership !== rules.fileOwnership) return false
    return true
  })
}
