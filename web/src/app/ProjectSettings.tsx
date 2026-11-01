import * as stylex from '@stylexjs/stylex'
import { useEffect, useRef, useState } from 'react'
import { ClientError } from '../data/client'
import { threadView } from '../data/derive'
import { useSetProjectStatus, useThreads, useUpdateProject } from '../data/queries'
import type { Device, Project, ProjectPatch, Thread } from '../data/types'
import { ProjectEmojiPicker, validProjectEmoji } from '../ui/ProjectEmojiPicker'
import { text } from '../theme/text'
import { semantic } from '../theme/semantic.stylex'
import { space } from '../theme/tokens.stylex'
import { Banner } from '../ui/Banner'
import { Button, focusRing } from '../ui/Button'
import { Dialog } from '../ui/Dialog'
import { Field, FormRow, FormSection, Input, SaveBar, SwitchField, TextArea } from '../ui/Field'
import { StatusDot } from '../ui/Status'
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
    maxWidth: '640px',
    marginInline: 'auto',
    paddingBlock: '40px',
    paddingInline: '48px',
  },
  title: { display: 'flex', alignItems: 'baseline', gap: space.xs, minWidth: 0 },
  description: { display: 'flex', flexDirection: 'column', flexGrow: 1, gap: '4px' },
  link: {
    padding: 0,
    borderWidth: 0,
    backgroundColor: 'transparent',
    color: semantic.brandForeground,
    cursor: 'pointer',
  },
  error: { color: semantic.destructiveForeground },
  progress: { display: 'flex', alignItems: 'center', gap: space.sm },
})

