/**
 * Cross-checks what a source *claimed* against what the audio actually measures.
 *
 * The video title, the video description, the filename and any embedded tags are
 * evaluated separately — not merged into one "declared" blob — so a producer can
 * see that the title said 140 BPM while the description said 144 and the audio
 * measured 128.
 *
 * Pure computation: no Node, no DOM, no I/O.
 */

import type {
  AgreementVerdict,
  BeatMetadata,
  CandidateOrigin,
  FieldVerification,
  MetadataField,
  MetadataValues,
  MetadataVerification,
  SourceValues,
  VerificationCandidate
} from './domain'
import type { AudioAnalysis } from './analysis'
import { formatBpm, formatCents } from './format'
import { parseKeyString } from './music'

/** Tempo claims within this many BPM are treated as the same tempo. */
export const BPM_MATCH_TOLERANCE = 2
/** Beyond this the claim is treated as contradicting the measurement. */
export const BPM_CLOSE_TOLERANCE = 5
/** Tuning estimates are coarse, so detune gets a generous window. */
export const DETUNE_TOLERANCE = 15
/** Relative window for treating two tempos as half- or double-time of each other. */
export const HALF_DOUBLE_TOLERANCE = 0.03

/** True when `a` is half or double `b`, judged symmetrically on a log scale. */
export function isHalfOrDoubleTempo(a: number, b: number, tolerance = HALF_DOUBLE_TOLERANCE): boolean {
  if (!(a > 0) || !(b > 0)) return false
  return Math.abs(Math.abs(Math.log(a / b)) - Math.LN2) <= Math.log(1 + tolerance)
}

/** Signed distance in cents after folding whole semitones, in [-50, 50). */
function centsWithinSemitone(cents: number): number {
  return ((((cents + 50) % 100) + 100) % 100) - 50
}

export const ORIGIN_LABEL: Record<CandidateOrigin, string> = {
  title: 'Video title',
  description: 'Description',
  filename: 'Filename',
  embeddedTag: 'Embedded tag',
  audioEstimate: 'Audio estimate',
  manual: 'Manual'
}

export interface VerifyInput {
  sources: SourceValues
  embedded: MetadataValues
  analyzed: MetadataValues
  analysis: AudioAnalysis | null
  final: BeatMetadata
  overrides: MetadataField[]
}

interface Collected {
  candidates: VerificationCandidate[]
}

function numericOf(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'string' && value.trim().length > 0) {
    const parsed = Number(value)
    return Number.isFinite(parsed) ? parsed : null
  }
  return null
}

function pushCandidate(
  collected: Collected,
  origin: CandidateOrigin,
  value: unknown,
  render: (raw: unknown) => string = (raw) => String(raw)
): void {
  if (value == null || value === '') return
  collected.candidates.push({
    origin,
    label: ORIGIN_LABEL[origin],
    value: render(value),
    numeric: numericOf(value)
  })
}

/** True when two Camelot codes share a number but differ in letter. */
function isRelativeKey(a: string | null, b: string | null): boolean {
  if (!a || !b) return false
  return a.slice(0, -1) === b.slice(0, -1) && a.slice(-1) !== b.slice(-1)
}

function compareTempo(stated: number, measured: number): { verdict: AgreementVerdict; note: string } {
  const diff = Math.abs(stated - measured)

  if (diff <= BPM_MATCH_TOLERANCE) {
    return {
      verdict: 'match',
      note: `The stated ${formatBpm(stated)} BPM agrees with the audio (${formatBpm(measured)} BPM).`
    }
  }

  // A half- or double-time reading is musically the same tempo, so it is a
  // related result rather than a contradiction — but it is named explicitly.
  if (isHalfOrDoubleTempo(stated, measured)) {
    return {
      verdict: 'close',
      note: `The stated ${formatBpm(stated)} BPM matches the audio at half/double time (${formatBpm(measured)} BPM).`
    }
  }

  if (diff <= BPM_CLOSE_TOLERANCE) {
    return {
      verdict: 'close',
      note: `Close: the stated ${formatBpm(stated)} BPM is ${diff.toFixed(1)} BPM from the audio estimate of ${formatBpm(measured)} BPM.`
    }
  }

  return {
    verdict: 'mismatch',
    note: `The stated ${formatBpm(stated)} BPM disagrees with the audio estimate of ${formatBpm(measured)} BPM.`
  }
}

