import * as stylex from '@stylexjs/stylex'
import type { ReactNode } from 'react'
import { text } from '../theme/text'
import { colors, size, space } from '../theme/tokens.stylex'
import { Icon, type IconName } from './Icon'

const styles = stylex.create({
  banner: {
    display: 'flex',
    alignItems: 'center',
    gap: space.md,
    width: '100%',
    maxWidth: size.measure,
    paddingBlock: '10px',
    paddingLeft: '14px',
    paddingRight: space.md,
    backgroundColor: colors.panel,
    borderWidth: '1px',
    borderStyle: 'solid',
    borderColor: colors.borderSoft,
    borderRadius: '10px',
  },
  attention: {
    backgroundColor: colors.attentionSoft,
    borderColor: 'rgb(91% 41% 12% / 18%)',
  },
  glyph: { color: colors.muted },
  glyphAttention: { color: colors.attention },
  body: { display: 'flex', flexDirection: 'column', flexGrow: 1, minWidth: 0 },
  detail: { color: colors.muted },
})

// 等待和异常状态的横幅：一句标题、一句说明，能处理时才配一个动作。
export function Banner({
  icon = 'clock',
  title,
  detail,
  action,
  attention,
}: {
  icon?: IconName
  title: string
  detail?: ReactNode
  action?: ReactNode
  attention?: boolean
}) {
  return (
    <div role="status" {...stylex.props(styles.banner, attention && styles.attention)}>
      <Icon name={attention ? 'alert' : icon} size={16} style={attention ? styles.glyphAttention : styles.glyph} />
      <div {...stylex.props(styles.body)}>
        <span {...stylex.props(text.label)}>{title}</span>
        {detail && <span {...stylex.props(text.caption, styles.detail)}>{detail}</span>}
      </div>
      {action}
    </div>
  )
}
