import { useCallback, useEffect, useRef, useState } from 'react'
import { ApiError, messageOf, request } from '../api.ts'
import { conversationItems, getProject, getProjectEvents, getProjectStatus, pendingMessageID, placementReasons, projectAPI, projectStates, projectURL, saveMessageID, waitingReasons, type Project, type ProjectEvent, type ProjectMemory, type ProjectMessage, type ProjectStatus } from '../projects.ts'
import { listTasks, taskStates, taskURL, timeLabel, type TaskPage } from '../tasks.ts'
import { TaskComposer } from './TaskComposer.tsx'
import type { NodeList } from '../types.ts'
import { TaskOrigin } from './TaskOrigin.tsx'

type Props = { id: string; csrf: string; employeeID: string; navigate: (id: string) => void; navigateTask: (id: string) => void }

export function ProjectsPage(props: Props) {
  return props.id ? <ProjectDetail key={props.id} {...props} /> : <ProjectList csrf={props.csrf} navigate={props.navigate} />
}

function ProjectList({ csrf, navigate }: { csrf: string; navigate: (id: string) => void }) {
  const [projects, setProjects] = useState<Project[]>([])
  const [after, setAfter] = useState('')
  const [cursor, setCursor] = useState('')
  const [error, setError] = useState('')
  const [title, setTitle] = useState('')
  const [busy, setBusy] = useState(false)
  const [reload, setReload] = useState(0)
  useEffect(() => {
    let stopped = false
    void request<{ projects: Project[]; next_after_id?: string }>(`/api/v1/projects?limit=100${cursor ? `&after_id=${cursor}` : ''}`).then((page) => {
      if (!stopped) { setProjects((current) => cursor ? [...current.filter((p) => !page.projects.some((v) => v.id === p.id)), ...page.projects] : page.projects); setAfter(page.next_after_id ?? ''); setError('') }
    }).catch((e: unknown) => { if (!stopped) setError(messageOf(e)) })
    return () => { stopped = true }
  }, [cursor, reload])
  return <section aria-label="Project 列表"><h1>Project</h1>
    <form onSubmit={(e) => {
      e.preventDefault(); setBusy(true); setError('')
      void request<Project>('/api/v1/projects', { method: 'POST', csrf, body: { title } }).then((p) => navigate(p.id)).catch((err: unknown) => setError(messageOf(err))).finally(() => setBusy(false))
    }}><label>Project 标题<input value={title} onChange={(e) => setTitle(e.target.value)} maxLength={200} required /></label><button disabled={busy || !csrf || !title.trim()}>创建 Project</button></form>
    {error && <p role="alert" className="error">{error}</p>}
    <button className="secondary" onClick={() => { setCursor(''); setReload((v) => v + 1) }}>刷新 Project 列表</button>
    {projects.map((p) => <article className="card" key={p.id}><h2><a href={projectURL(p.id)} onClick={(e) => { e.preventDefault(); navigate(p.id) }}>{p.title}</a></h2><p>{p.goal}</p><p>{projectStates[p.status] ?? (p.status === 'active' ? '启用' : p.status)} · {p.conversation.state === 'needs_attention' ? '需要处理' : '主对话'}</p></article>)}
    {!projects.length && !error && <p>暂无 Project。</p>}
    {after && <button onClick={() => setCursor(after)}>更多 Project</button>}
  </section>
}

