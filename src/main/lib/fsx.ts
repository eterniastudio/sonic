import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { copyFile, mkdir, rename, rm, stat, unlink } from 'node:fs/promises'
import path from 'node:path'

export async function ensureDir(directory: string): Promise<void> {
  await mkdir(directory, { recursive: true })
}

export async function fileExists(target: string): Promise<boolean> {
  try {
    const info = await stat(target)
    return info.isFile()
  } catch {
    return false
  }
}

export async function directoryExists(target: string): Promise<boolean> {
  try {
    const info = await stat(target)
    return info.isDirectory()
  } catch {
    return false
  }
}

export async function pathExists(target: string): Promise<boolean> {
  try {
    await stat(target)
    return true
  } catch {
    return false
  }
}

export async function fileSize(target: string): Promise<number> {
  try {
    const info = await stat(target)
    return info.size
  } catch {
    return 0
  }
}

/** Streaming SHA-256 of a file, used as the identity fingerprint for exports. */
export function sha256File(target: string, signal?: AbortSignal): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = createHash('sha256')
    const stream = createReadStream(target, { signal })
    stream.on('error', reject)
    stream.on('data', (chunk) => hash.update(chunk))
    stream.on('end', () => resolve(hash.digest('hex')))
  })
}

/**
 * Moves a file, falling back to copy + unlink when source and destination live
 * on different volumes (rename across devices fails with EXDEV).
 */
export async function moveFile(source: string, destination: string): Promise<void> {
  await ensureDir(path.dirname(destination))
  try {
    await rename(source, destination)
    return
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    if (code !== 'EXDEV' && code !== 'EPERM' && code !== 'EEXIST') throw error
  }

  await copyFile(source, destination)
  try {
    await unlink(source)
  } catch {
    // Leaving the staging copy behind is harmless; cleanup handles it.
  }
}

/** Removes a file if present, ignoring a missing file. */
export async function removeFile(target: string): Promise<void> {
  try {
    await unlink(target)
  } catch {
    // Nothing to remove.
  }
}

/** Recursively removes a directory if present. */
export async function removeDir(target: string): Promise<void> {
  try {
    await rm(target, { recursive: true, force: true })
  } catch {
    // Nothing to remove.
  }
}