function compareKey(
  statedRaw: string,
  measuredRaw: string
): { verdict: AgreementVerdict; note: string } {
  const stated = parseKeyString(statedRaw)
  const measured = parseKeyString(measuredRaw)

  if (!stated || !measured) {
    return {
      verdict: statedRaw.trim().toLowerCase() === measuredRaw.trim().toLowerCase() ? 'match' : 'close',
      note: 'One of the key values is not in a recognised form, so the comparison is approximate.'
    }
  }

  if (stated.key === measured.key) {
    return {
      verdict: 'match',
      note: `The stated key (${stated.key}) agrees with the audio estimate.`
    }
  }

  if (isRelativeKey(stated.camelot, measured.camelot)) {
    return {
      verdict: 'close',
      note: `Relative major/minor ambiguity: the source says ${stated.key}, the audio suggests ${measured.key}.`
    }
  }

  if (stated.key.split(' ')[0] === measured.key.split(' ')[0]) {
    return {
      verdict: 'close',
      note: `Same tonic, different mode: the source says ${stated.key}, the audio suggests ${measured.key}.`
    }
  }

  return {
    verdict: 'mismatch',
    note: `The stated key (${stated.key}) disagrees with the audio estimate of ${measured.key}.`
  }
}

function compareDetune(stated: number, measured: number): { verdict: AgreementVerdict; note: string } {
  // Measured tuning is folded to ±50 cents, while a declared detune can span
  // whole semitones; only the offset within a semitone is comparable.
  const diff = Math.abs(centsWithinSemitone(stated - measured))
  if (diff <= DETUNE_TOLERANCE) {
    return {
      verdict: 'match',
      note: `The stated tuning (${formatCents(stated)}) is consistent with the analysed tuning (${formatCents(measured)}).`
    }
  }
  return {
    verdict: 'close',
    note: `The stated tuning (${formatCents(stated)}) differs from the analysed tuning (${formatCents(measured)}). Tuning estimates are approximate.`
  }
}

/** Collapses a field's candidates into a verdict. */
function judge(
  field: MetadataField,
  collected: Collected,
  statedValue: unknown,
  measuredValue: unknown,
  compare: (stated: string, measured: string) => { verdict: AgreementVerdict; note: string },
  effective: string | null
): FieldVerification {
  const statedCandidates = collected.candidates.filter(
    (candidate) => candidate.origin !== 'audioEstimate' && candidate.origin !== 'manual'
  )
  const hasMeasured = measuredValue != null && measuredValue !== ''

  let verdict: AgreementVerdict
  let note: string

  if (statedCandidates.length === 0 && !hasMeasured) {
    verdict = 'no-evidence'
    note = 'Neither the source nor the audio provided a value for this field.'
  } else if (statedCandidates.length === 0) {
    verdict = 'single-source'
    note = 'Only the audio provided a value; there was nothing in the source to check it against.'
  } else if (!hasMeasured) {
    verdict = 'single-source'
    note = 'Only the source provided a value; no audio estimate is available to verify it.'
  } else {
    const result = compare(String(statedValue), String(measuredValue))
    verdict = result.verdict
    note = result.note

    // Independent statements that contradict each other also weaken the verdict,
    // even when the primary one happens to agree with the audio.
    const distinct = new Set(statedCandidates.map((candidate) => candidate.value))
    if (distinct.size > 1 && verdict === 'match') {
      verdict = 'close'
      note = `${note} The sources disagree with each other: ${[...distinct].join(' vs ')}.`
    }
  }

  return { field, verdict, candidates: collected.candidates, effective, note }
}

/**
 * Compares every declared source and embedded tag against the audio estimate.
 *
 * Returns null when there is nothing to verify — no declared values and no
 * analysis — so callers can distinguish "verified, no issues" from "never run".
 */
