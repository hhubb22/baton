import * as stylex from '@stylexjs/stylex'
import { useNavigate } from '@tanstack/react-router'
import { useRef, useState } from 'react'
import { ClientError } from '../data/client'
import { subscriptionReach } from '../data/derive'
import { newClientId, useCreateProject } from '../data/queries'
import { text } from '../theme/text'
import { colors } from '../theme/tokens.stylex'
import { Button } from '../ui/Button'
import { Dialog, DialogClose } from '../ui/Dialog'
import { Field, Input, TextArea } from '../ui/Field'
import { ProjectModelFields, useProjectModelCatalog } from './ProjectModelFields'

const styles = stylex.create({
  hint: { color: colors.muted },
  failure: { color: colors.danger },
})

function reachHint(subscription: string, ready: number) {
  if (ready === 0) {
    return `No online device has ${subscription} signed in. You can create this project now; messages wait until a device is ready.`
  }
  return `Uses your ${subscription} account. Signed in on ${ready} online ${ready === 1 ? 'device' : 'devices'}.`
}

// 订阅和模型属于这个 Project，之后每次运行助手都用它们。
export function NewProjectDialog({ onClose }: { onClose: () => void }) {
  const navigate = useNavigate()
  const { catalog, devices } = useProjectModelCatalog()
  const create = useCreateProject()
  const nameRef = useRef<HTMLInputElement>(null)
  const [name, setName] = useState('')
  const [goal, setGoal] = useState('')
  const [selection, setSelection] = useState<{ subscription: string; model: string } | null>(null)
  const { subscription, model } = selection ?? {
    subscription: catalog[0]?.provider ?? '',
    model: catalog[0]?.models[0] ?? '',
  }
  const [nameError, setNameError] = useState<string | null>(null)
  const [failure, setFailure] = useState<string | null>(null)
  // 重试沿用同一个 clientId，第一次其实已保存时不会建出两个 Project。
  const [clientId] = useState(newClientId)

  const subscriptionLabel =
    ({ 'openai-codex': 'ChatGPT', xai: 'xAI', anthropic: 'Claude' } as Record<string, string>)[subscription] ??
    subscription
  const ready = subscriptionReach(devices.data ?? [], subscriptionLabel)

  const submit = () => {
    if (create.isPending) return
    if (name.trim() === '') {
      setNameError('Enter a project name.')
      nameRef.current?.focus()
      return
    }
    if (!subscription.trim() || !model.trim()) {
      setFailure('Choose a provider and model, or enter them manually.')
      return
    }
    setFailure(null)
    create.mutate(
      { name, goal, subscription: subscription.trim(), model: model.trim(), clientId },
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
      description="A project has its own assistant that opens threads on your devices and reports back."
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
      <ProjectModelFields
        catalog={catalog}
        value={{ subscription, model }}
        onChange={setSelection}
        creating
        loading={devices.isPending}
      />
      {devices.data && subscription && (
        <p {...stylex.props(text.caption, styles.hint)}>{reachHint(subscriptionLabel, ready)}</p>
      )}
    </Dialog>
  )
}
