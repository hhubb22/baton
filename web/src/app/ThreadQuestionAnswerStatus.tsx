import * as stylex from '@stylexjs/stylex'
import type { ThreadQuestionAnswer } from '@baton/protocol'
import { text } from '../theme/text'
import { colors } from '../theme/tokens.stylex'

const styles = stylex.create({
  status: { color: colors.muted },
  attention: { color: colors.attentionText },
})

export function ThreadQuestionAnswerStatus({ answer, offline }: { answer: ThreadQuestionAnswer; offline: boolean }) {
  const notice =
    answer.outcome === 'pending'
      ? offline
        ? '回答已保存 · 设备上线后发送'
        : '回答已保存 · 等待助手接收'
      : answer.outcome === 'unknown'
        ? '设备无法确认助手是否收到回答。请检查输出后再继续。Baton 不会自动重发回答或原消息。'
        : answer.outcome === 'failed'
          ? '助手无法接收回答。原消息已保留，且不会自动重发。'
          : answer.outcome === 'cancelled'
            ? '回答送达前，问题已关闭。'
            : answer.decision === 'cancel'
              ? '问题已关闭'
              : '回答已送达'
  return (
    <p
      role="status"
      {...stylex.props(
        text.caption,
        styles.status,
        (answer.outcome === 'unknown' || answer.outcome === 'failed') && styles.attention,
      )}
    >
      {notice}
    </p>
  )
}
