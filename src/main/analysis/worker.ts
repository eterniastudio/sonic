import { parentPort, workerData } from 'node:worker_threads'
import type { KeyAnalysis, TempoAnalysis } from '@shared/analysis'
import { emptyKeyAnalysis, emptyTempoAnalysis } from '@shared/analysis'
import { readPcmFile } from './decode'
import { estimateKey, estimateTempo } from './dsp'
import { mergeKeyAnalyses } from './merge'
import type { AnalysisWorkerJob, AnalysisWorkerReply, AnalysisWorkerWindow } from './protocol'

/**
 * Analysis worker entry.
 *
 * Runs on a worker thread so a multi-second STFT pass never blocks the main
 * process — the queue keeps reporting progress and the UI keeps responding while
 * a track is being analysed.
 *
 * Reads only file paths from `workerData`; the PCM itself is read here, off the
 * main thread.
 */

async function run(): Promise<AnalysisWorkerReply> {
  const started = Date.now()
  const job = workerData as AnalysisWorkerJob | undefined

  if (!job) {
    return { ok: false, tempo: null, key: null, error: 'Analysis worker started without a job', elapsedMs: 0 }
  }

  const decoded = new Map<string, Float32Array>()
  const readWindow = async (window: AnalysisWorkerWindow): Promise<Float32Array> => {
    let pcm = decoded.get(window.path)
    if (!pcm) { pcm = await readPcmFile(window.path); decoded.set(window.path, pcm) }
    const start = window.sampleOffset ?? 0
    const count = window.sampleCount ?? pcm.length - start
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(count) || start < 0 || count < 0 || start + count > pcm.length) {
      throw new Error('Decoded audio window is outside the available samples.')
    }
    return pcm.subarray(start, start + count)
  }

  let tempo: TempoAnalysis | null = null
  if (job.tempo) {
    try {
      const pcm = await readWindow(job.tempo)
      tempo = estimateTempo({ pcm, sampleRate: job.tempo.sampleRate, sourceDurationSec: job.tempo.sourceDurationSec })
    } catch (error) {
      tempo = { ...emptyTempoAnalysis(), status: 'failed', warning: `Tempo input could not be read: ${error instanceof Error ? error.message : String(error)}` }
    }
  }

  const keyResults: KeyAnalysis[] = []
  for (const window of job.key) {
    try {
      const pcm = await readWindow(window)
      keyResults.push(estimateKey({ pcm, sampleRate: window.sampleRate, sourceDurationSec: window.sourceDurationSec }))
    } catch (error) {
      keyResults.push({ ...emptyKeyAnalysis(), status: 'failed', warning: `Key window input could not be read: ${error instanceof Error ? error.message : String(error)}` })
    }
  }

  return {
    ok: true,
    tempo,
    key: keyResults.length > 0 ? mergeKeyAnalyses(keyResults) : null,
    error: null,
    elapsedMs: Date.now() - started
  }
}

const port = parentPort

if (port) {
  run()
    .then((reply) => {
      port.postMessage(reply)
    })
    .catch((error: unknown) => {
      port.postMessage({
        ok: false,
        tempo: null,
        key: null,
        error: error instanceof Error ? error.message : String(error),
        elapsedMs: 0
      } satisfies AnalysisWorkerReply)
    })
}
