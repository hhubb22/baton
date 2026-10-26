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
import { Toggle } from '../ui/Toggle'
import { useDraft } from './drafts'
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
  const draft = useDraft(workspace.settingsDrafts, project.id)
  const pending = useRef<ProjectPatch>(draft ?? {})
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
  const patch = archived ? {} : (draft ?? {})
  const values = { ...project, ...patch }
  const embedding = values.memoryEmbedding
  const dirty = Object.keys(patch).length > 0
  const busy = saving || status.isPending

  const change = (next: ProjectPatch) => {
    pending.current = { ...pending.current, ...next }
    workspace.settingsDrafts.set(project.id, { ...pending.current })
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
          if (
            snapshot.memoryEmbedding &&
            (!snapshot.memoryEmbedding.base_url.trim() || !snapshot.memoryEmbedding.model.trim())
          ) {
            setError('Enter an embedding base URL and model.')
            return false
          }
          await update.mutateAsync({ projectId: project.id, patch: snapshot })
          const remaining = { ...pending.current }
          for (const key of Object.keys(snapshot) as (keyof ProjectPatch)[]) {
            if (remaining[key] === snapshot[key]) delete remaining[key]
          }
          pending.current = remaining
          workspace.settingsDrafts.set(project.id, (current) => {
            const next = { ...current }
            for (const key of Object.keys(snapshot) as (keyof ProjectPatch)[]) {
              if (next[key] === snapshot[key]) delete next[key]
            }
            return Object.keys(next).length > 0 ? next : null
          })
        }
        return mounted.current
      } catch (cause) {
        setError(cause instanceof ClientError && cause.code === 'invalid' ? cause.message : "Couldn't save. Try again.")
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

  const close = () => onClose()
  const changeStatus = async (next: 'active' | 'paused' | 'archived') => {
    if (status.isPending) return
    if (next === 'archived' && !(await save())) return
    setActionError(null)
    try {
      await status.mutateAsync({ projectId: project.id, status: next })
      if (next === 'archived') setConfirm(false)
    } catch (cause) {
      setActionError(
        cause instanceof ClientError && cause.code === 'invalid'
          ? cause.message
          : `Couldn't ${next === 'active' ? 'resume' : next === 'paused' ? 'pause' : 'archive'}. Try again.`,
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
        description={`Stops the project assistant and closes ${inbox.data ? `${questionCount} open ${questionCount === 1 ? 'question' : 'questions'}` : 'all open questions'}. Chat, memory, and threads are kept.`}
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
            <Button variant="dangerSolid" onClick={() => void changeStatus('archived')}>
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
        if (!open) close()
      }}
      finalFocus={finalFocus}
      note={
        <span role="status" {...stylex.props(styles.feedback)}>
          {error ? (
            <>
              <span {...stylex.props(styles.error)}>{error}</span>
              <Button small onClick={() => void save()}>
                Retry
              </Button>
            </>
          ) : saving ? (
            'Saving…'
          ) : archived ? (
            'Read-only'
          ) : dirty ? (
            'Changes not saved'
          ) : (
            'Saved'
          )}
        </span>
      }
      actions={
        <>
          {dirty && !saving && (
            <Button
              variant="ghost"
              onClick={() => {
                pending.current = {}
                workspace.settingsDrafts.set(project.id, null)
                setError(null)
              }}
            >
              Discard changes
            </Button>
          )}
          <Button onClick={close}>Done</Button>
        </>
      }
    >
      {archived && <Banner icon="archive" title="Project archived" detail="Read-only. Threads keep running." />}
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
        <Field label="Goal" optional>
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
      <p {...stylex.props(text.caption, text.muted)}>Applies from the next run.</p>
      <hr {...stylex.props(styles.divider)} />
      <div {...stylex.props(styles.section)}>
        <div {...stylex.props(styles.row)}>
          <h3 {...stylex.props(text.label, styles.description)}>Memory embeddings</h3>
          {archived ? (
            <span {...stylex.props(text.caption, text.muted)}>{embedding ? 'On' : 'Off'}</span>
          ) : (
            <Toggle
              label="Memory embeddings"
              checked={embedding !== null}
              onChange={(enabled) => {
                change({ memoryEmbedding: enabled ? { base_url: '', model: '' } : null })
                if (!enabled) void save()
              }}
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
                    onBlur={() => {
                      if (embedding.base_url.trim() && embedding.model.trim()) void save()
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
          <hr {...stylex.props(styles.divider)} />
          <div {...stylex.props(styles.row)}>
            <div {...stylex.props(styles.description)}>
              <h3 {...stylex.props(text.label)}>{project.status === 'paused' ? 'Resume project' : 'Pause project'}</h3>
              <p {...stylex.props(text.caption, text.muted)}>
                New messages wait until you resume. Threads keep running.
              </p>
            </div>
            <Button small onClick={() => void changeStatus(project.status === 'paused' ? 'active' : 'paused')}>
              {status.isPending ? 'Saving…' : project.status === 'paused' ? 'Resume' : 'Pause'}
            </Button>
          </div>
          <div {...stylex.props(styles.row)}>
            <div {...stylex.props(styles.description)}>
              <h3 {...stylex.props(text.label)}>Archive project</h3>
              <p {...stylex.props(text.caption, text.muted)}>Chat, memory, and threads are kept.</p>
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
