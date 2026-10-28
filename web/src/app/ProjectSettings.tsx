import * as stylex from '@stylexjs/stylex'
import { useEffect, useRef, useState } from 'react'
import { ClientError } from '../data/client'
import { pendingInbox, threadView } from '../data/derive'
import { useInbox, useSetProjectStatus, useThreads, useUpdateProject } from '../data/queries'
import type { Device, Project, ProjectPatch, Thread } from '../data/types'
import { text } from '../theme/text'
import { colors, space } from '../theme/tokens.stylex'
import { Banner } from '../ui/Banner'
import { Button, focusRing } from '../ui/Button'
import { Dialog } from '../ui/Dialog'
import { Field, Input, TextArea } from '../ui/Field'
import { StatusDot } from '../ui/Status'
import { Toggle } from '../ui/Toggle'
import { useDraft } from './drafts'
import { Page } from './Page'
import { useWorkspace } from './workspace'
import { ProjectModelFields, useProjectModelCatalog } from './ProjectModelFields'

const styles = stylex.create({
  content: {
    display: 'flex',
    flexDirection: 'column',
    gap: space.xl,
    width: '100%',
    maxWidth: '720px',
    marginInline: 'auto',
    paddingBlock: '40px',
    paddingInline: '48px',
  },
  title: { display: 'flex', alignItems: 'baseline', gap: space.xs, minWidth: 0 },
  section: { display: 'flex', flexDirection: 'column', gap: space.md },
  row: { display: 'flex', alignItems: 'center', gap: space.md },
  saveRow: { display: 'flex', alignItems: 'center', gap: space.md, minHeight: '32px' },
  feedback: { display: 'flex', alignItems: 'center', columnGap: space.md, flexGrow: 1, minWidth: 0 },
  description: { display: 'flex', flexDirection: 'column', flexGrow: 1, gap: '4px' },
  controls: {
    display: 'flex',
    flexDirection: 'column',
    gap: space.lg,
    paddingTop: '20px',
    borderWidth: 0,
    borderTopWidth: '1px',
    borderStyle: 'solid',
    borderColor: colors.borderSoft,
  },
  link: {
    padding: 0,
    borderWidth: 0,
    backgroundColor: 'transparent',
    color: colors.accentText,
    cursor: 'pointer',
  },
  error: { color: colors.danger },
  progress: { display: 'flex', alignItems: 'center', gap: space.sm },
})

const nameError = 'Enter a project name.'

