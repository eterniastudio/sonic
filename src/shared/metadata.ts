/**
 * Producer metadata parsing.
 *
 * Everything here is deterministic and text-only: Sonic reads what the source
 * declares (title, description, filename) and what the container tags say. It
 * never guesses at BPM or key from the audio itself, so a value in the UI can
 * always be traced back to the exact substring that produced it.
 */

import type {
  BeatMetadata,
  Evidence,
  EvidenceSource,
  MetadataConflict,
  MetadataDraft,
  MetadataField,
  MetadataValues,
  SourceValues
} from './domain'
import type { AudioAnalysis, AudioEvidence } from './analysis'
import { camelotFor, camelotToKey, formatKey, hzToCents, normalizeMode, parseKeyString } from './music'
import { isHalfOrDoubleTempo, verifyMetadata } from './verification'
import { formatBpm, formatCents } from './format'

export const BPM_MIN = 40
export const BPM_MAX = 300

/** Beat-type keywords used to derive a genre hint from the source title. */
const GENRE_KEYWORDS: { pattern: RegExp; label: string }[] = [
  { pattern: /\bjersey\s*club\b/i, label: 'Jersey Club' },
  { pattern: /\bboom\s*bap\b/i, label: 'Boom Bap' },
  { pattern: /\bafro(?:beat|swing|house|pop)?\b/i, label: 'Afrobeats' },
  { pattern: /\breggaeton\b/i, label: 'Reggaeton' },
  { pattern: /\bhyperpop\b/i, label: 'Hyperpop' },
  { pattern: /\bphonk\b/i, label: 'Phonk' },
  { pattern: /\bdrill\b/i, label: 'Drill' },
  { pattern: /\bpluggn?b\b/i, label: 'Plugg' },
  { pattern: /\brage\b/i, label: 'Rage' },
  { pattern: /\bambient\b/i, label: 'Ambient' },
  { pattern: /\bclassical\b/i, label: 'Classical' },
  { pattern: /\btechno\b/i, label: 'Techno' },
  { pattern: /\bhouse\b/i, label: 'House' },
  { pattern: /\bgarage\b/i, label: 'Garage' },
  { pattern: /\bdubstep\b/i, label: 'Dubstep' },
  { pattern: /\btrap\b/i, label: 'Trap' },
  { pattern: /\bsoul\b/i, label: 'Soul' },
  { pattern: /\br\s*&\s*b\b|\brnb\b/i, label: 'R&B' },
  { pattern: /\bhip\s*-?\s*hop\b|\brap\b/i, label: 'Hip-Hop' },
  { pattern: /\blo\s*-?\s*fi\b/i, label: 'Lo-fi' },
  { pattern: /\bjazz\b/i, label: 'Jazz' },
  { pattern: /\bpop\b/i, label: 'Pop' },
  { pattern: /\brock\b/i, label: 'Rock' },
  { pattern: /\bedm\b/i, label: 'EDM' }
]

export function emptyMetadata(): BeatMetadata {
  return {
    title: '',
    producer: null,
    bpm: null,
    altBpm: null,
    key: null,
    camelot: null,
    detune: null,
    tuning: null,
    genre: null
  }
}

export interface ParseSources {
  title?: string | null
  description?: string | null
  filename?: string | null
}

export interface ParseOutput {
  values: MetadataValues
  evidence: Evidence[]
  /** Each source kept separately, for cross-checking in the UI. */
  bySource: SourceValues
}

/** A single text source's parse result, before sources are combined. */
export interface TextParseOutput {
  values: MetadataValues
  evidence: Evidence[]
}

/** Splits a blob of text into lines while keeping offsets irrelevant. */
function firstMatch(text: string, pattern: RegExp): RegExpExecArray | null {
  pattern.lastIndex = 0
  return pattern.exec(text)
}

/** First match the caller accepts, for patterns that need context beyond a regex. */
function findMatch(text: string, pattern: RegExp, accept: (match: RegExpMatchArray) => boolean): RegExpMatchArray | null {
  const global = new RegExp(pattern.source, pattern.flags.includes('g') ? pattern.flags : `${pattern.flags}g`)
  for (const match of text.matchAll(global)) if (accept(match)) return match
  return null
}

function inBpmRange(value: number): boolean {
  return Number.isFinite(value) && value >= BPM_MIN && value <= BPM_MAX
}

/** What may sit directly before a tempo, key or tuning token (titles, filenames, tags). */
const LEAD = String.raw`(?:^|[\s[(\-–—|,_:=/#•·])`
const NUMBER = String.raw`(\d{2,3}(?:\.\d+)?)`
/** A number that is not the start of a longer number, decimal or percentage. */
const NUMBER_END = String.raw`(?![\d%]|\.\d)`
/** `LEAD` plus `@`, as in `Drill Type Beat @140bpm`. Only tempo tokens accept it. */
const BPM_LEAD = String.raw`(?:^|[\s[(\-–—|,_:=/#•·@])`
/** Tempos without a `bpm` word are accepted only inside the common producer range. */
const BARE_BPM_MIN = 60
const BARE_BPM_MAX = 200
/** Two numbers before one `bpm` read as a range when within 25% of each other (`140 - 145 BPM`). */
const BPM_RANGE_SPREAD = 0.25

function inBareBpmRange(value: number): boolean {
  return Number.isFinite(value) && value >= BARE_BPM_MIN && value <= BARE_BPM_MAX
}

/** A 2:1 pair within 3%, as producers quote half-time tempos (`70 - 140 BPM`). */
function isOctavePair(a: number, b: number): boolean {
  return Math.abs(Math.max(a, b) / Math.min(a, b) - 2) <= 0.03
}

/**
 * Reads tempo declarations. A `72 / 144 BPM` pairing is recorded with the
 * higher value as primary and the lower as the half-time alternate, which is
 * how producers quote trap and drill tempos.
 */