function ProjectDetail({ id, csrf, employeeID, navigate, navigateTask }: Props) {
  const [project, setProject] = useState<Project | null>(null)
  const [status, setStatus] = useState<ProjectStatus | null>(null)
  const [events, setEvents] = useState<ProjectEvent[]>([])
  const [messages, setMessages] = useState<ProjectMessage[]>([])
  const [memory, setMemory] = useState<ProjectMemory[]>([])
  const [nodes, setNodes] = useState<NodeList | null>(null)
  const [tasks, setTasks] = useState<TaskPage>({ tasks: [] })
  const [taskCursor, setTaskCursor] = useState('')
  const [error, setError] = useState('')
  const [actionError, setActionError] = useState('')
  const [notice, setNotice] = useState('')
  const [busy, setBusy] = useState(false)
  const [content, setContent] = useState('')
  const [messageID, setMessageID] = useState(() => pendingMessageID(employeeID, id))
  const [visibleSeq, setVisibleSeq] = useState(0)
  const [hasMore, setHasMore] = useState(false)
  const alive = useRef(false)
  const loading = useRef(false)
  const generation = useRef(0)
  const afterSeq = useRef(0)
  const refresh = useCallback(async () => {
    if (loading.current) return
    loading.current = true
    const gen = generation.current
    try {
      const p = await getProject(id)
      const [state, page, queued, memories, taskPage, nodePage] = await Promise.all([
        getProjectStatus(id), getProjectEvents(id, afterSeq.current),
        readAll<ProjectMessage>(`${projectAPI(id)}/messages`, 'messages'), readAll<ProjectMemory>(`${projectAPI(id)}/memory`, 'entries'),
        listTasks({ project_id: id, ...(taskCursor ? { cursor: taskCursor } : {}) }), request<NodeList>('/api/v1/nodes'),
      ])
      if (!alive.current || gen !== generation.current) return
      setProject(p); setStatus(state); setMessages(queued); setMemory(memories); setTasks(taskPage); setNodes(nodePage); setError('')
      setEvents((current) => [...current.filter((event) => !page.events.some((v) => v.seq === event.seq)), ...page.events].sort((a, b) => a.seq - b.seq))
      afterSeq.current = page.next_after_seq; setVisibleSeq(page.next_after_seq); setHasMore(page.has_more)
    } catch (err) {
      if (!alive.current || gen !== generation.current) return
      if (err instanceof ApiError && [401, 403, 404].includes(err.status)) { setProject(null); setStatus(null); setEvents([]); setMessages([]); setMemory([]); setTasks({ tasks: [] }); afterSeq.current = 0 }
      else setStatus(null)
      setError(`${messageOf(err)}。请刷新查询。`)
    } finally { loading.current = false }
  }, [id, taskCursor])
  useEffect(() => {
    alive.current = true; void Promise.resolve().then(refresh)
    const timer = window.setInterval(() => { if (document.visibilityState === 'visible') void refresh() }, 2000)
    const focus = () => { void refresh() }
    window.addEventListener('focus', focus)
    const invalidate = () => { generation.current++ }
    return () => { alive.current = false; invalidate(); window.clearInterval(timer); window.removeEventListener('focus', focus) }
  }, [refresh])
  async function action(operation: () => Promise<unknown>, success: string) {
    setBusy(true); setActionError(''); setNotice('')
    try { await operation(); if (alive.current) { setNotice(success); await refresh() } }
    catch (err) { if (alive.current) setActionError(messageOf(err)) }
    finally { if (alive.current) setBusy(false) }
  }
  async function send() {
    const clientID = messageID || crypto.randomUUID()
    saveMessageID(employeeID, id, clientID); setMessageID(clientID)
    await action(async () => {
      await request(`${projectAPI(id)}/messages`, { method: 'POST', csrf, body: { client_message_id: clientID, content } })
      if (!alive.current) return
      saveMessageID(employeeID, id, ''); setMessageID(''); setContent('')
    }, '消息已保存在中心。')
  }
  async function recover() {
    await action(async () => {
      const value = await request<{ messages: ProjectMessage[] }>(`${projectAPI(id)}/messages?client_message_id=${encodeURIComponent(messageID)}`)
      if (!value.messages.length) throw new ApiError(404, 'not_found', '中心暂未查到原消息。请补全相同正文并重发原消息。', '')
      if (!alive.current) return
      saveMessageID(employeeID, id, ''); setMessageID(''); setContent('')
    }, '原消息已保存在中心。')
  }
  return <section className="projects" aria-label="Project 详情">
    <a href="/projects" onClick={(e) => { e.preventDefault(); navigate('') }}>所有 Project</a>
    <button className="secondary" onClick={() => void refresh()}>刷新 Project</button>
    {error && <p role="alert" className="error">{error} 已读取的对话保留在页面中，运行状态需要重新查询。</p>}
    {actionError && <p role="alert" className="error">{actionError}</p>}
    {notice && <p role="status">{notice}</p>}
    {project && <>
      <h1>{project.title}</h1><p className="task-text">{project.goal}</p>
      <section className="card" aria-label="Project 运行状态"><h2>运行状态</h2>
        <p>{status ? projectStates[status.state] ?? status.state : '运行状态暂不可用'}</p>
        {status?.waiting_reason && <p>{waitingReasons[status.waiting_reason] ?? status.waiting_reason}</p>}
        {status && <p>待处理输入：{status.pending_inputs}</p>}
        {status?.next_attempt_at && status.state !== 'needs_attention' && <p>下次自动重试：{timeLabel(status.next_attempt_at)}</p>}
        {status?.last_error && <p className="error">最后的错误：{status.last_error}</p>}
        {status?.run && <><p>{status.run.effective ? '当前运行设备' : '上次运行设备'}：{status.run.node_name} · {status.run.node_id}</p>
          <p>{placementReasons[status.run.placement_reason] ?? status.run.placement_reason}</p>
          {!status.run.effective && <p>实例已失去资格；{status.run.stop_acked_at ? '进程已确认退出' : '进程退出尚未确认'}。{status.run.end_reason}</p>}</>}
        {status?.run?.effective && <button disabled={busy || !csrf} onClick={() => void action(() => request(`${projectAPI(id)}/stop`, { method: 'POST', csrf, body: {} }), '已停止这次运行，已派出的任务继续执行。待处理输入可能启动下一次运行。')}>停止当前运行</button>}
        {status?.state === 'needs_attention' && <button disabled={busy || !csrf} onClick={() => void action(() => request(`${projectAPI(id)}/retry`, { method: 'POST', csrf, body: {} }), '已请求从原位置重试。')}>重试 Project Agent</button>}
      </section>
      <section className="card" aria-label="主对话"><h2>主对话</h2>
        {events.map((event) => <article key={event.seq} data-seq={event.seq}>{conversationItems(event).map((item, i) => <div key={i}><h3>{item.label}</h3><p className="task-text">{item.text}</p></div>)}<small>#{event.seq} · {timeLabel(event.created_at)}</small></article>)}
        {hasMore && <button onClick={() => void refresh()}>继续读取对话</button>}
        {!hasMore && status?.preview?.text && status.run?.effective && status.preview.after_seq === visibleSeq && <article aria-label="流式回复"><h3>Project Agent 正在回复（尚未保存）</h3><p className="task-text">{status.preview.text}</p>{status.preview.truncated && <p>预览已截短，完整回复保存后显示。</p>}</article>}
        {messages.map((message) => <article key={message.id}><h3>你 · 已入队</h3><p className="task-text">{message.content}</p><small>{timeLabel(message.created_at)}</small></article>)}
        {!events.length && !messages.length && <p>暂无对话。</p>}
        <form onSubmit={(e) => { e.preventDefault(); void send() }}><label>发给 Project Agent 的消息<textarea value={content} disabled={busy} onChange={(e) => setContent(e.target.value)} required /></label>
          <p className="hint">消息最多 64 KiB。所有设备离线时也会保存。</p>
          {messageID && <><p>上次消息的结果尚未确认。查询或重发使用同一消息标识。</p><button type="button" disabled={busy} onClick={() => void recover()}>查询原消息</button></>}
          <button disabled={busy || !csrf || !content.trim() || new TextEncoder().encode(content).length > 64 * 1024}>{messageID ? '重发原消息' : '发送消息'}</button>
        </form>
      </section>
      <section className="card" aria-label="项目记忆"><h2>项目记忆</h2>
        {memory.map((entry) => <MemoryEditor key={entry.id} projectID={id} entry={entry} csrf={csrf} refresh={refresh} />)}
        {!memory.length && <p>暂无项目记忆。</p>}
        <details><summary>添加记忆</summary><MemoryEditor key="new" projectID={id} csrf={csrf} refresh={refresh} /></details>
      </section>
      <section className="card" aria-label="Project 任务"><h2>Project 的任务</h2>
        <details><summary>直接派发任务</summary><TaskComposer csrf={csrf} employeeID={employeeID} nodes={nodes} projectID={id} onAccepted={() => { setTaskCursor(''); void refresh() }} /></details>
        {tasks.tasks.map((task) => <article key={task.task_id}><h3><a href={taskURL(task.task_id)} onClick={(e) => { e.preventDefault(); navigateTask(task.task_id) }}>{task.description}</a></h3><TaskOrigin task={task} /><p>{taskStates[task.status] ?? task.status}</p><p className="task-text">{task.summary}</p>{task.error_message && <p className="error">{task.error_message}</p>}</article>)}
        {!tasks.tasks.length && <p>暂无任务。</p>}
        {taskCursor && <button onClick={() => setTaskCursor('')}>回到首批任务</button>}
        {tasks.next_cursor && <button onClick={() => setTaskCursor(tasks.next_cursor ?? '')}>下一批任务</button>}
      </section>
      <details><summary>Project 设置</summary><ProjectSettings key={project.id} project={project} csrf={csrf} save={(body) => void action(() => request(projectAPI(id), { method: 'PATCH', csrf, body }), 'Project 设置已保存，下次运行使用新的模型设置。')} busy={busy} /></details>
    </>}
  </section>
}

async function readAll<T>(url: string, field: 'messages' | 'entries'): Promise<T[]> {
  const all: T[] = []
  let after = ''
  do {
    const page = await request<{ messages?: T[]; entries?: T[]; next_after_id?: string | number }>(`${url}?limit=100${after ? `&after_id=${after}` : ''}`)
    all.push(...page[field] ?? []); after = String(page.next_after_id ?? '')
  } while (after)
  return all
}

function MemoryEditor({ projectID, entry, csrf, refresh }: { projectID: string; entry?: ProjectMemory; csrf: string; refresh: () => Promise<void> }) {
  const [editing, setEditing] = useState(!entry)
  const [draft, setDraft] = useState({ title: '', content: '', revision: 0 })
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const [conflict, setConflict] = useState(false)
  const newID = useRef('')
  function edit() { setDraft({ title: entry?.title ?? '', content: entry?.content ?? '', revision: entry?.revision ?? 0 }); setEditing(true); setError(''); setConflict(false) }
  return <article>
    {entry && <><h3>{entry.title}</h3><p className="task-text">{entry.content}</p><small>版本 {entry.revision} · {entry.author === 'user' ? '用户' : 'Project Agent'} · {timeLabel(entry.updated_at)}</small></>}
    {editing ? <form onSubmit={(e) => {
      e.preventDefault(); setBusy(true); setError('')
      if (!newID.current) newID.current = crypto.randomUUID()
      void request(`${projectAPI(projectID)}/memory/${entry?.id ?? newID.current}`, { method: 'PUT', csrf, body: { title: draft.title, content: draft.content, expected_revision: draft.revision } }).then(async () => {
        setEditing(!entry); setDraft({ title: '', content: '', revision: 0 }); newID.current = ''; await refresh()
      }).catch((err: unknown) => { setError(messageOf(err)); if (err instanceof ApiError && err.status === 409) setConflict(true) }).finally(() => setBusy(false))
    }}>
      <label>记忆标题<input value={draft.title} onChange={(e) => setDraft({ ...draft, title: e.target.value })} maxLength={200} required /></label>
      <label>记忆内容<textarea value={draft.content} onChange={(e) => setDraft({ ...draft, content: e.target.value })} /></label>
      {entry && entry.revision !== draft.revision && <p>记忆已有新版本。你的编辑仍基于版本 {draft.revision}。</p>}
      <button disabled={busy || conflict || !csrf || !draft.title.trim() || new TextEncoder().encode(draft.content).length > 64 * 1024}>保存记忆</button>
      {entry && <button type="button" disabled={busy} onClick={() => setEditing(false)}>取消编辑记忆</button>}
    </form> : <button onClick={edit}>修改记忆</button>}
    {error && <p role="alert" className="error">{error} 当前编辑内容已保留。</p>}
    {conflict && <button type="button" onClick={() => {
      void refresh().then(() => setEditing(false))
    }}>查看最新记忆后重新编辑</button>}
  </article>
}

function ProjectSettings({ project, csrf, save, busy }: { project: Project; csrf: string; save: (body: unknown) => void; busy: boolean }) {
  const [title, setTitle] = useState(project.title)
  const [goal, setGoal] = useState(project.goal)
  const [status, setStatus] = useState(project.status)
  const [provider, setProvider] = useState(project.agent.provider)
  const [model, setModel] = useState(project.agent.model)
  return <form onSubmit={(e) => { e.preventDefault(); save({ title, goal, provider, model, status }) }}>
    <label>标题<input value={title} onChange={(e) => setTitle(e.target.value)} required maxLength={200} /></label>
    <label>Project 状态<select value={status} onChange={(e) => setStatus(e.target.value)}><option value="active">启用</option><option value="paused">暂停</option><option value="archived">归档</option></select></label>
    <label>目标<textarea value={goal} onChange={(e) => setGoal(e.target.value)} /></label>
    <label>模型订阅<input value={provider} onChange={(e) => setProvider(e.target.value)} placeholder="openai-codex" /></label>
    <label>模型<input value={model} onChange={(e) => setModel(e.target.value)} /></label>
    <button disabled={busy || !csrf}>保存 Project 设置</button>
  </form>
}
