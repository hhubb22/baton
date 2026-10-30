import * as stylex from '@stylexjs/stylex'
import { createContext, useContext, useEffect, useState, useSyncExternalStore, type ReactNode } from 'react'
import {
  colorProperty,
  defaultInputs,
  generateTheme,
  highContrastInputs,
  type SemanticColor,
  type ThemeInputs,
} from './generate'
import { semantic } from './semantic.stylex'

export type ThemeMode = 'system' | 'light' | 'dark'

const storageKey = 'baton.theme'

const page = stylex.create({
  root: {
    backgroundColor: semantic.background,
    color: semantic.foreground,
    colorScheme: 'light dark',
  },
  light: { colorScheme: 'light' },
  dark: { colorScheme: 'dark' },
})

const ThemeContext = createContext<{ mode: ThemeMode; setMode: (mode: ThemeMode) => void }>({
  mode: 'system',
  setMode: () => {},
})

const moreContrastQuery = '(prefers-contrast: more)'

// 用生成器的结果覆盖 <html> 上的语义颜色。传 null 时恢复样式表里的默认值。
export function applyThemeInputs(inputs: ThemeInputs | null) {
  const root = document.documentElement
  const theme = generateTheme(inputs ?? defaultInputs)
  for (const name of Object.keys(theme) as SemanticColor[]) {
    const property = colorProperty(name)
    if (inputs) root.style.setProperty(property, theme[name])
    else root.style.removeProperty(property)
  }
}

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
    const props = stylex.props(page.root, mode === 'light' && page.light, mode === 'dark' && page.dark)
    const root = document.documentElement
    root.className = props.className ?? ''
    if (mode === 'system') delete root.dataset.openuiTheme
    else root.dataset.openuiTheme = mode
  }, [mode])

  useEffect(() => {
    if (typeof window.matchMedia !== 'function') return
    const query = window.matchMedia(moreContrastQuery)
    const apply = () => applyThemeInputs(query.matches ? highContrastInputs : null)
    apply()
    query.addEventListener('change', apply)
    return () => query.removeEventListener('change', apply)
  }, [])

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