function parseBpm(text: string, source: EvidenceSource, evidence: Evidence[]): {
  bpm: number | null
  altBpm: number | null
} {
  type Shape = 'pair' | 'range' | 'single' | 'bare'
  const patterns: { pattern: RegExp; confidence: number; shape: Shape }[] = [
    { pattern: new RegExp(`${BPM_LEAD}${NUMBER}\\s*\\/\\s*${NUMBER}\\s*bpm(?![a-z])`, 'i'), confidence: 0.98, shape: 'pair' },
    { pattern: new RegExp(`(?<![a-z])bpm\\s*[:=\\-–]?\\s*${NUMBER}\\s*\\/\\s*${NUMBER}${NUMBER_END}`, 'i'), confidence: 0.96, shape: 'pair' },
    // `140 - 145 BPM` is a range (the first number leads); `70 - 140 BPM` is a
    // half-time pair. Anything else, e.g. `Track 12 - 140 BPM`, falls through.
    { pattern: new RegExp(`${BPM_LEAD}${NUMBER}\\s*(?:[-–—~]|to)\\s*${NUMBER}\\s*bpm(?![a-z])`, 'i'), confidence: 0.9, shape: 'range' },
    // `140 BPM` before `BPM 140`, so `140 BPM 2024` never reads the year.
    { pattern: new RegExp(`${BPM_LEAD}${NUMBER}\\s*bpm(?![a-z])`, 'i'), confidence: 0.95, shape: 'single' },
    { pattern: new RegExp(`(?<![a-z])bpm\\s*[:=\\-–]?\\s*${NUMBER}${NUMBER_END}`, 'i'), confidence: 0.95, shape: 'single' },
    { pattern: /\b(\d{2,3}(?:\.\d+)?)\s*beats?\s*per\s*minute\b/i, confidence: 0.9, shape: 'single' },
    { pattern: new RegExp(`\\btempo\\s*[:=]?\\s*${NUMBER}${NUMBER_END}`, 'i'), confidence: 0.8, shape: 'single' },
    // `@ 140` with no unit is producers' shorthand for "at 140 BPM".
    { pattern: new RegExp(`(?:^|\\s)@\\s*${NUMBER}(?![\\d%a-z]|\\.\\d)`, 'i'), confidence: 0.75, shape: 'bare' }
  ]

  const record = (bpm: number, altBpm: number | null, matched: string, confidence: number) => {
    evidence.push({ field: 'bpm', value: formatBpm(bpm), source, matched: matched.trim(), confidence })
    if (altBpm != null) {
      evidence.push({ field: 'altBpm', value: formatBpm(altBpm), source, matched: matched.trim(), confidence: confidence - 0.05 })
    }
    return { bpm, altBpm }
  }

  for (const { pattern, confidence, shape } of patterns) {
    const match = firstMatch(text, pattern)
    if (!match) continue

    const first = Number(match[1])
    const second = match[2] != null ? Number(match[2]) : null

    if (shape === 'pair' && second != null) {
      if (!inBpmRange(first) && !inBpmRange(second)) continue
      const primary = Math.max(inBpmRange(first) ? first : second, inBpmRange(second) ? second : first)
      const alternate = primary === first ? second : first
      return record(primary, alternate, match[0], confidence)
    }

    if (shape === 'range' && second != null) {
      if (!inBpmRange(first) || !inBpmRange(second) || first === second) continue
      if (isOctavePair(first, second)) return record(Math.max(first, second), Math.min(first, second), match[0], confidence)
      if (Math.abs(first - second) / Math.min(first, second) > BPM_RANGE_SPREAD) continue
      return record(first, null, match[0], confidence)
    }

    if (shape === 'bare' ? !inBareBpmRange(first) : !inBpmRange(first)) continue
    return record(first, null, match[0], confidence)
  }

  // A bracketed number, `Pain [140] Type Beat`, is a tempo only when it is the
  // single bracketed number in the text and sits in the producer range; `[808]`,
  // `[2026]` and `(Part 2)` never qualify, and neither does a second `[10]`.
  const bracketed = [...text.matchAll(/[[(]\s*(\d{1,4}(?:\.\d+)?)\s*[\])]/g)]
  if (bracketed.length === 1) {
    const value = Number(bracketed[0][1])
    if (inBareBpmRange(value)) return record(value, null, bracketed[0][0], 0.7)
  }

  return { bpm: null, altBpm: null }
}

const MODE_WORDS =
  'maj|major|majeur|ionian|min|minor|mineur|aeolian|aeol|dorian|phrygian|lydian|mixolydian|locrian'

/**
 * Reads key declarations in three shapes: explicit `key: X`, note+mode pairs,
 * and bare Camelot positions (`11A`).
 */
