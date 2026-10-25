import * as stylex from '@stylexjs/stylex'
import { useState } from 'react'
import { useSetThreadExecutionLimit } from '../data/queries'
import type { Thread } from '../data/types'
import { text } from '../theme/text'
import { colors, space } from '../theme/tokens.stylex'
import { Button } from '../ui/Button'
import { Field, Input } from '../ui/Field'

const styles = stylex.create({
  root: { paddingBlock: space.sm },
  summary: { cursor: 'pointer', color: colors.muted },
  content: { display: 'flex', flexDirection: 'column', gap: space.sm, paddingBlock: space.sm, maxWidth: '360px' },
  actions: { display: 'flex', alignItems: 'center', gap: space.sm },
  error: { color: colors.danger },
})

const validLimit = (value: number) => Number.isInteger(value) && value > 0 && value <= 2147483647
const limitLabel = (seconds: number) =>
  seconds % 3600 === 0 ? `${seconds / 3600}h` : seconds % 60 === 0 ? `${seconds / 60}m` : `${seconds}s`

export function NewThreadExecutionLimit({ value, onChange }: { value: number; onChange: (value: number) => void }) {
  return (
    <details {...stylex.props(styles.root)}>
      <summary {...stylex.props(text.caption, styles.summary)}>Time per reply · {limitLabel(value)}</summary>
      <div {...stylex.props(styles.content)}>
        <Field
          label="Time per reply (seconds)"
          helper="Total time for each reply, counted from when it starts."
          error={!validLimit(value) ? 'Enter a whole number from 1 to 2147483647.' : undefined}
        >
          {(props) => (
            <Input
              {...props}
              type="number"
              min={1}
              max={2147483647}
              step={1}
              value={value || ''}
              onChange={(event) => onChange(Number(event.target.value))}
            />
          )}
        </Field>
      </div>
    </details>
  )
}

export function ThreadExecutionLimit({ thread }: { thread: Thread }) {
  const saved = thread.executionTimeoutSeconds ?? 7200
  const [draft, setDraft] = useState<number | null>(null)
  const mutation = useSetThreadExecutionLimit()
  const value = draft ?? saved
  if (thread.status === 'archived') return null
  function save() {
    if (mutation.isPending) return
    if (!validLimit(value)) return
    mutation.mutate(
      { threadId: thread.id, executionTimeoutSeconds: value },
      { onSuccess: () => setDraft((current) => (current === value ? null : current)) },
    )
  }
  return (
    <details {...stylex.props(styles.root)}>
      <summary {...stylex.props(text.caption, styles.summary)}>Time per reply · {limitLabel(saved)}</summary>
      <div {...stylex.props(styles.content)}>
        <Field
          label="Time per reply (seconds)"
          helper="Applies to the current reply and future replies. Total time is counted from each reply’s start."
          error={!validLimit(value) ? 'Enter a whole number from 1 to 2147483647.' : undefined}
        >
          {(props) => (
            <Input
              {...props}
              type="number"
              min={1}
              max={2147483647}
              step={1}
              value={value || ''}
              onChange={(event) => setDraft(Number(event.target.value))}
            />
          )}
        </Field>
        <div {...stylex.props(styles.actions)}>
          <Button variant="secondary" onClick={save}>
            {mutation.isPending ? 'Saving…' : 'Save time limit'}
          </Button>
          {mutation.isSuccess && (
            <span role="status" {...stylex.props(text.caption, text.muted)}>
              Saved · applies when the device receives it
            </span>
          )}
        </div>
        {mutation.error && (
          <p role="alert" {...stylex.props(text.caption, styles.error)}>
            {mutation.error.message}
          </p>
        )}
      </div>
    </details>
  )
}
