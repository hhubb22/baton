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
import { ProjectEmojiPicker, validProjectEmoji } from '../ui/ProjectEmojiPicker'
import { ProjectModelFields, useProjectModelCatalog } from './ProjectModelFields'

const styles = stylex.create({
  hint: { color: colors.muted },
  failure: { color: colors.danger },
})

// 订阅和模型属于这个 Project，之后每次运行助手都用它们。
export function NewProjectDialog({ onClose }: { onClose: () => void }) {
  const navigate = useNavigate()
  const { catalog, devices } = useProjectModelCatalog()
  const create = useCreateProject()
  const nameRef = useRef<HTMLInputElement>(null)
  const [name, setName] = useState('')
  const [emoji, setEmoji] = useState('📁')
  const [emojiError, setEmojiError] = useState<string | null>(null)
  const [goal, setGoal] = useState('')
  const [selection, setSelection] = useState<{
    subscription: string
    model: string
    sourceNodeId?: string | null
  } | null>(null)
  const { subscription, model, sourceNodeId } = selection ?? {
    subscription: catalog[0]?.provider ?? '',
    model: catalog[0]?.models[0] ?? '',
    sourceNodeId: catalog[0]?.sourceNodeId ?? null,
  }
  const [nameError, setNameError] = useState<string | null>(null)
  const [failure, setFailure] = useState<string | null>(null)
  // 重试沿用同一个 clientId，第一次其实已保存时不会建出两个 Project。
  const [clientId] = useState(newClientId)

  const subscriptionLabel =
    ({ 'openai-codex': 'ChatGPT', xai: 'xAI', anthropic: 'Claude' } as Record<string, string>)[subscription] ??
    subscription
  const ready = sourceNodeId
    ? (devices.data ?? []).some(
        (device) =>
          device.id === sourceNodeId &&
          device.connection === 'online' &&
          device.modelConnections?.some(
            (connection) => `api-${connection.id}` === subscription && !connection.keyNeeded,
          ),
      )
      ? 1
      : 0
    : subscriptionReach(devices.data ?? [], subscriptionLabel)

  const submit = () => {
    if (create.isPending) return
    if (name.trim() === '') {
      setNameError('请输入项目名称。')
      nameRef.current?.focus()
      return
    }
    if (!validProjectEmoji(emoji)) {
      setEmojiError('请选择或输入一个表情。')
      return
    }
    if (!subscription.trim() || !model.trim()) {
      setFailure('请选择或手动输入服务商和模型。')
      return
    }
    setFailure(null)
    create.mutate(
      { name, emoji, goal, subscription: subscription.trim(), model: model.trim(), sourceNodeId, clientId },
      {
        onSuccess: (project) => {
          onClose()
          void navigate({ to: '/projects/$projectId', params: { projectId: project.id } })
        },
        onError: (error) =>
          setFailure(
            error instanceof ClientError && error.code === 'invalid' ? error.message : '无法创建项目，请重试。',
          ),
      },
    )
  }

  return (
    <Dialog
      open
      onOpenChange={(open) => !open && onClose()}
      title="新建项目"
      description="项目助手会在你的设备上新建对话并汇报结果。"
      note={
        failure && (
          <span role="alert" {...stylex.props(styles.failure)}>
            {failure}
          </span>
        )
      }
      actions={
        <>
          <DialogClose render={<Button>取消</Button>} />
          <Button variant="primary" onClick={submit}>
            {create.isPending ? '正在创建…' : failure ? '重试' : '创建项目'}
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
        <Field label="名称" error={nameError}>
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
      <ProjectEmojiPicker
        value={emoji}
        error={emojiError ?? undefined}
        onChange={(value) => {
          setEmoji(value)
          setEmojiError(null)
        }}
      />
      <Field label="目标" optional>
        {(props) => (
          <TextArea
            {...props}
            value={goal}
            placeholder="这个项目要达成什么目标？"
            onChange={(event) => setGoal(event.target.value)}
          />
        )}
      </Field>
      <ProjectModelFields
        catalog={catalog}
        value={{ subscription, model, sourceNodeId }}
        onChange={setSelection}
        creating
        loading={devices.isPending}
      />
      {devices.data && subscription && ready === 0 && (
        <p {...stylex.props(text.caption, styles.hint)}>
          {sourceNodeId ? '此连接需要设备在线并配置 API 密钥。' : `在线设备均未登录 ${subscriptionLabel}。`}{' '}
          可用后将发送消息。
        </p>
      )}
    </Dialog>
  )
}
