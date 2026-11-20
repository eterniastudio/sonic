import { app, dialog, nativeImage, type NativeImage, type WebContents } from 'electron'
import { writeFile } from 'node:fs/promises'
import path from 'node:path'
import type { LibraryBeat } from '@shared/domain'
import { findDuplicateGroups } from '@shared/libraryTools'
import { libraryExportRows, serializeLibraryExport, type LibraryExportFormat } from '@shared/libraryExport'
import { fileExists } from '../lib/fsx'
import { libraryService } from './library'
import { organizationService } from './organization'

/** Windows Explorer and DAWs accept multi-file drops; keep the payload sane. */
export const MAX_DRAG_FILES = 100

let dragIcon: NativeImage | null = null
function icon(): NativeImage {
  if (dragIcon && !dragIcon.isEmpty()) return dragIcon
  const file = app.isPackaged ? path.join(process.resourcesPath, 'icon.png') : path.join(app.getAppPath(), 'build', 'icon.png')
  const image = nativeImage.createFromPath(file)
  dragIcon = image.isEmpty() ? image : image.resize({ width: 32, height: 32 })
  return dragIcon
}

/**
 * Starts an OS file drag for library records. The renderer names records by id
 * only; paths are resolved here and only files that exist on disk are offered.
 */
export async function startLibraryDrag(sender: WebContents, ids: string[]): Promise<{ started: boolean; count: number }> {
  const files: string[] = []
  for (const id of ids.slice(0, MAX_DRAG_FILES)) {
    const beat = libraryService.get(id)
    if (!beat || beat.missing || beat.fileAccessError) continue
    if (await fileExists(beat.filePath)) files.push(beat.filePath)
  }
  if (!files.length) return { started: false, count: 0 }
  const [file, ...rest] = files
  sender.startDrag(rest.length ? { file, files, icon: icon() } : { file, icon: icon() })
  return { started: true, count: files.length }
}

/** Writes the given records as CSV or JSON to a path the producer picks in a native dialog. */
export async function exportLibraryList(ids: string[]): Promise<{ saved: boolean; count: number; fileName: string | null }> {
  const byId = new Map(libraryService.list().map(beat => [beat.id, beat]))
  const beats = ids.flatMap(id => byId.has(id) ? [byId.get(id)!] : [])
  if (!beats.length) throw new Error('None of these tracks are in the library any more.')
  const stamp = new Date().toISOString().slice(0, 10)
  const result = await dialog.showSaveDialog({
    title: 'Export track list',
    defaultPath: path.join(app.getPath('documents'), `Sonic library ${stamp}.csv`),
    filters: [{ name: 'CSV spreadsheet', extensions: ['csv'] }, { name: 'JSON', extensions: ['json'] }]
  })
  if (result.canceled || !result.filePath) return { saved: false, count: 0, fileName: null }
  const format: LibraryExportFormat = path.extname(result.filePath).toLowerCase() === '.json' ? 'json' : 'csv'
  const target = path.extname(result.filePath) ? result.filePath : `${result.filePath}.${format}`
  const rows = libraryExportRows(beats, organizationService.collectionNamesByBeat())
  await writeFile(target, serializeLibraryExport(rows, format), 'utf8')
  return { saved: true, count: rows.length, fileName: path.basename(target) }
}

/**
 * Keeps one record of a duplicate group and removes the others from the
 * library only. Audio files are never deleted. Each record's annotations and
 * collection membership move to the kept record only once that record has
 * actually left the library, so a failed removal loses nothing.
 */
export async function resolveDuplicates(keepId: string, removeIds: string[]): Promise<LibraryBeat[]> {
  const library = libraryService.list()
  const group = findDuplicateGroups(library).find(item => item.beatIds.includes(keepId))
  if (!group) throw new Error('These tracks are no longer duplicates. Refresh the view and try again.')
  const removals = [...new Set(removeIds)].filter(id => id !== keepId)
  if (!removals.length) throw new Error('Choose at least one other record to remove.')
  if (removals.some(id => !group.beatIds.includes(id))) throw new Error('Only records in the same duplicate group can be removed.')
  libraryService.assertWritable()
  const failures: string[] = []
  for (const id of removals) {
    let result: Awaited<ReturnType<typeof libraryService.remove>>
    try { result = await libraryService.remove(id, false) }
    catch (error) { failures.push(error instanceof Error ? error.message : String(error)); continue }
    if (result.ok) organizationService.mergeInto(keepId, [id])
    else failures.push(result.reason ?? 'A duplicate record could not be removed.')
  }
  if (failures.length) throw new Error(failures[0])
  return libraryService.list()
}
