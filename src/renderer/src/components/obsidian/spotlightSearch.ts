export interface SearchableCommand {
  label: string
  group: string
  keywords?: string
  disabled?: boolean
}

export interface IndexedCommand<T> { item: T; text: string; label: string }

/** Normalize once per catalog change, rather than once per item per keystroke. */
export function indexCommands<T extends SearchableCommand>(items: readonly T[]): IndexedCommand<T>[] {
  return items.filter(item => !item.disabled).map(item => ({
    item, label: item.label.toLocaleLowerCase(),
    text: `${item.label} ${item.group} ${item.keywords ?? ''}`.toLocaleLowerCase()
  }))
}

function score<T>(entry: IndexedCommand<T>, query: string): number {
  if (!query) return 1
  if (entry.label === query) return 400
  if (entry.label.startsWith(query)) return 300
  const direct = entry.text.indexOf(query)
  // A long filename or producer must not turn a real substring match negative.
  if (direct !== -1) return 200 - Math.min(direct, 100)
  const words = query.split(/\s+/)
  if (words.length > 1 && words.every(word => entry.text.includes(word))) return 90
  let cursor = 0, gaps = 0
  for (const char of query) {
    const found = entry.text.indexOf(char, cursor)
    if (found === -1) return 0
    gaps += found - cursor
    cursor = found + 1
  }
  return Math.max(1, 40 - gaps)
}

/** Search the entire catalog, keeping only a bounded ranked result set in memory. */
export function searchCommands<T>(index: readonly IndexedCommand<T>[], rawQuery: string, limit = 60): { items: T[]; total: number } {
  const query = rawQuery.trim().toLocaleLowerCase()
  const best: { item: T; value: number }[] = []
  let total = 0
  for (const entry of index) {
    const value = score(entry, query)
    if (!value) continue
    total += 1
    if (best.length >= limit && value <= best[best.length - 1].value) continue
    let low = 0, high = best.length
    while (low < high) {
      const middle = (low + high) >>> 1
      if (best[middle].value >= value) low = middle + 1
      else high = middle
    }
    best.splice(low, 0, { item: entry.item, value })
    if (best.length > limit) best.pop()
  }
  return { items: best.map(entry => entry.item), total }
}
