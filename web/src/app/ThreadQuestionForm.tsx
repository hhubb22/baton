import * as stylex from '@stylexjs/stylex'
import { useState } from 'react'
import type { ThreadAnswerInput, ThreadQuestion } from '../data/types'
import { text } from '../theme/text'
import { semantic } from '../theme/semantic.stylex'
import { size, space } from '../theme/tokens.stylex'
import { Button } from '../ui/Button'
import { Field, TextArea } from '../ui/Field'

type AnswerValue = NonNullable<ThreadAnswerInput['answers']>[string]
const styles = stylex.create({
  form: { display: 'flex', flexDirection: 'column', gap: space.md, width: '100%', maxWidth: size.measure },
  question: {
    display: 'flex',
    flexDirection: 'column',
    gap: space.sm,
    borderWidth: 0,
    padding: 0,
    margin: 0,
    minWidth: 0,
  },
  options: {
    display: 'flex',
    flexDirection: 'column',
    gap: space.sm,
    paddingLeft: space.md,
    borderLeft: `1px solid ${semantic.border}`,
  },
  option: { display: 'flex', alignItems: 'flex-start', gap: space.sm, cursor: 'pointer' },
  description: { color: semantic.mutedForeground, display: 'block', whiteSpace: 'pre-wrap' },
  actions: { display: 'flex', gap: space.sm },
  error: { color: semantic.destructiveForeground },
})

