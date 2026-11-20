/**
 * Audio-analysis domain model.
 *
 * Deliberately separate from `domain.ts`'s text/tag metadata so that an acoustic
 * estimate never has to masquerade as a regex match. Nothing here touches Node
 * or the DOM — it crosses the process boundary like the rest of `shared/`.
 */

/**
 * Version of the analysis engine. Bump this whenever the DSP changes in a way
 * that would produce different numbers for the same input; it participates in
 * the analysis cache key.
 *
 * sonic-dsp/4: smoothed onset envelope, fractional multi-period tempo
 * refinement, 3:2 grouping and octave-accent checks, band-limited method
 * cross-check, non-finite samples treated as silence.
 *
 * sonic-dsp/5: half band-equalised onset envelope, metrical-consistency
 * candidate scoring (with octave candidates), producer octave folding into
 * 130–165 BPM, key-signature eligibility and a scale-residual gate for key,
 * half-size real FFT. See docs/DETECTION-2026-10-24.md.
 */
export const ANALYSIS_ENGINE = 'sonic-dsp/5'

/**
 * Version of the pipeline around the DSP: which windows are decoded
 * (`planWindows` in main/analysis/decode.ts) and how per-window results are
 * combined (main/analysis/merge.ts). Either can change a stored result without
 * any DSP change, so bump this when either changes. It participates in the
 * analysis cache key and is recorded on each analysis.
 */
export const ANALYSIS_PIPELINE = 'windows/1+merge/1'

/** Coarse status shown for a whole track. */
export type AnalysisStatus =
  | 'not-analyzed'
  | 'queued'
  | 'analyzing'
  /** Both tempo and key produced a reliable result. */
  | 'estimated'
  /** Exactly one of the two produced a reliable result. */
  | 'partial'
  /** Analysis ran but neither field was reliable. */
  | 'inconclusive'
  | 'failed'
  | 'cancelled'

/** Per-field outcome, so tempo and key stay independent. */
export type FieldAnalysisStatus = 'estimated' | 'inconclusive' | 'skipped' | 'failed'

/**
 * How an analysed tempo relates to the primary estimate.
 * A half-time or double-time reading is an equally valid interpretation of the
 * same signal, not an error — it is reported rather than silently collapsed.
 */
export type TempoRelation = 'primary' | 'half' | 'double' | 'other'

export interface TempoAlternative {
  bpm: number
  relation: TempoRelation
  /**
   * Raw normalised autocorrelation strength at this lag. Comparable between
   * alternatives of the same analysis only.
   */
  strength: number
}

export interface TempoAnalysis {
  status: FieldAnalysisStatus
  /** Display-rounded estimate, e.g. 143.8. */
  bpm: number | null
  /** Same estimate at full precision, for round-tripping and re-display. */
  bpmExact: number | null
  /** Half/double and other plausible readings, strongest first. */
  alternatives: TempoAlternative[]
  /**
   * 0..1 normalised prominence of the winning peak relative to the rest of the
   * autocorrelation. A heuristic quality indicator — NOT a probability.
   */
  confidence: number | null
  /** Why the result is inconclusive, or a caveat worth showing. */
  warning: string | null
}

export interface KeyAlternative {
  /** Canonical spelling, e.g. `F# minor`. */
  key: string
  camelot: string | null
  /** Pearson correlation against the key profile, roughly -1..1. */
  correlation: number
}

export interface KeyAnalysis {
  status: FieldAnalysisStatus
  key: string | null
  camelot: string | null
  alternatives: KeyAlternative[]
  /** Raw leading-profile Pearson correlation; absent in older stored analyses. */
  correlation?: number | null
  /**
   * 0..1 gap between the best and runner-up correlation. A heuristic quality
   * indicator — NOT a probability.
   */
  confidence: number | null
  /**
   * Estimated global tuning offset in cents. Informational: it is used to align
   * chroma bins during analysis and surfaced for inspection, but it is never
   * written to the user's `detune` field automatically.
   */
  tuningCents: number | null
  warning: string | null
}

/** Complete, reproducible record of one analysis run. */
export interface AudioAnalysis {
  /** Analyzer id + version, e.g. `sonic-dsp/1`. */
  engine: string
  /** Window-plan and merge-rule version (`ANALYSIS_PIPELINE`); absent in older records. */
  pipeline?: string
  /**
   * Identity of the analysed bytes (sha256 + byte length). Distinct from the
   * export integrity `fingerprint` on a library record: that one gates
   * destructive file operations, this one only invalidates cached analysis.
   */
  inputId: string
  /** Base name only — a stored analysis should not leak local paths. */
  inputName: string
  analyzedAt: number
  /** How many seconds of audio were actually examined. */
  analyzedSeconds: number
  /** Sample rate the audio was decoded to. */
  sampleRate: number
  channels: number
  durationSec: number
  tempo: TempoAnalysis
  key: KeyAnalysis
  /** Non-fatal notes: short input, monotonal material, decode oddities. */
  warnings: string[]
}

