/**
 * Producer-facing library tools: harmonic/tempo compatibility, duplicate
 * detection and the built-in smart views. Pure functions shared by main and
 * renderer; no Node or DOM dependencies.
 */

import type { LibraryBeat } from './domain'
import { camelotNeighbours, parseKeyString } from './music'
import { parseVideoUrl } from './url'

type CompatibilityBeat = Pick<LibraryBeat, 'id' | 'bpm' | 'key' | 'camelot'>

/** The Camelot code of a beat, from its stored code or its key spelling. */
export function camelotOf(beat: Pick<LibraryBeat, 'key' | 'camelot'>): string | null {
  const parsed = parseKeyString(beat.camelot) ?? parseKeyString(beat.key)
  return parsed?.camelot ?? null
}

/** Same position, one step either way round the wheel, and the relative major/minor. */
export function compatibleCamelots(camelot: string): string[] {
  const parsed = parseKeyString(camelot)
  if (!parsed?.camelot) return []
  return [parsed.camelot, ...camelotNeighbours(parsed.camelot)]
}

export interface CompatibilityOptions {
  /** Absolute BPM tolerance around the seed tempo (and its half/double). */
  bpmTolerance: number
  /** Also accept half and double time, e.g. 70 or 280 against 140. */
  includeHalfDouble: boolean
}

export interface CompatibilityCriteria {
  seedId: string
  /** Null when the seed has no key: key is then not a constraint. */
  camelots: string[] | null
  /** Inclusive tempo windows; null when the seed has no tempo. */
  tempoRanges: { min: number; max: number }[] | null
}

/** What a seed beat asks of a partner. Null when the seed has neither key nor tempo. */
export function compatibilityCriteria(seed: CompatibilityBeat, options: CompatibilityOptions): CompatibilityCriteria | null {
  const camelot = camelotOf(seed)
  const camelots = camelot ? compatibleCamelots(camelot) : null
  const tolerance = Math.max(0, Number.isFinite(options.bpmTolerance) ? options.bpmTolerance : 0)
  const tempos = seed.bpm != null && Number.isFinite(seed.bpm) && seed.bpm > 0
    ? (options.includeHalfDouble ? [seed.bpm, seed.bpm / 2, seed.bpm * 2] : [seed.bpm]) : null
  const tempoRanges = tempos?.map(tempo => ({ min: round(tempo - tolerance), max: round(tempo + tolerance) })) ?? null
  if (!camelots?.length && !tempoRanges) return null
  return { seedId: seed.id, camelots: camelots?.length ? camelots : null, tempoRanges }
}

const round = (value: number): number => Math.round(value * 100) / 100

/** Unknown key or tempo never matches a constraint the seed actually has. */
export function isCompatible(beat: CompatibilityBeat, criteria: CompatibilityCriteria): boolean {
  if (beat.id === criteria.seedId) return true
  if (criteria.camelots) {
    const camelot = camelotOf(beat)
    if (!camelot || !criteria.camelots.includes(camelot)) return false
  }
  if (criteria.tempoRanges) {
    if (beat.bpm == null) return false
    if (!criteria.tempoRanges.some(range => beat.bpm! >= range.min - 1e-9 && beat.bpm! <= range.max + 1e-9)) return false
  }
  return true
}

/** The seed first, then compatible beats in their existing order. */
export function findCompatible<T extends CompatibilityBeat>(seed: CompatibilityBeat, beats: T[], options: CompatibilityOptions): T[] {
  const criteria = compatibilityCriteria(seed, options)
  if (!criteria) return []
  const matches = beats.filter(beat => isCompatible(beat, criteria))
  const seedIndex = matches.findIndex(beat => beat.id === seed.id)
  if (seedIndex > 0) matches.unshift(...matches.splice(seedIndex, 1))
  return matches
}

// ------------------------------------------------------------------ duplicates

export type DuplicateReason = 'source' | 'audio'

export interface DuplicateGroup {
  /** Stable id: the first member's id in library order. */
  id: string
  /** Oldest first, so the default record to keep is `beatIds[0]`. */
  beatIds: string[]
  reasons: DuplicateReason[]
}

const identityCache = new Map<string, string | null>()

/** Provider plus media id, so watch, share and music links to one video agree. */
export function sourceIdentity(url: string | null | undefined): string | null {
  if (!url) return null
  const cached = identityCache.get(url)
  if (cached !== undefined) return cached
  // Stored links are judged as saved, whatever the current "Allow other sites" setting.
  const parsed = parseVideoUrl(url, { allowOtherSites: true })
  const identity = !parsed.ok ? null
    : parsed.provider && parsed.videoId ? `${parsed.provider}:${parsed.videoId}`
      : parsed.normalized ? parsed.normalized.toLowerCase() : null
  // Library updates re-run duplicate detection often; URL parsing is the cost.
  if (identityCache.size >= 50_000) identityCache.clear()
  identityCache.set(url, identity)
  return identity
}

