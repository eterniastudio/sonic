import { randomBytes } from 'node:crypto'

/** Short, filename-safe identifier. */
export function createId(prefix?: string): string {
  const raw = randomBytes(8).toString('hex')
  return prefix ? `${prefix}_${raw}` : raw
}
