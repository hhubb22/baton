import * as stylex from '@stylexjs/stylex'
import { fonts, weight } from './base.stylex'
import { colors } from './tokens.stylex'

// 对应 design/foundations/typography.elyx 的文字样式。
export const text = stylex.create({
  body: { fontSize: '14px', lineHeight: 1.6, fontWeight: weight.regular },
  title: { fontSize: '20px', lineHeight: 1.4, fontWeight: weight.semibold },
  heading: { fontSize: '15px', lineHeight: 1.45, fontWeight: weight.semibold },
  bodyMedium: { fontSize: '14px', lineHeight: 1.6, fontWeight: weight.medium },
  small: { fontSize: '13px', lineHeight: 1.5, fontWeight: weight.regular },
  label: { fontSize: '13px', lineHeight: 1.45, fontWeight: weight.medium },
  caption: { fontSize: '12px', lineHeight: 1.45, fontWeight: weight.regular },
  captionMedium: { fontSize: '12px', lineHeight: 1.45, fontWeight: weight.medium },
  mono: { fontFamily: fonts.mono, fontSize: '12px', lineHeight: 1.55, fontWeight: weight.regular },
  muted: { color: colors.muted },
  faint: { color: colors.faint },
  danger: { color: colors.danger },
  truncate: { overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', minWidth: 0 },
})
