import * as stylex from '@stylexjs/stylex'
import { useEffect, useRef, useState } from 'react'
import { ClientError } from '../data/client'
import { pendingInbox } from '../data/derive'
import { useInbox, useSetProjectStatus, useUpdateProject } from '../data/queries'
import type { Project, ProjectPatch } from '../data/types'
import { text } from '../theme/text'
import { colors, space } from '../theme/tokens.stylex'
import { Banner } from '../ui/Banner'
import { Button } from '../ui/Button'
import { Dialog } from '../ui/Dialog'
import { Field, Input, TextArea } from '../ui/Field'
import { useWorkspace } from './workspace'
import { ProjectModelFields, useProjectModelCatalog } from './ProjectModelFields'

const styles = stylex.create({
  section: { display: 'flex', flexDirection: 'column', gap: space.md },
  divider: { borderWidth: 0, borderTopWidth: '1px', borderStyle: 'solid', borderColor: colors.borderSoft, margin: 0 },
  row: { display: 'flex', alignItems: 'center', gap: space.md },
  description: { display: 'flex', flexDirection: 'column', flexGrow: 1, gap: '4px' },
  error: { color: colors.danger },
  feedback: { display: 'flex', alignItems: 'center', gap: space.sm },
})

// @elyx design/screens/project-settings.elyx#settings
export function ProjectSettingsDialog({
  project,
  onClose,
  initialArchive = false,
}: {
  project: Project
  onClose: () => void
  initialArchive?: boolean
}) {
  const workspace = useWorkspace()
  const { catalog, devices } = useProjectModelCatalog()
  const update = useUpdateProject(project.id)
  const status = useSetProjectStatus()
  const inbox = useInbox()
  const pending = useRef<ProjectPatch>(workspace.settingsDrafts[project.id] ?? {})
  const flight = useRef<Promise<boolean> | null>(null)
  const mounted = useRef(true)
  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
    }
  }, [])
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [confirm, setConfirm] = useState(initialArchive)
  const [actionError, setActionError] = useState<string | null>(null)
  const archived = project.status === 'archived'
  const patch = archived ? {} : (workspace.settingsDrafts[project.id] ?? {})
  const values = { ...project, ...patch }
  const dirty = Object.keys(patch).length > 0
  const busy = saving || status.isPending

  const change = (next: ProjectPatch) => {
    pending.current = { ...pending.current, ...next }
    workspace.setSettingsDraft(project.id, { ...pending.current })
    setError(null)
  }

  // 写入按顺序完成；保存期间的新编辑留在下一次写入中。
  const save = () => {
    if (archived) return Promise.resolve(true)
    if (flight.current) return flight.current
    const drain = async () => {
      setError(null)
      setSaving(true)
      try {
        while (mounted.current && Object.keys(pending.current).length > 0) {
          const snapshot = { ...pending.current }
          if (snapshot.name !== undefined && !snapshot.name.trim()) {
            setError('Enter a project name.')
            return false
          }
          const selected = { ...project, ...snapshot }
          if (!selected.subscription.trim() || !selected.model.trim()) {
            setError('Enter a provider and model.')
            return false
          }
          await update.mutateAsync({ projectId: project.id, patch: snapshot })
          const remaining = { ...pending.current }
          for (const key of Object.keys(snapshot) as (keyof ProjectPatch)[]) {
            if (remaining[key] === snapshot[key]) delete remaining[key]
          }
          pending.current = remaining
          workspace.setSettingsDraft(project.id, (current) => {
            const next = { ...current }
            for (const key of Object.keys(snapshot) as (keyof ProjectPatch)[]) {
              if (next[key] === snapshot[key]) delete next[key]
            }
            return Object.keys(next).length > 0 ? next : null
          })
        }
        return mounted.current
      } catch (cause) {
        setError(
          cause instanceof ClientError && cause.code === 'invalid'
            ? cause.message
            : 'Could not save changes. Your edits are kept. Try again.',
        )
        return false
      } finally {
        if (mounted.current) setSaving(false)
      }
    }
    const task = drain().finally(() => {
      flight.current = null
    })
    flight.current = task
    return task
  }

  const close = async () => {
    if (status.isPending) return
    if ((await save()) && mounted.current) onClose()
  }
  const changeStatus = async (next: 'active' | 'paused' | 'archived') => {
    if (busy) return
    if (!(await save())) return
    setActionError(null)
    try {
      await status.mutateAsync({ projectId: project.id, status: next })
      if (next === 'archived') setConfirm(false)
    } catch (cause) {
      setActionError(
        cause instanceof ClientError && cause.code === 'invalid'
          ? cause.message
          : `Could not ${next === 'active' ? 'resume' : next === 'paused' ? 'pause' : 'archive'} this project. Try again.`,
      )
    }
  }
  const questionCount = pendingInbox(inbox.data ?? [], project.id).length
  const finalFocus = () => document.querySelector<HTMLButtonElement>('[aria-label="Project actions"]')

  if (confirm && !archived)
    return (
      <Dialog
        open
        title={`Archive “${project.name}”?`}
        description={`Stops the project assistant and withdraws ${inbox.data ? `${questionCount} open ${questionCount === 1 ? 'question' : 'questions'}` : 'all open questions'}. Chats and memory are kept. Existing threads continue.`}
        onOpenChange={(open) => {
          if (!open && !busy) {
            setConfirm(false)
            setActionError(null)
          }
        }}
        finalFocus={finalFocus}
        note={
          actionError && (
            <span role="alert" {...stylex.props(styles.error)}>
              {actionError}
            </span>
          )
        }
        actions={
          <>
            <Button
              onClick={() => {
                if (!busy) {
                  setConfirm(false)
                  setActionError(null)
                }
              }}
            >
              Cancel
            </Button>
            <Button variant="danger" onClick={() => void changeStatus('archived')}>
              {status.isPending ? 'Archiving…' : 'Archive'}
            </Button>
          </>
        }
      />
    )

  return (
    <Dialog
      open
      wide
      title={`${project.name} · settings`}
      onOpenChange={(open) => {
        if (!open) void close()
      }}
      finalFocus={finalFocus}
      note={
        <span role="status" {...stylex.props(styles.feedback)}>
          {error ? (
            <>
              <span {...stylex.props(styles.error)}>{error}</span>
              <Button small onClick={() => void save()}>
                Retry save
              </Button>
            </>
          ) : saving ? (
            'Saving…'
          ) : archived ? (
            'Read only'
          ) : dirty ? (
            'Unsaved changes'
          ) : (
            'Saved'
          )}
        </span>
      }
      actions={<Button onClick={() => void close()}>Done</Button>}
    >
      {archived && (
        <Banner
          icon="archive"
          title="This project is archived"
          detail="Chats and memory are kept. Existing threads can still be used."
        />
      )}
      <div {...stylex.props(styles.section)}>
        <Field label="Project name" error={error === 'Enter a project name.' ? error : undefined}>
          {(props) => (
            <Input
              {...props}
              value={values.name}
              readOnly={archived}
              onChange={(event) => change({ name: event.target.value })}
              onBlur={() => {
                if (!error) void save()
              }}
            />
          )}
        </Field>
        <Field label="Goal" optional helper="The project assistant reads goal changes with your next message.">
          {(props) => (
            <TextArea
              {...props}
              value={values.goal}
              readOnly={archived}
              onChange={(event) => change({ goal: event.target.value })}
              onBlur={() => {
                if (!error) void save()
              }}
            />
          )}
        </Field>
      </div>
      <hr {...stylex.props(styles.divider)} />
      <ProjectModelFields
        catalog={catalog}
        value={{ subscription: values.subscription, model: values.model }}
        onChange={change}
        onCommit={() => void save()}
        readOnly={archived}
        loading={devices.isPending}
      />
      <p {...stylex.props(text.caption, text.muted)}>
        Applies to the next run.{project.agent.state === 'running' && ' The current run keeps its model.'}
      </p>
      {!archived && (
        <>
          <hr {...stylex.props(styles.divider)} />
          <div {...stylex.props(styles.row)}>
            <div {...stylex.props(styles.description)}>
              <h3 {...stylex.props(text.label)}>{project.status === 'paused' ? 'Resume project' : 'Pause project'}</h3>
              <p {...stylex.props(text.caption, text.muted)}>
                Pauses automatic replies. You can still use individual threads and answer questions. Messages and
                replies here are saved until you resume.
              </p>
            </div>
            <Button small onClick={() => void changeStatus(project.status === 'paused' ? 'active' : 'paused')}>
              {status.isPending ? 'Saving…' : project.status === 'paused' ? 'Resume' : 'Pause'}
            </Button>
          </div>
          <div {...stylex.props(styles.row)}>
            <div {...stylex.props(styles.description)}>
              <h3 {...stylex.props(text.label)}>Archive project</h3>
              <p {...stylex.props(text.caption, text.muted)}>
                Stops the project assistant and withdraws open questions. Chats and memory are kept. Existing threads
                continue.
              </p>
            </div>
            <Button
              small
              variant="danger"
              onClick={async () => {
                if (!busy && (await save())) {
                  setActionError(null)
                  setConfirm(true)
                }
              }}
            >
              Archive
            </Button>
          </div>
        </>
      )}
      {actionError && (
        <p role="alert" {...stylex.props(text.caption, styles.error)}>
          {actionError}
        </p>
      )}
    </Dialog>
  )
}
