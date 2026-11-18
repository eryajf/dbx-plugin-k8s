/* eslint-disable react-refresh/only-export-components */
import { createContext, useContext, useEffect, useState } from 'react'

type Theme = 'dark' | 'light' | 'system'
type ResolvedTheme = 'dark' | 'light'

type ThemeProviderProps = {
  children: React.ReactNode
  defaultTheme?: Theme
  storageKey?: string
  // Host-owned appearance (e.g. the DBX workbench theme). When set it wins
  // over the stored preference so the plugin follows the surrounding shell.
  overrideTheme?: ResolvedTheme | null
}

type ThemeProviderState = {
  theme: Theme
  actualTheme: ResolvedTheme
  setTheme: (theme: Theme) => void
}

const initialState: ThemeProviderState = {
  theme: 'system',
  setTheme: () => null,
  actualTheme: 'light',
}

const ThemeProviderContext = createContext<ThemeProviderState>(initialState)

export function ThemeProvider({
  children,
  defaultTheme = 'system',
  storageKey = 'vite-ui-theme',
  overrideTheme = null,
  ...props
}: ThemeProviderProps) {
  const [theme, setTheme] = useState<Theme>(
    () => (localStorage.getItem(storageKey) as Theme) || defaultTheme
  )
  const appliedTheme = overrideTheme ?? theme
  const [actualTheme, setActualTheme] = useState<ResolvedTheme>(
    appliedTheme === 'system'
      ? window.matchMedia('(prefers-color-scheme: dark)').matches
        ? 'dark'
        : 'light'
      : appliedTheme
  )

  // Watch for system theme changes when theme is 'system'
  useEffect(() => {
    if (appliedTheme === 'system') {
      const mediaQuery = window.matchMedia('(prefers-color-scheme: dark)')
      const handleChange = () => {
        const root = window.document.documentElement
        root.classList.remove('light', 'dark')

        const systemTheme = mediaQuery.matches ? 'dark' : 'light'
        root.classList.add(systemTheme)
        root.style.colorScheme = systemTheme
        setActualTheme(systemTheme)
      }

      handleChange()
      mediaQuery.addEventListener('change', handleChange)
      return () => mediaQuery.removeEventListener('change', handleChange)
    }
    const root = window.document.documentElement
    root.classList.remove('light', 'dark')
    setActualTheme(appliedTheme)
    root.classList.add(appliedTheme)
    root.style.colorScheme = appliedTheme
  }, [appliedTheme])

  useEffect(() => {
    const handleStorage = (event: StorageEvent) => {
      if (event.key !== storageKey || event.newValue === null) {
        return
      }

      if (
        event.newValue === 'light' ||
        event.newValue === 'dark' ||
        event.newValue === 'system'
      ) {
        setTheme(event.newValue)
      }
    }

    window.addEventListener('storage', handleStorage)
    return () => window.removeEventListener('storage', handleStorage)
  }, [storageKey])

  const value = {
    theme: appliedTheme,
    setTheme: (theme: Theme) => {
      localStorage.setItem(storageKey, theme)
      setTheme(theme)
    },
    actualTheme,
  }

  return (
    <ThemeProviderContext.Provider {...props} value={value}>
      {children}
    </ThemeProviderContext.Provider>
  )
}

export const useTheme = () => {
  const context = useContext(ThemeProviderContext)

  if (context === undefined)
    throw new Error('useTheme must be used within a ThemeProvider')

  return context
}
