import * as stylex from '@stylexjs/stylex'
import { colors, radius, space } from '../theme/tokens.stylex'
import { text } from '../theme/text'
import { focusRing } from './Button'
import { Field, Input } from './Field'

const choices = ['📁', '🚀', '💻', '🛠️', '🎯', '💡', '📚', '🧪', '🎨', '🌱', '🌍', '⚡', '🔬', '🧩', '📊', '🤖']
const styles = stylex.create({
  choices: { display: 'flex', flexWrap: 'wrap', gap: space.xs, marginTop: space.sm },
  choice: {
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    width: '32px',
    height: '32px',
    borderWidth: 0,
    borderRadius: radius.md,
    backgroundColor: { default: 'transparent', ':hover': colors.hover },
    fontSize: '18px',
  },
  selected: { backgroundColor: { default: colors.selected, ':hover': colors.selected } },
})

export function validProjectEmoji(value: string) {
  return (
    [...new Intl.Segmenter(undefined, { granularity: 'grapheme' }).segment(value)].length === 1 &&
    /\p{Extended_Pictographic}|\p{Regional_Indicator}|[#*0-9]\uFE0F?\u20E3/u.test(value) &&
    new TextEncoder().encode(value).length <= 128
  )
}

export function ProjectEmojiPicker({
  value,
  onChange,
  readOnly = false,
  error,
}: {
  value: string
  onChange: (value: string) => void
  readOnly?: boolean
  error?: string
}) {
  return (
    <div>
      <Field label="项目图标" error={error}>
        {(props) => (
          <Input {...props} value={value} readOnly={readOnly} onChange={(event) => onChange(event.target.value)} />
        )}
      </Field>
      {!readOnly && (
        <div aria-label="推荐的项目图标" {...stylex.props(styles.choices)}>
          {choices.map((emoji) => (
            <button
              key={emoji}
              type="button"
              aria-label={emoji}
              aria-pressed={value === emoji}
              onClick={() => onChange(emoji)}
              {...stylex.props(styles.choice, value === emoji && styles.selected, focusRing.ring)}
            >
              {emoji}
            </button>
          ))}
        </div>
      )}
      {!readOnly && <p {...stylex.props(text.caption, text.muted)}>选择图标或输入表情。</p>}
    </div>
  )
}
