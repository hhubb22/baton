import * as stylex from '@stylexjs/stylex'

// 设计稿用 PingFang SC 和 Paper Mono，仓库不带字体文件，回退到系统字体。
export const fonts = stylex.defineConsts({
  ui: '"PingFang SC", -apple-system, BlinkMacSystemFont, "Segoe UI", "Hiragino Sans GB", "Microsoft YaHei", sans-serif',
  mono: '"Paper Mono", ui-monospace, "SF Mono", Menlo, Consolas, monospace',
})

export const weight = stylex.defineConsts({
  regular: '400',
  medium: '500',
  semibold: '600',
})

export const shadow = stylex.defineConsts({
  card: '0 1px 2px rgb(0 0 0 / 3%), 0 4px 16px rgb(0 0 0 / 4%)',
  composer: '0 1px 2px rgb(0 0 0 / 3%), 0 8px 24px rgb(0 0 0 / 6%)',
  menu: '0 8px 24px rgb(0 0 0 / 10%)',
  dialog: '0 12px 32px rgb(0 0 0 / 12%), 0 2px 6px rgb(0 0 0 / 6%)',
  chip: '0 1px 3px rgb(0 0 0 / 4%)',
  segment: '0 1px 2px rgb(0 0 0 / 8%), 0 1px 6px rgb(0 0 0 / 4%)',
})
