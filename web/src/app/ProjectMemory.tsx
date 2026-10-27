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
import { colors, space } from '../theme/tokens.stylex'
import { Banner } from '../ui/Banner'
import { Button, focusRing } from '../ui/Button'
import { Dialog } from '../ui/Dialog'
import { Field, TextArea } from '../ui/Field'
import { useWorkspace, type MemoryDraft } from './workspace'

const styles = stylex.create({
  list: { display: 'flex', flexDirection: 'column', gap: space.md, minWidth: 0 },
  row: {
    display: 'flex',
    flexDirection: 'column',
    gap: '6px',
    paddingBlock: space.sm,
    minWidth: 0,
    overflowWrap: 'anywhere',
  },
  edit: {
    backgroundColor: 'transparent',
    borderWidth: 0,
    padding: 0,
    color: colors.text,
    textAlign: 'left',
    whiteSpace: 'pre-wrap',
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
  return `v${version.version} · ${version.source === 'you' ? 'You' : 'Project assistant'} · ${new Date(version.updatedAt).toLocaleString()}`
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
      setError('Enter a memory.')
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
      setError(
        cause instanceof ClientError && cause.code === 'invalid' ? cause.message : 'Not saved. Your draft is kept.',
      )
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
      setError(
        note.status === 'retired'
          ? 'Could not restore memory. Check its current history.'
          : 'Could not stop using memory. Your draft is kept.',
      )
    } finally {
      saving.current = false
    }
  }
  return (
    <Dialog
      open
      title={note ? 'Edit memory' : 'Add memory'}
      onOpenChange={(open) => {
        if (!open) cancel()
      }}
      finalFocus={() => document.querySelector<HTMLButtonElement>(`[data-memory-id="${note?.id ?? 'new'}"]`)}
      note={
        <span role="status">
          {save.isPending ? 'Saving…' : latest ? 'Updated while you edited. Your draft is kept.' : null}
        </span>
      }
      actions={
        <>
          <Button onClick={cancel}>Cancel</Button>
          {note && !archived && !latest && (
            <Button onClick={() => void changeStatus()}>
              {note.status === 'retired' ? 'Restore memory' : 'Stop using'}
            </Button>
          )}
          {latest ? (
            <Button
              onClick={() => {
                update({ ...draft, version: latest.version, clientId: newClientId() })
                setLatest(null)
                setError(null)
              }}
            >
              Review latest
            </Button>
          ) : (
            !archived && (
              <Button variant="primary" onClick={() => void submit()}>
                {save.isPending ? 'Saving…' : 'Save memory'}
              </Button>
            )
          )}
        </>
      }
    >
      {archived && <Banner icon="archive" title="Project archived" detail="Read-only. Threads keep running." />}
      <Field label="Memory" error={error}>
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
          <p {...stylex.props(text.caption, text.muted)}>Latest · {metadata(latest)}</p>
          <p {...stylex.props(text.small)}>{latest.body}</p>
        </div>
      )}
      {note && (
        <details onToggle={(event) => setShowSources(event.currentTarget.open)}>
          <summary {...stylex.props(text.caption, text.muted, focusRing.ring)}>View source and history</summary>
          <div {...stylex.props(styles.history)}>
            {sources.isPending && showSources && <p role="status">Loading sources…</p>}
            {sources.isError && (
              <Button small onClick={() => void sources.refetch()}>
                Retry sources
              </Button>
            )}
            {sources.data?.map((source) => (
              <div key={source.id}>
                <p {...stylex.props(text.caption, text.muted)}>
                  {source.role === 'user'
                    ? 'You'
                    : source.role === 'execution'
                      ? 'Execution result'
                      : 'Assistant report'}
                  {source.source_seq ? ' · Message ' + source.source_seq : ''}
                  {source.suppressed ? ' · No longer used' : ''}
                </p>
                <p {...stylex.props(text.small)}>{source.text}</p>
              </div>
            ))}
            {note.versions.toReversed().map((version) => (
              <div key={version.version}>
                <p {...stylex.props(text.caption, text.muted)}>
                  {metadata(version)}
                  {version.details?.retracted ? ' · Retracted' : ''}
                </p>
                {version.details?.reason && <p {...stylex.props(text.caption, text.muted)}>{version.details.reason}</p>}
                {(version.details?.validFrom || version.details?.validUntil) && (
                  <p {...stylex.props(text.caption, text.muted)}>
                    Applies{' '}
                    {version.details.validFrom
                      ? new Date(version.details.validFrom).toLocaleString()
                      : 'from an unknown time'}
                    {version.details.validUntil
                      ? ' until ' + new Date(version.details.validUntil).toLocaleString()
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

// @elyx design/blocks/overview.elyx#overviewMemory
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
    <article key={note.id} aria-label="Memory" {...stylex.props(styles.row)}>
      <button
        data-memory-id={note.id}
        type="button"
        onClick={() => setEditing(note)}
        {...stylex.props(text.small, styles.edit, focusRing.ring)}
      >
        {note.body}
      </button>
    </article>
  )
  return (
    <section aria-label="Project memory" {...stylex.props(styles.list)}>
      {attention && (
        <Banner
          attention
          title={
            attention === 'login_required' ? 'Memory updates need sign-in' : 'Memory search needs device credentials'
          }
          detail={
            attention === 'login_required'
              ? 'Saved conversations will be processed after sign-in.'
              : 'Keyword search is still available.'
          }
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
              {attention === 'login_required' ? 'View devices' : 'Open settings'}
            </Button>
          }
        />
      )}
      {memory.isPending && (
        <p role="status" {...stylex.props(text.small, text.muted)}>
          Loading memory…
        </p>
      )}
      {memory.isError && (
        <Banner
          icon="alert"
          title="Couldn't load project memory"
          action={
            <Button small onClick={() => void memory.refetch()}>
              Retry memory
            </Button>
          }
        />
      )}
      {memory.data?.length === 0 && <p {...stylex.props(text.small, text.muted)}>No memory yet</p>}
      {[...new Set(active.map((note) => note.topic))].map((topic) => (
        <div key={topic}>
          {topic && <p {...stylex.props(text.caption, text.muted)}>{topic}</p>}
          {active.filter((note) => note.topic === topic).map(renderNote)}
        </div>
      ))}
      {retired.length > 0 && (
        <details>
          <summary {...stylex.props(text.caption, text.muted, focusRing.ring)}>No longer used</summary>
          {retired.map(renderNote)}
        </details>
      )}
      {!archived && (
        <Button small data-memory-id="new" onClick={() => setEditing('new')}>
          Add memory
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
