import * as stylex from '@stylexjs/stylex'
import { useSyncExternalStore, type ReactNode } from 'react'
import { DiagnosticCopy } from '../telemetry/DiagnosticCopy'
import { hasFailure, subscribeFailures } from '../telemetry/diagnostics'
import { semantic } from '../theme/semantic.stylex'
import { text } from '../theme/text'
import { radius, shadow, size, space } from '../theme/tokens.stylex'
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
    backgroundColor: semantic.sidebar,
    borderWidth: '1px',
    borderStyle: 'solid',
    borderColor: semantic.border,
    borderRadius: radius.lg,
  },
  // 需要人处理的横幅反色显示，在一屏内容里最先被看到。
  attention: {
    paddingBlock: '14px',
    paddingLeft: '18px',
    paddingRight: '14px',
    backgroundColor: semantic.inverse,
    borderColor: 'transparent',
    borderRadius: radius.xl,
    boxShadow: shadow.floating,
    color: semantic.onInverse,
  },
  glyph: { color: semantic.mutedForeground },
  glyphAttention: { color: semantic.warning },
  body: { display: 'flex', flexDirection: 'column', flexGrow: 1, minWidth: 0 },
  detail: { color: semantic.mutedForeground },
  detailInverse: { color: semantic.onInverseMuted },
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
