/**
 * Filename templating and Windows-safe sanitisation.
 *
 * Rendering lives in `shared/` so the Settings screen can preview exactly the
 * name the main process will produce.
 */

import type { BeatMetadata, PresetId, SourceKind, TemplatePreview } from './domain'
import { formatBpm, formatCents, formatDateStamp, formatDuration } from './format'
import { getPreset } from './presets'
import { ALL_PROVIDERS } from './providers'

export const TEMPLATE_TOKENS = [
  'title',
  'producer',
  'bpm',
  'key',
  'camelot',
  'detune',
  'preset',
  'source',
  'date',
  'index',
  'duration'
] as const

export type TemplateToken = (typeof TEMPLATE_TOKENS)[number]

export const DEFAULT_NAMING_TEMPLATE = '{producer} - {title} [{bpm} BPM] [{key}]'

export const TEMPLATE_TOKEN_HELP: { token: TemplateToken; description: string }[] = [
  { token: 'title', description: 'Final beat title' },
  { token: 'producer', description: 'Final producer credit' },
  { token: 'bpm', description: 'Final tempo' },
  { token: 'key', description: 'Final key, e.g. F# minor' },
  { token: 'camelot', description: 'Camelot position, e.g. 11A' },
  { token: 'detune', description: 'Signed cents offset' },
  { token: 'preset', description: 'Export preset label' },
  { token: 'source', description: 'Source provider name' },
  { token: 'date', description: 'Export date, YYYY-MM-DD' },
  { token: 'index', description: 'Position within the batch' },
  { token: 'duration', description: 'Track length, M:SS' }
]

export interface TemplateContext {
  metadata: BeatMetadata
  presetId: PresetId
  sourceKind: SourceKind
  date?: Date
  index?: number
  durationSec?: number | null
}

const SOURCE_LABELS = {
  ...Object.fromEntries(ALL_PROVIDERS.map(provider => [provider.id, provider.tokenLabel])),
  local: 'Local',
  unknown: 'Source'
} as Record<SourceKind, string>

function tokenValue(token: TemplateToken, context: TemplateContext): string {
  const { metadata } = context
  switch (token) {
    case 'title':
      return metadata.title ?? ''
    case 'producer':
      return metadata.producer ?? ''
    case 'bpm':
      return metadata.bpm == null ? '' : formatBpm(metadata.bpm)
    case 'key':
      return metadata.key ?? ''
    case 'camelot':
      return metadata.camelot ?? ''
    case 'detune':
      return metadata.detune == null || metadata.detune === 0 ? '' : formatCents(metadata.detune).replace(' ¢', '')
    case 'preset':
      return getPreset(context.presetId).short
    case 'source':
      return SOURCE_LABELS[context.sourceKind] ?? SOURCE_LABELS.unknown
    case 'date':
      return formatDateStamp(context.date ?? new Date())
    case 'index':
      return context.index == null ? '' : String(context.index).padStart(2, '0')
    case 'duration':
      return formatDuration(context.durationSec ?? null)
    default:
      return ''
  }
}

/**
 * Unit words that are only meaningful next to a token. When the token resolves
 * to nothing — an unknown BPM, say — the literal unit is left behind, and
 * `[ BPM]` in a filename is worse than no group at all.
 */
const ORPHANED_UNIT = /^(?:bpm|key|camelot|detune|cents?|st|semitones?|kbps|khz|source|date|index|duration|preset)$/i

/**
 * Drops bracket groups that nothing but an orphaned unit word survived in.
 * Token values are still opaque slots here, so only brackets written in the
 * template itself can form a group: a title such as `Love (Key)` is never cut.
 */
function stripEmptyGroups(input: string): string {
  // One level, non-nested — templates never nest groups in practice.
  return input.replace(/[[(]([^\])}]*)[\])}]/g, (match, inner: string) => {
    const trimmed = String(inner).trim()
    if (trimmed.length === 0) return ''
    return ORPHANED_UNIT.test(trimmed) ? '' : match
  })
}

