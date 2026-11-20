import type { ReactNode } from 'react'
import { cn } from '@/lib/cn'

interface SettingsPanelProps {
  title: string
  description?: string
  accessory?: ReactNode
  children: ReactNode
  className?: string
  bodyClassName?: string
}

/** Flat preference rows, with section labels aligned beside their controls. */
export function SettingsPanel({
  title,
  description,
  accessory,
  children,
  className,
  bodyClassName
}: SettingsPanelProps): ReactNode {
  return (
    <section className={cn('grid gap-4 border-b border-line py-5 min-[1000px]:grid-cols-[180px_minmax(0,1fr)] min-[1000px]:gap-8', className)}>
      <div className="min-w-0">
        <h3 className="text-[13.5px] font-medium text-fg">{title}</h3>
        {description ? (
          <p className="mt-1 text-[12px] leading-relaxed text-fg-subtle">{description}</p>
        ) : null}
        {accessory ? <div className="mt-2">{accessory}</div> : null}
      </div>
      <div className={cn('min-w-0', bodyClassName)}>{children}</div>
    </section>
  )
}
