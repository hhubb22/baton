import { useEffect, useRef, useState, type FormEvent } from 'react'
import { Conversation, InboxCard, type Dispatch } from './Conversation.tsx'
import { Overview } from './Overview.tsx'
import { Avatar, Icon, Mark } from './controls.tsx'
import {
  conversations as sampleConversations,
  devices,
  employee,
  inbox,
  memories,
  projects as sampleProjects,
  tasks as sampleTasks,
  type Entry,
  type Project,
  type Task,
} from './sample.ts'

type View = { kind: 'project'; id: string } | { kind: 'inbox' }

export function HomePage() {
  const [projects, setProjects] = useState<Project[]>(sampleProjects)
  const [conversations, setConversations] = useState<Record<string, Entry[]>>(sampleConversations)
  const [tasks, setTasks] = useState<Task[]>(sampleTasks)
  const [answers, setAnswers] = useState<Record<string, string>>({})
  const [thinking, setThinking] = useState<Record<string, boolean>>({})
  const [view, setView] = useState<View>({ kind: 'project', id: sampleProjects[0].id })
  const [sidebar, setSidebar] = useState(true)
  const [overview, setOverview] = useState(true)
  const [creating, setCreating] = useState(false)

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'b') {
        e.preventDefault()
        setSidebar((v) => !v)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  const anyOnline = devices.some((d) => d.online)
  const pending = inbox.filter((i) => !answers[i.id])
  const project = view.kind === 'project' ? projects.find((p) => p.id === view.id) : undefined

  function open(id: string) {
    setView({ kind: 'project', id })
    setProjects((list) => list.map((p) => (p.id === id ? { ...p, unread: 0 } : p)))
  }

  function update(id: string, change: Partial<Project>) {
    setProjects((list) => list.map((p) => (p.id === id ? { ...p, ...change } : p)))
  }

  function append(id: string, ...entries: Entry[]) {
    setConversations((all) => ({ ...all, [id]: [...(all[id] ?? []), ...entries] }))
  }

  function wake(p: Project) {
    if (p.status === 'paused' || !anyOnline) return
    setThinking((all) => ({ ...all, [p.id]: true }))
    update(p.id, { status: 'running', runtime: devices.find((d) => d.online)?.name })
  }

  function send(p: Project, text: string) {
    append(p.id, { kind: 'user', text, time: now(), pending: !anyOnline })
    wake(p)
  }

  function dispatch(p: Project, d: Dispatch) {
    const task: Task = {
      id: `t${Date.now()}`,
      projectID: p.id,
      title: d.title,
      device: d.device.name,
      agent: d.agent,
      state: d.device.online ? 'running' : 'queued',
      by: 'user',
      updatedAt: '刚刚',
    }
    setTasks((list) => [task, ...list])
    append(p.id, { kind: 'task', taskID: task.id })
  }

  function answer(itemID: string, text: string) {
    setAnswers((all) => ({ ...all, [itemID]: text }))
    const item = inbox.find((i) => i.id === itemID)
    const owner = projects.find((p) => p.id === item?.projectID)
    if (owner && text !== '已关闭') wake(owner)
  }

  function create(title: string, goal: string) {
    const p: Project = { id: `p${Date.now()}`, title, goal, status: 'idle', model: 'gpt-6.1-sol', hue: (projects.length * 67) % 360, unread: 0 }
    setProjects((list) => [p, ...list])
    setConversations((all) => ({ ...all, [p.id]: [] }))
    setCreating(false)
    open(p.id)
  }

  function archive(p: Project) {
    const rest = projects.filter((x) => x.id !== p.id)
    setProjects(rest)
    if (rest[0]) open(rest[0].id)
    else setView({ kind: 'inbox' })
  }

  return (
    <div className={`home${sidebar ? '' : ' home--collapsed'}${project && overview ? ' home--rail' : ''}`}>
      <aside className="sidebar">
        <div className="sidebar__head">
          <span className="wordmark"><Mark />Baton</span>
          <button type="button" className="icon-btn" aria-label="新建 Project" title="新建 Project" onClick={() => setCreating(true)}>
            <Icon name="pen" />
          </button>
        </div>
        <nav className="nav" aria-label="页面">
          <button type="button" className={`nav__row${view.kind === 'inbox' ? ' is-active' : ''}`} onClick={() => setView({ kind: 'inbox' })}>
            <Icon name="inbox" />待处理{pending.length > 0 ? <span className="count">{pending.length}</span> : null}
          </button>
          <a className="nav__row" href="#"><Icon name="tasks" />任务</a>
          <a className="nav__row" href="#"><Icon name="device" />设备</a>
        </nav>
        <div className="sidebar__label">Project</div>
        <ul className="threads">
          {projects.map((p) => (
            <li key={p.id}>
              <button type="button" className={`thread${view.kind === 'project' && view.id === p.id ? ' is-active' : ''}`} onClick={() => open(p.id)}>
                <Avatar project={p} size={32} />
                <span className="thread__text">
                  <span className="thread__top">
                    <span className="thread__title truncate">{p.title}</span>
                    <span className="meta">{lastTime(conversations[p.id])}</span>
                  </span>
                  <span className="thread__bottom">
                    <span className="thread__preview truncate">{preview(p, conversations[p.id], thinking[p.id])}</span>
                    {p.unread > 0 ? <span className="unread">{p.unread}</span> : null}
                  </span>
                </span>
              </button>
            </li>
          ))}
        </ul>
        <div className="account">
          <span className="avatar">{employee.initial}</span>
          <span className="account__text">
            <span className="account__name">{employee.name}</span>
            <span className="account__meta">{devices.filter((d) => d.online).length} 台设备在线</span>
          </span>
        </div>
      </aside>

      <main className="panel">
        {sidebar ? null : (
          <button type="button" className="icon-btn panel__expand" aria-label="展开侧栏" title="展开侧栏 ⌘B" onClick={() => setSidebar(true)}>
            <Icon name="sidebar" />
          </button>
        )}
        {project ? (
          <>
            <Conversation
              key={project.id}
              project={project}
              entries={conversations[project.id] ?? []}
              tasks={tasks}
              inbox={inbox}
              answers={answers}
              thinking={!!thinking[project.id]}
              overview={overview}
              onToggleOverview={() => setOverview((v) => !v)}
              onSend={(text) => send(project, text)}
              onDispatch={(d) => dispatch(project, d)}
              onAnswer={answer}
              onPause={(paused) => update(project.id, paused ? { status: 'paused' } : { status: 'idle' })}
              onArchive={() => archive(project)}
            />
            {overview ? <Overview project={project} tasks={tasks} inbox={inbox} memories={memories} answers={answers} /> : null}
          </>
        ) : (
          <section className="inbox-view" aria-label="待处理">
            <h1>待处理</h1>
            {pending.length === 0 ? <p className="muted">没有等你处理的事</p> : null}
            {pending.map((item) => {
              const owner = projects.find((p) => p.id === item.projectID)
              return (
                <div key={item.id} className="inbox-view__item">
                  {owner ? (
                    <button type="button" className="inbox-view__from" onClick={() => open(owner.id)}>
                      <Avatar project={owner} size={20} />{owner.title}<span className="meta">{item.createdAt}</span>
                    </button>
                  ) : null}
                  <InboxCard compact item={item} answer={answers[item.id]} onAnswer={answer} />
                </div>
              )
            })}
          </section>
        )}
      </main>

      {creating ? <CreateDialog onCancel={() => setCreating(false)} onCreate={create} /> : null}
    </div>
  )
}

