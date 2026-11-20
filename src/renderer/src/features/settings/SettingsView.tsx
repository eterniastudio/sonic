import { useState, type ReactNode } from 'react'
import { MagnetTabs } from '@/components/obsidian/MagnetTabs'
import { AboutSection } from './AboutSection'
import { AdvancedSection } from './AdvancedSection'
import { AppearanceSection } from './AppearanceSection'
import { EngineSection } from './EngineSection'
import { ExportSection } from './ExportSection'

type Tab = 'appearance' | 'export' | 'engine' | 'advanced' | 'about'

const SECTIONS: { value: Tab; label: string }[] = [
  { value: 'appearance', label: 'Appearance' },
  { value: 'export', label: 'Export' },
  { value: 'engine', label: 'Media engine' },
  { value: 'advanced', label: 'Advanced' },
  { value: 'about', label: 'About' }
]

/** Focused preferences with a stable category bar and clearly grouped controls. */
export function SettingsView(): ReactNode {
  const [tab, setTab] = useState<Tab>(() => {
    const saved = localStorage.getItem('settings-tab')
    return SECTIONS.some((section) => section.value === saved) ? saved as Tab : 'appearance'
  })

  return (
    <div className="workspace-page h-full overflow-y-auto">
      <div className="mx-auto w-full max-w-[960px] pb-6">
        <header className="page-header mb-3">
          <h1 className="page-title">Settings</h1>
        </header>

        <div className="border-b border-line">
          <MagnetTabs
            value={tab}
            onChange={(next) => { setTab(next as Tab); localStorage.setItem('settings-tab', next) }}
            ariaLabel="Settings sections"
            tabs={SECTIONS}
            className="max-w-full gap-6 !rounded-none !border-0 !bg-transparent !p-0 [&>button]:!rounded-none [&>button]:!px-0 [&>button]:!py-3 [&>span]:!top-auto [&>span]:!bottom-[-1px] [&>span]:!h-px [&>span]:!rounded-none [&>span]:!bg-fg [&>span]:!shadow-none"
          />
        </div>

        <div role="tabpanel" id={`settings-panel-${tab}`} aria-labelledby={`settings-tab-${tab}`}>
          {tab === 'appearance' ? <AppearanceSection /> : null}
          {tab === 'export' ? <ExportSection /> : null}
          {tab === 'engine' ? <EngineSection /> : null}
          {tab === 'advanced' ? <AdvancedSection /> : null}
          {tab === 'about' ? <AboutSection /> : null}
        </div>
      </div>
    </div>
  )
}
