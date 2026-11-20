import { useEffect, useRef, useState, type ReactNode } from 'react'
import { ClipboardPaste, X } from 'lucide-react'
import { ipc } from '@/lib/ipc'
import { useApp } from '@/store/app'
import { Button, IconButton } from '@/components/ui/Button'
import { toast } from '@/components/ui/Toaster'
import { clipboardOffer, type ClipboardOffer as Offer } from './clipboardWatch'

/**
 * Opt-in clipboard link watch. When Sonic's window gains focus and the
 * clipboard holds supported links that are not already queued, a small
 * non-modal prompt offers to queue them. Nothing is queued without a click,
 * and an answered clipboard is not offered again.
 */
export function ClipboardOffer(): ReactNode {
  const enabled = useApp((state) => state.settings.watchClipboard)
  const [offer, setOffer] = useState<Offer | null>(null)
  const [adding, setAdding] = useState(false)
  const answered = useRef<string | null>(null)
  const reading = useRef(false)

  useEffect(() => {
    if (!enabled) { setOffer(null); return }
    const check = (): void => {
      if (reading.current) return
      reading.current = true
      void ipc.invoke('app:readClipboard').then((text) => {
        const state = useApp.getState()
        const queued = state.queue.jobs.map((job) => job.url)
        const next = clipboardOffer(text, queued, answered.current, { allowOtherSites: state.settings.allowOtherSites === true })
        if (next) setOffer(next)
      }).catch(() => { /* The clipboard is optional; a failed read offers nothing. */ })
        .finally(() => { reading.current = false })
    }
    window.addEventListener('focus', check)
    return () => window.removeEventListener('focus', check)
  }, [enabled])

  if (!offer || !enabled) return null
  const count = offer.urls.length
  const dismiss = (): void => { answered.current = offer.text; setOffer(null) }
  const add = (): void => {
    setAdding(true)
    answered.current = offer.text
    void useApp.getState().addUrls(offer.urls).then(() => {
      setOffer(null)
      toast({ kind: 'success', title: `Added ${count} link${count === 1 ? '' : 's'} to the queue`, description: 'Find them in Downloads.' })
    }).catch((error) => toast({ kind: 'error', title: 'Could not add the copied links', description: String(error) }))
      .finally(() => setAdding(false))
  }

  return (
    <div role="region" aria-label="Copied link" className="fixed top-14 right-5 z-[300] w-[340px] rounded-[2px] border border-line bg-surface p-3 shadow-pop">
      <div className="flex items-start gap-2.5">
        <ClipboardPaste aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-fg-subtle" strokeWidth={1.6} />
        <div className="min-w-0 flex-1">
          <p className="text-[13.5px] font-semibold text-fg">
            {count === 1 ? 'Copied link found' : `${count} copied links found`}
          </p>
          <p className="mt-0.5 truncate text-[12px] text-fg-muted" title={offer.urls.join('\n')}>
            {count === 1 ? offer.urls[0] : `${offer.urls[0]} and ${count - 1} more`}
          </p>
          <div className="mt-2.5 flex gap-2">
            <Button size="sm" variant="primary" disabled={adding} onClick={add}>
              {adding ? 'Adding…' : 'Add to queue'}
            </Button>
            <Button size="sm" variant="ghost" disabled={adding} onClick={dismiss}>Not now</Button>
          </div>
        </div>
        <IconButton label="Dismiss copied link" size="icon-xs" onClick={dismiss}><X /></IconButton>
      </div>
    </div>
  )
}