// 设置页只在点「Save changes」时提交；编辑留在工作区草稿里，在应用内离开再回来也不会丢。
export function ProjectSettings({
  project,
  onBack,
  initialArchive = false,
}: {
  project: Project
  onBack: () => void
  initialArchive?: boolean
}) {
  const workspace = useWorkspace()
  const { catalog, devices } = useProjectModelCatalog()
  const update = useUpdateProject(project.id)
  const status = useSetProjectStatus()
  const inbox = useInbox()
  const threads = useThreads()
  const draft = useDraft(workspace.settingsDrafts, project.id)
  const mounted = useRef(true)
  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
    }
  }, [])
  const [saving, setSaving] = useState(false)
  const [saved, setSaved] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [confirm, setConfirm] = useState(initialArchive)
  const [actionError, setActionError] = useState<string | null>(null)
  const archived = project.status === 'archived'
  const patch = archived ? {} : (draft ?? {})
  const values = { ...project, ...patch }
  const embedding = values.memoryEmbedding
  const dirty = Object.keys(patch).length > 0

  // 有未保存的修改时，刷新或关闭标签页前由浏览器确认。
  useEffect(() => {
    if (!dirty) return
    const guard = (event: BeforeUnloadEvent) => {
      event.preventDefault()
      event.returnValue = ''
    }
    window.addEventListener('beforeunload', guard)
    return () => window.removeEventListener('beforeunload', guard)
  }, [dirty])

  const change = (next: ProjectPatch) => {
    workspace.settingsDrafts.set(project.id, (current) => {
      const merged: ProjectPatch = { ...current, ...next }
      for (const key of Object.keys(merged) as (keyof ProjectPatch)[]) {
        if (JSON.stringify(merged[key] ?? null) === JSON.stringify(project[key] ?? null)) delete merged[key]
      }
      return Object.keys(merged).length > 0 ? merged : null
    })
    setSaved(false)
    if (error === nameError && next.name !== undefined) setError(null)
  }

  const discard = () => {
    workspace.settingsDrafts.set(project.id, null)
    setError(null)
    setSaved(false)
  }

  // 一次点击提交一次当前草稿；保存期间的新编辑留在草稿里，等下一次保存。
  const save = async () => {
    if (archived || saving || !dirty) return
    const snapshot = { ...patch }
    const selected = { ...project, ...snapshot }
    const invalid = !selected.name.trim()
      ? nameError
      : !selected.subscription.trim() || !selected.model.trim()
        ? 'Enter a provider and model.'
        : selected.memoryEmbedding &&
            (!selected.memoryEmbedding.base_url.trim() || !selected.memoryEmbedding.model.trim())
          ? 'Enter an embedding base URL and model.'
          : null
    setSaved(false)
    setError(invalid)
    if (invalid) return
    setSaving(true)
    try {
      await update.mutateAsync({ projectId: project.id, patch: snapshot })
      workspace.settingsDrafts.set(project.id, (current) => {
        const next = { ...current }
        for (const key of Object.keys(snapshot) as (keyof ProjectPatch)[]) {
          if (JSON.stringify(next[key]) === JSON.stringify(snapshot[key])) delete next[key]
        }
        return Object.keys(next).length > 0 ? next : null
      })
      if (mounted.current) setSaved(true)
    } catch (cause) {
      if (mounted.current)
        setError(cause instanceof ClientError && cause.code === 'invalid' ? cause.message : "Couldn't save. Try again.")
    } finally {
      if (mounted.current) setSaving(false)
    }
  }

  const changeStatus = async (next: 'active' | 'paused' | 'archived') => {
    if (status.isPending) return
    setActionError(null)
    try {
      await status.mutateAsync({ projectId: project.id, status: next })
      if (next === 'archived') {
        workspace.settingsDrafts.set(project.id, null)
        if (mounted.current) setConfirm(false)
      }
    } catch (cause) {
      if (mounted.current)
        setActionError(
          cause instanceof ClientError && cause.code === 'invalid'
            ? cause.message
            : `Couldn't ${next === 'active' ? 'resume' : next === 'paused' ? 'pause' : 'archive'}. Try again.`,
        )
    }
  }
  const archiving = status.isPending && status.variables?.status === 'archived'
  const closeConfirm = () => {
    if (archiving) return
    setConfirm(false)
    setActionError(null)
  }
  const questionCount = pendingInbox(inbox.data ?? [], project.id).length
  const questions = inbox.data
    ? `${questionCount} open ${questionCount === 1 ? 'question' : 'questions'}`
    : 'all open questions'
  const projectThreads = (threads.data ?? []).filter((item) => item.projectId === project.id)

  const feedback = saving ? (
    'Saving…'
  ) : error && error !== nameError ? (
    <>
      <span role="alert" {...stylex.props(styles.error)}>
        {error}
      </span>
      {error === "Couldn't save. Try again." && (
        <Button small onClick={() => void save()}>
          Retry
        </Button>
      )}
      <button type="button" onClick={discard} {...stylex.props(styles.link, focusRing.ring)}>
        Discard changes
      </button>
    </>
  ) : dirty ? (
    <>
      Changes not saved
      <button type="button" onClick={discard} {...stylex.props(styles.link, focusRing.ring)}>
        Discard changes
      </button>
    </>
  ) : saved ? (
    'Saved'
  ) : null

  return (
    <Page
      title={
        <span {...stylex.props(styles.title)}>
          <span {...stylex.props(text.truncate)}>{project.name}</span>
          <span {...stylex.props(text.muted)}>/ Settings</span>
        </span>
      }
      actions={
        <Button variant="ghost" small onClick={onBack}>
          Back to project
        </Button>
      }
    >
      <div {...stylex.props(styles.content)}>
        <h2 {...stylex.props(text.title)}>Project settings</h2>
        {archived && <ArchivedNotice project={project} threads={projectThreads} devices={devices.data ?? []} />}
        <Field label="Name" error={error === nameError ? nameError : undefined}>
          {(props) => (
            <Input
              {...props}
              value={values.name}
              readOnly={archived}
              onChange={(event) => change({ name: event.target.value })}
            />
          )}
        </Field>
        <Field label="Goal" optional>
          {(props) => (
            <TextArea
              {...props}
              value={values.goal}
              readOnly={archived}
              onChange={(event) => change({ goal: event.target.value })}
            />
          )}
        </Field>
        <div {...stylex.props(styles.section)}>
          <ProjectModelFields
            catalog={catalog}
            value={{ subscription: values.subscription, model: values.model, sourceNodeId: values.sourceNodeId }}
            onChange={change}
            readOnly={archived}
            loading={devices.isPending}
          />
          <p {...stylex.props(text.caption, text.faint)}>Changes apply from the next run.</p>
        </div>
        <div {...stylex.props(styles.section)}>
          <div {...stylex.props(styles.row)}>
            <h3 {...stylex.props(text.label, styles.description)}>Memory embeddings</h3>
            {archived ? (
              <span {...stylex.props(text.caption, text.muted)}>{embedding ? 'On' : 'Off'}</span>
            ) : (
              <Toggle
                label="Memory embeddings"
                checked={embedding !== null}
                onChange={(enabled) => change({ memoryEmbedding: enabled ? { base_url: '', model: '' } : null })}
              />
            )}
          </div>
          {embedding && (
            <>
              <p {...stylex.props(text.caption, text.muted)}>
                Your devices send requests to this OpenAI-compatible endpoint. Configure API keys on each device.
              </p>
              {(
                [
                  ['base_url', 'Embedding base URL'],
                  ['model', 'Embedding model'],
                  ['credential_profile', 'Device credential name'],
                ] as const
              ).map(([key, label]) => (
                <Field key={key} label={label} optional={key === 'credential_profile'}>
                  {(props) => (
                    <Input
                      {...props}
                      value={embedding[key] ?? ''}
                      readOnly={archived}
                      onChange={(event) => {
                        const config = {
                          base_url: embedding.base_url,
                          model: embedding.model,
                          ...(embedding.credential_profile ? { credential_profile: embedding.credential_profile } : {}),
                          [key]: event.target.value,
                        }
                        change({ memoryEmbedding: config })
                      }}
                    />
                  )}
                </Field>
              ))}
              <p {...stylex.props(text.caption, text.muted)}>
                Set the named key with <code>batond project-runtime embedding-key &lt;name&gt;</code>. Leave blank for a
                keyless endpoint.
              </p>
            </>
          )}
        </div>
        {!archived && (
          <>
            <div {...stylex.props(styles.saveRow)}>
              <span role="status" {...stylex.props(text.small, text.muted, styles.feedback)}>
                {feedback}
              </span>
              <Button variant="primary" onClick={() => void save()}>
                Save changes
              </Button>
            </div>
            <div {...stylex.props(styles.controls)}>
              <div {...stylex.props(styles.row)}>
                <div {...stylex.props(styles.description)}>
                  <h3 {...stylex.props(text.label)}>
                    {project.status === 'paused' ? 'Resume project' : 'Pause project'}
                  </h3>
                  <p {...stylex.props(text.caption, text.faint)}>New messages wait until you resume.</p>
                </div>
                <Button small onClick={() => void changeStatus(project.status === 'paused' ? 'active' : 'paused')}>
                  {status.isPending && !archiving ? 'Saving…' : project.status === 'paused' ? 'Resume' : 'Pause'}
                </Button>
              </div>
              <div {...stylex.props(styles.row)}>
                <div {...stylex.props(styles.description)}>
                  <h3 {...stylex.props(text.label)}>Archive project</h3>
                  <p {...stylex.props(text.caption, text.faint)}>
                    Stops the assistant and running threads. Chat, memory, and thread history are kept.
                  </p>
                </div>
                <Button
                  small
                  variant="danger"
                  onClick={() => {
                    if (status.isPending) return
                    setActionError(null)
                    setConfirm(true)
                  }}
                >
                  Archive
                </Button>
              </div>
              {actionError && !confirm && (
                <p role="alert" {...stylex.props(text.caption, styles.error)}>
                  {actionError}
                </p>
              )}
            </div>
          </>
        )}
      </div>
      {confirm && !archived && archiving && (
        <Dialog open title="Archiving project" onOpenChange={() => {}}>
          <span role="status" {...stylex.props(text.small, text.muted, styles.progress)}>
            <StatusDot tone="info" />
            Saving archive status…
          </span>
          <p {...stylex.props(text.caption, text.faint)}>Stop requests go to online devices.</p>
        </Dialog>
      )}
      {confirm && !archived && !archiving && (
        <Dialog
          open
          title="Archive project?"
          description={`Stops the project assistant and its running threads, and closes ${questions}. Chat, memory, and thread history are kept.${dirty ? ' Unsaved settings changes are discarded.' : ''}`}
          onOpenChange={(open) => {
            if (!open) closeConfirm()
          }}
          note={
            actionError && (
              <span role="alert" {...stylex.props(styles.error)}>
                {actionError}
              </span>
            )
          }
          actions={
            <>
              <Button onClick={closeConfirm}>Cancel</Button>
              <Button variant="dangerSolid" onClick={() => void changeStatus('archived')}>
                Archive project
              </Button>
            </>
          }
        />
      )}
    </Page>
  )
}

