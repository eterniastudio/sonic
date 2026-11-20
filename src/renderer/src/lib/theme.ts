import { useEffect } from 'react'
import { useMediaQuery } from './hooks'
import { useApp } from '../store/app'

export type ResolvedTheme = 'dark' | 'light'

/** Resolves `system` against the OS preference. */
export function useResolvedTheme(): ResolvedTheme {
  const mode = useApp((state) => state.settings.theme)
  const systemDark = useMediaQuery('(prefers-color-scheme: dark)')
  if (mode === 'system') return systemDark ? 'dark' : 'light'
  return mode
}

/**
 * Mirrors settings onto `<html>` so both Sonic's tokens and the vendored
 * transitions.dev `data-theme` hooks resolve from one place.
 */
export function useThemeSync(): void {
  const theme = useResolvedTheme()
  const accent = useApp((state) => state.settings.accent)
  const reduceMotion = useApp((state) => state.settings.reduceMotion)
  const systemReduced = useMediaQuery('(prefers-reduced-motion: reduce)')

  useEffect(() => {
    const root = document.documentElement
    root.dataset.theme = theme
    root.dataset.accent = accent

    const reduced = reduceMotion === 'on' || (reduceMotion === 'system' && systemReduced)
    root.dataset.reduceMotion = reduced ? 'true' : 'false'
  }, [theme, accent, reduceMotion, systemReduced])
}

export const THEME_LABELS: Record<string, string> = {
  dark: 'Dark',
  light: 'Light',
  system: 'System'
}

/** Effective preference, including the explicit in-app override. */
export function useReducedMotion(): boolean {
  const preference = useApp(state => state.settings.reduceMotion)
  const system = useMediaQuery('(prefers-reduced-motion: reduce)')
  return preference === 'on' || (preference === 'system' && system)
}
