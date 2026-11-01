// 设计 token：间距、圆角、尺寸、阴影和动效。颜色在 semantic.stylex.ts，组件直接使用那里的语义名。
import * as stylex from '@stylexjs/stylex'

// Project 头像底色，按创建顺序轮换。
export const hues = stylex.defineConsts({
  slate: 'oklch(0.58 0.03 255)',
  amber: 'oklch(0.56 0.11 75)',
  violet: 'oklch(0.56 0.11 295)',
  green: 'oklch(0.55 0.1 150)',
  blue: 'oklch(0.56 0.1 245)',
  rose: 'oklch(0.56 0.13 10)',
})

export const space = stylex.defineConsts({
  xxs: '2px',
  xs: '4px',
  sm: '8px',
  md: '12px',
  lg: '16px',
  xl: '24px',
  xxl: '32px',
  section: '48px',
  canvas: '64px',
})

// 控件和小面板用 sm、md，卡片、菜单、弹窗用 lg，外框用 xl。
export const radius = stylex.defineConsts({
  inner: 'var(--radius-inner)',
  sm: 'var(--radius-sm)',
  md: 'var(--radius-md)',
  lg: 'var(--radius-lg)',
  xl: 'var(--radius-xl)',
  pill: '999px',
})

export const size = stylex.defineConsts({
  micro: '20px',
  row: '28px',
  compact: '28px',
  control: '32px',
  comfortable: '40px',
  header: '48px',
  gutter: '8px',
  measure: '720px',
  dot: '6px',
  screenWidth: '1440px',
  screenHeight: '900px',
})

// 控件贴地、Frame 面板稍浮、菜单和 Tooltip 浮起、弹窗最高。
export const shadow = stylex.defineConsts({
  control: '0 1px 2px var(--color-shadow-soft), inset 0 1px var(--color-edge-high), inset 0 -1px var(--color-edge-low)',
  panel:
    '0 1px 2px var(--color-shadow-soft), 0 2px 6px -2px var(--color-shadow-soft), inset 0 1px var(--color-edge-high), inset 0 -1px var(--color-edge-low)',
  floating:
    '0 8px 24px var(--color-shadow-far), 0 1px 3px var(--color-shadow-soft), inset 0 1px var(--color-edge-high)',
  modal: '0 16px 40px var(--color-shadow-far), 0 2px 6px var(--color-shadow-near), inset 0 1px var(--color-edge-high)',
  // 深色填充上的顶部高光，主按钮和危险按钮用。
  filled: '0 1px 2px var(--color-shadow-near), inset 0 1px oklch(1 0 0 / 0.16)',
  focus: '0 0 0 3px color-mix(in oklab, var(--color-ring) 24%, transparent)',
  focusDanger: '0 0 0 3px color-mix(in oklab, var(--color-destructive) 20%, transparent)',
})

// 取值在 global.css 的 :root，系统减少动态效果时全部归零，画廊可整体放慢。
// micro 用于控件反馈，popover 用于弹层和折叠，modal 用于弹窗，layout 用于面板宽度，exit 用于退场。
// easeOut 用于进出场，easeInOut 用于屏幕内移动，easeDrawer 用于面板展开和收起。
export const motion = stylex.defineConsts({
  micro: 'var(--motion-micro)',
  popover: 'var(--motion-popover)',
  modal: 'var(--motion-modal)',
  layout: 'var(--motion-layout)',
  exit: 'var(--motion-exit)',
  hoverDelay: 'var(--motion-hover-delay)',
  activity: 'var(--motion-activity)',
  shimmer: 'var(--motion-shimmer)',
  easeOut: 'var(--ease-out)',
  easeInOut: 'var(--ease-in-out)',
  easeDrawer: 'var(--ease-drawer)',
})