const nameError = '请输入项目名称。'

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
  const contentRef = useRef<HTMLDivElement>(null)

  // 校验失败时把焦点放到第一个出错的字段。
  useEffect(() => {
    if (error) contentRef.current?.querySelector<HTMLElement>('[aria-invalid="true"]')?.focus()
  }, [error])
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
      : !validProjectEmoji(selected.emoji ?? '📁')
        ? '请选择或输入一个表情。'
        : !selected.subscription.trim() || !selected.model.trim()
          ? '请输入服务商和模型。'
          : selected.memoryEmbedding &&
              (!selected.memoryEmbedding.base_url.trim() || !selected.memoryEmbedding.model.trim())
            ? '请输入嵌入模型的基础 URL 和模型名称。'
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
        setError(cause instanceof ClientError && cause.code === 'invalid' ? cause.message : '无法保存，请重试。')
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
            : `无法${next === 'active' ? '恢复' : next === 'paused' ? '暂停' : '归档'}，请重试。`,
        )
    }
  }
  const archiving = status.isPending && status.variables?.status === 'archived'
  const closeConfirm = () => {
    if (archiving) return
    setConfirm(false)
    setActionError(null)
  }
  const projectThreads = (threads.data ?? []).filter((item) => item.projectId === project.id)

  const feedback = saving ? (
    'Saving…'
  ) : error && error !== nameError ? (
    <>
      <span role="alert" {...stylex.props(styles.error)}>
        {error}
      </span>
      {error === '无法保存，请重试。' && (
        <Button small onClick={() => void save()}>
          重试
        </Button>
      )}
      <button type="button" onClick={discard} {...stylex.props(styles.link, focusRing.ring)}>
        放弃更改
      </button>
    </>
  ) : dirty ? (
    <>
      更改尚未保存
      <button type="button" onClick={discard} {...stylex.props(styles.link, focusRing.ring)}>
        放弃更改
      </button>
    </>
  ) : saved ? (
    '已保存'
  ) : null

  return (
    <Page
      title={
        <span {...stylex.props(styles.title)}>
          <span {...stylex.props(text.truncate)}>{project.name}</span>
          <span {...stylex.props(text.muted)}>/ 设置</span>
        </span>
      }
      actions={
        <Button variant="ghost" small onClick={onBack}>
          返回项目
        </Button>
      }
    >
      <div ref={contentRef} {...stylex.props(styles.content)}>
        <h2 {...stylex.props(text.title)}>项目设置</h2>
        {archived && <ArchivedNotice project={project} threads={projectThreads} devices={devices.data ?? []} />}
        <FormSection title="基本信息">
          <Field
            label="名称"
            layout="row"
            changed={'name' in patch}
            error={error === nameError ? nameError : undefined}
          >
            {(props) => (
              <Input
                {...props}
                value={values.name}
                readOnly={archived}
                onChange={(event) => change({ name: event.target.value })}
              />
            )}
          </Field>
          <ProjectEmojiPicker
            layout="row"
            changed={'emoji' in patch}
            value={values.emoji ?? '📁'}
            readOnly={archived}
            error={error === '请选择或输入一个表情。' ? error : undefined}
            onChange={(emoji) => change({ emoji })}
          />
          <Field label="目标" layout="row" optional changed={'goal' in patch}>
            {(props) => (
              <TextArea
                {...props}
                value={values.goal}
                readOnly={archived}
                onChange={(event) => change({ goal: event.target.value })}
              />
            )}
          </Field>
        </FormSection>
        <FormSection title="项目助手" description="更改将在下次运行时生效。">
          <ProjectModelFields
            layout="row"
            changed={{ source: 'subscription' in patch || 'sourceNodeId' in patch, model: 'model' in patch }}
            catalog={catalog}
            value={{ subscription: values.subscription, model: values.model, sourceNodeId: values.sourceNodeId }}
            onChange={change}
            readOnly={archived}
            loading={devices.isPending}
          />
        </FormSection>
        <FormSection title="记忆">
          {archived ? (
            <FormRow>
              <h3 {...stylex.props(text.label, styles.description)}>记忆嵌入</h3>
              <span {...stylex.props(text.caption, text.muted)}>{embedding ? '已开启' : '已关闭'}</span>
            </FormRow>
          ) : (
            <SwitchField
              label="记忆嵌入"
              helper={embedding ? '设备会向此兼容 OpenAI 的端点发送请求。请在各设备上配置 API 密钥。' : undefined}
              checked={embedding !== null}
              onChange={(enabled) => change({ memoryEmbedding: enabled ? { base_url: '', model: '' } : null })}
            />
          )}
          {embedding && (
            <>
              {(
                [
                  ['base_url', '嵌入模型基础 URL'],
                  ['model', '嵌入模型'],
                  ['credential_profile', '设备凭据名称'],
                ] as const
              ).map(([key, label]) => (
                <Field
                  key={key}
                  label={label}
                  layout="row"
                  optional={key === 'credential_profile'}
                  changed={(project.memoryEmbedding?.[key] ?? '') !== (embedding[key] ?? '')}
                >
                  {(props) => (
                    <Input
                      {...props}
                      mono={key === 'base_url'}
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
              <FormRow>
                <p {...stylex.props(text.caption, text.muted)}>
                  使用 <code>batond project-runtime embedding-key &lt;name&gt;</code> 设置对应密钥。无密钥的服务可留空。
                </p>
              </FormRow>
            </>
          )}
        </FormSection>
        {!archived && (
          <>
            <FormSection title="项目状态">
              <FormRow>
                <div {...stylex.props(styles.description)}>
                  <h3 {...stylex.props(text.label)}>{project.status === 'paused' ? '恢复项目' : '暂停项目'}</h3>
                  <p {...stylex.props(text.caption, text.faint)}>新消息将在恢复后处理。</p>
                </div>
                <Button small onClick={() => void changeStatus(project.status === 'paused' ? 'active' : 'paused')}>
                  {status.isPending && !archiving ? '正在保存…' : project.status === 'paused' ? '恢复' : '暂停'}
                </Button>
              </FormRow>
              <FormRow>
                <div {...stylex.props(styles.description)}>
                  <h3 {...stylex.props(text.label)}>归档项目</h3>
                  <p {...stylex.props(text.caption, text.faint)}>停止助手和运行中的对话，保留聊天、记忆和对话记录。</p>
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
                  归档
                </Button>
              </FormRow>
              {actionError && !confirm && (
                <FormRow>
                  <p role="alert" {...stylex.props(text.caption, styles.error)}>
                    {actionError}
                  </p>
                </FormRow>
              )}
            </FormSection>
            <SaveBar
              open={feedback !== null}
              status={feedback}
              actions={
                (dirty || saving || error) && (
                  <Button variant="primary" onClick={() => void save()}>
                    保存更改
                  </Button>
                )
              }
            />
          </>
        )}
      </div>
      {confirm && !archived && archiving && (
        <Dialog open title="正在归档项目" onOpenChange={() => {}}>
          <span role="status" {...stylex.props(text.small, text.muted, styles.progress)}>
            <StatusDot tone="info" />
            正在保存归档状态…
          </span>
          <p {...stylex.props(text.caption, text.faint)}>停止请求会发送到在线设备。</p>
        </Dialog>
      )}
      {confirm && !archived && !archiving && (
        <Dialog
          open
          title="归档项目？"
          description={`停止项目助手和运行中的对话。聊天、记忆和对话记录会保留。${dirty ? '未保存的设置更改会被放弃。' : ''}`}
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
              <Button onClick={closeConfirm}>取消</Button>
              <Button variant="dangerSolid" onClick={() => void changeStatus('archived')}>
                归档项目
              </Button>
            </>
          }
        />
      )}
    </Page>
  )
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
    const name = deviceOf(thread)?.name ?? '设备'
    waiting.set(name, (waiting.get(name) ?? 0) + 1)
  }
  const running = live.filter((thread) => thread.status === 'running' && !thread.pending)
  const failed = running.filter((thread) => thread.stopFailed).length
  const unstopped = running.length - failed
  const assistantDevice = devices.find((item) => item.id === project.agent.deviceId)?.name ?? '设备'
  const parts = [
    project.agent.state === 'stopping' && `等待 ${assistantDevice} 停止助手。`,
    stopping > 0 && `${stopping} 个对话正在停止。`,
    ...[...waiting].map(([name, count]) => `${count} 个对话将在 ${name} 连接后停止。`),
    failed > 0 && `${failed} 个对话停止失败，请打开后重试。`,
    unstopped > 0 && `${unstopped} 个对话仍在运行，请打开后停止。`,
  ].filter(Boolean)
  return (
    <Banner
      icon="archive"
      title="项目已归档"
      detail={parts.length > 0 ? `只读。${parts.join('')}` : '只读。聊天、记忆和对话记录已保留。'}
    />
  )
}
