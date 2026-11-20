import { useEffect, useRef, useState, type ReactNode } from 'react'
import { Command, Moon, RotateCw, Sun } from 'lucide-react'
import { toast } from '@/components/ui/Toaster'
import { cn } from '@/lib/cn'
import { ipc } from '@/lib/ipc'
import { useIpcEvent } from '@/lib/hooks'
import { useApp } from '@/store/app'
import { useResolvedTheme, THEME_LABELS } from '@/lib/theme'
import { IconSwap } from '@/components/ui/Tooltip'
import { Wordmark } from './Logo'

/** Windows-style window glyphs, drawn to match the OS metrics. */
function Glyph({ kind }: { kind: 'minimize' | 'maximize' | 'restore' | 'close' }): ReactNode {
  const common = { stroke: 'currentColor', strokeWidth: 1, fill: 'none' } as const
  return (
    <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden>
      {kind === 'minimize' ? <path d="M0 5h10" {...common} /> : null}
      {kind === 'maximize' ? <rect x="0.5" y="0.5" width="9" height="9" {...common} /> : null}
      {kind === 'restore' ? (
        <>
          <rect x="0.5" y="2.5" width="7" height="7" {...common} />
          <path d="M2.5 2.5V0.5h7v7h-2" {...common} />
        </>
      ) : null}
      {kind === 'close' ? <path d="M0.5 0.5l9 9M9.5 0.5l-9 9" {...common} /> : null}
    </svg>
  )
}

function WindowButton({
  kind,
  label,
  onClick,
  danger
}: {
  kind: 'minimize' | 'maximize' | 'restore' | 'close'
  label: string
  onClick: () => void | Promise<unknown>
  danger?: boolean
}): ReactNode {
  const pending = useRef(false)
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      onClick={() => {
        if (pending.current) return
        pending.current = true
        Promise.resolve().then(onClick).catch(error => toast({ kind: 'error', title: `${label} failed`, description: String(error) })).finally(() => { pending.current = false })
      }}
      className={cn(
        'no-drag grid h-full min-h-9 w-11 shrink-0 place-items-center text-fg-muted',
        'transition-colors duration-[var(--duration-quick)] ease-[var(--ease-smooth-out)]',
        danger ? 'hover:bg-danger hover:text-white' : 'hover:bg-surface-3 hover:text-fg'
      )}
    >
      <Glyph kind={kind} />
    </button>
  )
}

/**
 * Custom title bar for the frameless window: brand on the left, quick actions
 * and native window controls on the right.
 */
export function TitleBar(): ReactNode {
  const cycleTheme = useApp((state) => state.cycleTheme)
  const setCommandOpen = useApp((state) => state.setCommandOpen)
  const themeMode = useApp((state) => state.settings.theme)
  const theme = useResolvedTheme()
  const [maximized, setMaximized] = useState(false)
  const update = useApp((state) => state.update)

  useEffect(() => {
    void ipc.invoke('window:isMaximized').then(setMaximized).catch(() => undefined)
  }, [])

  useIpcEvent('window:maximized', setMaximized)

  return (
    <header className="drag-region relative z-40 flex h-[48px] shrink-0 items-end border-b border-line bg-bg">
      <div className="flex h-11 min-w-0 flex-1 items-center px-4">
        <Wordmark />
      </div>

      {/* Windows reserves the outer resize border before Chromium hit testing.
          Keep a visible 8px title strip above the full 44px button hit areas. */}
      <div className="no-drag flex h-11 items-stretch gap-1 pr-1">
        {update?.phase === 'ready' ? (
          <button
            type="button"
            onClick={() => {
              void ipc.invoke('update:install').then((started) => {
                if (!started) toast({ kind: 'error', title: 'The update is not ready to install yet.' })
              }).catch((error) => toast({ kind: 'error', title: 'Could not start the update', description: String(error) }))
            }}
            title={`Sonic ${update.availableVersion} is downloaded. Restart to install it.`}
            className="mr-1 flex h-7 self-center items-center gap-1.5 rounded-[2px] border border-[var(--sonic-accent-line)] bg-accent-softer px-2 text-[12px] font-medium text-accent transition-colors duration-[var(--duration-quick)] hover:brightness-110"
          >
            <RotateCw aria-hidden="true" className="size-3" />
            <span>Restart to update</span>
          </button>
        ) : null}

        <button
          type="button"
          onClick={() => void cycleTheme()}
          title={`Theme: ${THEME_LABELS[themeMode]} — click to cycle`}
          aria-label={`Theme: ${THEME_LABELS[themeMode]}. Click to cycle.`}
          className="grid size-8 self-center place-items-center rounded-[2px] text-fg-subtle transition-colors duration-[var(--duration-quick)] hover:bg-surface-2 hover:text-fg"
        >
          <IconSwap
            swapped={theme === 'light'}
            className="size-4"
            first={<Sun className="size-4" />}
            second={<Moon className="size-4" />}
          />
        </button>

        <button
          type="button"
          onClick={() => setCommandOpen(true)}
          className="flex h-7 self-center items-center gap-2 rounded-[2px] border border-line px-2 text-[12px] font-medium text-fg-muted transition-colors duration-[var(--duration-quick)] hover:border-line-strong hover:text-fg"
        >
          <Command aria-hidden="true" className="size-3 text-fg-subtle" />
          <span>Commands</span>
          <kbd className="ml-1 font-sans text-[12px] font-semibold text-fg-subtle">
            Ctrl K
          </kbd>
        </button>

        <span aria-hidden="true" className="w-2" />

        <WindowButton kind="minimize" label="Minimize" onClick={() => ipc.invoke('window:minimize')} />
        <WindowButton
          kind={maximized ? 'restore' : 'maximize'}
          label={maximized ? 'Restore' : 'Maximize'}
          onClick={() => ipc.invoke('window:toggleMaximize').then(setMaximized)}
        />
        <WindowButton
          kind="close"
          label="Close"
          danger
          onClick={() => ipc.invoke('window:close')}
        />
      </div>
    </header>
  )
}
