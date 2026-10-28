import * as stylex from '@stylexjs/stylex'
import { fonts, weight } from './base.stylex'
import { colors } from './tokens.stylex'

// 界面文字样式。字距按 Inter 的字号规则收紧，caption 用等宽数字。
export const text = stylex.create({
  body: { fontSize: '14px', lineHeight: 1.6, letterSpacing: '-0.006em', fontWeight: weight.regular },
  title: { fontSize: '20px', lineHeight: 1.4, letterSpacing: '-0.017em', fontWeight: weight.semibold },
  heading: { fontSize: '15px', lineHeight: 1.45, letterSpacing: '-0.009em', fontWeight: weight.semibold },
  bodyMedium: { fontSize: '14px', lineHeight: 1.6, letterSpacing: '-0.006em', fontWeight: weight.medium },
  small: { fontSize: '13px', lineHeight: 1.5, letterSpacing: '-0.003em', fontWeight: weight.regular },
  label: { fontSize: '13px', lineHeight: 1.45, letterSpacing: '-0.003em', fontWeight: weight.medium },
  caption: {
    fontSize: '12px',
    lineHeight: 1.45,
    letterSpacing: 0,
    fontWeight: weight.regular,
    fontVariantNumeric: 'tabular-nums',
  },
  captionMedium: {
    fontSize: '12px',
    lineHeight: 1.45,
    letterSpacing: 0,
    fontWeight: weight.medium,
    fontVariantNumeric: 'tabular-nums',
  },
  mono: { fontFamily: fonts.mono, fontSize: '12px', lineHeight: 1.55, letterSpacing: 0, fontWeight: weight.regular },
  muted: { color: colors.muted },
  faint: { color: colors.faint },
  danger: { color: colors.danger },
  truncate: { overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', minWidth: 0 },
})
