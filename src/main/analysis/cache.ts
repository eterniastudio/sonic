import type { AudioAnalysis } from '@shared/analysis'
import { ANALYSIS_ENGINE, ANALYSIS_PIPELINE } from '@shared/analysis'
import { JsonStore } from '../lib/jsonStore'
import { analysisCacheFile } from '../services/paths'

/**
 * Analysis result cache.
 *
 * Keyed by the identity of the analysed bytes plus the engine version and the
 * window-plan/merge pipeline version, so a different file — or the same file
 * after a DSP, window-planning or merge-rule change — never returns a stale
 * estimate. This is deliberately separate from the library record's
 * integrity `fingerprint`: that one gates destructive file operations, this one
 * only decides whether analysis can be skipped.
 */

interface CacheEntry {
  inputId: string
  engine: string
  /** Absent on entries written before pipeline versions existed: never a hit. */
  pipeline?: string
  analysis: AudioAnalysis
}

function isCurrent(entry: CacheEntry, inputId: string): boolean {
  return entry.inputId === inputId && entry.engine === ANALYSIS_ENGINE && entry.pipeline === ANALYSIS_PIPELINE
}

/** Bounded so the cache cannot grow without limit. */
const MAX_ENTRIES = 300

function normalize(raw: unknown): CacheEntry[] {
  if (!Array.isArray(raw)) return []
  return raw.filter((entry): entry is CacheEntry => {
    if (typeof entry !== 'object' || entry === null) return false
    const candidate = entry as Partial<CacheEntry>
    return typeof candidate.inputId === 'string' && typeof candidate.engine === 'string' && !!candidate.analysis
  })
}

class AnalysisCache {
  private store = new JsonStore<CacheEntry[]>(analysisCacheFile(), [], normalize)

  get(inputId: string): AudioAnalysis | null {
    const hit = this.store.read().find((entry) => isCurrent(entry, inputId))
    return hit ? hit.analysis : null
  }

  set(inputId: string, analysis: AudioAnalysis): void {
    // Results for the same bytes from any older version can never be served
    // again, so they are replaced rather than left to occupy the cap.
    const entries = this.store
      .read()
      .filter((entry) => entry.inputId !== inputId)

    entries.push({ inputId, engine: ANALYSIS_ENGINE, pipeline: ANALYSIS_PIPELINE, analysis })

    // Drop the oldest analyses once the cap is reached.
    entries.sort((a, b) => b.analysis.analyzedAt - a.analysis.analyzedAt)
    this.store.write(entries.slice(0, MAX_ENTRIES))
  }

  delete(inputId: string): void {
    this.store.write(this.store.read().filter((entry) => entry.inputId !== inputId))
  }

  clear(): void {
    this.store.write([])
  }

  size(): number {
    return this.store.read().length
  }
}

export const analysisCache = new AnalysisCache()