function CreateDialog({ onCancel, onCreate }: { onCancel: () => void; onCreate: (title: string, goal: string) => void }) {
  const [title, setTitle] = useState('')
  const [goal, setGoal] = useState('')
  const dialog = useRef<HTMLDialogElement>(null)

  useEffect(() => { dialog.current?.showModal() }, [])

  function submit(e: FormEvent) {
    e.preventDefault()
    if (title.trim()) onCreate(title.trim(), goal.trim())
  }

  return (
    <dialog ref={dialog} className="dialog" onClose={onCancel}>
      <form onSubmit={submit}>
        <h2>新建 Project</h2>
        <label>
          <span>标题</span>
          <input autoFocus value={title} placeholder="例如 Baton 开发" onChange={(e) => setTitle(e.target.value)} />
        </label>
        <label>
          <span>目标<span className="muted">（可选）</span></span>
          <textarea rows={2} value={goal} placeholder="这件事做到什么程度算完成" onChange={(e) => setGoal(e.target.value)} />
        </label>
        <div className="dialog__actions">
          <button type="button" className="btn btn--ghost" onClick={onCancel}>取消</button>
          <button type="submit" className="btn btn--dark" disabled={!title.trim()}>创建</button>
        </div>
      </form>
    </dialog>
  )
}

function preview(p: Project, entries: Entry[] = [], thinking?: boolean) {
  if (thinking) return '正在处理…'
  if (p.status === 'paused') return '已暂停'
  for (let i = entries.length - 1; i >= 0; i--) {
    const e = entries[i]
    if (e.kind === 'agent') return e.text.replaceAll('`', '')
    if (e.kind === 'user') return `我：${e.text}`
    if (e.kind === 'inbox') return '有一件事等你决定'
  }
  return p.goal || '还没有消息'
}

function lastTime(entries: Entry[] = []) {
  for (let i = entries.length - 1; i >= 0; i--) {
    const e = entries[i]
    if (e.kind === 'agent' || e.kind === 'user') return e.time
  }
  return ''
}

function now() {
  const d = new Date()
  return `${d.getHours()}:${String(d.getMinutes()).padStart(2, '0')}`
}
