import * as stylex from '@stylexjs/stylex'
import { useRef, useState } from 'react'
import { ClientError } from '../data/client'
import { newClientId, useProjectMemory, useSaveMemory } from '../data/queries'
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
      <Field label="Memory" error={error} helper="Read with your next message.">
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
        <details>
          <summary {...stylex.props(text.caption, text.muted, focusRing.ring)}>View source and history</summary>
          <div {...stylex.props(styles.history)}>
            {note.versions.toReversed().map((version) => (
              <div key={version.version}>
                <p {...stylex.props(text.caption, text.muted)}>{metadata(version)}</p>
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
  const [editing, setEditing] = useState<MemoryNote | 'new' | null>(null)
  const archived = project.status === 'archived'
  return (
    <section aria-label="Project memory" {...stylex.props(styles.list)}>
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
      {memory.data?.map((note) => (
        <article key={note.id} aria-label={`Memory v${note.version}`} {...stylex.props(styles.row)}>
          {archived ? (
            <p {...stylex.props(text.small)}>{note.body}</p>
          ) : (
            <button
              data-memory-id={note.id}
              type="button"
              onClick={() => setEditing(note)}
              {...stylex.props(text.small, styles.edit, focusRing.ring)}
            >
              {note.body}
            </button>
          )}
        </article>
      ))}
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