/** Collapses the debris left behind when a token resolves to nothing. */
function tidy(rendered: string): string {
  return stripEmptyGroups(rendered)
    .replace(/\[\s*\]/g, '')
    .replace(/\(\s*\)/g, '')
    .replace(/\{\s*\}/g, '')
    .replace(/\s*-\s*(?=-\s*)/g, ' ')
    .replace(/^[\s\-_.]+/, '')
    .replace(/[\s\-_.]+$/, '')
    .replace(/\s{2,}/g, ' ')
    .replace(/\s+([\]\)])/g, '$1')
    .replace(/([\[(])\s+/g, '$1')
    .trim()
}

/** Private-use delimiters for a token value while the template literal is tidied. */
const SLOT_CHARS = /[\uE000\uE001]/g
const SLOT = /\uE000(\d+)\uE001/g

function renderWithin(template: string, context: TemplateContext, maxLength: number): TemplatePreview {
  const unknownTokens: string[] = []
  const values: string[] = []
  const raw = template.replace(SLOT_CHARS, '').replace(/\{([a-zA-Z0-9_]+)\}/g, (_match, name: string) => {
    if ((TEMPLATE_TOKENS as readonly string[]).includes(name)) {
      const value = tokenValue(name as TemplateToken, context).replace(SLOT_CHARS, '').trim()
      if (!value) return ''
      values.push(value)
      return `\uE000${values.length - 1}\uE001`
    }
    unknownTokens.push(name)
    return ''
  })

  const tidied = tidy(raw).replace(SLOT, (_match, index: string) => values[Number(index)] ?? '')
  const sanitized = sanitizeFilename(tidied, maxLength)
  return {
    rendered: sanitized.value,
    unknownTokens,
    sanitized: sanitized.changed
  }
}

export function renderTemplate(template: string, context: TemplateContext): TemplatePreview {
  return renderWithin(template, context, MAX_STEM_LENGTH)
}

/** A DAW-visible name always carries known tempo and key, even with a custom template. */
export function renderExportStem(template: string, context: TemplateContext): string {
  const suffix: string[] = []
  if (context.metadata.bpm != null && !template.includes('{bpm}')) suffix.push(`[${formatBpm(context.metadata.bpm)} BPM]`)
  if (context.metadata.key && !template.includes('{key}')) suffix.push(`[${context.metadata.key}]`)
  const tail = suffix.join(' ')
  // Shorten the name, not the tempo and key that make it DAW-visible.
  const room = tail ? Math.max(1, MAX_STEM_LENGTH - tail.length - 1) : MAX_STEM_LENGTH
  const rendered = renderWithin(template, context, room).rendered
  return sanitizeFilename([rendered, tail].filter(Boolean).join(' ')).value
}

const RESERVED_DEVICE_NAMES = new Set([
  'CON',
  'PRN',
  'AUX',
  'NUL',
  'COM0',
  'COM1',
  'COM2',
  'COM3',
  'COM4',
  'COM5',
  'COM6',
  'COM7',
  'COM8',
  'COM9',
  'LPT0',
  'LPT1',
  'LPT2',
  'LPT3',
  'LPT4',
  'LPT5',
  'LPT6',
  'LPT7',
  'LPT8',
  'LPT9',
  'COM¹',
  'COM²',
  'COM³',
  'LPT¹',
  'LPT²',
  'LPT³'
])

/** Maximum stem length, leaving room for a numbered collision suffix and extension. */
const MAX_STEM_LENGTH = 150

let graphemes: Intl.Segmenter | null | undefined

/**
 * Cuts to at most `max` UTF-16 units (the unit Windows path limits count) but
 * only between user-perceived characters, so an emoji is never split into a
 * lone surrogate.
 */
function truncateText(value: string, max: number): string {
  if (value.length <= max) return value
  if (graphemes === undefined) graphemes = typeof Intl.Segmenter === 'function' ? new Intl.Segmenter(undefined, { granularity: 'grapheme' }) : null
  const pieces = graphemes ? Array.from(graphemes.segment(value), (part) => part.segment) : Array.from(value)
  let out = ''
  for (const piece of pieces) {
    if (out.length + piece.length > max) break
    out += piece
  }
  return out
}

export function sanitizeFilename(input: string, maxLength = MAX_STEM_LENGTH): { value: string; changed: boolean } {
  // NFC keeps visually identical names identical on disk, whatever the source.
  let value = input.normalize('NFC')

  // Windows forbids these outright; control characters are never useful.
  value = value.replace(/[<>:"/\\|?*]/g, '')
  // eslint-disable-next-line no-control-regex
  value = value.replace(/[\u0000-\u001f\u007f]/g, '')
  // Trailing dots and spaces are silently stripped by Windows, which makes the
  // on-disk name differ from the name we recorded. Strip them up front.
  value = value.replace(/[. ]+$/g, '')
  value = value.replace(/^[. ]+/g, '')
  value = value.replace(/\s{2,}/g, ' ')
  value = value.replace(/\.{2,}/g, '.')

  if (value.length > maxLength) {
    value = truncateText(value, maxLength).replace(/[. ]+$/g, '')
  }

  const stem = value.split('.')[0]?.trim().toUpperCase() ?? ''
  if (RESERVED_DEVICE_NAMES.has(stem)) {
    value = `_${value}`
  }

  if (value.trim().length === 0) {
    value = 'Untitled'
  }

  return { value, changed: value !== input }
}

/**
 * Appends ` (2)`, ` (3)`, … until the candidate name is free.
 * `exists` is injected so this stays pure and testable.
 */
export function resolveCollision(
  baseName: string,
  exists: (candidate: string) => boolean
): string {
  if (!exists(baseName)) return baseName

  const dot = baseName.lastIndexOf('.')
  const hasExtension = dot > 0
  const stem = hasExtension ? baseName.slice(0, dot) : baseName
  const extension = hasExtension ? baseName.slice(dot) : ''

  for (let suffix = 2; suffix < 10_000; suffix += 1) {
    const candidate = `${stem} (${suffix})${extension}`
    if (!exists(candidate)) return candidate
  }

  return `${stem} (${Date.now()})${extension}`
}