export function verifyMetadata(input: VerifyInput): MetadataVerification | null {
  const hasAnything =
    input.analysis != null ||
    Object.values(input.sources).some((source) => Object.keys(source).length > 0) ||
    Object.keys(input.embedded).length > 0

  if (!hasAnything) return null

  const fields: FieldVerification[] = []

  // ---------------------------------------------------------------- tempo ----
  const tempoCandidates: Collected = { candidates: [] }
  pushCandidate(tempoCandidates, 'title', input.sources.title.bpm)
  pushCandidate(tempoCandidates, 'description', input.sources.description.bpm)
  pushCandidate(tempoCandidates, 'filename', input.sources.filename.bpm)
  pushCandidate(tempoCandidates, 'embeddedTag', input.embedded.bpm)
  pushCandidate(tempoCandidates, 'audioEstimate', input.analyzed.bpm)
  if (input.overrides.includes('bpm')) pushCandidate(tempoCandidates, 'manual', input.final.bpm)

  const statedTempo =
    input.sources.title.bpm ??
    input.sources.description.bpm ??
    input.sources.filename.bpm ??
    input.embedded.bpm ??
    null

  fields.push(
    judge(
      'bpm',
      tempoCandidates,
      statedTempo,
      input.analyzed.bpm,
      (stated, measured) => compareTempo(Number(stated), Number(measured)),
      input.final.bpm == null ? null : formatBpm(input.final.bpm)
    )
  )

  // ------------------------------------------------------------------ key ----
  const keyCandidates: Collected = { candidates: [] }
  pushCandidate(keyCandidates, 'title', input.sources.title.key)
  pushCandidate(keyCandidates, 'description', input.sources.description.key)
  pushCandidate(keyCandidates, 'filename', input.sources.filename.key)
  pushCandidate(keyCandidates, 'embeddedTag', input.embedded.key)
  pushCandidate(keyCandidates, 'audioEstimate', input.analyzed.key)
  if (input.overrides.includes('key')) pushCandidate(keyCandidates, 'manual', input.final.key)

  const statedKey =
    input.sources.title.key ??
    input.sources.description.key ??
    input.sources.filename.key ??
    input.embedded.key ??
    null

  fields.push(
    judge('key', keyCandidates, statedKey, input.analyzed.key, compareKey, input.final.key)
  )

  // --------------------------------------------------------------- detune ----
  const measuredTuning = input.analysis?.key.tuningCents ?? null
  const statedDetune = input.sources.title.detune ?? input.sources.description.detune ?? input.embedded.detune ?? null

  if (statedDetune != null || measuredTuning != null) {
    const detuneCandidates: Collected = { candidates: [] }
    pushCandidate(detuneCandidates, 'title', input.sources.title.detune, (raw) => formatCents(Number(raw)))
    pushCandidate(detuneCandidates, 'description', input.sources.description.detune, (raw) =>
      formatCents(Number(raw))
    )
    pushCandidate(detuneCandidates, 'embeddedTag', input.embedded.detune, (raw) => formatCents(Number(raw)))
    if (measuredTuning != null) {
      detuneCandidates.candidates.push({
        origin: 'audioEstimate',
        label: ORIGIN_LABEL.audioEstimate,
        value: formatCents(measuredTuning),
        numeric: measuredTuning
      })
    }

    fields.push(
      judge(
        'detune',
        detuneCandidates,
        statedDetune,
        measuredTuning,
        (stated, measured) => compareDetune(Number(stated), Number(measured)),
        input.final.detune == null ? null : formatCents(input.final.detune)
      )
    )
  }

  const summary = { match: 0, close: 0, mismatch: 0, unchecked: 0 }
  for (const field of fields) {
    if (field.verdict === 'match') summary.match += 1
    else if (field.verdict === 'close') summary.close += 1
    else if (field.verdict === 'mismatch') summary.mismatch += 1
    else summary.unchecked += 1
  }

  return { checkedAt: Date.now(), fields, summary }
}

/** Short label for a verdict, for compact UI. */
export const VERDICT_LABEL: Record<AgreementVerdict, string> = {
  match: 'Matches audio',
  close: 'Close to audio',
  mismatch: 'Disagrees with audio',
  'single-source': 'Unverified',
  'no-evidence': 'No data'
}