function parseKey(
  text: string,
  source: EvidenceSource,
  evidence: Evidence[]
): { key: string | null; camelot: string | null } {
  const fromCamelot = (camelot: string, matched: string, confidence: number, keyConfidence: number | null) => {
    const resolved = camelotToKey(camelot)
    if (!resolved) return null
    evidence.push({ field: 'camelot', value: camelot, source, matched: matched.trim(), confidence })
    if (keyConfidence != null) evidence.push({ field: 'key', value: resolved.key, source, matched: matched.trim(), confidence: keyConfidence })
    return { key: resolved.key, camelot }
  }

  // 1. Camelot, explicitly labelled.
  const labelledCamelot = firstMatch(text, /\bcamelot\s*[:=#]?\s*(1[0-2]|0?[1-9])\s*([AB])\b/i)
  if (labelledCamelot) {
    const found = fromCamelot(`${Number(labelledCamelot[1])}${labelledCamelot[2].toUpperCase()}`, labelledCamelot[0], 0.98, 0.9)
    if (found) return found
  }

  // 2. Explicit `key:` label, which may carry either a note name or a Camelot code.
  const labelledKey = firstMatch(
    text,
    new RegExp(`(?<![a-z])key\\s*[:=#\\-–]?\\s*(?:(1[0-2]|0?[1-9])([AB])(?![a-z\\d])|([A-G][#b♯♭]?)\\s*[-–—]?\\s*(${MODE_WORDS}|m)?(?![a-z\\d#♯♭]))`, 'i')
  )
  if (labelledKey) {
    if (labelledKey[1]) {
      const found = fromCamelot(`${Number(labelledKey[1])}${labelledKey[2].toUpperCase()}`, labelledKey[0], 0.96, 0.92)
      if (found) return found
    } else if (labelledKey[4]) {
      const note = labelledKey[3]
      const modeRaw = labelledKey[4]
      // A lone `m` keeps its case even under the case-insensitive label: `m` is minor, `M` major.
      const mode = modeRaw === 'm' ? 'minor' : modeRaw === 'M' ? 'major' : normalizeMode(modeRaw)
      const key = mode ? formatKey(note, mode === 'modal' ? modeRaw : mode) : null
      if (key) {
        evidence.push({ field: 'key', value: key, source, matched: labelledKey[0].trim(), confidence: 0.96 })
        return { key, camelot: mode && mode !== 'modal' ? camelotFor(note, mode) : null }
      }
    }
  }

  // 2b. `in the key of G`, `key of F# minor`, `key of B flat`. The note must be
  //     a capital letter (`key of a lifetime` is prose); no mode means major.
  const keyOf = findMatch(
    text,
    new RegExp(`(?<![a-z])key\\s+of\\s+([A-G])(?:([#b♯♭])|[\\s-]+(sharp|flat))?(?:\\s*[-–—]?\\s*(${MODE_WORDS}|m))?(?![a-z\\d#♯♭])`, 'i'),
    (match) => /[A-G]/.test(match[1])
  )
  if (keyOf) {
    const accidental = keyOf[2] ?? (keyOf[3] ? (keyOf[3].toLowerCase() === 'sharp' ? '#' : 'b') : '')
    const note = `${keyOf[1]}${accidental}`
    const modeRaw = keyOf[4]
    const mode = modeRaw == null ? 'major' : modeRaw === 'm' ? 'minor' : modeRaw === 'M' ? 'major' : normalizeMode(modeRaw)
    const key = mode ? formatKey(note, mode === 'modal' ? modeRaw : mode) : null
    if (key) {
      evidence.push({ field: 'key', value: key, source, matched: keyOf[0].trim(), confidence: modeRaw == null ? 0.85 : 0.94 })
      return { key, camelot: mode && mode !== 'modal' ? camelotFor(note, mode) : null }
    }
  }

  // 2c. Spelled accidentals: `C sharp minor`, `B-flat major`. As below, a
  //     lowercase `a` is the article (`a sharp minor turn` is prose).
  const spelled = findMatch(
    text,
    new RegExp(`${LEAD}([A-G])[\\s-]*(sharp|flat)\\s*[-–—]?\\s*(${MODE_WORDS})(?![a-z\\d])`, 'i'),
    (match) => match[1] !== 'a'
  )
  if (spelled) {
    const note = `${spelled[1].toUpperCase()}${spelled[2].toLowerCase() === 'sharp' ? '#' : 'b'}`
    const key = formatKey(note, spelled[3])
    if (key) {
      const mode = normalizeMode(spelled[3])
      evidence.push({ field: 'key', value: key, source, matched: spelled[0].trim(), confidence: 0.9 })
      return { key, camelot: mode && mode !== 'modal' ? camelotFor(note, mode) : null }
    }
  }

  // 3. Bare note + mode, e.g. `F# minor` or `Cmaj`. A lowercase `a` set apart by
  //    a space is the English article (`a minor setback`), never a key.
  const noteMode = findMatch(
    text,
    new RegExp(`${LEAD}([A-G])([#b♯♭]?)(\\s*[-–—]?\\s*)(${MODE_WORDS})(?![a-z\\d])`, 'i'),
    (match) => !(match[1] === 'a' && !match[2] && match[3].length > 0)
  )
  if (noteMode) {
    const key = formatKey(`${noteMode[1]}${noteMode[2]}`, noteMode[4])
    if (key) {
      const mode = normalizeMode(noteMode[4])
      evidence.push({ field: 'key', value: key, source, matched: noteMode[0].trim(), confidence: 0.9 })
      return {
        key,
        camelot: mode && mode !== 'modal' ? camelotFor(`${noteMode[1]}${noteMode[2]}`, mode) : null
      }
    }
  }

  // 4. Compact form: `F#m`, `Am`, `[CM]`. Without an accidental these are also
  //    words (`Am I`, `DM me`, `10 AM`), so context decides — see compactAccepted.
  const compact = findMatch(
    text,
    /(?<=^|[\s[\](){}\-–—|,_:=/#•·;+~])([A-G])([#b♯♭]?)(m|M)(?![A-Za-z\d#♯♭'’])/,
    (match) => compactAccepted(text, match.index ?? 0, (match.index ?? 0) + match[0].length, match[2], match[3])
  )
  if (compact) {
    const mode = compact[3] === 'm' ? 'minor' : 'major'
    const key = formatKey(`${compact[1]}${compact[2]}`, mode)
    if (key) {
      evidence.push({ field: 'key', value: key, source, matched: compact[0].trim(), confidence: 0.72 })
      return { key, camelot: camelotFor(`${compact[1]}${compact[2]}`, mode) }
    }
  }

  // 5. Bare Camelot position. Lowest confidence — could be anything, so it is
  //    only accepted when the token stands alone between separators or at an edge.
  const bareCamelot = firstMatch(text, new RegExp(`${LEAD}(1[0-2]|0?[1-9])([AB])(?=$|[\\s)\\]|\\-–—_,/;:•·])`))
  if (bareCamelot) {
    const found = fromCamelot(`${Number(bareCamelot[1])}${bareCamelot[2]}`, bareCamelot[0], 0.6, null)
    if (found) return found
  }

  return { key: null, camelot: null }
}

const TOKEN_SEPARATOR = String.raw`[\r\n[\](){}|\-–—_/,;:=•·~+]`
const SEPARATED_BEFORE = new RegExp(`(?:^|${TOKEN_SEPARATOR})[ \\t]*$`)
const SEPARATED_AFTER = new RegExp(`^[ \\t]*(?:$|${TOKEN_SEPARATOR})`)
const BPM_BEFORE = /\d\s*bpm[\s\-–—_|,:/]*$/i
const BPM_AFTER = /^[\s\-–—_|,:/]*\d{2,3}(?:\.\d+)?\s*bpm(?![a-z])/i

/**
 * Decides whether a compact key token is a key rather than a word.
 *
 * With an accidental (`F#m`, `Bbm`) it is unambiguous. Otherwise it must stand
 * next to a tempo (`140 BPM Am`) or be set apart by separators on both sides
 * (`- Am -`, `[Gm]`, a whole tag). A bare `M` for major (`AM`, `DM`, `FM`) is
 * common English, so it additionally needs brackets, a tempo, or the whole text.
 */
function compactAccepted(text: string, start: number, end: number, accidental: string, mode: string): boolean {
  if (accidental) return true
  const before = text.slice(0, start)
  const after = text.slice(end)
  if (BPM_BEFORE.test(before) || BPM_AFTER.test(after)) return true
  if (mode === 'M') return (/[[(]\s*$/.test(before) && /^\s*[\])]/.test(after)) || (!before.trim() && !after.trim())
  return SEPARATED_BEFORE.test(before) && SEPARATED_AFTER.test(after)
}

/** Reads detune declarations in cents, semitones, or absolute tuning. */
function parseDetune(
  text: string,
  source: EvidenceSource,
  evidence: Evidence[]
): { detune: number | null; tuning: string | null } {
  const explicitTuning = firstMatch(text, /\b(?:tuning\s*[:=]?\s*)?A\s*=\s*(\d{3}(?:\.\d+)?)\s*hz\b/i)
  if (explicitTuning) {
    const hz = Number(explicitTuning[1])
    if (Number.isFinite(hz) && hz >= 380 && hz <= 500) {
      const cents = Math.round(hzToCents(hz) * 10) / 10
      const label = `A=${explicitTuning[1]}Hz`
      evidence.push({
        field: 'tuning',
        value: label,
        source,
        matched: explicitTuning[0].trim(),
        confidence: 0.96
      })
      evidence.push({
        field: 'detune',
        value: formatCents(cents),
        source,
        matched: explicitTuning[0].trim(),
        confidence: 0.9
      })
      return { detune: cents, tuning: label }
    }
  }

  const patterns: { pattern: RegExp; toCents: (raw: string, unit: string | undefined) => number; confidence: number }[] = [
    {
      pattern: /\bdetun(?:e|ed)\s*(?:by\s*)?([+-]?\d+(?:\.\d+)?)\s*(cents?|st|semitones?|half[\s-]?steps?)?/i,
      toCents: (raw, unit) => convertToCents(raw, unit),
      confidence: 0.94
    },
    {
      pattern: new RegExp(`${LEAD}([+-]?\\d+(?:\\.\\d+)?)\\s*cents?(?![a-z])`, 'i'),
      toCents: (raw) => Number(raw),
      confidence: 0.9
    },
    {
      // A bare `st` needs a sign: unsigned it is an ordinal (`1st`, `21st`).
      pattern: new RegExp(`${LEAD}([+-]\\d+(?:\\.\\d+)?\\s*st|[+-]?\\d+(?:\\.\\d+)?\\s*(?:semitones?|half[\\s-]?steps?))(?![a-z])`, 'i'),
      toCents: (raw) => Number.parseFloat(raw) * 100,
      confidence: 0.84
    }
  ]

  for (const { pattern, toCents, confidence } of patterns) {
    const match = firstMatch(text, pattern)
    if (!match) continue
    const cents = toCents(match[1], match[2])
    if (!Number.isFinite(cents) || Math.abs(cents) > 1200) continue
    const rounded = Math.round(cents * 10) / 10
    evidence.push({
      field: 'detune',
      value: formatCents(rounded),
      source,
      matched: match[0].trim(),
      confidence
    })
    return { detune: rounded, tuning: null }
  }

  return { detune: null, tuning: null }
}

function convertToCents(raw: string, unit: string | undefined): number {
  const value = Number(raw)
  if (!Number.isFinite(value)) return Number.NaN
  if (!unit) return value
  const normalized = unit.toLowerCase()
  if (normalized.startsWith('cent')) return value
  if (normalized.startsWith('st') || normalized.startsWith('semitone') || normalized.startsWith('half')) {
    return value * 100
  }
  return value
}

/** Reads the producer credit from the usual `prod. by X` shapes. */
function parseProducer(
  text: string,
  source: EvidenceSource,
  evidence: Evidence[]
): string | null {
  const patterns: { pattern: RegExp; confidence: number }[] = [
    { pattern: /\bprod(?:\.|uced)?\s*by\s*[:\-]?\s*@?([\p{L}\p{N}][\p{L}\p{N}_.\-&' ]{0,48})/iu, confidence: 0.95 },
    { pattern: /\bproduced\s*by\s*[:\-]?\s*@?([\p{L}\p{N}][\p{L}\p{N}_.\-&' ]{0,48})/iu, confidence: 0.95 },
    { pattern: /\bbeat\s*by\s*[:\-]?\s*@?([\p{L}\p{N}][\p{L}\p{N}_.\-&' ]{0,48})/iu, confidence: 0.9 },
    { pattern: /\bprod\.?\s*[:\-]\s*@?([\p{L}\p{N}][\p{L}\p{N}_.\-&' ]{0,48})/iu, confidence: 0.85 },
    // `prod. NAME` / `prod NAME` with neither "by" nor a colon is just as common
    // as the labelled forms, so it is accepted last and at lower confidence.
    { pattern: /\bprod(?:\.|uced)?\s+@?([\p{L}\p{N}][\p{L}\p{N}_.\-&' ]{0,48})/iu, confidence: 0.8 }
  ]

  for (const { pattern, confidence } of patterns) {
    const match = firstMatch(text, pattern)
    if (!match) continue
    const cleaned = trimTrailingNoise(match[1])
    if (cleaned.length === 0) continue
    evidence.push({
      field: 'producer',
      value: cleaned,
      source,
      matched: match[0].trim(),
      confidence
    })
    return cleaned
  }

  return null
}

/** Strips tempo/key/bracket debris that a greedy capture may have swallowed. */
function trimTrailingNoise(value: string): string {
  let out = value
  // Cut at the first bracket, pipe, or separator that usually ends a credit.
  out = out.split(/[[\]()|]|\s{2,}/)[0] ?? out
  // Cut before any trailing metadata phrase.
  out = out.replace(
    /\s*(?:\d{2,3}\s*bpm|bpm\s*[:=]?\s*\d{2,3}|key\s*[:=]|[A-G][#b]?\s*(?:maj|min|major|minor)\b|\d+\s*cents?\b).*$/i,
    ''
  )
  // Drop a trailing "type beat" / year / "free" descriptor.
  out = out.replace(/\s+(?:type\s*beat|instrumental|beat)\b.*$/i, '')
  out = out.replace(/\s*\b(?:19|20)\d{2}\b\s*$/g, '')
  return out.replace(/[\s\-–—_.]+$/g, '').trim()
}

function parseGenre(
  text: string,
  source: EvidenceSource,
  evidence: Evidence[]
): string | null {
  for (const { pattern, label } of GENRE_KEYWORDS) {
    if (pattern.test(text)) {
      const matched = firstMatch(text, pattern)
      evidence.push({
        field: 'genre',
        value: label,
        source,
        matched: matched?.[0].trim() ?? label,
        confidence: 0.7
      })
      return label
    }
  }
  return null
}

/** A quoted beat name, with each opening quote closed by its own partner. */
const QUOTED_TITLE = /“([^“”]{2,90})”|"([^"]{2,90})"|«([^«»]{2,90})»|‘([^‘’]{2,90})’|„([^„“”]{2,90})[“”]/

/** Extracts a display title, preferring an explicitly quoted beat name. */
export function extractTitle(rawTitle: string): string {
  const quoted = firstMatch(rawTitle, QUOTED_TITLE)
  if (quoted) {
    const inner = (quoted.slice(1).find((group) => group != null) ?? '').replace(/\s+/g, ' ').trim()
    if (inner.length >= 2) return stripTitleSuffix(inner)
  }

  let out = rawTitle
  // Remove bracketed metadata groups.
  out = out.replace(/[[({][^\])}]*[\])}]/g, ' ')
  // Remove producer credits, including `@handle` credits.
  out = out.replace(/\bprod(?:\.|uced)?\s*(?:by)?\s*[:\-]?\s*@?[\p{L}\p{N}][\p{L}\p{N}_.\-&' ]*/giu, ' ')
  // Tempo, key and tuning declarations belong in metadata, not in the name.
  out = out.replace(/\b(?:tuning\s*[:=]?\s*)?A\s*=\s*\d{3}(?:\.\d+)?\s*hz\b/gi, ' ')
  out = out.replace(
    /\b(?:key|camelot)\s*[:=#]?\s*[A-Ga-g0-9#b]{1,6}(?:\s*(?:maj|min|major|minor))?\b/gi,
    ' '
  )
  out = out.replace(/(?:[+-]?\d+(?:\.\d+)?\s*(?:cents?|semitones?)|[+-]\d+(?:\.\d+)?\s*st)\b/gi, ' ')
  out = out.replace(/\b\d{2,3}(?:\.\d+)?\s*\/\s*\d{2,3}(?:\.\d+)?\b/g, ' ')
  out = out.replace(/\b\d{2,3}(?:\.\d+)?\s*bpm\b/gi, ' ')
  out = out.replace(/\bbpm\s*[:=]?\s*\d{2,3}(?:\.\d+)?/gi, ' ')
  out = out.replace(/\bbpm\b/gi, ' ')
  // Remove the trailing descriptor that every type-beat upload carries.
  out = out.replace(/\bfree\s*(?:for|4)\s*profit\b/gi, ' ')
  out = out.replace(/\b(?:free|type|instrumental|beat|remake|flip)\b/gi, ' ')
  out = out.replace(/\b(?:19|20)\d{2}\b/g, ' ')
  // Collapse runs of separators left behind by the removals above.
  out = out.replace(/(?:\s*[|\-–—]\s*){2,}/g, ' - ')
  out = out.replace(/[|\-–—]\s*$/g, ' ')
  out = out.replace(/\s{2,}/g, ' ').trim()
  out = out.replace(/^[\s\-–—_|]+|[\s\-–—_|]+$/g, '')
  return out.length >= 2 ? out : rawTitle.trim()
}

function stripTitleSuffix(value: string): string {
  return value
    .replace(/\s*\b(?:type|instrumental|freestyle)\s*beat\b.*$/i, '')
    .replace(/\s*[\[(].*$/, '')
    .replace(/[\s\-–—_]+$/g, '')
    .trim()
}

/**
 * Parses one text source into metadata values plus evidence.
 * Later sources do not overwrite earlier ones; precedence is handled by the
 * caller through source ordering.
 */
export function parseText(text: string, source: EvidenceSource): TextParseOutput {
  const evidence: Evidence[] = []
  const values: MetadataValues = {}

  const { bpm, altBpm } = parseBpm(text, source, evidence)
  if (bpm != null) values.bpm = bpm
  if (altBpm != null) values.altBpm = altBpm

  const { key, camelot } = parseKey(text, source, evidence)
  if (key) values.key = key
  if (camelot) values.camelot = camelot

  const { detune, tuning } = parseDetune(text, source, evidence)
  if (detune != null) values.detune = detune
  if (tuning) values.tuning = tuning

  const producer = parseProducer(text, source, evidence)
  if (producer) values.producer = producer

  const genre = parseGenre(text, source, evidence)
  if (genre) values.genre = genre

  return { values, evidence }
}

/** Parses every available source, in descending order of trust. */
export function parseDeclared(sources: ParseSources): ParseOutput {
  const values: MetadataValues = {}
  const evidence: Evidence[] = []
  const bySource: SourceValues = { title: {}, description: {}, filename: {} }

  // The video title is the strongest human statement about a track, then the
  // description, then the filename. (A Sonic-generated filename is derived from
  // the title anyway, so it adds nothing when the title is present.)
  if (sources.title) {
    const result = parseText(sources.title, 'title')
    const title = extractTitle(sources.title)
    if (title) result.values.title = title
    bySource.title = result.values
    mergeMissing(values, result.values)
    evidence.push(...result.evidence)
  }

  if (sources.description) {
    const result = parseText(sources.description, 'description')
    bySource.description = result.values
    mergeMissing(values, result.values)
    evidence.push(...result.evidence)
  }

  if (sources.filename) {
    const stem = sources.filename.replace(/\.[a-z0-9]{2,5}$/i, '')
    const result = parseText(stem, 'filename')
    if (!result.values.title) result.values.title = stem.trim()
    bySource.filename = result.values
    mergeMissing(values, result.values)
    evidence.push(...result.evidence)
  }

  if (sources.title) {
    const title = extractTitle(sources.title)
    if (title) values.title = title
  }

  return { values, evidence, bySource }
}

function mergeMissing(target: MetadataValues, source: MetadataValues): void {
  for (const key of Object.keys(source) as (keyof BeatMetadata)[]) {
    if (target[key] == null || target[key] === '') {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      ;(target as any)[key] = source[key]
    }
  }
}

/** Declared text wins over embedded tags, field by field. */
/**
 * Fields reconciled across evidence layers.
 *
 * Authority order is manual override → declared text → embedded tag → audio
 * estimate → whatever the field already held. Declared text and embedded tags
 * are statements a human made about the track; an acoustic estimate is
 * inference. Inference fills gaps but never overrides a statement — when they
 * disagree the conflict is recorded and offered to the producer instead.
 */
export const RECONCILED_FIELDS: MetadataField[] = [
  'title',
  'producer',
  'bpm',
  'altBpm',
  'key',
  'camelot',
  'detune',
  'tuning',
  'genre'
]

export interface ReconcileInput {
  declared?: MetadataValues
  embedded?: MetadataValues
  analyzed?: MetadataValues
  /** Fields the producer set by hand. These win outright. */
  overrides?: MetadataField[]
  /** The existing final layer, so an already-decided value is never dropped. */
  previousFinal?: Partial<BeatMetadata>
}

export interface ReconcileOutput {
  suggested: MetadataValues
  final: BeatMetadata
  conflicts: MetadataConflict[]
}

function present(value: unknown): boolean {
  return value != null && value !== ''
}

export type FieldOrigin = 'manual' | 'title' | 'description' | 'filename' | 'embedded' | 'audio' | 'legacy' | 'none'

export interface FieldDecision {
  value: MetadataValues[MetadataField] | null
  origin: FieldOrigin
  resetValue: MetadataValues[MetadataField] | null
  resetOrigin: FieldOrigin
  measuredValue: MetadataValues[MetadataField] | null
}

/** Compares effective metadata with tags actually read back at publication. */
export function publishedTagStatus(current: Partial<BeatMetadata>, readback: MetadataValues | null | undefined):
  'unknown' | 'absent' | 'current' | 'out-of-sync' {
  if (readback == null) return 'unknown'
  const fields: Array<keyof Pick<BeatMetadata, 'title' | 'producer' | 'bpm' | 'key'>> = ['title', 'producer', 'bpm', 'key']
  if (fields.every(field => !present(readback[field]))) return 'absent'
  return fields.every(field => {
    const actual = readback[field]
    const expected = current[field]
    if (!present(expected) && !present(actual)) return true
    if (field === 'bpm') return typeof expected === 'number' && typeof actual === 'number' && Math.abs(expected - actual) < 0.01
    return String(actual ?? '').trim().toLowerCase() === String(expected ?? '').trim().toLowerCase()
  }) ? 'current' : 'out-of-sync'
}

/** The same evidence priority used by library reset and the preview label. */
export function decideMetadataField(field: MetadataField, input: {
  current: Partial<BeatMetadata>
  overrides: MetadataField[]
  sources: SourceValues
  embedded: MetadataValues
  analyzed: MetadataValues
}): FieldDecision {
  const layers: Array<{ origin: FieldOrigin; values: MetadataValues }> = [
    { origin: 'title', values: input.sources.title },
    { origin: 'description', values: input.sources.description },
    { origin: 'filename', values: input.sources.filename },
    { origin: 'embedded', values: input.embedded },
    { origin: 'audio', values: input.analyzed }
  ]
  // An alternate tempo is only meaningful beside the tempo it came with.
  const anchor = layers.find(layer => present(layer.values[field === 'altBpm' ? 'bpm' : field]))
  const anchorValue = anchor?.values[field] ?? null
  const resetValue = field === 'altBpm' && !relatedAltBpm(anchor?.values.bpm, anchorValue) ? null : anchorValue
  const evidence = present(resetValue) ? anchor : undefined
  const measuredValue = input.analyzed[field] ?? null
  const current = input.current[field] ?? null
  if (input.overrides.includes(field)) {
    return { value: current, origin: 'manual', resetValue, resetOrigin: evidence?.origin ?? 'none', measuredValue }
  }
  // A pre-provenance library record can retain its effective value. Never
  // mislabel it as acoustic evidence merely because an analysis also exists.
  if (present(current) && !evidence) {
    return { value: current, origin: 'legacy', resetValue: null, resetOrigin: 'none', measuredValue }
  }
  if (present(current) && evidence && String(current) !== String(resetValue)) {
    return { value: current, origin: 'legacy', resetValue, resetOrigin: evidence.origin, measuredValue }
  }
  return { value: resetValue, origin: evidence?.origin ?? 'none', resetValue, resetOrigin: evidence?.origin ?? 'none', measuredValue }
}

/** Picks the effective value for one field under the authority order. */
function chooseField(field: MetadataField, input: ReconcileInput): MetadataValues[MetadataField] {
  if (input.overrides?.includes(field)) {
    const manual = input.previousFinal?.[field]
    return present(manual) ? manual : undefined
  }

  // The alternate tempo comes from whichever layer supplied the tempo itself, so
  // a declared 140 is never paired with an estimate's 191.2 alternate.
  const anchor = field === 'altBpm' ? 'bpm' : field
  const layers = field === 'altBpm' && input.overrides?.includes('bpm') ? [] : [input.declared, input.embedded, input.analyzed]
  const layer = layers.find(candidate => present(candidate?.[anchor]))
  const chosen = layer ? layer[field] : input.previousFinal?.[field]
  return present(chosen) ? chosen : undefined
}

/** True when `alt` is a half- or double-time reading of `bpm`. */
function relatedAltBpm(bpm: unknown, alt: unknown): boolean {
  return typeof bpm === 'number' && typeof alt === 'number' && isHalfOrDoubleTempo(alt, bpm)
}

/**
 * Keeps `key` and `camelot` in lockstep in both directions.
 *
 * A Camelot code attached to a different or unknown key is worse than no code at
 * all, so the pair is always re-derived from whichever side is authoritative.
 * A manually edited side always wins — even when it is unusable, because a typo
 * must not be silently replaced by the other side's older value.
 */
function reconcileKeyPair(values: MetadataValues, overrides: MetadataField[]): void {
  const keyIsManual = overrides.includes('key')
  const camelotIsManual = overrides.includes('camelot')

  const rawKey = typeof values.key === 'string' ? values.key.trim() : ''
  const rawCamelot = typeof values.camelot === 'string' ? values.camelot.trim() : ''

  const parsedKey = rawKey.length > 0 ? parseKeyString(rawKey) : null
  const parsedFromCamelot = rawCamelot.length > 0 ? parseKeyString(rawCamelot) : null

  if (keyIsManual && !camelotIsManual) {
    values.key = rawKey.length > 0 ? rawKey : null
    values.camelot = parsedKey ? parsedKey.camelot : null
    return
  }

  if (camelotIsManual && !keyIsManual) {
    values.camelot = rawCamelot.length > 0 ? rawCamelot : null
    values.key = parsedFromCamelot ? parsedFromCamelot.key : null
    return
  }

  // Neither side manual, or both: prefer whichever side parses, key first.
  if (parsedKey) {
    values.key = parsedKey.key
    values.camelot = parsedKey.camelot
    return
  }

  if (parsedFromCamelot) {
    values.key = parsedFromCamelot.key
    values.camelot = parsedFromCamelot.camelot
    return
  }

  values.key = rawKey.length > 0 ? rawKey : null
  values.camelot = null
}

/**
 * An alternate tempo with no primary tempo to alternate from is meaningless, and
 * one that is not half or double the tempo is not an alternate. A hand-typed
 * alternate is kept unless it merely repeats the tempo.
 */
function reconcileTempoPair(values: MetadataValues, overrides: MetadataField[]): void {
  if (!present(values.bpm)) {
    values.altBpm = null
    return
  }
  if (!present(values.altBpm)) return
  if (Number(values.altBpm) === Number(values.bpm)) {
    values.altBpm = null
    return
  }
  if (!overrides.includes('altBpm') && !relatedAltBpm(Number(values.bpm), Number(values.altBpm))) values.altBpm = null
}

/** Single reconciliation entry point used by every metadata mutation path. */
export function reconcile(input: ReconcileInput): ReconcileOutput {
  const suggested: MetadataValues = {}

  for (const field of RECONCILED_FIELDS) {
    const chosen = chooseField(field, input)
    if (chosen !== undefined) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      ;(suggested as any)[field] = chosen
    }
  }

  reconcileKeyPair(suggested, input.overrides ?? [])
  reconcileTempoPair(suggested, input.overrides ?? [])

  const final: BeatMetadata = {
    ...emptyMetadata(),
    ...suggested,
    title: typeof suggested.title === 'string' ? suggested.title : ''
  }

  return { suggested, final, conflicts: diffConflicts(input) }
}


/** Two values agree if they are equal, or numerically within a rounding whisker. */
function sameValue(a: unknown, b: unknown): boolean {
  const na = Number(a)
  const nb = Number(b)
  if (Number.isFinite(na) && Number.isFinite(nb) && typeof a !== 'boolean' && typeof b !== 'boolean') {
    // Tempo estimates are rarely exact; treat sub-BPM differences as agreement.
    return Math.abs(na - nb) < 1.5
  }
  return String(a).trim().toLowerCase() === String(b).trim().toLowerCase()
}

/**
 * Records disagreements across all three evidence layers.
 *
 * These are kept for inspection rather than resolved by deletion: the producer
 * decides. Nothing here changes the reconciled value.
 */
export function diffConflicts(input: ReconcileInput): MetadataConflict[] {
  const conflicts: MetadataConflict[] = []
  const comparable: MetadataField[] = ['bpm', 'key', 'genre', 'producer']

  for (const field of comparable) {
    const declaredValue = input.declared?.[field]
    const embeddedValue = input.embedded?.[field]
    const analyzedValue = input.analyzed?.[field]

    const hasDeclared = present(declaredValue)
    const hasEmbedded = present(embeddedValue)
    const hasAnalyzed = present(analyzedValue)

    if (hasDeclared && hasAnalyzed && !sameValue(declaredValue, analyzedValue)) {
      conflicts.push({
        field,
        declared: String(declaredValue),
        embedded: hasEmbedded ? String(embeddedValue) : null,
        analyzed: String(analyzedValue),
        note: 'Source text and the audio estimate disagree. The declared value was used.'
      })
      continue
    }

    if (!hasDeclared && hasEmbedded && hasAnalyzed && !sameValue(embeddedValue, analyzedValue)) {
      conflicts.push({
        field,
        declared: null,
        embedded: String(embeddedValue),
        analyzed: String(analyzedValue),
        note: 'The container tag and the audio estimate disagree. The tag was used.'
      })
      continue
    }

    if (hasDeclared && hasEmbedded && !sameValue(declaredValue, embeddedValue)) {
      conflicts.push({
        field,
        declared: String(declaredValue),
        embedded: String(embeddedValue),
        analyzed: hasAnalyzed ? String(analyzedValue) : null,
        note: 'Source text and container tags disagree. The declared value was used.'
      })
    }
  }

  return conflicts
}

export interface CreateDraftInput {
  declared?: MetadataValues
  embedded?: MetadataValues
  analyzed?: MetadataValues
  /** Per-source declared values, so title/description/tags stay cross-checkable. */
  sources?: SourceValues
  evidence?: Evidence[]
  audioEvidence?: AudioEvidence[]
  overrides?: MetadataField[]
  analysis?: AudioAnalysis | null
}

/** Computes the declared-vs-measured verification for the current state. */
function attachVerification(draft: MetadataDraft): MetadataDraft {
  return {
    ...draft,
    verification: verifyMetadata({
      sources: draft.sources,
      embedded: draft.embedded,
      analyzed: draft.analyzed,
      analysis: draft.analysis,
      final: draft.final,
      overrides: draft.overrides
    })
  }
}

const EMPTY_SOURCES: SourceValues = { title: {}, description: {}, filename: {} }

/** Builds a complete draft from whatever evidence layers are available. */
export function createDraft(input: CreateDraftInput = {}): MetadataDraft {
  const declared = input.declared ?? {}
  const embedded = input.embedded ?? {}
  const analyzed = input.analyzed ?? {}
  const overrides = input.overrides ?? []

  const { suggested, final, conflicts } = reconcile({ declared, embedded, analyzed, overrides })

  return attachVerification({
    declared,
    embedded,
    analyzed,
    suggested,
    final,
    sources: input.sources ?? EMPTY_SOURCES,
    evidence: input.evidence ?? [],
    audioEvidence: input.audioEvidence ?? [],
    conflicts,
    verification: null,
    overrides,
    analysis: input.analysis ?? null
  })
}

/**
 * Applies a single producer edit to the final layer.
 *
 * Only the edited field is recorded as overridden. That is the fix for the old
 * global `dirty` flag, which froze every field as soon as any one was touched —
 * so typing a new title permanently blocked an audio estimate from landing on an
 * untouched BPM or key.
 */
export function applyFinalEdit(
  draft: MetadataDraft,
  field: MetadataField,
  value: string | number | null
): MetadataDraft {
  const final: BeatMetadata = { ...draft.final }
  const next = value === '' ? null : value

  switch (field) {
    case 'title':
      final.title = typeof next === 'string' ? next : ''
      break
    case 'producer':
    case 'genre':
    case 'tuning':
      final[field] = typeof next === 'string' && next.trim().length > 0 ? next : null
      break
    case 'bpm':
    case 'altBpm':
    case 'detune':
      final[field] = typeof next === 'number' && Number.isFinite(next) ? next : null
      break
    case 'key':
    case 'camelot':
      final[field] = typeof next === 'string' && next.trim().length > 0 ? next.trim() : null
      break
    default:
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      ;(final as any)[field] = next
  }

  const overrides = draft.overrides.includes(field) ? draft.overrides : [...draft.overrides, field]

  // Re-derive the key/Camelot pair so clearing or retyping one side can never
  // leave a Camelot code attached to a different or unknown key.
  reconcileKeyPair(final as unknown as MetadataValues, overrides)
  reconcileTempoPair(final as unknown as MetadataValues, overrides)

  return attachVerification({ ...draft, final, overrides })
}

type EvidencePatch = Partial<
  Pick<
    MetadataDraft,
    'declared' | 'embedded' | 'analyzed' | 'analysis' | 'audioEvidence' | 'evidence' | 'sources'
  >
>

/** Folds a new evidence layer in and re-reconciles. */
function applyLayer(draft: MetadataDraft, patch: EvidencePatch): MetadataDraft {
  const next: MetadataDraft = { ...draft, ...patch }
  const { suggested, final, conflicts } = reconcile({
    declared: next.declared,
    embedded: next.embedded,
    analyzed: next.analyzed,
    overrides: next.overrides,
    previousFinal: draft.final
  })
  return attachVerification({ ...next, suggested, final, conflicts })
}

/** Folds a container-tag readback into the model. */
export function withEmbedded(draft: MetadataDraft, embedded: MetadataValues): MetadataDraft {
  return applyLayer(draft, { embedded })
}

/**
 * Folds an audio analysis into the model.
 *
 * The full analysis record and its audio evidence are retained so the result can
 * be explained and reproduced later; only the reconciled values reach `final`.
 */
export function withAnalyzed(
  draft: MetadataDraft,
  analyzed: MetadataValues,
  analysis: AudioAnalysis,
  audioEvidence: AudioEvidence[]
): MetadataDraft {
  return applyLayer(draft, { analyzed, analysis, audioEvidence })
}

/** Drops a manual override so evidence can take the field back over. */
export function clearOverride(draft: MetadataDraft, field: MetadataField): MetadataDraft {
  const overrides = draft.overrides.filter((entry) => entry !== field)
  // Blank the carried value for this one field only, so evidence wins it back.
  const carried = { ...draft.final, [field]: null } as Partial<BeatMetadata>

  const { suggested, final, conflicts } = reconcile({
    declared: draft.declared,
    embedded: draft.embedded,
    analyzed: draft.analyzed,
    overrides,
    previousFinal: carried
  })

  return attachVerification({ ...draft, overrides, suggested, final, conflicts })
}

/** Promotes analysed values into `final` as explicit producer decisions. */
export function adoptAnalyzed(draft: MetadataDraft, fields: MetadataField[]): MetadataDraft {
  let next = draft
  for (const field of fields) {
    const value = draft.analyzed[field]
    if (!present(value)) continue
    next = applyFinalEdit(next, field, value as string | number)
  }
  return next
}

/** Builds the ordered audio-evidence list for an analysis run. */
export function buildAudioEvidence(analysis: AudioAnalysis): AudioEvidence[] {
  const evidence: AudioEvidence[] = []
  const { tempo, key } = analysis

  if (tempo.status === 'estimated' && tempo.bpm != null) {
    evidence.push({
      field: 'bpm',
      value: formatBpm(tempo.bpm),
      analyzer: analysis.engine,
      quality: tempo.confidence,
      alternatives: tempo.alternatives
        .filter((candidate) => candidate.relation !== 'primary')
        .map((candidate) => ({ value: formatBpm(candidate.bpm), quality: candidate.strength })),
      inputId: analysis.inputId,
      analyzedAt: analysis.analyzedAt,
      note: tempo.warning
    })
  }

  if (key.status === 'estimated' && key.key) {
    evidence.push({
      field: 'key',
      value: key.key,
      analyzer: analysis.engine,
      quality: key.confidence,
      alternatives: key.alternatives.map((candidate) => ({
        value: candidate.key,
        quality: candidate.correlation
      })),
      inputId: analysis.inputId,
      analyzedAt: analysis.analyzedAt,
      note: key.warning
    })
  }

  return evidence
}
