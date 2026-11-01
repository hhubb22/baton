import * as stylex from '@stylexjs/stylex'
import { semantic } from '../theme/semantic.stylex'
import { radius, space } from '../theme/tokens.stylex'
import { focusRing } from './Button'
import { Field, Input } from './Field'

const choices = ['📁', '🚀', '💻', '🛠️', '🎯', '💡', '📚', '🧪', '🎨', '🌱', '🌍', '⚡', '🔬', '🧩', '📊', '🤖']
const styles = stylex.create({
  input: { width: '72px' },
  choices: { display: 'flex', flexWrap: 'wrap', gap: space.xs },
  choicesInRow: { paddingInline: space.sm, paddingBottom: space.sm },
  choice: {
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    width: '32px',
    height: '32px',
    borderWidth: 0,
    borderRadius: radius.md,
    backgroundColor: { default: 'transparent', ':hover': semantic.muted },
    fontSize: '18px',
  },
  selected: { backgroundColor: { default: semantic.accent, ':hover': semantic.accent } },
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
  layout = 'stack',
  changed = false,
}: {
  value: string
  onChange: (value: string) => void
  readOnly?: boolean
  error?: string
  layout?: 'stack' | 'row'
  changed?: boolean
}) {
  return (
    <Field
      label="项目图标"
      error={error}
      layout={layout}
      changed={changed}
      helper={readOnly ? undefined : '选择图标或输入表情。'}
    >
      {(props) => (
        <>
          <Input
            {...props}
            value={value}
            readOnly={readOnly}
            style={styles.input}
            onChange={(event) => onChange(event.target.value)}
          />
          {!readOnly && (
            <div aria-label="推荐的项目图标" {...stylex.props(styles.choices, layout === 'row' && styles.choicesInRow)}>
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
        </>
      )}
    </Field>
  )
}
