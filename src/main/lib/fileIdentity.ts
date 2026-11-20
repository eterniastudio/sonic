import { createHash } from 'node:crypto'
import { lstat, open, realpath } from 'node:fs/promises'
import path from 'node:path'
import type { BigIntStats } from 'node:fs'
import type { PhysicalFileIdentity } from '@shared/recovery'

export const isContentFingerprint = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{64}$/i.test(value)

export function canonicalPath(value: string): string {
  const normalized = path.resolve(value)
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized
}

export function insideRoot(root: string, candidate: string): boolean {
  const relative = path.relative(canonicalPath(root), canonicalPath(candidate))
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative))
}

export function physicalIdentity(stat: BigIntStats): PhysicalFileIdentity {
  return { device: String(stat.dev), inode: String(stat.ino), born: String(stat.birthtimeNs) }
}

export function samePhysicalFile(a: PhysicalFileIdentity | undefined, b: PhysicalFileIdentity): boolean {
  // Some filesystems do not provide reliable file IDs; never grant ownership from zeros.
  return !!a && a.inode !== '0' && a.born !== '0' && a.device === b.device && a.inode === b.inode && a.born === b.born
}

export async function capturePhysicalIdentity(filePath: string): Promise<PhysicalFileIdentity> {
  const stat = await lstat(filePath, { bigint: true })
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('The path is not a regular file.')
  return physicalIdentity(stat)
}

export interface VerifiedFile {
  path: string
  fingerprint: string
  sizeBytes: number
  file: PhysicalFileIdentity
  modified: string
  changed: string
}

export function sameFileStamp(a: VerifiedFile, b: VerifiedFile): boolean {
  return canonicalPath(a.path) === canonicalPath(b.path) && samePhysicalFile(a.file, b.file) &&
    a.sizeBytes === b.sizeBytes && a.modified === b.modified && a.changed === b.changed && a.fingerprint === b.fingerprint
}

/** Reject linked roots, linked descendants, and a path that resolves outside the picked boundary. */
export async function assertUnlinkedPath(root: string, filePath: string): Promise<void> {
  const rootPath = path.resolve(root)
  const target = path.resolve(filePath)
  if (!insideRoot(rootPath, target)) throw new Error('The candidate is outside the selected folder.')
  if (canonicalPath(await realpath(rootPath)) !== canonicalPath(rootPath) || canonicalPath(await realpath(target)) !== canonicalPath(target)) {
    throw new Error('Linked files and folders are not followed during recovery.')
  }
  let current = target
  for (;;) {
    if ((await lstat(current)).isSymbolicLink()) throw new Error('Linked files and folders are not followed during recovery.')
    if (canonicalPath(current) === canonicalPath(rootPath)) break
    const parent = path.dirname(current)
    if (parent === current) throw new Error('The candidate is outside the selected folder.')
    current = parent
  }
}

/** Hash a stable opened file, then verify the selected path still names that exact file. */
export async function verifyFile(filePath: string, root: string, signal: AbortSignal, maxBytes: number): Promise<VerifiedFile> {
  signal.throwIfAborted()
  await assertUnlinkedPath(root, filePath)
  const handle = await open(filePath, 'r')
  try {
    signal.throwIfAborted()
    const before = await handle.stat({ bigint: true })
    if (!before.isFile() || before.size > BigInt(maxBytes)) throw new Error(`Only regular files up to ${Math.round(maxBytes / 1024 ** 2)} MB can be verified.`)
    const atPath = await lstat(filePath, { bigint: true })
    if (atPath.isSymbolicLink() || atPath.dev !== before.dev || atPath.ino !== before.ino) throw new Error('The candidate changed while it was being opened.')
    await assertUnlinkedPath(root, filePath)
    signal.throwIfAborted()
    const hash = createHash('sha256')
    const stream = handle.createReadStream({ autoClose: false, signal, highWaterMark: 256 * 1024 })
    try { for await (const chunk of stream) { signal.throwIfAborted(); hash.update(chunk) } }
    finally { if (!stream.readableEnded) stream.destroy() }
    const after = await handle.stat({ bigint: true })
    const named = await lstat(filePath, { bigint: true })
    await assertUnlinkedPath(root, filePath)
    if (named.isSymbolicLink() || before.size !== after.size || before.mtimeNs !== after.mtimeNs || before.ctimeNs !== after.ctimeNs ||
      named.dev !== before.dev || named.ino !== before.ino || named.size !== after.size || named.mtimeNs !== after.mtimeNs || named.ctimeNs !== after.ctimeNs) {
      throw new Error('The candidate changed while its content was being verified.')
    }
    signal.throwIfAborted()
    return { path: path.resolve(filePath), fingerprint: hash.digest('hex'), sizeBytes: Number(after.size),
      file: physicalIdentity(after), modified: String(after.mtimeNs), changed: String(after.ctimeNs) }
  } finally { await handle.close() }
}
