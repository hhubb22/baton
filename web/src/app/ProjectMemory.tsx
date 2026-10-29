import * as stylex from '@stylexjs/stylex'
import { useRef, useState } from 'react'
import { useNavigate } from '@tanstack/react-router'
import { ClientError } from '../data/client'
import {
  newClientId,
  useProjectMemory,
  useSaveMemory,
  useChangeMemory,
  useMemorySources,
  useMemoryStatus,
} from '../data/queries'
import type { MemoryNote, MemoryVersion, Project } from '../data/types'
import { text } from '../theme/text'
import { colors, radius, size, space } from '../theme/tokens.stylex'
import { Banner } from '../ui/Banner'
import { Button, focusRing } from '../ui/Button'
import { Dialog } from '../ui/Dialog'
import { Field, TextArea } from '../ui/Field'
import { Icon } from '../ui/Icon'
import { useWorkspace, type MemoryDraft } from './workspace'

const styles = stylex.create({
  list: { display: 'flex', flexDirection: 'column', gap: space.md, minWidth: 0 },
  row: {
    minWidth: 0,
  },
  edit: {
    display: 'flex',
    alignItems: 'center',
    gap: space.sm,
    width: '100%',
    minHeight: size.control,
    minWidth: 0,
    backgroundColor: { default: 'transparent', ':hover': colors.hover },
    borderWidth: 0,
    borderRadius: radius.sm,
    paddingBlock: '6px',
    paddingInline: space.sm,
    color: colors.text,
    textAlign: 'left',
    cursor: 'pointer',
  },
  history: { display: 'flex', flexDirection: 'column', gap: space.sm, paddingBlock: space.sm },
  latest: {
    padding: space.md,
    backgroundColor: colors.subtle,
    borderRadius: '8px',
    whiteSpace: 'pre-wrap',
    overflowWrap: 'anywhere',
  },
})

function metadata(version: MemoryVersion) {
  return `v${version.version} · ${version.source === 'you' ? '你' : '项目助手'} · ${new Date(version.updatedAt).toLocaleString('zh-CN', { hour12: false })}`
}

