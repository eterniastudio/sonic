import { extractIntakeUrls } from '@shared/url'
import { sourceIdentity } from '@shared/libraryTools'

/** At most this many links are offered from one clipboard read. */
export const MAX_CLIPBOARD_LINKS = 50
/** Clipboard text longer than this is not a copied link; ignore it. */
export const MAX_CLIPBOARD_TEXT = 20_000

export interface ClipboardOffer {
  /** The clipboard text this offer was made for, so a dismissal sticks to it. */
  text: string
  /** Supported single-track links, canonicalised, not yet queued. */
  urls: string[]
}

/**
 * Which copied links are worth offering. Validation is `extractIntakeUrls`, the
 * same parser the intake box uses, so supported sites follow it automatically.
 * Links already queued (by source identity, so share and watch URLs agree) are
 * skipped, as is a clipboard the producer already answered.
 */
export function clipboardOffer(
  text: string,
  queuedUrls: readonly string[],
  answeredText: string | null,
  options: { allowOtherSites?: boolean } = {}
): ClipboardOffer | null {
  const trimmed = text.trim()
  if (!trimmed || trimmed.length > MAX_CLIPBOARD_TEXT || trimmed === answeredText) return null
  const queued = new Set(queuedUrls.flatMap(url => {
    const identity = sourceIdentity(url)
    return identity ? [identity] : []
  }))
  const seen = new Set<string>()
  const urls: string[] = []
  for (const track of extractIntakeUrls(trimmed, { allowOtherSites: options.allowOtherSites === true }).tracks) {
    if (!track.ok || !track.normalized) continue
    const identity = sourceIdentity(track.normalized) ?? track.normalized
    if (queued.has(identity) || seen.has(identity)) continue
    seen.add(identity)
    urls.push(track.normalized)
    if (urls.length >= MAX_CLIPBOARD_LINKS) break
  }
  return urls.length ? { text: trimmed, urls } : null
}
