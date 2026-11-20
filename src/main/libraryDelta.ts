import type { LibraryBeat } from '@shared/domain'
import type { LibraryDelta } from '@shared/ipc'

/**
 * Encodes library pushes against the previous push.
 *
 * The library store keeps an unchanged record as the same object across
 * commits, so the records that changed are exactly the ones whose identity
 * differs from the last push. A push then carries the ordered ids plus those
 * records instead of every record. When most records changed (or nothing was
 * pushed yet) the full list is cheaper and is sent as-is.
 */
export class LibraryDeltaEncoder {
  private previous: Map<string, LibraryBeat> | null = null

  encode(beats: LibraryBeat[]): { full: LibraryBeat[] } | { delta: LibraryDelta } {
    const previous = this.previous
    const next = new Map<string, LibraryBeat>()
    const ids: string[] = new Array(beats.length)
    const changed: LibraryBeat[] = []
    for (let index = 0; index < beats.length; index++) {
      const beat = beats[index]
      ids[index] = beat.id
      // A duplicate id is never produced by the library; send it whole if it ever is.
      if (next.has(beat.id)) { this.previous = mapOf(beats); return { full: beats } }
      next.set(beat.id, beat)
      if (previous?.get(beat.id) !== beat) changed.push(beat)
    }
    this.previous = next
    if (!previous || changed.length * 2 > beats.length) return { full: beats }
    return { delta: { ids, changed } }
  }
}

function mapOf(beats: LibraryBeat[]): Map<string, LibraryBeat> {
  return new Map(beats.map(beat => [beat.id, beat]))
}