type DuplicateBeat = Pick<LibraryBeat, 'id' | 'sourceUrl' | 'fingerprint' | 'addedAt'>

/**
 * Records that share a source link or identical audio content. Groups are
 * transitive: A shares a source with B and B shares audio with C makes one group.
 */
export function findDuplicateGroups(beats: DuplicateBeat[]): DuplicateGroup[] {
  const parent = new Map<string, string>()
  const find = (id: string): string => {
    let root = id
    while (parent.get(root) !== root) root = parent.get(root)!
    let node = id
    while (node !== root) { const next = parent.get(node)!; parent.set(node, root); node = next }
    return root
  }
  const reasons = new Map<string, Set<DuplicateReason>>()
  for (const beat of beats) parent.set(beat.id, beat.id)
  const link = (bucket: Map<string, string>, value: string | null, id: string, reason: DuplicateReason): void => {
    if (!value) return
    const first = bucket.get(value)
    if (!first) { bucket.set(value, id); return }
    for (const member of [first, id]) {
      const set = reasons.get(member) ?? new Set<DuplicateReason>()
      set.add(reason)
      reasons.set(member, set)
    }
    const a = find(first), b = find(id)
    if (a !== b) parent.set(b, a)
  }
  const bySource = new Map<string, string>()
  const byAudio = new Map<string, string>()
  for (const beat of beats) {
    link(bySource, sourceIdentity(beat.sourceUrl), beat.id, 'source')
    link(byAudio, typeof beat.fingerprint === 'string' && beat.fingerprint.length >= 16 ? beat.fingerprint : null, beat.id, 'audio')
  }
  const groups = new Map<string, DuplicateBeat[]>()
  for (const beat of beats) {
    const root = find(beat.id)
    const list = groups.get(root) ?? []
    list.push(beat)
    groups.set(root, list)
  }
  const out: DuplicateGroup[] = []
  for (const members of groups.values()) {
    if (members.length < 2) continue
    const ordered = [...members].sort((a, b) => a.addedAt - b.addedAt)
    const groupReasons = new Set<DuplicateReason>()
    for (const member of members) for (const reason of reasons.get(member.id) ?? []) groupReasons.add(reason)
    out.push({ id: members[0].id, beatIds: ordered.map(beat => beat.id), reasons: (['source', 'audio'] as const).filter(reason => groupReasons.has(reason)) })
  }
  return out
}

// ------------------------------------------------------------------ smart views

/** Built-in views live beside Favorites; they are computed, never stored as collections. */
export const RECENT_VIEW_ID = 'recently-added'
export const NEEDS_REVIEW_VIEW_ID = 'needs-review'
export const DUPLICATES_VIEW_ID = 'duplicates'
export const BUILT_IN_VIEW_IDS: readonly string[] = [RECENT_VIEW_ID, NEEDS_REVIEW_VIEW_ID, DUPLICATES_VIEW_ID]
export const RECENT_WINDOW_DAYS = 14

export function isRecentlyAdded(beat: Pick<LibraryBeat, 'addedAt'>, now: number, days = RECENT_WINDOW_DAYS): boolean {
  return Number.isFinite(beat.addedAt) && beat.addedAt >= now - days * 86_400_000
}

export type ReviewReason = 'no-bpm' | 'no-key' | 'bpm-disagreement' | 'key-disagreement'

/** Why a beat needs the producer's eye: a missing tempo or key, or source and audio disagreeing. */
export function reviewReasons(beat: Pick<LibraryBeat, 'bpm' | 'key' | 'camelot' | 'verification'>): ReviewReason[] {
  const reasons: ReviewReason[] = []
  if (beat.bpm == null) reasons.push('no-bpm')
  if (!beat.key && !beat.camelot) reasons.push('no-key')
  for (const field of beat.verification?.fields ?? []) {
    if (field.verdict !== 'mismatch') continue
    if (field.field === 'bpm') reasons.push('bpm-disagreement')
    if (field.field === 'key') reasons.push('key-disagreement')
  }
  return reasons
}

export const needsReview = (beat: Pick<LibraryBeat, 'bpm' | 'key' | 'camelot' | 'verification'>): boolean => reviewReasons(beat).length > 0
