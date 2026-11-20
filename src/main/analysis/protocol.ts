import type { KeyAnalysis, TempoAnalysis } from '@shared/analysis'

/**
 * Message contract between the analysis service and its worker.
 *
 * Kept in its own module so the main process never imports the worker entry
 * (which starts work on load) merely to obtain these types.
 */

export interface AnalysisWorkerWindow {
  path: string
  sampleRate: number
  sourceDurationSec: number
  /** Slice within a shared decoded file; omitted means the whole file. */
  sampleOffset?: number
  sampleCount?: number
}

export interface AnalysisWorkerJob {
  tempo: AnalysisWorkerWindow | null
  key: AnalysisWorkerWindow[]
}

export interface AnalysisWorkerReply {
  ok: boolean
  tempo: TempoAnalysis | null
  key: KeyAnalysis | null
  error: string | null
  elapsedMs: number
}
