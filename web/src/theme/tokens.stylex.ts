// 由 scripts/tokens.mjs 从 design/tokens 生成，不要手改。修改设计稿后运行 `pnpm --dir web tokens`。
import * as stylex from '@stylexjs/stylex'

// 主题默认跟随系统；用户手动选择时由 themes.ts 覆盖。
export const colors = stylex.defineVars({
  canvas: { default: 'rgb(98.8% 98.8% 98.7%)', '@media (prefers-color-scheme: dark)': 'rgb(8.6% 8.6% 9%)' },
  panel: { default: 'rgb(96.4% 96.4% 96.2%)', '@media (prefers-color-scheme: dark)': 'rgb(6.6% 6.6% 7%)' },
  surface: { default: '#fff', '@media (prefers-color-scheme: dark)': 'rgb(11.6% 11.6% 12%)' },
  subtle: { default: 'rgb(94.2% 94.2% 94%)', '@media (prefers-color-scheme: dark)': 'rgb(14% 14% 14.5%)' },
  hover: { default: 'rgb(0% 0% 0% / 4%)', '@media (prefers-color-scheme: dark)': 'rgb(100% 100% 100% / 6%)' },
  selected: { default: 'rgb(0% 0% 0% / 6%)', '@media (prefers-color-scheme: dark)': 'rgb(100% 100% 100% / 9%)' },
  hairline: { default: 'rgb(0% 0% 0% / 6%)', '@media (prefers-color-scheme: dark)': 'rgb(100% 100% 100% / 7%)' },
  borderSoft: { default: 'rgb(0% 0% 0% / 8%)', '@media (prefers-color-scheme: dark)': 'rgb(100% 100% 100% / 8%)' },
  border: { default: 'rgb(0% 0% 0% / 11%)', '@media (prefers-color-scheme: dark)': 'rgb(100% 100% 100% / 12%)' },
  borderStrong: { default: 'rgb(0% 0% 0% / 16%)', '@media (prefers-color-scheme: dark)': 'rgb(100% 100% 100% / 16%)' },
  text: { default: 'rgb(11.6% 11.6% 12%)', '@media (prefers-color-scheme: dark)': 'rgb(96% 96% 96.2%)' },
  muted: { default: 'rgb(40% 40% 41%)', '@media (prefers-color-scheme: dark)': 'rgb(68% 68% 69.5%)' },
  faint: { default: 'rgb(56% 56% 57%)', '@media (prefers-color-scheme: dark)': 'rgb(50% 50% 51.5%)' },
  accent: { default: 'rgb(17% 42% 93%)', '@media (prefers-color-scheme: dark)': 'rgb(30% 55% 98%)' },
  accentHover: { default: 'rgb(13% 36% 85%)', '@media (prefers-color-scheme: dark)': 'rgb(38% 62% 100%)' },
  accentPressed: { default: 'rgb(11% 31% 76%)', '@media (prefers-color-scheme: dark)': 'rgb(25% 48% 90%)' },
  accentSoft: { default: 'rgb(92% 95% 100%)', '@media (prefers-color-scheme: dark)': 'rgb(12% 19% 32%)' },
  accentSoftHover: { default: 'rgb(86.5% 91.5% 100%)', '@media (prefers-color-scheme: dark)': 'rgb(15% 24% 40%)' },
  onAccent: '#fff',
  agent: { default: 'rgb(4.34% 62.32% 58.42%)', '@media (prefers-color-scheme: dark)': 'rgb(32.72% 75% 71.06%)' },
  agentText: { default: 'rgb(0% 45.24% 42.24%)', '@media (prefers-color-scheme: dark)': 'rgb(45% 82% 78%)' },
  agentSoft: { default: 'rgb(89.94% 97.31% 96.3%)', '@media (prefers-color-scheme: dark)': 'rgb(4.85% 18.51% 17.29%)' },
  onAgent: { default: '#fff', '@media (prefers-color-scheme: dark)': 'rgb(4% 10% 10%)' },
  link: { default: 'rgb(14% 40% 76%)', '@media (prefers-color-scheme: dark)': 'rgb(49% 69% 95%)' },
  focus: { default: 'rgb(24% 52% 92%)', '@media (prefers-color-scheme: dark)': 'rgb(40% 64.6% 100%)' },
  info: { default: 'rgb(15.5% 51.6% 83.6%)', '@media (prefers-color-scheme: dark)': 'rgb(44% 70% 96.8%)' },
  infoSoft: { default: 'rgb(91.5% 95.4% 99.4%)', '@media (prefers-color-scheme: dark)': 'rgb(8% 15% 25%)' },
  success: { default: 'rgb(15% 54% 30%)', '@media (prefers-color-scheme: dark)': 'rgb(45% 80.8% 58.6%)' },
  successSoft: { default: 'rgb(91% 96.6% 92.6%)', '@media (prefers-color-scheme: dark)': 'rgb(7% 17% 10%)' },
  attention: { default: 'rgb(91% 41% 12%)', '@media (prefers-color-scheme: dark)': 'rgb(100% 58.6% 38%)' },
  attentionText: { default: 'rgb(70% 30% 6%)', '@media (prefers-color-scheme: dark)': 'rgb(100% 68% 50%)' },
  attentionSoft: { default: 'rgb(99.6% 94.4% 90.4%)', '@media (prefers-color-scheme: dark)': 'rgb(26% 14% 7%)' },
  danger: { default: 'rgb(74.1% 25.8% 22.9%)', '@media (prefers-color-scheme: dark)': 'rgb(96.4% 42.3% 42.8%)' },
  dangerSoft: { default: 'rgb(100% 92.9% 92.6%)', '@media (prefers-color-scheme: dark)': 'rgb(28% 12.6% 13%)' },
  code: { default: 'rgb(95.6% 95.6% 95.4%)', '@media (prefers-color-scheme: dark)': 'rgb(7.5% 7.5% 8%)' },
  codeBorder: { default: 'rgb(0% 0% 0% / 7%)', '@media (prefers-color-scheme: dark)': 'rgb(100% 100% 100% / 8%)' },
  disabled: { default: 'rgb(92.1% 92.1% 92.4%)', '@media (prefers-color-scheme: dark)': 'rgb(15% 15% 15.5%)' },
  disabledText: { default: 'rgb(60% 60% 61%)', '@media (prefers-color-scheme: dark)': 'rgb(42% 42% 43%)' },
  selection: { default: 'rgb(86.2% 91.4% 99%)', '@media (prefers-color-scheme: dark)': 'rgb(11.9% 22.9% 39%)' },
  overlay: { default: 'rgb(0% 0% 0% / 28%)', '@media (prefers-color-scheme: dark)': 'rgb(0% 0% 0% / 55%)' },
  transparent: 'transparent',
})

// Project 头像底色，按创建顺序轮换。
export const hues = stylex.defineConsts({
  slate: 'rgb(36% 42% 52%)',
  amber: 'rgb(85% 55% 15%)',
  violet: 'rgb(50% 40% 80%)',
  green: 'rgb(30% 60% 35%)',
  blue: 'rgb(25% 50% 85%)',
  rose: 'rgb(80% 35% 45%)',
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

export const radius = stylex.defineConsts({
  inner: '4px',
  sm: '6px',
  md: '8px',
  lg: '12px',
  pill: '999px',
})

export const size = stylex.defineConsts({
  micro: '20px',
  row: '28px',
  compact: '28px',
  control: '32px',
  comfortable: '40px',
  header: '48px',
  sidebar: '248px',
  overview: '320px',
  detail: '440px',
  measure: '720px',
  dot: '6px',
  screenWidth: '1440px',
  screenHeight: '900px',
})
