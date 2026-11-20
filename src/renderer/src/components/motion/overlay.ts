import { useLayoutEffect, useRef, type RefObject } from 'react'

type Entry = { refs: RefObject<HTMLElement | null>[]; dismiss: () => void; modal: boolean; previous: HTMLElement | null }
const stack: Entry[] = []
export function overlayRoot(): HTMLElement {
  let root = document.getElementById('sonic-overlays')
  if (!root) { root = document.createElement('div'); root.id = 'sonic-overlays'; document.body.append(root) }
  return root
}
const focusable = 'button:not(:disabled):not([tabindex="-1"]), input:not(:disabled):not([tabindex="-1"]), textarea:not(:disabled):not([tabindex="-1"]), select:not(:disabled):not([tabindex="-1"]), a[href]:not([tabindex="-1"]), summary:not([tabindex="-1"]), [tabindex="0"]'
function inside(entry: Entry, target: Node | null): boolean {
  return entry.refs.some(ref => ref.current?.contains(target))
}
function restore(previous: HTMLElement | null): void {
  const fallback = document.querySelector<HTMLElement>('[data-focus-fallback], main button, header button')
  ;(previous?.isConnected && !previous.closest('[inert]') ? previous : fallback)?.focus()
}

/** A single ordered policy for dialogs and portaled menus. */
export function useOverlay(refs: RefObject<HTMLElement | null>[], dismiss: () => void, active: boolean, modal = false): void {
  const latest = useRef({ refs, dismiss }); latest.current = { refs, dismiss }
  useLayoutEffect(() => {
    if (!active) return
    const entry: Entry = { refs: latest.current.refs, dismiss: () => latest.current.dismiss(), modal, previous: document.activeElement as HTMLElement }
    stack.push(entry)
    const panel = entry.refs[0].current
    if (panel) panel.style.zIndex = String(400 + stack.length * 10)
    if (modal) (panel?.querySelector<HTMLElement>('[autofocus], [data-autofocus]') ?? panel)?.focus()
    const pointer = (event: PointerEvent): void => {
      if (stack.at(-1) !== entry || inside(entry, event.target as Node)) return
      if (modal) { event.preventDefault(); event.stopImmediatePropagation() }
      entry.dismiss()
    }
    const key = (event: KeyboardEvent): void => {
      if (stack.at(-1) !== entry) return
      if (event.key === 'Escape') {
        event.preventDefault(); event.stopImmediatePropagation(); entry.dismiss()
      } else if (event.key === 'Tab' && modal && panel) {
        const nodes = [...panel.querySelectorAll<HTMLElement>(focusable)].filter(n => n.getClientRects().length && !n.closest('[inert]'))
        const first = nodes[0], last = nodes.at(-1)
        if (!first) { event.preventDefault(); panel.focus() }
        else if (event.shiftKey && (document.activeElement === first || document.activeElement === panel)) { event.preventDefault(); last?.focus() }
        else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus() }
      }
    }
    const focus = (event: FocusEvent): void => {
      if (modal && stack.at(-1) === entry && !inside(entry, event.target as Node)) panel?.focus()
    }
    document.addEventListener('pointerdown', pointer, true)
    document.addEventListener('keydown', key, true)
    document.addEventListener('focusin', focus, true)
    return () => {
      const wasTop = stack.at(-1) === entry
      stack.splice(stack.indexOf(entry), 1)
      document.removeEventListener('pointerdown', pointer, true)
      document.removeEventListener('keydown', key, true)
      document.removeEventListener('focusin', focus, true)
      if (wasTop && (modal || inside(entry, document.activeElement))) {
        // React restores input selection after layout-effect cleanup. Restoring
        // here synchronously lets that commit refocus an exiting palette, whose
        // later removal drops focus to the body. Wait until the commit finishes,
        // and preserve a destination that another action explicitly focused.
        queueMicrotask(() => {
          const focused = document.activeElement
          if (!focused || focused === document.body || inside(entry, focused)) restore(entry.previous)
        })
      }
    }
  }, [active, modal])
}
