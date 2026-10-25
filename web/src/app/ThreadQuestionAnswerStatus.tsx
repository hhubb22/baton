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
        ? 'Answer saved · sends when this device is online'
        : 'Answer saved · waiting for the agent'
      : answer.outcome === 'unknown'
        ? 'The device could not confirm whether the agent received your answer. Check its output before continuing. Baton will not resend the answer or your original message automatically.'
        : answer.outcome === 'failed'
          ? 'The agent could not receive your answer. Your original message is kept and will not be sent again automatically.'
          : answer.outcome === 'cancelled'
            ? 'The question closed before your answer could be delivered.'
            : answer.decision === 'cancel'
              ? 'Question closed'
              : 'Answer delivered'
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
