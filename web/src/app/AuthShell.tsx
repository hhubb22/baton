import * as stylex from '@stylexjs/stylex'
import type { ReactNode } from 'react'
import { glass, sceneImage } from '../theme/backdrop'
import { useResolvedTheme } from '../theme/ThemeProvider'
import { semantic } from '../theme/semantic.stylex'
import { radius, shadow, space } from '../theme/tokens.stylex'

// 场景图缓慢平移和缩放，一个来回 60 秒；系统开启减少动态效果时停在原位。
const drift = stylex.keyframes({
  from: { transform: 'scale(1.06) translate3d(-1%, -1%, 0)' },
  to: { transform: 'scale(1.06) translate3d(1%, 1%, 0)' },
})

const styles = stylex.create({
  page: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    minHeight: '100vh',
    padding: space.xl,
    backgroundColor: semantic.background,
    isolation: 'isolate',
    overflow: 'hidden',
  },
  scene: {
    position: 'fixed',
    inset: 0,
    zIndex: -1,
    backgroundPosition: 'center',
    backgroundSize: 'cover',
    transform: 'scale(1.06)',
    animationName: { default: drift, '@media (prefers-reduced-motion: reduce)': 'none' },
    animationDuration: '30s',
    animationTimingFunction: 'ease-in-out',
    animationIterationCount: 'infinite',
    animationDirection: 'alternate',
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
    borderWidth: '1px',
    borderStyle: 'solid',
    borderColor: semantic.glassEdge,
    borderRadius: radius.xl,
    boxShadow: shadow.modal,
  },
  backdrop: (image: string) => ({ backgroundImage: image }),
})

// 登录和改密码页：场景图上的一块玻璃面板，表单直接放在面板里。
export function AuthShell({ children }: { children: ReactNode }) {
  const theme = useResolvedTheme()
  return (
    <main {...stylex.props(styles.page)}>
      <div aria-hidden {...stylex.props(styles.scene, styles.backdrop(sceneImage(theme)))} />
      <div {...stylex.props(styles.panel, glass.layer)}>{children}</div>
    </main>
  )
}
