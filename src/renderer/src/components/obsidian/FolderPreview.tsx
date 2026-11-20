import type { ReactNode } from 'react'
import { FileAudio, FolderOpen } from 'lucide-react'
import { formatBytes } from '@shared/format'
import { cn } from '@/lib/cn'

/**
 * Ported from ObsidianUI's *Folder Preview*.
 *
 * A folder tab with stacked card layers behind it, listing what the export
 * destination actually contains. Used in Settings so the destination folder is
 * something you can see rather than just a path string.
 */
export interface FolderPreviewFile {
  name: string
  sizeBytes: number
}

export function FolderPreview({
  path,
  files,
  emptyLabel = 'No exports yet',
  className
}: {
  path: string
  files: FolderPreviewFile[]
  emptyLabel?: string
  className?: string
}): ReactNode {
  const shown = files.slice(0, 4)

  return (
    <div className={cn('select-none', className)}>
      <div className="relative pt-3.5">
        {/* Stacked layers imply a folder with more inside than is listed. */}
        <span className="absolute inset-x-5 top-2 h-4 rounded-t-[10px] border border-line bg-surface-2" />
        <span className="absolute inset-x-2.5 top-[11px] h-4 rounded-t-[10px] border border-line bg-surface-3" />

        <div className="relative rounded-[2px] border border-line bg-surface">
          {/* Folder tab. */}
          <span className="absolute -top-3 left-4 h-3 w-20 rounded-t-[7px] border border-b-0 border-line bg-surface" />

          <div className="flex items-center gap-2 border-b border-line px-3.5 py-2.5">
            <FolderOpen className="size-3.5 shrink-0 text-accent" />
            <span className="min-w-0 flex-1 truncate font-mono text-[12px] text-fg-muted" title={path}>
              {path || 'Not set'}
            </span>
            <span className="shrink-0 text-[12px] text-fg-subtle nums">{files.length} files</span>
          </div>

          <ul className="p-1.5">
            {shown.length === 0 ? (
              <li className="px-2 py-3 text-center text-[12px] text-fg-subtle">{emptyLabel}</li>
            ) : (
              shown.map((file) => (
                <li
                  key={file.name}
                  className="flex items-center gap-2 rounded-[2px] px-2 py-1.5 transition-colors duration-[var(--duration-quick)] hover:bg-surface-2"
                >
                  <FileAudio className="size-3.5 shrink-0 text-fg-subtle" />
                  <span className="min-w-0 flex-1 truncate text-[12px] text-fg-muted" title={file.name}>
                    {file.name}
                  </span>
                  <span className="shrink-0 text-[12px] text-fg-subtle nums">
                    {formatBytes(file.sizeBytes)}
                  </span>
                </li>
              ))
            )}
            {files.length > shown.length ? (
              <li className="px-2 pt-1 pb-1.5 text-[12px] text-fg-subtle">
                +{files.length - shown.length} more
              </li>
            ) : null}
          </ul>
        </div>
      </div>
    </div>
  )
}
