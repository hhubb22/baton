import * as stylex from '@stylexjs/stylex'

// Geist 家族随网页打包，覆盖英文和数字。中文无衬线回落到系统字体，中文衬线用 Noto Serif SC，按需下载分片。
// 取值在 global.css，画廊的调节面板可以覆盖。
export const fonts = stylex.defineConsts({
  ui: 'var(--font-ui)',
  mono: 'var(--font-mono)',
  serif: 'var(--font-serif)',
  // 只用于英文和数字，没有中文字形。
  pixel: 'var(--font-pixel)',
})

// 不能直接用 text 样式时取这里的字号，例如代码块和设置了专门行高的正文。
export const fontSize = stylex.defineConsts({
  caption: '12px',
  small: '13px',
  body: '14px',
  large: '16px',
})

export const weight = stylex.defineConsts({
  regular: '400',
  medium: '500',
  semibold: '600',
})