function plural(count: number, word: string) {
  return `${count} ${word}${count === 1 ? '' : 's'}`
}

// 归档后的说明按 Thread 的实际状态写：设备确认停止前，只说停止请求在路上，不说已停止。
export function ArchivedNotice({
  project,
  threads,
  devices,
}: {
  project: Project
  threads: Thread[]
  devices: Device[]
}) {
  const deviceOf = (thread: Thread) => devices.find((item) => item.id === thread.deviceId)
  const live = threads.filter((thread) => thread.status !== 'archived')
  const stopping = live.filter((thread) => threadView(thread, deviceOf(thread)).group === 'stopping').length
  const waiting = new Map<string, number>()
  for (const thread of live) {
    if (threadView(thread, deviceOf(thread)).group !== 'stopRequested') continue
    const name = deviceOf(thread)?.name ?? 'the device'
    waiting.set(name, (waiting.get(name) ?? 0) + 1)
  }
  const running = live.filter((thread) => thread.status === 'running' && !thread.pending)
  const failed = running.filter((thread) => thread.stopFailed).length
  const unstopped = running.length - failed
  const assistantDevice = devices.find((item) => item.id === project.agent.deviceId)?.name ?? 'the device'
  const parts = [
    project.agent.state === 'stopping' && `Waiting for ${assistantDevice} to stop the assistant.`,
    stopping > 0 && `${plural(stopping, 'thread')} still stopping.`,
    ...[...waiting].map(([name, count]) => `${plural(count, 'thread')} will stop when ${name} connects.`),
    failed > 0 && `${plural(failed, 'thread')} couldn't stop. Open ${failed === 1 ? 'it' : 'them'} to stop again.`,
    unstopped > 0 && `${plural(unstopped, 'thread')} still running. Open ${unstopped === 1 ? 'it' : 'them'} to stop.`,
  ].filter(Boolean)
  return (
    <Banner
      icon="archive"
      title="Project archived"
      detail={
        parts.length > 0 ? `Read-only. ${parts.join(' ')}` : 'Read-only. Chat, memory, and thread history are kept.'
      }
    />
  )
}
