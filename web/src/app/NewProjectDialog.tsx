import * as stylex from '@stylexjs/stylex'
import { useNavigate } from '@tanstack/react-router'
import { useRef, useState } from 'react'
import { ClientError } from '../data/client'
import { assistantModels, subscriptionReach } from '../data/derive'
import { newClientId, useCreateProject, useDevices } from '../data/queries'
import { text } from '../theme/text'
import { colors, radius, size, space } from '../theme/tokens.stylex'
import { Button, focusRing } from '../ui/Button'
import { Dialog, DialogClose } from '../ui/Dialog'
import { Field, Input, TextArea } from '../ui/Field'

const styles = stylex.create({
  models: { display: 'grid', gridTemplateColumns: '1fr 1fr', gap: space.md },
  select: {
    width: '100%',
    height: size.control,
    paddingInline: '10px',
    backgroundColor: colors.surface,
    borderWidth: '1px',
    borderStyle: 'solid',
    borderColor: { default: colors.border, ':focus': colors.focus },
    borderRadius: radius.sm,
    outline: 'none',
    color: colors.text,
  },
  assistant: { display: 'flex', flexDirection: 'column', gap: '6px' },
  hint: { color: colors.muted },
  failure: { color: colors.danger },
})

function reachHint(subscription: string, ready: number) {
  if (ready === 0) {
    return `No online device has ${subscription} signed in. You can create this project now; messages wait until a device is ready.`
  }
  return `Uses your ${subscription} account. Signed in on ${ready} online ${ready === 1 ? 'device' : 'devices'}.`
}

// 新建 Project：只有名称必填。订阅和模型属于这个 Project，之后每次运行助手都用它们。
export function NewProjectDialog({ onClose }: { onClose: () => void }) {
  const navigate = useNavigate()
  const devices = useDevices()
  const create = useCreateProject()
  const nameRef = useRef<HTMLInputElement>(null)
  const [name, setName] = useState('')
  const [goal, setGoal] = useState('')
  const [subscription, setSubscription] = useState('ChatGPT')
  const [model, setModel] = useState(assistantModels.ChatGPT[0])
  const [nameError, setNameError] = useState<string | null>(null)
  const [failure, setFailure] = useState<string | null>(null)
  // 重试沿用同一个 clientId，第一次其实已保存时不会建出两个 Project。
  const [clientId] = useState(newClientId)

  const ready = subscriptionReach(devices.data ?? [], subscription)

  const submit = () => {
    if (create.isPending) return
    if (name.trim() === '') {
      setNameError('Enter a project name.')
      nameRef.current?.focus()
      return
    }
    setFailure(null)
    create.mutate(
      { name, goal, subscription, model, clientId },
      {
        onSuccess: (project) => {
          onClose()
          void navigate({ to: '/projects/$projectId', params: { projectId: project.id } })
        },
        onError: (error) =>
          setFailure(
            error instanceof ClientError && error.code === 'invalid'
              ? error.message
              : 'Baton could not save this project. Your entries are kept. Try again.',
          ),
      },
    )
  }

  return (
    <Dialog
      open
      onOpenChange={(open) => !open && onClose()}
      title="New project"
      description="A project has its own assistant that opens chats on your devices and reports back."
      note={
        failure && (
          <span role="alert" {...stylex.props(styles.failure)}>
            {failure}
          </span>
        )
      }
      actions={
        <>
          <DialogClose render={<Button>Cancel</Button>} />
          <Button variant="primary" onClick={submit}>
            {create.isPending ? 'Creating…' : failure ? 'Try again' : 'Create project'}
          </Button>
        </>
      }
    >
      <form
        onSubmit={(event) => {
          event.preventDefault()
          submit()
        }}
      >
        <Field label="Name" error={nameError}>
          {(props) => (
            <Input
              {...props}
              ref={nameRef}
              autoFocus
              value={name}
              placeholder="Baton"
              onChange={(event) => {
                setName(event.target.value)
                if (event.target.value.trim() !== '') setNameError(null)
              }}
            />
          )}
        </Field>
      </form>
      <Field label="Goal" optional helper="The assistant reads this at the start of every run.">
        {(props) => (
          <TextArea
            {...props}
            value={goal}
            placeholder="What should this project achieve?"
            onChange={(event) => setGoal(event.target.value)}
          />
        )}
      </Field>
      <div {...stylex.props(styles.assistant)}>
        <div {...stylex.props(styles.models)}>
          <Field label="Assistant subscription">
            {(props) => (
              <select
                {...props}
                value={subscription}
                onChange={(event) => {
                  setSubscription(event.target.value)
                  setModel(assistantModels[event.target.value][0])
                }}
                {...stylex.props(text.small, styles.select, focusRing.ring)}
              >
                {Object.keys(assistantModels).map((item) => (
                  <option key={item} value={item}>
                    {item} subscription
                  </option>
                ))}
              </select>
            )}
          </Field>
          <Field label="Model">
            {(props) => (
              <select
                {...props}
                value={model}
                onChange={(event) => setModel(event.target.value)}
                {...stylex.props(text.small, styles.select, focusRing.ring)}
              >
                {assistantModels[subscription].map((item) => (
                  <option key={item} value={item}>
                    {item}
                  </option>
                ))}
              </select>
            )}
          </Field>
        </div>
        {devices.data && <p {...stylex.props(text.caption, styles.hint)}>{reachHint(subscription, ready)}</p>}
      </div>
    </Dialog>
  )
}
