import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync, unlinkSync, appendFileSync, openSync, closeSync, fsyncSync, linkSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { EventEmitter } from 'node:events'
import os from 'node:os'
import path from 'node:path'

const instance = `${process.pid}-${randomUUID()}`
export const storageEvents = new EventEmitter()
/** `primaryValid`: the destination holds a validated, flushed commit, so it can become the backup by link. */
type State = { cached: unknown; loaded: boolean; revision: number; persisted: number; pending?: unknown; error: string | null; retry?: () => void; writing?: boolean; prepareRetry?: () => Promise<void>; retryTask?: Promise<void>; primaryValid?: boolean; records?: RecordCache }
/** Records owned by an array store's snapshots, with their serialized JSON once known (null until first needed). */
type RecordCache = WeakMap<object, string | null>
const states = new Map<string, State>()

function deepFreeze(value: object): void {
  Object.freeze(value)
  if (Array.isArray(value)) {
    for (const child of value as unknown[]) if (typeof child === 'object' && child !== null && !Object.isFrozen(child)) deepFreeze(child)
    return
  }
  for (const key in value) {
    const child = (value as Record<string, unknown>)[key]
    if (typeof child === 'object' && child !== null && !Object.isFrozen(child)) deepFreeze(child)
  }
}

export interface JsonStoreOptions {
  /** For array stores whose callers replace records instead of mutating them.
   * Each committed record is frozen and its JSON is retained, so a commit
   * serializes and copies only the records that changed. The bytes written are
   * identical to `JSON.stringify` of the whole array. */
  recordCache?: boolean
}
export function storageStatus(): { file: string; revision: number; persisted: number; error: string | null }[] {
  return [...states].map(([file, s]) => ({ file, revision: s.revision, persisted: s.persisted, error: s.error }))
}
export function retryStorage(): void | Promise<void> {
  const tasks: Promise<void>[] = []
  for (const s of states.values()) {
    if (!s.error || !s.retry) continue
    if (s.retryTask) { tasks.push(s.retryTask); continue }
    if (!s.prepareRetry) { s.retry(); continue }
    const revision = s.revision
    const task = s.prepareRetry().then(() => {
      if (s.revision !== revision || !s.retry) throw new Error('The pending save changed during validation. Retry saving again.')
      s.retry()
    }).catch(error => { s.error = String(error); storageEvents.emit('changed'); throw error })
    s.retryTask = task
    void task.finally(() => { if (s.retryTask === task) s.retryTask = undefined }).catch(() => undefined)
    tasks.push(task)
  }
  if (tasks.length) return Promise.all(tasks).then(() => undefined)
}
export function storageDiagnostic(file: string, details: Record<string, unknown>): void {
  const record = JSON.stringify({ time: new Date().toISOString(), pid: process.pid, instance, file, ...details }) + '\n'
  // A removed profile must not be recreated by a late callback.
  try { appendFileSync(path.join(path.dirname(file), 'persistence.jsonl'), record) }
  catch { try { appendFileSync(path.join(os.tmpdir(), `sonic-persistence-${instance}.jsonl`), record) } catch { /* stderr remains available */ } }
  if (details.error) console.error(record.trim())
}

/** Main-event-loop synchronous commits, shared cache for every instance of a path.
 * Success means flushed bytes and atomic replacement, not power-loss-proof directory metadata.
 */
