import type { ReactNode } from 'react'
import { Download, Library, Settings as SettingsIcon } from 'lucide-react'
import { cn } from '@/lib/cn'
import { useApp, type ViewId } from '@/store/app'

interface NavItemProps {
  icon: ReactNode
  label: string
  active: boolean
  onClick: () => void
}

function NavItem({ icon, label, active, onClick }: NavItemProps): ReactNode {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-current={active ? 'page' : undefined}
      className={cn(
        'group flex h-9 w-full items-center gap-2.5 rounded-[2px] px-3 text-left',
        'transition-colors duration-[var(--duration-quick)] ease-[var(--ease-smooth-out)]',
        active ? 'bg-surface-2 text-fg shadow-[inset_1px_0_0_var(--sonic-accent)]' : 'text-fg-muted hover:bg-surface-2/60 hover:text-fg'
      )}
    >
      <span aria-hidden="true" className={cn('shrink-0 [&>svg]:size-4 [&>svg]:stroke-[1.6]', active ? 'text-accent' : 'text-fg-subtle group-hover:text-fg-muted')}>
        {icon}
      </span>
      <span className="truncate text-[13.5px] font-semibold">{label}</span>
    </button>
  )
}

/** The persistent workspace navigation. */
export function Sidebar(): ReactNode {
  const view = useApp((state) => state.view)
  const setView = useApp((state) => state.setView)
  const engine = useApp((state) => state.engine)

  const engineReady = engine?.ready ?? false

  const go = (next: ViewId): void => setView(next)

  return (
    <nav aria-label="Main navigation" className="flex w-[196px] shrink-0 flex-col overflow-y-auto border-r border-line bg-bg px-3 py-4">
      <div className="space-y-1">
        <NavItem
          icon={<Download />}
          label="Download"
          active={view === 'download'}
          onClick={() => go('download')}
        />
        <NavItem
          icon={<Library />}
          label="Library"
          active={view === 'library'}
          onClick={() => go('library')}
        />
      </div>

      <div className="min-h-8 flex-1" />

      <NavItem
        icon={<SettingsIcon />}
        label="Settings"
        active={view === 'settings'}
        onClick={() => go('settings')}
      />

      <button
        type="button"
        aria-label="Media engine status. Open settings"
        onClick={() => go('settings')}
        className={cn(
          'mt-2 flex h-8 shrink-0 items-center gap-2 rounded-[2px] px-3 text-left text-[12px] font-medium text-fg-subtle',
          'transition-colors duration-[var(--duration-quick)] ease-[var(--ease-smooth-out)] hover:text-fg-muted'
        )}
        title={engine?.lastError ?? (engineReady ? 'Media engine ready' : 'Media engine setup required')}
      >
        <span aria-hidden="true" className={cn('size-1.5 shrink-0 rounded-full', engineReady ? 'bg-success' : 'bg-warning')} />
        <span className="truncate">{engineReady ? 'Engine ready' : 'Setup required'}</span>
      </button>
    </nav>
  )
}
