import { useResolvedTheme } from '../theme/ThemeProvider'
import { Icon } from './Icon'

// 侧栏用单色标识，颜色跟随文字；登录页用随主题切换的彩色标识。
export function BrandMark({ tone = 'mono', size = 24 }: { tone?: 'mono' | 'color'; size?: 24 | 36 }) {
  const theme = useResolvedTheme()
  const name = tone === 'mono' ? 'baton-mark-mono' : theme === 'dark' ? 'baton-mark-dark' : 'baton-mark'
  return <Icon name={name} size={size} label="Baton" />
}
