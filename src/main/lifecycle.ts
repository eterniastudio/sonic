/** Admission closes before any asynchronous teardown. Existing operations retain ownership. */
let stopping = false
const operations = new Set<Promise<unknown>>()
export function isStopping(): boolean { return stopping }
export function beginShutdown(): void { stopping = true }
export function assertAccepting(): void { if (stopping) throw new Error('Sonic is closing. Wait for saving to finish.') }
export async function ownOperation<T>(operation: () => T | Promise<T>): Promise<T> {
  const task = Promise.resolve().then(operation)
  operations.add(task)
  try { return await task } finally { operations.delete(task) }
}
export async function settleOperations(): Promise<void> {
  while (operations.size) await Promise.allSettled([...operations])
}
