import * as stylex from '@stylexjs/stylex'
import { useSyncExternalStore, type ReactNode } from 'react'
import { DiagnosticCopy } from '../telemetry/DiagnosticCopy'
import { hasFailure, subscribeFailures } from '../telemetry/diagnostics'
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
  // 需要人处理的横幅反色显示，在一屏内容里最先被看到。
  attention: {
    paddingBlock: '14px',
    paddingLeft: '18px',
    paddingRight: '14px',
    backgroundColor: colors.inverse,
    borderColor: 'transparent',
    borderRadius: '16px',
    boxShadow: `0 1px 3px ${colors.shadowNear}, 0 12px 32px ${colors.shadowFar}`,
    color: colors.onInverse,
  },
  glyph: { color: colors.muted },
  glyphAttention: { color: colors.attention },
  body: { display: 'flex', flexDirection: 'column', flexGrow: 1, minWidth: 0 },
  detail: { color: colors.muted },
  detailInverse: { color: colors.onInverseMuted },
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
  const failedRequest = useSyncExternalStore(subscribeFailures, hasFailure, () => false)
  return (
    <div role="status" {...stylex.props(styles.banner, attention && styles.attention)}>
      <Icon name={attention ? 'alert' : icon} size={16} style={attention ? styles.glyphAttention : styles.glyph} />
      <div {...stylex.props(styles.body)}>
        <span {...stylex.props(text.label)}>{title}</span>
        {detail && (
          <span {...stylex.props(text.caption, styles.detail, attention && styles.detailInverse)}>{detail}</span>
        )}
      </div>
      {action}
      {icon === 'alert' && failedRequest && <DiagnosticCopy />}
    </div>
  )
}