function MemoryEditor({ project, note, onClose }: { project: Project; note: MemoryNote | null; onClose: () => void }) {
  const workspace = useWorkspace()
  const key = note?.id ?? `new:${project.id}`
  const [draft, setDraft] = useState<MemoryDraft>(
    () =>
      workspace.memoryDrafts.get(key) ?? {
        body: note?.body ?? '',
        version: note?.version ?? null,
        clientId: newClientId(),
      },
  )
  const save = useSaveMemory()
  const change = useChangeMemory()
  const [showSources, setShowSources] = useState(false)
  const sources = useMemorySources(project.id, note, showSources)
  const actionId = useRef(newClientId())
  const [error, setError] = useState<string | null>(null)
  const [latest, setLatest] = useState<MemoryNote | null>(null)
  const saving = useRef(false)
  const archived = project.status === 'archived'
  const update = (next: MemoryDraft) => {
    setDraft(next)
    workspace.memoryDrafts.set(key, next)
  }
  const cancel = () => {
    if (!saving.current) {
      workspace.memoryDrafts.set(key, null)
      onClose()
    }
  }
  const submit = async () => {
    if (saving.current || latest || archived) return
    if (!draft.body.trim()) {
      setError('请输入记忆内容。')
      return
    }
    setError(null)
    saving.current = true
    try {
      const result = await save.mutateAsync({ projectId: project.id, noteId: note?.id ?? null, ...draft })
      if (result.state === 'conflict') {
        setLatest(result.note)
        return
      }
      workspace.memoryDrafts.set(key, (current) => (current?.clientId === draft.clientId ? null : (current ?? null)))
      onClose()
    } catch (cause) {
      setError(cause instanceof ClientError && cause.code === 'invalid' ? cause.message : '保存失败，草稿已保留。')
    } finally {
      saving.current = false
    }
  }
  const changeStatus = async () => {
    if (!note || saving.current || archived || latest) return
    saving.current = true
    setError(null)
    try {
      const result = await change.mutateAsync({
        projectId: project.id,
        noteId: note.id,
        version: draft.version ?? note.version,
        action: note.status === 'retired' ? 'restore' : 'retire',
        suppressionId: note.suppressionId,
        clientId: actionId.current,
      })
      if (result.state === 'conflict') {
        setLatest(result.note)
        return
      }
      workspace.memoryDrafts.set(key, null)
      onClose()
    } catch {
      setError(note.status === 'retired' ? '无法恢复记忆，请查看当前历史记录。' : '无法停用记忆，草稿已保留。')
    } finally {
      saving.current = false
    }
  }
  return (
    <Dialog
      open
      title={note ? '编辑记忆' : '添加记忆'}
      onOpenChange={(open) => {
        if (!open) cancel()
      }}
      finalFocus={() => document.querySelector<HTMLButtonElement>(`[data-memory-id="${note?.id ?? 'new'}"]`)}
      note={
        <span role="status">{save.isPending ? '正在保存…' : latest ? '编辑期间内容已更新，草稿已保留。' : null}</span>
      }
      actions={
        <>
          <Button onClick={cancel}>取消</Button>
          {note && !archived && !latest && (
            <Button onClick={() => void changeStatus()}>{note.status === 'retired' ? '恢复记忆' : '停用'}</Button>
          )}
          {latest ? (
            <Button
              onClick={() => {
                update({ ...draft, version: latest.version, clientId: newClientId() })
                setLatest(null)
                setError(null)
              }}
            >
              查看最新版本
            </Button>
          ) : (
            !archived && (
              <Button variant="primary" onClick={() => void submit()}>
                {save.isPending ? '正在保存…' : '保存记忆'}
              </Button>
            )
          )}
        </>
      }
    >
      {archived && <Banner icon="archive" title="项目已归档" detail="仅可查看。" />}
      <Field label="记忆" error={error}>
        {(props) => (
          <TextArea
            {...props}
            autoFocus
            rows={6}
            value={draft.body}
            readOnly={save.isPending || archived}
            onChange={(event) => {
              update({ ...draft, body: event.target.value, clientId: newClientId() })
              setError(null)
            }}
          />
        )}
      </Field>
      {latest && (
        <div {...stylex.props(styles.latest)}>
          <p {...stylex.props(text.caption, text.muted)}>最新 · {metadata(latest)}</p>
          <p {...stylex.props(text.small)}>{latest.body}</p>
        </div>
      )}
      {note && (
        <details onToggle={(event) => setShowSources(event.currentTarget.open)}>
          <summary {...stylex.props(text.caption, text.muted, focusRing.ring)}>查看来源和历史</summary>
          <div {...stylex.props(styles.history)}>
            {sources.isPending && showSources && <p role="status">正在加载来源…</p>}
            {sources.isError && (
              <Button small onClick={() => void sources.refetch()}>
                重试加载来源
              </Button>
            )}
            {sources.data?.map((source) => (
              <div key={source.id}>
                <p {...stylex.props(text.caption, text.muted)}>
                  {source.role === 'user' ? '你' : source.role === 'execution' ? '执行结果' : '助手报告'}
                  {source.source_seq ? ' · 消息 ' + source.source_seq : ''}
                  {source.suppressed ? ' · 已停用' : ''}
                </p>
                <p {...stylex.props(text.small)}>{source.text}</p>
              </div>
            ))}
            {note.versions.toReversed().map((version) => (
              <div key={version.version}>
                <p {...stylex.props(text.caption, text.muted)}>
                  {metadata(version)}
                  {version.details?.retracted ? ' · 已撤回' : ''}
                </p>
                {version.details?.reason && <p {...stylex.props(text.caption, text.muted)}>{version.details.reason}</p>}
                {(version.details?.validFrom || version.details?.validUntil) && (
                  <p {...stylex.props(text.caption, text.muted)}>
                    生效时间：{' '}
                    {version.details.validFrom
                      ? new Date(version.details.validFrom).toLocaleString('zh-CN', { hour12: false })
                      : '开始时间未知'}
                    {version.details.validUntil
                      ? ' 至 ' + new Date(version.details.validUntil).toLocaleString('zh-CN', { hour12: false })
                      : ''}
                  </p>
                )}
                <p {...stylex.props(text.small)}>{version.body}</p>
              </div>
            ))}
          </div>
        </details>
      )}
    </Dialog>
  )
}

