/**
 * Library list export (CSV or JSON). Pure, so the exact file contents can be
 * tested without a save dialog. Only file names are written, never full paths.
 */

import type { LibraryBeat } from './domain'
import { camelotOf } from './libraryTools'
import { sourceKindName } from './providers'

export type LibraryExportFormat = 'csv' | 'json'

export interface LibraryExportRow {
  title: string
  producer: string | null
  bpm: number | null
  key: string | null
  camelot: string | null
  durationSec: number | null
  source: string | null
  sourceUrl: string | null
  fileName: string
  collections: string[]
}

export const LIBRARY_EXPORT_COLUMNS: readonly { field: keyof LibraryExportRow; label: string }[] = [
  { field: 'title', label: 'Title' },
  { field: 'producer', label: 'Producer' },
  { field: 'bpm', label: 'BPM' },
  { field: 'key', label: 'Key' },
  { field: 'camelot', label: 'Camelot' },
  { field: 'durationSec', label: 'Duration' },
  { field: 'source', label: 'Source' },
  { field: 'sourceUrl', label: 'Source URL' },
  { field: 'fileName', label: 'File name' },
  { field: 'collections', label: 'Collections' }
]

const sourceLabel = (kind: LibraryBeat['sourceKind']): string => kind === 'local' ? 'Local file' : sourceKindName(kind)

export function libraryExportRows(
  beats: Pick<LibraryBeat, 'id' | 'title' | 'producer' | 'bpm' | 'key' | 'camelot' | 'durationSec' | 'sourceKind' | 'sourceUrl' | 'fileName'>[],
  collectionsByBeat: ReadonlyMap<string, string[]>
): LibraryExportRow[] {
  return beats.map(beat => ({
    title: beat.title,
    producer: beat.producer,
    bpm: beat.bpm,
    key: beat.key,
    camelot: beat.camelot ?? camelotOf(beat),
    durationSec: Number.isFinite(beat.durationSec) && beat.durationSec > 0 ? Math.round(beat.durationSec * 100) / 100 : null,
    source: sourceLabel(beat.sourceKind),
    sourceUrl: beat.sourceUrl && /^https:\/\//i.test(beat.sourceUrl) ? beat.sourceUrl : null,
    fileName: beat.fileName,
    collections: collectionsByBeat.get(beat.id) ?? []
  }))
}

/** `m:ss` (or `h:mm:ss`), the way a DAW browser shows length. */
export function formatExportDuration(seconds: number | null): string {
  if (seconds == null) return ''
  const total = Math.round(seconds)
  const h = Math.floor(total / 3600), m = Math.floor((total % 3600) / 60), s = total % 60
  return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}` : `${m}:${String(s).padStart(2, '0')}`
}

/**
 * RFC 4180 quoting, plus a leading apostrophe on cells a spreadsheet would
 * run as a formula (`=`, `+`, `-`, `@`, tab, carriage return).
 */
export function csvCell(value: string): string {
  const safe = /^[=+\-@\t\r]/.test(value) ? `'${value}` : value
  return /[",\r\n]/.test(safe) || safe !== safe.trim() ? `"${safe.replace(/"/g, '""')}"` : safe
}

export function serializeLibraryExport(rows: LibraryExportRow[], format: LibraryExportFormat, exportedAt = new Date()): string {
  if (format === 'json') {
    return JSON.stringify({ schema: 'sonic-v2/library-list', schemaVersion: 1, exportedAt: exportedAt.toISOString(), count: rows.length, tracks: rows }, null, 2) + '\n'
  }
  const lines = [LIBRARY_EXPORT_COLUMNS.map(column => csvCell(column.label)).join(',')]
  for (const row of rows) {
    lines.push(LIBRARY_EXPORT_COLUMNS.map(({ field }) => {
      const value = row[field]
      if (field === 'durationSec') return csvCell(formatExportDuration(value as number | null))
      if (Array.isArray(value)) return csvCell(value.join('; '))
      return csvCell(value == null ? '' : String(value))
    }).join(','))
  }
  // A byte-order mark lets Excel open UTF-8 titles without mangling them.
  return '﻿' + lines.join('\r\n') + '\r\n'
}