/**
 * User-requested batch refresh includes records measured by older engines or
 * by an older window plan / merge pipeline. Records written before pipeline
 * versions were recorded all carry an older engine, so a missing pipeline is
 * only stale through its engine.
 */
export function needsAnalysisRefresh(beat: {
  missing: boolean
  fileAccessError?: string | null
  analysisStatus: AnalysisStatus
  analysis: Pick<AudioAnalysis, 'engine' | 'pipeline'> | null
}): boolean {
  if (beat.missing || beat.fileAccessError || beat.analysisStatus === 'queued' || beat.analysisStatus === 'analyzing') return false
  return !beat.analysis || beat.analysis.engine !== ANALYSIS_ENGINE ||
    (beat.analysis.pipeline != null && beat.analysis.pipeline !== ANALYSIS_PIPELINE) ||
    beat.analysisStatus === 'not-analyzed' || beat.analysisStatus === 'failed' || beat.analysisStatus === 'cancelled'
}

/** The subset of metadata an analysis can propose. */
export interface AnalyzedValues {
  bpm: number | null
  altBpm: number | null
  key: string | null
  camelot: string | null
}

/**
 * Audio-derived evidence.
 *
 * Intentionally NOT the text `Evidence` shape: there is no source substring to
 * point at, and a correlation coefficient is not a regex confidence. Keeping
 * them as separate types stops the two from being compared or averaged.
 */
export interface AudioEvidence {
  field: 'bpm' | 'altBpm' | 'key' | 'camelot'
  value: string
  analyzer: string
  /** Normalised quality indicator, or null when the analyzer gives none. */
  quality: number | null
  alternatives: { value: string; quality: number | null }[]
  inputId: string
  analyzedAt: number
  note: string | null
}

export function emptyTempoAnalysis(): TempoAnalysis {
  return {
    status: 'skipped',
    bpm: null,
    bpmExact: null,
    alternatives: [],
    confidence: null,
    warning: null
  }
}

export function emptyKeyAnalysis(): KeyAnalysis {
  return {
    status: 'skipped',
    key: null,
    camelot: null,
    alternatives: [],
    confidence: null,
    tuningCents: null,
    warning: null
  }
}

/** Derives the track-level status from the two independent field outcomes. */
export function deriveAnalysisStatus(tempo: TempoAnalysis, key: KeyAnalysis): AnalysisStatus {
  const tempoOk = tempo.status === 'estimated'
  const keyOk = key.status === 'estimated'
  if (tempoOk && keyOk) return 'estimated'
  if (tempoOk || keyOk) return 'partial'

  const failed = [tempo, key].filter((field) => field.status === 'failed').length
  if (failed === 2) return 'failed'
  if (failed === 1) return 'partial'
  return 'inconclusive'
}

/** Pulls the metadata values an analysis is entitled to propose. */
export function analyzedValuesFrom(analysis: AudioAnalysis): AnalyzedValues {
  const { tempo, key } = analysis
  const reliableTempo = tempo.status === 'estimated' ? tempo.bpm : null
  const reliableKey = key.status === 'estimated' ? key.key : null

  // A half-time reading is offered as the alternate, not as the primary.
  const halfOrDouble = tempo.alternatives.find(
    (candidate) => candidate.relation === 'half' || candidate.relation === 'double'
  )

  return {
    bpm: reliableTempo,
    altBpm: reliableTempo != null && halfOrDouble ? round(halfOrDouble.bpm, 0.1) : null,
    key: reliableKey,
    camelot: reliableKey != null && key.status === 'estimated' ? key.camelot : null
  }
}

function round(value: number, step: number): number {
  return Math.round(value / step) * step
}

/** Short human label for a track-level status. */
export function describeAnalysisStatus(status: AnalysisStatus): string {
  switch (status) {
    case 'not-analyzed':
      return 'Not analyzed'
    case 'queued':
      return 'Queued for analysis'
    case 'analyzing':
      return 'Analyzing audio…'
    case 'estimated':
      return 'Analyzed'
    case 'partial':
      return 'Partially analyzed'
    case 'inconclusive':
      return 'Analysis inconclusive'
    case 'failed':
      return 'Analysis failed'
    case 'cancelled':
      return 'Analysis cancelled'
    default:
      return 'Unknown'
  }
}

/** Which evidence layer a displayed value came from. */
export type MetadataProvenance = 'manual' | 'sourceText' | 'embeddedTag' | 'audioEstimate' | 'unknown'

export const PROVENANCE_LABEL: Record<MetadataProvenance, string> = {
  manual: 'Manual',
  sourceText: 'Source text',
  embeddedTag: 'Embedded tag',
  audioEstimate: 'Audio estimate',
  unknown: 'Not set'
}
