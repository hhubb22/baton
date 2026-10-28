// 设计 token：颜色、间距、圆角和尺寸。新颜色同时在 themes.ts 补上浅色和深色取值。
import * as stylex from '@stylexjs/stylex'

// 主题默认跟随系统；用户手动选择时由 themes.ts 覆盖。
export const colors = stylex.defineVars({
  glass: { default: 'rgb(100% 100% 100% / 66%)', '@media (prefers-color-scheme: dark)': 'rgb(4% 5% 8% / 72%)' },
  glassLift: {
    default: 'rgb(100% 100% 100% / 50%)',
    '@media (prefers-color-scheme: dark)': 'rgb(100% 100% 100% / 4%)',
  },
  glassEdge: {
    default: 'rgb(100% 100% 100% / 55%)',
    '@media (prefers-color-scheme: dark)': 'rgb(100% 100% 100% / 9%)',
  },
  raised: { default: 'rgb(100% 100% 100% / 78%)', '@media (prefers-color-scheme: dark)': 'rgb(100% 100% 100% / 10%)' },
  shadowSoft: {
    default: 'rgb(10.2% 12.3% 16.1% / 5%)',
    '@media (prefers-color-scheme: dark)': 'rgb(0.4% 0.7% 1.3% / 20%)',
  },
  shadowNear: {
    default: 'rgb(10.2% 12.3% 16.1% / 8%)',
    '@media (prefers-color-scheme: dark)': 'rgb(0.4% 0.7% 1.3% / 30%)',
  },
  shadowFar: {
    default: 'rgb(10.2% 12.3% 16.1% / 14%)',
    '@media (prefers-color-scheme: dark)': 'rgb(0.4% 0.7% 1.3% / 45%)',
  },
  highlight: {
    default: 'rgb(100% 100% 100% / 28%)',
    '@media (prefers-color-scheme: dark)': 'rgb(100% 100% 100% / 20%)',
  },
  sheen: { default: 'rgb(100% 100% 100% / 14%)', '@media (prefers-color-scheme: dark)': 'rgb(100% 100% 100% / 10%)' },
  keyTop: { default: 'rgb(100% 100% 100% / 8%)', '@media (prefers-color-scheme: dark)': 'rgb(100% 100% 100% / 6%)' },
  keyBottom: {
    default: 'rgb(10.2% 12.3% 16.1% / 4%)',
    '@media (prefers-color-scheme: dark)': 'rgb(0.4% 0.7% 1.3% / 14%)',
  },
  keyHighlight: {
    default: 'rgb(100% 100% 100% / 95%)',
    '@media (prefers-color-scheme: dark)': 'rgb(100% 100% 100% / 7%)',
  },
  keyShade: {
    default: 'rgb(10.2% 12.3% 16.1% / 6%)',
    '@media (prefers-color-scheme: dark)': 'rgb(0.4% 0.7% 1.3% / 30%)',
  },
  keyPress: {
    default: 'rgb(10.2% 12.3% 16.1% / 14%)',
    '@media (prefers-color-scheme: dark)': 'rgb(0.4% 0.7% 1.3% / 45%)',
  },
  keyGround: {
    default: 'rgb(100% 100% 100% / 90%)',
    '@media (prefers-color-scheme: dark)': 'rgb(100% 100% 100% / 4%)',
  },
  keyEdgeSolid: {
    default: 'rgb(0.4% 0.7% 1.3% / 22%)',
    '@media (prefers-color-scheme: dark)': 'rgb(0.4% 0.7% 1.3% / 45%)',
  },
  keyShadeSolid: {
    default: 'rgb(0.4% 0.7% 1.3% / 22%)',
    '@media (prefers-color-scheme: dark)': 'rgb(0.4% 0.7% 1.3% / 30%)',
  },
  keyPressSolid: {
    default: 'rgb(0.4% 0.7% 1.3% / 40%)',
    '@media (prefers-color-scheme: dark)': 'rgb(0.4% 0.7% 1.3% / 50%)',
  },
  keyLiftSolid: {
    default: 'rgb(10.2% 12.3% 16.1% / 22%)',
    '@media (prefers-color-scheme: dark)': 'rgb(0.4% 0.7% 1.3% / 45%)',
  },
  canvas: { default: 'rgb(98.1% 98.4% 99%)', '@media (prefers-color-scheme: dark)': 'rgb(7% 7.8% 9.2%)' },
  panel: { default: 'rgb(95.8% 96.4% 97.4%)', '@media (prefers-color-scheme: dark)': 'rgb(5.3% 6.1% 7.4%)' },
  surface: { default: '#fff', '@media (prefers-color-scheme: dark)': 'rgb(10% 10.9% 12.6%)' },
  subtle: { default: 'rgb(92.9% 93.8% 95.4%)', '@media (prefers-color-scheme: dark)': 'rgb(13.1% 14.2% 16.1%)' },
  hover: {
    default: 'rgb(10.2% 12.3% 16.1% / 4%)',
    '@media (prefers-color-scheme: dark)': 'rgb(93.5% 94.2% 95.2% / 6%)',
  },
  selected: {
    default: 'rgb(10.2% 12.3% 16.1% / 7%)',
    '@media (prefers-color-scheme: dark)': 'rgb(93.5% 94.2% 95.2% / 9%)',
  },
  hairline: {
    default: 'rgb(10.2% 12.3% 16.1% / 7%)',
    '@media (prefers-color-scheme: dark)': 'rgb(93.5% 94.2% 95.2% / 7%)',
  },
  borderSoft: {
    default: 'rgb(10.2% 12.3% 16.1% / 9%)',
    '@media (prefers-color-scheme: dark)': 'rgb(93.5% 94.2% 95.2% / 8%)',
  },
  border: {
    default: 'rgb(10.2% 12.3% 16.1% / 13%)',
    '@media (prefers-color-scheme: dark)': 'rgb(93.5% 94.2% 95.2% / 12%)',
  },
  borderStrong: {
    default: 'rgb(10.2% 12.3% 16.1% / 19%)',
    '@media (prefers-color-scheme: dark)': 'rgb(93.5% 94.2% 95.2% / 17%)',
  },
  text: { default: 'rgb(11% 12.3% 14.5%)', '@media (prefers-color-scheme: dark)': 'rgb(93.5% 94.2% 95.2%)' },
  muted: { default: 'rgb(28.6% 30.3% 33.3%)', '@media (prefers-color-scheme: dark)': 'rgb(69.3% 70.7% 73.2%)' },
  faint: { default: 'rgb(41.1% 42.9% 46.1%)', '@media (prefers-color-scheme: dark)': 'rgb(53.4% 55% 57.9%)' },
  accent: { default: 'rgb(16.5% 41.2% 90%)', '@media (prefers-color-scheme: dark)': 'rgb(15.8% 43.6% 89%)' },
  accentHover: { default: 'rgb(10.4% 34.9% 83.2%)', '@media (prefers-color-scheme: dark)': 'rgb(20.3% 50.2% 92.7%)' },
  accentPressed: { default: 'rgb(8.5% 30% 72.3%)', '@media (prefers-color-scheme: dark)': 'rgb(9.7% 38% 82.9%)' },
  accentSoft: { default: 'rgb(90.6% 94.6% 99.8%)', '@media (prefers-color-scheme: dark)': 'rgb(9.8% 16.9% 28.6%)' },
  accentText: { default: 'rgb(15.6% 36% 76.2%)', '@media (prefers-color-scheme: dark)': 'rgb(48.5% 70.6% 98.8%)' },
  accentShadow: {
    default: 'rgb(16.5% 41.2% 90% / 28%)',
    '@media (prefers-color-scheme: dark)': 'rgb(0.4% 0.7% 1.3% / 40%)',
  },
  onAccent: '#fff',
  focus: { default: 'rgb(25.2% 53% 93.2%)', '@media (prefers-color-scheme: dark)': 'rgb(33.4% 60.1% 95.2%)' },
  agent: { default: 'rgb(0.7% 66.4% 59.4%)', '@media (prefers-color-scheme: dark)': 'rgb(21% 76.5% 69.2%)' },
  agentText: { default: 'rgb(2.7% 45.2% 40.4%)', '@media (prefers-color-scheme: dark)': 'rgb(42.2% 82.7% 76.3%)' },
  agentSoft: { default: 'rgb(89.5% 97.5% 95.9%)', '@media (prefers-color-scheme: dark)': 'rgb(5.3% 20.8% 18.6%)' },
  success: { default: 'rgb(9.5% 47.8% 23.1%)', '@media (prefers-color-scheme: dark)': 'rgb(37.7% 78% 50.5%)' },
  attention: { default: 'rgb(93% 43% 7.1%)', '@media (prefers-color-scheme: dark)': 'rgb(97.2% 54% 24%)' },
  attentionText: { default: 'rgb(61.6% 27.3% 8.6%)', '@media (prefers-color-scheme: dark)': 'rgb(96.6% 66.9% 41.9%)' },
  attentionSoft: { default: 'rgb(99.9% 94.3% 90.1%)', '@media (prefers-color-scheme: dark)': 'rgb(24.7% 13.9% 7.6%)' },
  attentionEdge: {
    default: 'rgb(93% 43% 7.1% / 22%)',
    '@media (prefers-color-scheme: dark)': 'rgb(97.2% 54% 24% / 24%)',
  },
  danger: { default: 'rgb(74.4% 18.4% 18.2%)', '@media (prefers-color-scheme: dark)': 'rgb(96.5% 42.5% 41.1%)' },
  dangerSoft: { default: 'rgb(99.8% 93.3% 93.1%)', '@media (prefers-color-scheme: dark)': 'rgb(26.9% 11.7% 11.6%)' },
  dangerFill: { default: 'rgb(74.4% 18.4% 18.2%)', '@media (prefers-color-scheme: dark)': 'rgb(70% 20% 19.5%)' },
  inverse: { default: 'rgb(13.5% 14.6% 16.8%)', '@media (prefers-color-scheme: dark)': 'rgb(18.6% 19.9% 22.6%)' },
  onInverse: { default: 'rgb(97% 97.5% 98.2%)', '@media (prefers-color-scheme: dark)': 'rgb(93.5% 94.2% 95.2%)' },
  onInverseMuted: { default: 'rgb(68% 69.5% 72.5%)', '@media (prefers-color-scheme: dark)': 'rgb(69.3% 70.7% 73.2%)' },
  code: { default: 'rgb(95.8% 96.4% 97.4%)', '@media (prefers-color-scheme: dark)': 'rgb(4.9% 5.6% 7%)' },
  codeBorder: {
    default: 'rgb(10.2% 12.3% 16.1% / 8%)',
    '@media (prefers-color-scheme: dark)': 'rgb(93.5% 94.2% 95.2% / 8%)',
  },
  overlay: {
    default: 'rgb(10.2% 12.3% 16.1% / 32%)',
    '@media (prefers-color-scheme: dark)': 'rgb(0.4% 0.7% 1.3% / 60%)',
  },
  transparent: 'transparent',
})

// Project 头像底色，按创建顺序轮换。
export const hues = stylex.defineConsts({
  slate: 'rgb(45.8% 50.5% 58.7%)',
  amber: 'rgb(70.7% 42.8% 6.3%)',
  violet: 'rgb(52.7% 43.3% 77.3%)',
  green: 'rgb(29.2% 57.4% 36.1%)',
  blue: 'rgb(25.8% 51.8% 77.2%)',
  rose: 'rgb(75.3% 35.8% 43.3%)',
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
  gutter: '8px',
  sidebar: '248px',
  overview: '320px',
  detail: '440px',
  measure: '720px',
  dot: '6px',
  screenWidth: '1440px',
  screenHeight: '900px',
})
