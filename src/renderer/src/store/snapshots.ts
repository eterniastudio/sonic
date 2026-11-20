import type { QueueSnapshot } from '@shared/domain'

/** IPC snapshots contain plain records and arrays; retain equal records across pushes. */
function sameValue(left: unknown, right: unknown): boolean {
  if (Object.is(left, right)) return true
  if (left == null || right == null || typeof left !== 'object' || typeof right !== 'object') return false
  if (Array.isArray(left) || Array.isArray(right)) {
    return Array.isArray(left) && Array.isArray(right) && left.length === right.length &&
      left.every((value, index) => sameValue(value, right[index]))
  }
  const leftRecord = left as Record<string, unknown>
  const rightRecord = right as Record<string, unknown>
  const keys = Object.keys(leftRecord)
  return keys.length === Object.keys(rightRecord).length && keys.every(key =>
    Object.prototype.hasOwnProperty.call(rightRecord, key) && sameValue(leftRecord[key], rightRecord[key]))
}

/** Preserve order and all changed values without repainting unchanged library/queue rows. */
export function reuseSnapshotItems<T extends { id: string }>(previous: T[], incoming: T[]): T[] {
  if (previous === incoming) return previous
  const byId = new Map(previous.map(item => [item.id, item]))
  let unchanged = previous.length === incoming.length
  let reused = false
  const next = incoming.map((item, index) => {
    const existing = byId.get(item.id)
    const value = existing && sameValue(existing, item) ? existing : item
    if (value !== previous[index]) unchanged = false
    if (value !== item) reused = true
    return value
  })
  return unchanged ? previous : reused ? next : incoming
}

/**
 * Rebuild a pushed list from a delta: `ids` is the complete order, `changed`
 * holds every record that differs from the previous push. Returns null when a
 * listed id is unknown here (for example a push that raced the first load), so
 * the caller can fetch the full list instead.
 */
export function applySnapshotDelta<T extends { id: string }>(previous: T[], ids: readonly string[], changed: readonly T[]): T[] | null {
  const byId = new Map<string, T>()
  for (const item of previous) if (!byId.has(item.id)) byId.set(item.id, item)
  const updates = new Map<string, T>()
  for (const item of changed) {
    const existing = byId.get(item.id)
    updates.set(item.id, existing && sameValue(existing, item) ? existing : item)
  }
  let unchanged = previous.length === ids.length
  const next: T[] = new Array(ids.length)
  for (let index = 0; index < ids.length; index++) {
    const value = updates.get(ids[index]) ?? byId.get(ids[index])
    if (!value) return null
    if (value !== previous[index]) unchanged = false
    next[index] = value
  }
  return unchanged ? previous : next
}

export function reuseQueueSnapshot(previous: QueueSnapshot, incoming: QueueSnapshot): QueueSnapshot {
  if (previous === incoming) return previous
  const jobs = reuseSnapshotItems(previous.jobs, incoming.jobs)
  if (jobs === previous.jobs && previous.paused === incoming.paused && previous.concurrency === incoming.concurrency) return previous
  return jobs === incoming.jobs ? incoming : { ...incoming, jobs }
}