export class JsonStore<T> {
  private readonly state: State
  constructor(private readonly file: string, private readonly defaults: T, private readonly normalize: (raw: unknown) => T = raw => {
    if (Array.isArray(defaults)) {
      if (!Array.isArray(raw)) throw new Error('Expected a JSON array')
      return raw as T
    }
    if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) throw new Error('Expected a JSON object')
    return { ...defaults, ...raw } as T
  }, options: JsonStoreOptions = {}) {
    const key = path.resolve(file).toLowerCase()
    let state = states.get(key)
    if (!state) {
      mkdirSync(path.dirname(file), { recursive: true })
      state = { cached: null, loaded: false, revision: 0, persisted: 0, error: null }
      states.set(key, state)
    }
    if (options.recordCache && Array.isArray(defaults)) state.records ??= new WeakMap()
    this.state = state
  }
  /** Serialize `value` and produce the store's own snapshot of it. With a record
   * cache, unchanged (already owned, frozen) records are reused with their JSON;
   * only new record objects are serialized and copied. */
  private encode(value: T): { data: string; snapshot: T } {
    const records = this.state.records
    if (!records || !Array.isArray(value)) {
      const data = JSON.stringify(value)
      return { data, snapshot: JSON.parse(data) as T }
    }
    const parts: string[] = new Array(value.length)
    const snapshot: unknown[] = new Array(value.length)
    for (let index = 0; index < value.length; index++) {
      const item: unknown = value[index]
      if (typeof item !== 'object' || item === null) {
        parts[index] = JSON.stringify(item) ?? 'null'
        snapshot[index] = JSON.parse(parts[index])
        continue
      }
      let part = records.get(item)
      if (part !== undefined) {
        if (part === null) { part = JSON.stringify(item); records.set(item, part) }
        snapshot[index] = item
      } else {
        part = JSON.stringify(item)
        const copy = JSON.parse(part) as object
        deepFreeze(copy)
        records.set(copy, part)
        snapshot[index] = copy
      }
      parts[index] = part
    }
    return { data: `[${parts.join(',')}]`, snapshot: snapshot as T }
  }
  private adopt(value: T): void {
    const records = this.state.records
    if (!records || !Array.isArray(value)) return
    for (const item of value as unknown[]) {
      if (typeof item !== 'object' || item === null || records.has(item)) continue
      deepFreeze(item)
      records.set(item, null)
    }
  }
  get path(): string { return this.file }
  read(): T {
    if (this.state.loaded) return this.state.cached as T
    let value = this.defaults
    let primaryValid = false
    // Compact (current) and indented (earlier releases) JSON both parse here.
    if (existsSync(this.file)) {
      try { value = this.normalize(JSON.parse(readFileSync(this.file, 'utf8'))); primaryValid = true }
      catch (error) {
        const damaged = `${this.file}.damaged-${Date.now()}-${randomUUID()}`
        writeFileSync(damaged, readFileSync(this.file), { flag: 'wx' })
        try { value = this.normalize(JSON.parse(readFileSync(`${this.file}.backup`, 'utf8'))) }
        catch { throw new Error(`Cannot recover ${this.file}. Damaged data preserved at ${damaged}. ${String(error)}`) }
        storageDiagnostic(this.file, { operation: 'recovered-backup', damaged, error: String(error) })
      }
    } else if (existsSync(`${this.file}.backup`)) {
      value = this.normalize(JSON.parse(readFileSync(`${this.file}.backup`, 'utf8')))
      storageDiagnostic(this.file, { operation: 'recovered-missing-destination' })
    }
    this.adopt(value)
    this.state.cached = value
    this.state.loaded = true
    this.state.primaryValid = primaryValid
    return value
  }
  private replace(destination: string, data: string): void {
    const temporary = `${destination}.${instance}.${randomUUID()}.tmp`
    let created = false
    let stage = 'create'
    try {
      const fd = openSync(temporary, 'wx')
      created = true
      try { stage = 'write'; writeFileSync(fd, data, 'utf8'); stage = 'flush'; fsyncSync(fd) } finally { closeSync(fd) }
      stage = 'replace'
      renameSync(temporary, destination)
    } catch (error) {
      storageDiagnostic(this.file, { operation: stage, destination, temporary, temporaryExists: existsSync(temporary), directoryExists: existsSync(path.dirname(destination)), revision: this.state.revision, error: String(error), stack: error instanceof Error ? error.stack : null })
      throw error
    } finally { if (created) { try { unlinkSync(temporary) } catch { /* Only this operation owns this path. */ } } }
  }
  /** Preserve the previous commit as the backup. The validated, already flushed
   * destination is linked rather than re-serialized and flushed again; a volume
   * without hard links (or an unvalidated destination) receives a full copy. */
  private backup(): void {
    const s = this.state
    const destination = `${this.file}.backup`
    if (s.primaryValid) {
      const temporary = `${destination}.${instance}.${randomUUID()}.tmp`
      let linked = false
      try { linkSync(this.file, temporary); linked = true }
      catch { /* Fall back to a full copy below. */ }
      if (linked) {
        try { renameSync(temporary, destination); return }
        catch (error) {
          storageDiagnostic(this.file, { operation: 'backup-link-replace', destination, temporary, revision: s.revision, error: String(error) })
          throw error
        } finally { try { unlinkSync(temporary) } catch { /* Renamed, or owned only by this operation. */ } }
      }
    }
    this.replace(destination, this.encode(s.cached as T).data)
  }
  write(value: T, options: { replacePending?: boolean; prepareRetry?: () => Promise<void> } = {}): T {
    const start = performance.now()
    const s = this.state
    if (s.writing) throw new Error(`Reentrant write rejected for ${this.file}; retry after the active commit.`)
    // Compact JSON: indentation roughly doubles the bytes serialized, written and flushed per commit.
    const { data, snapshot } = this.encode(value)
    if (s.error && s.pending !== undefined && !options.replacePending && data !== this.encode(s.pending as T).data) {
      throw new Error(`Unsaved revision ${s.revision} of ${this.file} must be retried before another change.`)
    }
    s.revision += 1
    s.pending = snapshot
    s.prepareRetry = options.prepareRetry
    s.retry = () => { this.write(s.pending as T, { replacePending: true, prepareRetry: s.prepareRetry }) }
    s.writing = true
    try {
      if (s.loaded) this.backup()
      else if (existsSync(this.file)) {
        this.read()
        this.backup()
      }
      this.replace(this.file, data)
      s.primaryValid = true
      s.cached = snapshot
      s.loaded = true
      s.persisted = s.revision
      s.pending = undefined
      s.error = null
      s.retry = undefined
      s.prepareRetry = undefined
      storageDiagnostic(this.file, { operation: 'committed', revision: s.persisted, bytes: Buffer.byteLength(data), elapsedMs: performance.now() - start })
      storageEvents.emit('changed')
      return this.read()
    } catch (error) {
      s.error = String(error)
      storageEvents.emit('changed')
      throw error
    } finally { s.writing = false }
  }
  /** Abandon an uncommitted operation without discarding the last acknowledged snapshot.
   * The storage fault stays visible. Its next retry writes the already committed state.
   */
  async settleRetry(): Promise<void> { await this.state.retryTask?.catch(() => undefined) }

  discardPending(revision: number): void {
    const s = this.state
    if (s.writing || s.retryTask || !s.error || s.revision !== revision || s.pending === undefined) {
      throw new Error('This pending save changed. Refresh its status before cancelling.')
    }
    s.pending = JSON.parse(JSON.stringify(this.read())) as T
    s.prepareRetry = undefined
    storageEvents.emit('changed')
  }
  update(mutator: (current: T) => T): T { return this.write(mutator(structuredClone(this.read()))) }

  /** Replace the in-memory snapshot without committing it to disk.
   *
   * Only for transient state that `normalize` discards on load anyway (for
   * example a queued/analyzing marker): losing it in a crash changes nothing.
   * The next durable write carries it. While a save is pending, or before the
   * first load, this falls back to a normal commit so retry ordering and the
   * pending-revision guard are unchanged. The caller must not mutate `value`.
   */
  stage(value: T): T {
    const s = this.state
    if (s.writing) throw new Error(`Reentrant write rejected for ${this.file}; retry after the active commit.`)
    if (s.error || !s.loaded) return this.write(value)
    s.cached = value
    return value
  }
}
