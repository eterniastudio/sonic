/**
 * Canonical musical key handling: note normalisation, mode parsing and the
 * Camelot wheel. Pure functions, shared by main and renderer.
 */

const SHARP_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'] as const

/** Maps any accepted spelling of a pitch class onto a sharp-based name. */
const PITCH_CLASS: Record<string, string> = {
  c: 'C',
  'c#': 'C#',
  db: 'C#',
  d: 'D',
  'd#': 'D#',
  eb: 'D#',
  e: 'E',
  fb: 'E',
  'e#': 'F',
  f: 'F',
  'f#': 'F#',
  gb: 'F#',
  g: 'G',
  'g#': 'G#',
  ab: 'G#',
  a: 'A',
  'a#': 'A#',
  bb: 'A#',
  b: 'B',
  cb: 'B',
  'b#': 'C'
}

export type Mode = 'major' | 'minor'

/** Camelot position for every pitch class, split by mode. */
const CAMELOT_MINOR: Record<string, string> = {
  'G#': '1A',
  'D#': '2A',
  'A#': '3A',
  F: '4A',
  C: '5A',
  G: '6A',
  D: '7A',
  A: '8A',
  E: '9A',
  B: '10A',
  'F#': '11A',
  'C#': '12A'
}

const CAMELOT_MAJOR: Record<string, string> = {
  B: '1B',
  'F#': '2B',
  'C#': '3B',
  'G#': '4B',
  'D#': '5B',
  'A#': '6B',
  F: '7B',
  C: '8B',
  G: '9B',
  D: '10B',
  A: '11B',
  E: '12B'
}

/** Modal names that resolve to a plain major/minor tonic for Camelot purposes. */
const MODE_ALIASES: Record<string, Mode | 'modal'> = {
  maj: 'major',
  major: 'major',
  majeur: 'major',
  ionian: 'major',
  min: 'minor',
  minor: 'minor',
  mineur: 'minor',
  aeolian: 'minor',
  aeol: 'minor',
  dorian: 'modal',
  phrygian: 'modal',
  lydian: 'modal',
  mixolydian: 'modal',
  locrian: 'modal'
}

export function normalizePitchClass(raw: string): string | null {
  const key = raw.trim().toLowerCase().replace(/♯/g, '#').replace(/♭/g, 'b').replace(/\s+/g, '')
  return PITCH_CLASS[key] ?? null
}

export function normalizeMode(raw: string): Mode | 'modal' | null {
  return MODE_ALIASES[raw.trim().toLowerCase()] ?? null
}

export function camelotFor(pitchClass: string, mode: Mode): string | null {
  const note = normalizePitchClass(pitchClass)
  if (!note) return null
  return (mode === 'minor' ? CAMELOT_MINOR : CAMELOT_MAJOR)[note] ?? null
}

/** Formats a canonical key string, e.g. `F# minor`. */
export function formatKey(pitchClass: string, mode: string): string | null {
  const note = normalizePitchClass(pitchClass)
  if (!note) return null
  const normalizedMode = normalizeMode(mode)
  if (!normalizedMode) return null
  if (normalizedMode === 'modal') return `${note} ${mode.trim().toLowerCase()}`
  return `${note} ${normalizedMode}`
}

/** Reverse lookup: `11A` → `F# minor`. */
export function camelotToKey(camelot: string): { key: string; mode: Mode } | null {
  const match = /^(1[0-2]|[1-9])\s*([AB])$/i.exec(camelot.trim())
  if (!match) return null
  const target = `${match[1]}${match[2].toUpperCase()}`
  const mode: Mode = target.endsWith('A') ? 'minor' : 'major'
  const table = mode === 'minor' ? CAMELOT_MINOR : CAMELOT_MAJOR
  const pitch = Object.keys(table).find((note) => table[note] === target)
  if (!pitch) return null
  return { key: `${pitch} ${mode}`, mode }
}

/**
 * Parses a hand-typed key into its canonical form.
 *
 * Accepts every spelling a producer is likely to use — `F# minor`, `F#m`,
 * `f#min`, `F♯ Minor`, `F# aeolian`, a bare `11A` — and returns the single
 * canonical representation plus its Camelot code, so a value can never enter the
 * model as an unparseable string that leaves a stale Camelot behind.
 *
 * A bare note with no mode (`F#`) is rejected: major or minor is a coin flip and
 * guessing would be worse than asking.
 */
export function parseKeyString(raw: string | null | undefined): {
  key: string
  camelot: string | null
  mode: Mode | 'modal'
} | null {
  if (raw == null) return null
  const trimmed = raw.trim()
  if (trimmed.length === 0) return null

  // A Camelot code standing on its own.
  const camelotOnly = /^(1[0-2]|[1-9])\s*([AB])$/i.exec(trimmed)
  if (camelotOnly) {
    const code = `${camelotOnly[1]}${camelotOnly[2].toUpperCase()}`
    const resolved = camelotToKey(code)
    return resolved ? { key: resolved.key, camelot: code, mode: resolved.mode } : null
  }

  const match = /^([A-Ga-g])([#b♯♭]?)\s*[-–—]?\s*(maj|major|majeur|ionian|min|minor|mineur|aeolian|aeol|dorian|phrygian|lydian|mixolydian|locrian|m|M)?$/.exec(
    trimmed
  )
  if (!match) return null

  const note = normalizePitchClass(`${match[1]}${match[2]}`)
  if (!note) return null

  const modeRaw = match[3]
  if (!modeRaw) return null

  // Single-letter shorthands: `m` is minor, `M` is major.
  const alias = modeRaw === 'm' ? 'min' : modeRaw === 'M' ? 'maj' : modeRaw
  const mode = normalizeMode(alias)
  if (!mode) return null

  if (mode === 'modal') {
    return { key: `${note} ${alias.toLowerCase()}`, camelot: null, mode: 'modal' }
  }

  const key = formatKey(note, mode)
  if (!key) return null
  return { key, camelot: camelotFor(note, mode), mode }
}


/** Neighbouring Camelot positions, useful for suggesting compatible beats. */
export function camelotNeighbours(camelot: string): string[] {
  const match = /^(1[0-2]|[1-9])([AB])$/i.exec(camelot.trim())
  if (!match) return []
  const number = Number(match[1])
  const side = match[2].toUpperCase()
  const prev = number === 1 ? 12 : number - 1
  const next = number === 12 ? 1 : number + 1
  return [`${prev}${side}`, `${next}${side}`, `${number}${side === 'A' ? 'B' : 'A'}`]
}

/**
 * Converts an absolute tuning frequency into a cents offset from A440.
 * e.g. 432 Hz → -31.77 cents.
 */
export function hzToCents(hz: number): number {
  if (!Number.isFinite(hz) || hz <= 0) return 0
  return 1200 * Math.log2(hz / 440)
}

/** The pitch classes, exported so the UI can render a key picker. */
export const PITCH_CLASSES: readonly string[] = SHARP_NAMES

/** Every Camelot position in wheel order. */
export function camelotWheel(): { camelot: string; key: string }[] {
  const out: { camelot: string; key: string }[] = []
  for (let number = 1; number <= 12; number += 1) {
    for (const side of ['A', 'B'] as const) {
      const resolved = camelotToKey(`${number}${side}`)
      if (resolved) out.push({ camelot: `${number}${side}`, key: resolved.key })
    }
  }
  return out
}
