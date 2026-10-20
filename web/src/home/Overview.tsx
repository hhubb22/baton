import { useState, type ReactNode } from 'react'
import { stateLabel } from './labels.ts'
import { Icon } from './controls.tsx'
import type { InboxItem, Memory, Project, Task } from './sample.ts'

interface Props {
  project: Project
  tasks: Task[]
  inbox: InboxItem[]
  memories: Memory[]
  answers: Record<string, string>
}

export function Overview({ project, tasks, inbox, memories, answers }: Props) {
  const [tab, setTab] = useState<'tasks' | 'memory'>('tasks')
  const own = tasks.filter((t) => t.projectID === project.id)
  const waiting = inbox.filter((i) => i.projectID === project.id && !answers[i.id])
  const active = own.filter((t) => t.state === 'running' || t.state === 'queued')
  const done = own.filter((t) => t.state !== 'running' && t.state !== 'queued')
  const notes = memories.filter((m) => m.projectID === project.id)

  return (
    <aside className="overview" aria-label="概览">
      <div className="overview__goal">
        <span className="overview__label">目标</span>
        <p>{project.goal || <span className="muted">还没有写目标</span>}</p>
      </div>
      <div className="tabs" role="tablist">
        <button type="button" role="tab" aria-selected={tab === 'tasks'} onClick={() => setTab('tasks')}>任务<span className="count">{own.length}</span></button>
        <button type="button" role="tab" aria-selected={tab === 'memory'} onClick={() => setTab('memory')}>记忆<span className="count">{notes.length}</span></button>
      </div>
      {tab === 'tasks' ? (
        <div className="overview__body">
          <Group title="等你处理" empty={waiting.length === 0}>
            {waiting.map((i) => (
              <a key={i.id} className="ov-row" href="#">
                <span className="dot dot--unverified" />
                <span className="truncate">{i.title}</span>
              </a>
            ))}
          </Group>
          <Group title="进行中" empty={active.length === 0}>
            {active.map((t) => <TaskRow key={t.id} task={t} />)}
          </Group>
          <Group title="已结束" empty={done.length === 0}>
            {done.map((t) => <TaskRow key={t.id} task={t} />)}
          </Group>
          {own.length === 0 && waiting.length === 0 ? <p className="muted ov-empty">还没有任务</p> : null}
        </div>
      ) : (
        <div className="overview__body">
          <ul className="memories">
            {notes.map((m) => (
              <li key={m.id}>
                <p>{m.text}</p>
                <span className="meta">v{m.version} · {m.by === 'agent' ? 'Project Agent' : '我'} · {m.updatedAt}</span>
              </li>
            ))}
          </ul>
          {notes.length === 0 ? <p className="muted ov-empty">Project Agent 记下的决定和事实会出现在这里</p> : null}
          <button type="button" className="btn btn--ghost ov-add"><Icon name="plus" />添加记忆</button>
        </div>
      )}
    </aside>
  )
}

function Group({ title, empty, children }: { title: string; empty: boolean; children: ReactNode }) {
  if (empty) return null
  return (
    <section className="ov-group">
      <h3>{title}</h3>
      {children}
    </section>
  )
}

function TaskRow({ task }: { task: Task }) {
  return (
    <a className="ov-row" href="#">
      <span className={`dot dot--${task.state}`} />
      <span className="ov-row__main">
        <span className="truncate">{task.title}</span>
        <span className="meta">{task.device} · {stateLabel[task.state]}</span>
      </span>
    </a>
  )
}
