import type { AudioAnalysis, KeyAnalysis, TempoAnalysis } from '@shared/analysis'
import { ANALYSIS_ENGINE, ANALYSIS_PIPELINE, deriveAnalysisStatus } from '@shared/analysis'
import type { AnalyzedValues } from '@shared/analysis'

/**
 * Combining rules for multi-window analysis.
 *
 * Kept separate from the DSP so the merge policy is testable on its own and the
 * DSP stays a pure signal→estimate function. A rule change here changes stored
 * results: bump `ANALYSIS_PIPELINE` (shared/analysis) with it.
 */

/** Two key estimates are considered to agree when they name the same key. */
function sameKey(a: string | null, b: string | null): boolean {
  return a != null && b != null && a === b
}

/**
 * Merges key estimates from several windows of one track.
 *
 * A single window can be fooled: a drum-only breakdown, a modulated bridge, or a
 * sparse intro may not carry the track's tonal centre. Requiring separated
 * windows to agree is a cheap, honest confidence boost; when they disagree the
 * result is reported as uncertain rather than picking one silently.
 */
export function mergeKeyAnalyses(analyses: KeyAnalysis[]): KeyAnalysis {
  const usable = analyses.filter((analysis) => analysis.key != null && analysis.status === 'estimated')
  const failures = analyses.filter((analysis) => analysis.status === 'failed')
  const failureWarning = failures.length > 0
    ? `${failures.length} of ${analyses.length} key windows failed. ${failures.map((analysis) => analysis.warning).filter(Boolean).join(' ')}`
    : null
  const alternatives = dedupeAlternatives(analyses.flatMap((analysis) => [
    ...(analysis.key && analysis.correlation != null
      ? [{ key: analysis.key, camelot: analysis.camelot, correlation: analysis.correlation }]
      : []),
    ...analysis.alternatives
  ]).sort((a, b) => b.correlation - a.correlation))

  if (usable.length === 0) {
    const inconclusive = analyses.find((analysis) => analysis.status === 'inconclusive')
    if (inconclusive) return {
      ...inconclusive,
      alternatives,
      warning: [inconclusive.warning, failureWarning].filter(Boolean).join(' ') || null
    }
    const failed = failures[0]
    if (failed) return { ...failed, alternatives, warning: failureWarning }
    return (
      inconclusive ?? {
        status: 'inconclusive',
        key: null,
        camelot: null,
        alternatives: [],
        confidence: null,
        tuningCents: null,
        warning: 'No usable tonal content was found in the analysed windows.'
      }
    )
  }

  if (usable.length === 1) return {
    ...usable[0],
    alternatives: alternatives.filter((entry) => entry.key !== usable[0].key),
    warning: [usable[0].warning, failureWarning].filter(Boolean).join(' ') || null
  }

  // Rank windows by their own confidence; the best one leads.
  const ranked = [...usable].sort((a, b) => (b.confidence ?? 0) - (a.confidence ?? 0))
  const winner = ranked[0]
  const agreements = usable.filter((analysis) => sameKey(analysis.key, winner.key)).length
  const unanimous = agreements === usable.length

  if (unanimous) {
    return {
      ...winner,
      confidence: Math.min(1, (winner.confidence ?? 0.5) + (usable.length === analyses.length ? 0.1 : 0)),
      warning: [winner.warning, failureWarning].filter(Boolean).join(' ') || null,
      // A confirmed result still carries the runner-up keys for inspection.
      alternatives: alternatives.filter((entry) => entry.key !== winner.key)
    }
  }

  // Section disagreement is meaningful evidence, not a contest between a
  // confidence heuristic from one section and an alternative's correlation
  // from another. Retain both raw leading correlations for review.
  return {
    status: 'inconclusive',
    key: null,
    camelot: null,
    alternatives,
    confidence: null,
    correlation: null,
    tuningCents: winner.tuningCents,
    warning: ['The tonal centre differed between sections of the track; the leading candidates are retained for review.', failureWarning].filter(Boolean).join(' ')
  }
}

function dedupeAlternatives<T extends { key: string }>(entries: T[]): T[] {
  const seen = new Set<string>()
  const out: T[] = []
  for (const entry of entries) {
    if (seen.has(entry.key)) continue
    seen.add(entry.key)
    out.push(entry)
    if (out.length >= 4) break
  }
  return out
}

export interface AssembleInput {
  tempo: TempoAnalysis
  key: KeyAnalysis
  inputId: string
  inputName: string
  analyzedAt: number
  sampleRate: number
  channels: number
  durationSec: number
  /** Seconds actually examined, summed across windows. */
  analyzedSeconds: number
  windowDescription: string
}

/** Assembles the persistent analysis record from its parts. */
export function assembleAnalysis(input: AssembleInput): AudioAnalysis {
  const warnings: string[] = []
  if (input.tempo.warning) warnings.push(input.tempo.warning)
  if (input.key.warning) warnings.push(input.key.warning)
  if (input.durationSec > 0 && input.durationSec < 20) {
    warnings.push('Short track: the estimate is based on less than 20 seconds of audio.')
  }

  return {
    engine: ANALYSIS_ENGINE,
    pipeline: ANALYSIS_PIPELINE,
    inputId: input.inputId,
    inputName: input.inputName,
    analyzedAt: input.analyzedAt,
    analyzedSeconds: Math.round(input.analyzedSeconds * 10) / 10,
    sampleRate: input.sampleRate,
    channels: input.channels,
    durationSec: Math.round(input.durationSec * 100) / 100,
    tempo: input.tempo,
    key: input.key,
    warnings: [...new Set(warnings)]
  }
}

export { deriveAnalysisStatus }
export type { AnalyzedValues }
