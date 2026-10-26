import * as stylex from '@stylexjs/stylex'
import type { ReactNode } from 'react'
import { glassImage, sceneImage } from '../theme/backdrop'
import { useResolvedTheme } from '../theme/ThemeProvider'
import { colors, space } from '../theme/tokens.stylex'

// frost 图和 scene 图都按视口固定铺满，玻璃面板里的模糊背景和外面的场景位置一致。
const styles = stylex.create({
  page: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    minHeight: '100vh',
    padding: space.xl,
    backgroundColor: colors.canvas,
    backgroundPosition: 'center',
    backgroundSize: 'cover',
    backgroundAttachment: 'fixed',
  },
  panel: {
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
    gap: space.xl,
    width: '100%',
    maxWidth: '400px',
    paddingTop: '36px',
    paddingInline: '32px',
    paddingBottom: '28px',
    backgroundPosition: 'center',
    backgroundSize: 'cover',
    backgroundAttachment: 'fixed',
    borderWidth: '1px',
    borderStyle: 'solid',
    borderColor: colors.glassEdge,
    borderRadius: '24px',
    boxShadow: `0 24px 64px ${colors.shadowFar}`,
  },
  backdrop: (image: string) => ({ backgroundImage: image }),
})

// 登录和改密码页：场景图上的一块玻璃面板，表单直接放在面板里。
export function AuthShell({ children }: { children: ReactNode }) {
  const theme = useResolvedTheme()
  return (
    <main {...stylex.props(styles.page, styles.backdrop(sceneImage(theme)))}>
      <div {...stylex.props(styles.panel, styles.backdrop(glassImage(theme)))}>{children}</div>
    </main>
  )
}