export function ThreadQuestionForm({
  question,
  onAnswer,
}: {
  question: ThreadQuestion
  onAnswer: (answer: ThreadAnswerInput) => Promise<void>
}) {
  const [values, setValues] = useState<Record<string, AnswerValue>>(() =>
    Object.fromEntries(
      question.questions.flatMap((item) => (item.initialAnswer === undefined ? [] : [[item.id, item.initialAnswer]])),
    ),
  )
  const [custom, setCustom] = useState<Record<string, string>>({})
  const [error, setError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const [saved, setSaved] = useState(false)

  async function submit(decision: ThreadAnswerInput['decision']) {
    if (saving || saved) return
    const answers: Record<string, AnswerValue> = { ...values }
    for (const item of question.questions) {
      const extra = Object.hasOwn(custom, item.id) ? custom[item.id]?.trim() : undefined
      if (extra) {
        const previous = Object.hasOwn(answers, item.id) ? answers[item.id] : undefined
        answers[item.id] = item.multiSelect ? [...(Array.isArray(previous) ? previous : []), extra] : extra
      }
      const value = Object.hasOwn(answers, item.id) ? answers[item.id] : undefined
      if (
        question.kind !== 'approval' &&
        decision === 'accept' &&
        item.required !== false &&
        (value === undefined || value === '' || (Array.isArray(value) && value.length === 0))
      ) {
        setError(`请回答“${item.header || item.question}”后继续。`)
        return
      }
    }
    const answer: ThreadAnswerInput = {
      request_id: question.request_id,
      decision,
      ...(decision === 'accept' ? { answers } : {}),
    }
    if (new TextEncoder().encode(JSON.stringify(answer)).length > 64 * 1024) {
      setError('回答不能超过 64 KB。')
      return
    }
    setSaving(true)
    setError(null)
    try {
      await onAnswer(answer)
      setSaved(true)
    } catch {
      setError('无法保存回答，所选内容和文字已保留。请重试。')
    } finally {
      setSaving(false)
    }
  }

  if (question.kind === 'approval') {
    const options = question.options ?? [
      { decision: 'accept' as const, label: '允许' },
      { decision: 'decline' as const, label: '拒绝' },
      { decision: 'cancel' as const, label: '取消' },
    ]
    return (
      <div aria-label="权限审批" {...stylex.props(styles.form)}>
        {question.prompt && <p {...stylex.props(text.small)}>{question.prompt}</p>}
        {question.reason && <p {...stylex.props(text.small)}>{question.reason}</p>}
        <div {...stylex.props(styles.actions)}>
          {options.map((option) => (
            <Button key={option.decision} disabled={saving || saved} onClick={() => void submit(option.decision)}>
              {option.label}
            </Button>
          ))}
        </div>
        {options.map((option) => option.warning && <p key={option.decision}>{option.warning}</p>)}
        {error && (
          <p role="alert" {...stylex.props(text.caption, styles.error)}>
            {error}
          </p>
        )}
        {saved && (
          <p role="status" {...stylex.props(text.caption)}>
            回答已保存
          </p>
        )}
      </div>
    )
  }

  return (
    <form
      aria-label="助手的问题"
      {...stylex.props(styles.form)}
      onSubmit={(event) => {
        event.preventDefault()
        void submit('accept')
      }}
    >
      {question.prompt && <p {...stylex.props(text.small)}>{question.prompt}</p>}
      {question.questions.map((item) => {
        const selected = Object.hasOwn(values, item.id) ? values[item.id] : undefined
        const matches = (value: AnswerValue) => JSON.stringify(value) === JSON.stringify(selected)
        return (
          <fieldset key={item.id} {...stylex.props(styles.question)}>
            <legend {...stylex.props(text.label)}>{item.header}</legend>
            <p {...stylex.props(text.small)}>{item.question}</p>
            <div {...stylex.props(styles.options)}>
              {item.options.map((option, index) => {
                const value = option.value ?? option.label
                const checked = item.multiSelect
                  ? Array.isArray(selected) && selected.some((entry) => JSON.stringify(entry) === JSON.stringify(value))
                  : matches(value)
                return (
                  <label key={index} {...stylex.props(styles.option, text.small)}>
                    <input
                      type={item.multiSelect ? 'checkbox' : 'radio'}
                      name={`${question.request_id}:${item.id}`}
                      checked={checked}
                      onChange={() => {
                        const previous = Array.isArray(selected) ? selected : []
                        setValues({
                          ...values,
                          [item.id]: item.multiSelect
                            ? checked
                              ? previous.filter((entry) => JSON.stringify(entry) !== JSON.stringify(value))
                              : [...previous, value]
                            : value,
                        })
                        if (!item.multiSelect) setCustom({ ...custom, [item.id]: '' })
                      }}
                    />
                    <span>
                      {option.label}
                      {option.description && (
                        <span {...stylex.props(text.caption, styles.description)}>{option.description}</span>
                      )}
                    </span>
                  </label>
                )
              })}
              {(item.options.length === 0 || item.allowCustomAnswer !== false) && (
                <Field label={item.options.length ? '其他回答' : '你的回答'} optional={item.required === false}>
                  {(props) => (
                    <TextArea
                      {...props}
                      value={
                        (Object.hasOwn(custom, item.id) ? custom[item.id] : undefined) ??
                        (typeof selected === 'string' &&
                        !item.options.some((option) => matches(option.value ?? option.label))
                          ? selected
                          : '')
                      }
                      onChange={(event) => {
                        setCustom({ ...custom, [item.id]: event.target.value })
                        if (!item.multiSelect)
                          setValues(Object.fromEntries(Object.entries(values).filter(([id]) => id !== item.id)))
                      }}
                    />
                  )}
                </Field>
              )}
            </div>
          </fieldset>
        )
      })}
      {error && (
        <p role="alert" {...stylex.props(text.caption, styles.error)}>
          {error}
        </p>
      )}
      <div {...stylex.props(styles.actions)}>
        <Button type="submit" variant="secondary">
          {saving
            ? '正在保存…'
            : question.kind === 'mcp-elicitation' && question.questions.length === 0
              ? '继续'
              : '发送回答'}
        </Button>
        <Button variant="ghost" onClick={() => void submit('cancel')}>
          关闭问题
        </Button>
      </div>
      {saved && (
        <p role="status" {...stylex.props(text.caption)}>
          回答已保存
        </p>
      )}
    </form>
  )
}
