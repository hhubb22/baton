import * as stylex from '@stylexjs/stylex'
import { fonts } from '../theme/base.stylex'
import { colors, radius } from '../theme/tokens.stylex'
import { focusRing } from '../ui/Button'

const styles = stylex.create({
  body: { margin: 0, whiteSpace: 'pre-wrap', wordBreak: 'break-word' },
  code: {
    fontFamily: fonts.mono,
    fontSize: '0.92em',
    paddingInline: '4px',
    borderRadius: radius.sm,
    backgroundColor: colors.subtle,
  },
  path: {
    fontFamily: fonts.mono,
    fontSize: '0.92em',
    paddingInline: '4px',
    borderWidth: 0,
    borderRadius: radius.sm,
    backgroundColor: { default: colors.subtle, ':hover': colors.hover },
    color: colors.accentText,
    cursor: 'pointer',
  },
})

const isPath = (value: string) => /^(\/|~\/|[A-Za-z]:\\)/.test(value)

// 消息正文：反引号里的绝对路径可以点开预览，其余反引号内容按代码显示。
export function MessageBody({ body, onOpenPath }: { body: string; onOpenPath: (path: string) => void }) {
  const parts = body.split(/`([^`\n]+)`/)
  return (
    <p {...stylex.props(styles.body)}>
      {parts.map((part, index) => {
        if (index % 2 === 0) return part
        if (isPath(part)) {
          return (
            <button
              key={index}
              type="button"
              onClick={() => onOpenPath(part)}
              {...stylex.props(styles.path, focusRing.ring)}
            >
              {part}
            </button>
          )
        }
        return (
          <code key={index} {...stylex.props(styles.code)}>
            {part}
          </code>
        )
      })}
    </p>
  )
}
