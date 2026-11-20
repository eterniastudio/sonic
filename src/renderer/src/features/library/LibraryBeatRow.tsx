import { memo, useCallback, type KeyboardEvent, type MouseEvent, type ReactNode } from 'react'
import type { LibraryBeat } from '@shared/domain'
import { BeatCard, type BeatCardProps } from './BeatCard'

interface LibraryBeatRowProps extends Pick<BeatCardProps, 'beat' | 'layout' | 'selected' | 'batchSelected' | 'playbackState'> {
  onSelect: (event: MouseEvent | KeyboardEvent, beat: LibraryBeat) => void
  onPlay: (id: string) => void
  onToggleSelection: (id: string) => void
  onContextMenu: (event: MouseEvent, beat: LibraryBeat) => void
  registerCard: (id: string, node: HTMLDivElement | null) => void
}

/** Selection and playback changes only render the rows whose visible state changed. */
export const LibraryBeatRow = memo(function LibraryBeatRow({ beat, layout, selected, batchSelected,
  playbackState, onSelect, onPlay, onToggleSelection, onContextMenu, registerCard }: LibraryBeatRowProps): ReactNode {
  const attach = useCallback((node: HTMLDivElement | null) => registerCard(beat.id, node), [beat.id, registerCard])
  // Draggable so a row can be dropped into a DAW or Explorer; LibraryView starts the OS drag.
  return <div ref={attach} draggable={!beat.missing}>
    <BeatCard beat={beat} layout={layout} selected={selected} batchSelected={batchSelected}
      playbackState={playbackState} onSelect={event => onSelect(event, beat)} onPlay={() => onPlay(beat.id)}
      onToggleSelection={() => onToggleSelection(beat.id)} onContextMenu={event => onContextMenu(event, beat)} />
  </div>
})
