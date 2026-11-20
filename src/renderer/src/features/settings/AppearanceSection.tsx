import type { ReactNode } from 'react'
import { Monitor, Moon, Sun } from 'lucide-react'
import type { ReduceMotionPreference, ThemeMode } from '@shared/domain'
import { useApp } from '@/store/app'
import { Segmented } from '@/components/ui/Segmented'
import { MagnetTabs } from '@/components/obsidian/MagnetTabs'
import { SettingsPanel } from './SettingsPanel'

export function AppearanceSection(): ReactNode {
  const settings = useApp((state) => state.settings)
  const patchSettings = useApp((state) => state.patchSettings)

  return (
    <div>
      <SettingsPanel title="Theme" description="Choose a color scheme.">
        <MagnetTabs
          value={settings.theme}
          onChange={(next) => void patchSettings({ theme: next as ThemeMode })}
          ariaLabel="Theme"
          mode="choices"
          variant="segmented"
          className="!rounded-md !bg-transparent !p-0 [&>button]:!h-8 [&>button]:!rounded-md [&>button]:!px-3 [&>button]:!py-1 [&>.t-tabs-pill]:!top-0 [&>.t-tabs-pill]:!h-8 [&>.t-tabs-pill]:!rounded-md [&>.t-tabs-pill]:!bg-surface-2 [&>.t-tabs-pill]:!shadow-none"
          tabs={[
            { value: 'dark', label: 'Dark', icon: <Moon /> },
            { value: 'light', label: 'Light', icon: <Sun /> },
            { value: 'system', label: 'System', icon: <Monitor /> }
          ]}
        />
      </SettingsPanel>


      <SettingsPanel title="Motion preference" description="Control interface animations.">
        <Segmented
          value={settings.reduceMotion}
          onChange={(next: ReduceMotionPreference) => void patchSettings({ reduceMotion: next })}
          ariaLabel="Motion preference"
          options={[
            { value: 'system', label: 'Follow system' },
            { value: 'on', label: 'Always reduce' },
            { value: 'off', label: 'Always animate' }
          ]}
          size="sm"
        />
      </SettingsPanel>
    </div>
  )
}
