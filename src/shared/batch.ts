import type { PresetId } from './domain'

export type BatchAction = 'analyze' | 'export'
export type BatchItemStatus = 'pending' | 'running' | 'pending-save' | 'completed' | 'failed' | 'skipped' | 'cancelled'

export interface BatchRequest {
  action: BatchAction
  beatIds: string[]
  presetId?: PresetId
}

export interface BatchItem {
  beatId: string
  status: BatchItemStatus
  error: string | null
  outputPath: string | null
  publishedBeatId: string | null
}

export interface BatchSession {
  id: string
  request: BatchRequest
  status: 'running' | 'completed' | 'cancelled'
  items: BatchItem[]
  startedAt: number
  finishedAt: number | null
}

const PRESET_IDS = new Set<PresetId>([
  'mp3-v0', 'mp3-320', 'm4a-256', 'wav-44100-24',
  'wav-48000-24', 'flac', 'opus-192'
])

/** Validate untrusted IPC data before admitting any batch work. */
export function validateBatchRequest(input: unknown): BatchRequest {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('Invalid batch request.')
  const value = input as Record<string, unknown>
  if (value.action !== 'analyze' && value.action !== 'export') throw new Error('Invalid batch action.')
  if (!Array.isArray(value.beatIds) || value.beatIds.length < 1 || value.beatIds.length > 1000 ||
      value.beatIds.some(id => typeof id !== 'string' || id.length < 1 || id.length > 256 || /[\x00-\x1f]/.test(id))) {
    throw new Error('Select between 1 and 1000 valid beat IDs.')
  }
  if (new Set(value.beatIds).size !== value.beatIds.length) throw new Error('Batch beat IDs must be unique.')
  if (value.action === 'export') {
    if (typeof value.presetId !== 'string' || !PRESET_IDS.has(value.presetId as PresetId)) {
      throw new Error('Choose a supported export recipe.')
    }
    return { action: 'export', beatIds: [...value.beatIds] as string[], presetId: value.presetId as PresetId }
  }
  if (value.presetId !== undefined) throw new Error('Analysis does not use an export recipe.')
  return { action: 'analyze', beatIds: [...value.beatIds] as string[] }
}
