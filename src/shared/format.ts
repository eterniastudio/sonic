/**
 * Small formatting helpers shared by both processes.
 * Implemented locally so the renderer and main process agree on output.
 */

export function formatDuration(totalSeconds: number | null | undefined): string {
  if (totalSeconds == null || !Number.isFinite(totalSeconds) || totalSeconds < 0) return '--:--'
  const seconds = Math.floor(totalSeconds % 60)
  const minutes = Math.floor((totalSeconds / 60) % 60)
  const hours = Math.floor(totalSeconds / 3600)
  const pad = (value: number): string => value.toString().padStart(2, '0')
  return hours > 0 ? `${hours}:${pad(minutes)}:${pad(seconds)}` : `${minutes}:${pad(seconds)}`
}

export function formatBytes(bytes: number | null | undefined): string {
  if (bytes == null || !Number.isFinite(bytes) || bytes < 0) return '—'
  if (bytes < 1024) return `${bytes} B`
  const units = ['KB', 'MB', 'GB', 'TB']
  let value = bytes / 1024
  let unit = 0
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024
    unit += 1
  }
  return `${value >= 100 ? value.toFixed(0) : value.toFixed(1)} ${units[unit]}`
}

/** Formats a bitrate in kbps, tolerating values that arrive as bits/s. */
export function formatBitrate(kbps: number | null | undefined): string {
  if (kbps == null || !Number.isFinite(kbps) || kbps <= 0) return '—'
  return `${Math.round(kbps)} kbps`
}

export function formatSampleRate(hz: number | null | undefined): string {
  if (hz == null || !Number.isFinite(hz) || hz <= 0) return '—'
  return `${(hz / 1000).toFixed(hz % 1000 === 0 ? 0 : 1)} kHz`
}

export function formatChannelCount(channels: number | null | undefined): string {
  if (channels == null || !Number.isFinite(channels)) return '—'
  if (channels === 1) return 'Mono'
  if (channels === 2) return 'Stereo'
  return `${channels} ch`
}

/** Signed cents, e.g. `-18 ¢`. */
export function formatCents(cents: number | null | undefined): string {
  if (cents == null || !Number.isFinite(cents)) return '—'
  const rounded = Math.round(cents * 10) / 10
  return `${rounded > 0 ? '+' : ''}${rounded} ¢`
}

export function formatBpm(bpm: number | null | undefined): string {
  if (bpm == null || !Number.isFinite(bpm)) return '—'
  return Number.isInteger(bpm) ? `${bpm}` : bpm.toFixed(1)
}

/** `2026-02-14` in local time, used by the `{date}` naming token. */
export function formatDateStamp(date: Date = new Date()): string {
  const pad = (value: number): string => value.toString().padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
}

export function formatRelativeTime(timestamp: number, now: number = Date.now()): string {
  const delta = Math.max(0, now - timestamp)
  const minute = 60_000
  const hour = 60 * minute
  const day = 24 * hour
  if (delta < minute) return 'just now'
  if (delta < hour) return `${Math.floor(delta / minute)}m ago`
  if (delta < day) return `${Math.floor(delta / hour)}h ago`
  if (delta < 7 * day) return `${Math.floor(delta / day)}d ago`
  return new Date(timestamp).toLocaleDateString()
}

/** Clamps a number into an inclusive range. */
export function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value))
}
