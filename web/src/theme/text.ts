import * as stylex from '@stylexjs/stylex'
import { fonts, weight } from './base.stylex'
import { semantic } from './semantic.stylex'

// 文字样式分四类：Heading 标题，Label 单行界面文字，Copy 多行正文，Mono 代码。
// title、body、small、caption 等是页面还在使用的名字，指向相同的取值。
export const text = stylex.create({
  display: {
    fontFamily: fonts.serif,
    fontSize: '32px',
    lineHeight: 1.2,
    letterSpacing: '-0.01em',
    fontWeight: weight.regular,
  },
  displaySmall: {
    fontFamily: fonts.serif,
    fontSize: '24px',
    lineHeight: 1.25,
    letterSpacing: '-0.005em',
    fontWeight: weight.regular,
  },
  heading20: { fontSize: '20px', lineHeight: 1.4, letterSpacing: '-0.015em', fontWeight: weight.semibold },
  heading16: { fontSize: '16px', lineHeight: 1.45, letterSpacing: '-0.01em', fontWeight: weight.semibold },
  heading14: { fontSize: '14px', lineHeight: 1.45, letterSpacing: '-0.006em', fontWeight: weight.semibold },
  label14: { fontSize: '14px', lineHeight: 1.45, letterSpacing: '-0.006em', fontWeight: weight.regular },
  label14Medium: { fontSize: '14px', lineHeight: 1.45, letterSpacing: '-0.006em', fontWeight: weight.medium },
  label13: { fontSize: '13px', lineHeight: 1.45, letterSpacing: '-0.003em', fontWeight: weight.regular },
  label13Medium: { fontSize: '13px', lineHeight: 1.45, letterSpacing: '-0.003em', fontWeight: weight.medium },
  label12: {
    fontSize: '12px',
    lineHeight: 1.45,
    letterSpacing: 0,
    fontWeight: weight.regular,
    fontVariantNumeric: 'tabular-nums',
  },
  label12Medium: {
    fontSize: '12px',
    lineHeight: 1.45,
    letterSpacing: 0,
    fontWeight: weight.medium,
    fontVariantNumeric: 'tabular-nums',
  },
  copy14: { fontSize: '14px', lineHeight: 1.6, letterSpacing: '-0.006em', fontWeight: weight.regular },
  copy13: { fontSize: '13px', lineHeight: 1.55, letterSpacing: '-0.003em', fontWeight: weight.regular },
  mono: { fontFamily: fonts.mono, fontSize: '12px', lineHeight: 1.55, letterSpacing: 0, fontWeight: weight.regular },
  pixel: { fontFamily: fonts.pixel, fontVariantNumeric: 'tabular-nums', letterSpacing: 0, fontWeight: weight.regular },

  title: { fontSize: '20px', lineHeight: 1.4, letterSpacing: '-0.015em', fontWeight: weight.semibold },
  heading: { fontSize: '15px', lineHeight: 1.45, letterSpacing: '-0.009em', fontWeight: weight.semibold },
  body: { fontSize: '14px', lineHeight: 1.6, letterSpacing: '-0.006em', fontWeight: weight.regular },
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
  muted: { color: semantic.mutedForeground },
  faint: { color: semantic.faintForeground },
  danger: { color: semantic.destructiveForeground },
  truncate: { overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', minWidth: 0 },
})
