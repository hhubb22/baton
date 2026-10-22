import * as stylex from '@stylexjs/stylex'
import { useParams } from '@tanstack/react-router'
import { useState } from 'react'
import { FilePreview } from '../app/FilePreview'
import { MessageBody } from '../app/MessageBody'
import { Page } from '../app/Page'
import { agentNames } from '../app/ThreadRow'
import { ClientError } from '../data/client'
import { operationLabel, threadView } from '../data/derive'
import {
  newClientId,
  useDevices,
  useMessages,
  useOperation,
  useSendMessage,
  useStopThread,
  useThreads,
} from '../data/queries'
import type { Message } from '../data/types'
import { text } from '../theme/text'
import { colors, size, space } from '../theme/tokens.stylex'
import { Banner } from '../ui/Banner'
import { Button } from '../ui/Button'
import { Chip } from '../ui/Chip'
import { Composer } from '../ui/Composer'
import { StatusPill } from '../ui/Status'

const styles = stylex.create({
  split: { display: 'flex', height: '100%', minHeight: 0 },
  main: { display: 'flex', flexDirection: 'column', flexGrow: 1, minWidth: 0 },
  timeline: { flexGrow: 1, minHeight: 0, overflowY: 'auto' },
  messages: {
    display: 'flex',
    flexDirection: 'column',
    gap: space.lg,
    width: '100%',
    maxWidth: size.measure,
    marginInline: 'auto',
    padding: space.xl,
  },
  user: {
    alignSelf: 'flex-end',
    maxWidth: '80%',
    paddingBlock: space.sm,
    paddingInline: space.md,
    borderRadius: '14px',
    backgroundColor: colors.subtle,
  },
  agent: { alignSelf: 'stretch' },
  sender: { color: colors.faint },
  dock: {
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
    gap: space.sm,
    flexShrink: 0,
    paddingInline: space.xl,
    paddingBottom: space.lg,
  },
  phase: { width: '100%', maxWidth: size.measure, minHeight: '18px', color: colors.muted },
  error: { color: colors.danger },
})

const deliveryLabels: Partial<Record<Message['delivery'], string>> = {
  submitted: 'Sending…',
  waitingDevice: 'Saved · waiting for device',
  queued: 'Queued',
  withdrawn: 'Not sent',
}

function MessageItem({ message, onOpenPath }: { message: Message; onOpenPath: (path: string) => void }) {
  const fromUser = message.role === 'user'
  const note = fromUser ? deliveryLabels[message.delivery] : undefined
  return (
    <article {...stylex.props(text.body, fromUser ? styles.user : styles.agent)}>
      {message.sender === 'projectAgent' && (
        <span {...stylex.props(text.caption, styles.sender)}>From project assistant</span>
      )}
      <MessageBody body={message.body} onOpenPath={onOpenPath} />
      {note && <span {...stylex.props(text.caption, styles.sender)}>{note}</span>}
    </article>
  )
}

export function ThreadPage() {
  const { threadId } = useParams({ from: '/workspace/threads/$threadId' })
  const threads = useThreads()
  const devices = useDevices()
  const messages = useMessages(threadId)
  const send = useSendMessage()
  const stop = useStopThread()
  const [draft, setDraft] = useState('')
  const [operationId, setOperationId] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [previewPath, setPreviewPath] = useState<string | null>(null)
  const operation = useOperation(operationId)

  const thread = threads.data?.find((item) => item.id === threadId)
  if (threads.data && !thread) {
    return (
      <Page title="Thread not found">
        <p {...stylex.props(text.body, text.muted, styles.messages)}>
          This thread was deleted or you no longer have access.
        </p>
      </Page>
    )
  }
  if (!thread) return null

  const device = devices.data?.find((item) => item.id === thread.deviceId)
  const view = threadView(thread, device)
  const canStop = thread.status === 'running' || thread.status === 'waiting'
  const phase = operation.data ? operationLabel(operation.data, device) : null

  const onSend = () => {
    const body = draft.trim()
    if (!body) return
    setError(null)
    send.mutate(
      { threadId, body, clientId: newClientId() },
      {
        onSuccess: (result) => {
          setDraft('')
          setOperationId(result.id)
        },
        onError: (cause) => setError(cause instanceof ClientError ? cause.message : 'Could not send. Try again.'),
      },
    )
  }

  const onStop = () => {
    setError(null)
    stop.mutate(threadId, {
      onSuccess: (result) => setOperationId(result.id),
      onError: (cause) => setError(cause instanceof ClientError ? cause.message : 'Could not stop. Try again.'),
    })
  }

  return (
    <Page
      title={thread.title}
      actions={
        <>
          <StatusPill tone={view.status.tone}>{view.status.label}</StatusPill>
          {canStop && (
            <Button small icon="stop" onClick={onStop}>
              Stop
            </Button>
          )}
        </>
      }
    >
      <div {...stylex.props(styles.split)}>
        <div {...stylex.props(styles.main)}>
          <div {...stylex.props(styles.timeline)}>
            <div {...stylex.props(styles.messages)}>
              {messages.data?.map((message) => (
                <MessageItem key={message.id} message={message} onOpenPath={setPreviewPath} />
              ))}
            </div>
          </div>
          <div {...stylex.props(styles.dock)}>
            {view.notice && <Banner title={view.notice.title} detail={view.notice.detail} />}
            <Composer
              value={draft}
              onChange={setDraft}
              onSend={onSend}
              placeholder="Ask for follow-up changes"
              chips={
                <>
                  <Chip icon="laptop" caret={false}>
                    {device?.name ?? 'Removed device'}
                  </Chip>
                  <Chip caret={false}>
                    {agentNames[thread.agent]} · {thread.model}
                  </Chip>
                </>
              }
            />
            <span role="status" {...stylex.props(text.caption, styles.phase, error !== null && styles.error)}>
              {error ?? phase}
            </span>
          </div>
        </div>
        {previewPath && (
          <FilePreview deviceId={thread.deviceId} path={previewPath} onClose={() => setPreviewPath(null)} />
        )}
      </div>
    </Page>
  )
}
