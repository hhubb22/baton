import * as stylex from '@stylexjs/stylex'

// Inter Variable 随网页打包，中文回落到系统字体；Paper Mono 不随网页提供，回落到系统等宽字体。
export const fonts = stylex.defineConsts({
  ui: '"Inter Variable", system-ui, -apple-system, "Segoe UI", "PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", "Noto Sans CJK SC", sans-serif',
  mono: '"Paper Mono", ui-monospace, "SF Mono", Menlo, Consolas, monospace',
})

export const weight = stylex.defineConsts({
  regular: '450',
  medium: '500',
  semibold: '600',
})