export function ProjectMemory({ project }: { project: Project }) {
  const memory = useProjectMemory(project.id)
  const status = useMemoryStatus(project.id, project.status === 'active')
  const navigate = useNavigate()
  const attention = project.status === 'active' ? status.data?.attention[0] : undefined
  const [editing, setEditing] = useState<MemoryNote | 'new' | null>(null)
  const archived = project.status === 'archived'
  const active = memory.data?.filter((note) => note.effective && note.status !== 'retired') ?? []
  const retired = memory.data?.filter((note) => note.status === 'retired') ?? []
  const renderNote = (note: MemoryNote) => (
    <article key={note.id} aria-label="记忆" {...stylex.props(styles.row)}>
      <button
        data-memory-id={note.id}
        type="button"
        title={note.body}
        onClick={() => setEditing(note)}
        {...stylex.props(text.small, styles.edit, focusRing.ring)}
      >
        <Icon name="memory" size={16} style={text.muted} />
        <span {...stylex.props(text.truncate)}>{note.body}</span>
      </button>
    </article>
  )
  return (
    <section aria-label="项目记忆" {...stylex.props(styles.list)}>
      {attention && (
        <Banner
          attention
          title={attention === 'login_required' ? '更新记忆需要登录' : '搜索记忆需要设备凭据'}
          detail={attention === 'login_required' ? '登录后将处理已保存的对话。' : '仍可使用关键词搜索。'}
          action={
            <Button
              small
              onClick={() =>
                void (attention === 'login_required'
                  ? navigate({ to: '/devices' })
                  : navigate({
                      to: '/projects/$projectId',
                      params: { projectId: project.id },
                      search: { view: 'memory', settings: true },
                    }))
              }
            >
              {attention === 'login_required' ? '查看设备' : '打开设置'}
            </Button>
          }
        />
      )}
      {memory.isPending && (
        <p role="status" {...stylex.props(text.small, text.muted)}>
          正在加载记忆…
        </p>
      )}
      {memory.isError && (
        <Banner
          icon="alert"
          title="无法加载项目记忆"
          action={
            <Button small onClick={() => void memory.refetch()}>
              重试加载记忆
            </Button>
          }
        />
      )}
      {memory.data?.length === 0 && <p {...stylex.props(text.small, text.muted)}>暂无记忆</p>}
      {[...new Set(active.map((note) => note.topic))].map((topic) => (
        <div key={topic}>
          {topic && <p {...stylex.props(text.caption, text.muted)}>{topic}</p>}
          {active.filter((note) => note.topic === topic).map(renderNote)}
        </div>
      ))}
      {retired.length > 0 && (
        <details>
          <summary {...stylex.props(text.caption, text.muted, focusRing.ring)}>已停用</summary>
          {retired.map(renderNote)}
        </details>
      )}
      {!archived && (
        <Button small data-memory-id="new" onClick={() => setEditing('new')}>
          添加记忆
        </Button>
      )}
      {editing && (
        <MemoryEditor
          key={`${project.id}:${editing === 'new' ? 'new' : editing.id}`}
          project={project}
          note={editing === 'new' ? null : editing}
          onClose={() => setEditing(null)}
        />
      )}
    </section>
  )
}
