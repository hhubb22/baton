import * as stylex from '@stylexjs/stylex'
import { createContext, useContext, useEffect, useState, useSyncExternalStore, type ReactNode } from 'react'
import { darkTheme, lightTheme } from './themes'
import { colors } from './tokens.stylex'

export type ThemeMode = 'system' | 'light' | 'dark'

const storageKey = 'baton.theme'

const page = stylex.create({
  root: {
    backgroundColor: colors.canvas,
    color: colors.text,
    colorScheme: 'light dark',
  },
  light: { colorScheme: 'light' },
  dark: { colorScheme: 'dark' },
})

const ThemeContext = createContext<{ mode: ThemeMode; setMode: (mode: ThemeMode) => void }>({
  mode: 'system',
  setMode: () => {},
})

function readMode(): ThemeMode {
  try {
    const value = localStorage.getItem(storageKey)
    if (value === 'light' || value === 'dark') return value
  } catch {
    // 无痕窗口等环境读不到存储时跟随系统。
  }
  return 'system'
}

// 主题类名挂在 <html> 上，弹层 portal 也能继承颜色变量。
export function ThemeProvider({ children }: { children: ReactNode }) {
  const [mode, setModeState] = useState<ThemeMode>(readMode)

  useEffect(() => {
    const props = stylex.props(
      page.root,
      mode === 'light' && [lightTheme, page.light],
      mode === 'dark' && [darkTheme, page.dark],
    )
    const root = document.documentElement
    root.className = props.className ?? ''
  }, [mode])

  const setMode = (next: ThemeMode) => {
    setModeState(next)
    try {
      if (next === 'system') localStorage.removeItem(storageKey)
      else localStorage.setItem(storageKey, next)
    } catch {
      // 存不下时只在本次打开内生效。
    }
  }

  return <ThemeContext value={{ mode, setMode }}>{children}</ThemeContext>
}

export function useTheme() {
  return useContext(ThemeContext)
}

const darkQuery = '(prefers-color-scheme: dark)'

function subscribeSystem(onChange: () => void) {
  const media = window.matchMedia?.(darkQuery)
  media?.addEventListener('change', onChange)
  return () => media?.removeEventListener('change', onChange)
}

function systemIsDark() {
  return window.matchMedia?.(darkQuery).matches ?? false
}

// 实际生效的浅色或深色，用于需要换资源的地方，例如彩色品牌标识。
export function useResolvedTheme(): 'light' | 'dark' {
  const { mode } = useTheme()
  const dark = useSyncExternalStore(subscribeSystem, systemIsDark, () => false)
  if (mode === 'system') return dark ? 'dark' : 'light'
  return mode
}
