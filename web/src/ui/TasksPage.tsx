import { useCallback, useEffect, useRef, useState } from 'react'
import { ApiError, messageOf, request } from '../api.ts'
import { taskEventLabels, deliveryStates, getTask, getTaskEvents, listTasks, taskStates, taskURL, timeLabel, type TaskEvent, type TaskPage, type TaskRecord } from '../tasks.ts'
import type { NodeList } from '../types.ts'
import { useAttentionList, type AskProject } from '../inbox.ts'
import { AttentionCard } from './AttentionCard.tsx'
import { ProjectQuote } from './ProjectQuote.tsx'
import { TaskOrigin } from './TaskOrigin.tsx'
import { TaskComposer } from './TaskComposer.tsx'
import { TaskActions } from './TaskActions.tsx'
import { TaskReferences } from './TaskReferences.tsx'
import type { WorkSession } from './SessionsPage.tsx'

export function TasksPage({ id, csrf, employeeID, nodes, navigate, askProject }: {
  id: string; csrf: string; employeeID: string; nodes: NodeList | null; navigate: (id: string) => void; askProject?: AskProject
}) {
  return id ? <TaskDetail key={id} id={id} csrf={csrf} employeeID={employeeID} nodes={nodes} navigate={navigate} askProject={askProject} /> : <TaskList csrf={csrf} employeeID={employeeID} nodes={nodes} navigate={navigate} />
}

function TaskList({ csrf, employeeID, nodes, navigate }: Omit<Parameters<typeof TasksPage>[0], 'id'>) {
  const [page, setPage] = useState<TaskPage>({ tasks: [] })
  const [sessions, setSessions] = useState<WorkSession[]>([])
  const [includeShell, setIncludeShell] = useState(false)
  const [cursor, setCursor] = useState('')
  const [previous, setPrevious] = useState<string[]>([])
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  useEffect(() => {
    let stopped = false
    void request<{ sessions: WorkSession[] }>('/api/v1/sessions').then((value) => { if (!stopped) setSessions(value.sessions) }).catch(() => {})
    return () => { stopped = true }
  }, [])
  useEffect(() => {
    let stopped = false
    let loading = false
    const refresh = async () => {
      if (loading) return
      loading = true; setBusy(true)
      try {
        const value = await listTasks({ include_shell: String(includeShell), ...(cursor ? { cursor } : {}) })
        if (!stopped) { setPage(value); setError('') }
      } catch (e) { if (!stopped) setError(`${messageOf(e)}。保留最近读取的列表。`) }
      finally { loading = false; if (!stopped) setBusy(false) }
    }
    void refresh()
    const timer = window.setInterval(() => { if (document.visibilityState === 'visible') void refresh() }, 5000)
    window.addEventListener('focus', refresh)
    return () => { stopped = true; window.clearInterval(timer); window.removeEventListener('focus', refresh) }
  }, [includeShell, cursor])
  return <section className="tasks" aria-label="任务列表">
    <h1>任务</h1><p className="hint">中心保存任务记录，节点离线时仍可查看。每页最多 100 条，每 5 秒刷新。</p>
    <details><summary>发起任务</summary><TaskComposer csrf={csrf} employeeID={employeeID} nodes={nodes} sessions={sessions} onAccepted={(task) => navigate(task.task_id)} /></details>
    <label className="check"><input type="checkbox" checked={includeShell} onChange={(e) => { setIncludeShell(e.target.checked); setCursor(''); setPrevious([]); setPage({ tasks: [] }) }} />显示命令任务（shell）</label>
    {error && <p role="alert" className="error">{error}</p>}
    {!page.tasks.length && <p>{busy ? '正在读取任务。' : '暂无任务。'}</p>}
    {page.tasks.map((task) => <article className="card" key={task.task_id}>
      <h2><a href={taskURL(task.task_id)} onClick={(e) => { e.preventDefault(); navigate(task.task_id) }}>{task.description}</a></h2>
      <p>{taskStates[task.status] ?? task.status} · {task.agent_type} · {nodes?.nodes.find((node) => node.id === task.target_node_id)?.display_name ?? task.target_node_id}</p>
      <TaskOrigin task={task} /><small>{timeLabel(task.updated_at)} · {task.task_id}</small>
    </article>)}
    <div className="actions"><button disabled={busy || !previous.length} onClick={() => { setCursor(previous.at(-1) ?? ''); setPrevious(previous.slice(0, -1)); setPage({ tasks: [] }) }}>上一页</button>
      <button disabled={busy || !page.next_cursor} onClick={() => { setPrevious([...previous, cursor]); setCursor(page.next_cursor ?? ''); setPage({ tasks: [] }) }}>下一页</button></div>
  </section>
}

function TaskDetail({ id, csrf, employeeID, nodes, navigate, askProject }: Parameters<typeof TasksPage>[0]) {
  const related = useAttentionList('all', { task_id: id }, Infinity)
  const [task, setTask] = useState<TaskRecord | null>(null)
  const [events, setEvents] = useState<TaskEvent[]>([])
  const [children, setChildren] = useState<TaskPage>({ tasks: [] })
  const [childCursor, setChildCursor] = useState('')
  const [error, setError] = useState('')
  const [auxError, setAuxError] = useState('')
  const generation = useRef(0)
  const alive = useRef(true)
  const refresh = useCallback(async () => {
    const gen = ++generation.current
    try {
      const value = await getTask(id)
      if (!alive.current || gen !== generation.current) return
      setTask(value); setError('')
    } catch (e) {
      if (alive.current && gen === generation.current) {
        if (e instanceof ApiError && [401, 403].includes(e.status)) { setTask(null); setEvents([]); setChildren({ tasks: [] }) }
        setError(`${messageOf(e)}。${e instanceof ApiError && [401, 403].includes(e.status) ? '' : '页面保留上次读取的记录，请重试查询。'}`)
      }
      throw e
    }
    const extra = await Promise.allSettled([getTaskEvents(id), listTasks({ parent_task_id: id, ...(childCursor ? { cursor: childCursor } : {}) })])
    if (!alive.current || gen !== generation.current) return
    if (extra[0].status === 'fulfilled') setEvents(extra[0].value.events)
    if (extra[1].status === 'fulfilled') setChildren(extra[1].value)
    setAuxError(extra.some((r) => r.status === 'rejected') ? '委托关系或操作记录暂时读取失败，保留最近记录。' : '')
  }, [id, childCursor])
  useEffect(() => {
    alive.current = true
    let loading = false
    const load = async () => { if (loading) return; loading = true; try { await refresh() } catch { /* 查询失败由页面显示。 */ } finally { loading = false } }
    void load()
    const timer = window.setInterval(() => { if (document.visibilityState === 'visible') void load() }, 5000)
    window.addEventListener('focus', load)
    return () => { alive.current = false; window.clearInterval(timer); window.removeEventListener('focus', load) }
  }, [refresh])
  const node = nodes?.nodes.find((n) => n.id === task?.target_node_id)
  const link = (taskID: string, label: string) => <a href={taskURL(taskID)} onClick={(e) => { e.preventDefault(); navigate(taskID) }}>{label}</a>
  return <section className="tasks" aria-label="任务详情">
    <a href="/tasks" onClick={(e) => { e.preventDefault(); navigate('') }}>所有任务</a>
    <h1>任务详情</h1>
    <button className="secondary" onClick={() => void refresh().catch(() => {})}>刷新任务记录</button>
    {error && <p role="alert" className="error">{error}</p>}
    {auxError && <p role="alert" className="error">{auxError}</p>}
    {!task && !error && <p>正在读取任务。</p>}
    {task && <>
      <h2>{task.description}</h2><TaskOrigin task={task} /><p className="meta">{task.task_id}</p>
      <div className="task-statuses">
        <section className="card" aria-label="节点连接"><h3>节点连接</h3><p>{node ? node.online ? node.synced ? '在线，已同步' : '在线，等待同步' : '离线' : '暂未取得节点连接状态'}</p><small>最后联系：{timeLabel(node?.last_contact_at)}</small></section>
        <section className="card" aria-label="执行状态"><h3>执行状态</h3><p>{taskStates[task.status] ?? task.status}</p><small>记录更新：{timeLabel(task.updated_at)} · 版本 {task.version}</small></section>
        <section className="card" aria-label="结果交付"><h3>结果交付</h3><p>{deliveryStates[task.delivery_status ?? ''] ?? '暂未取得交付状态'}</p>{task.delivery_updated_at && <small>交付记录：{timeLabel(task.delivery_updated_at)}</small>}</section>
      </div>
      <section className="card" aria-label="结果摘要"><h3>结果摘要和错误</h3><ProjectQuote projectID={task.project_id} source={{ taskID: id, field: 'summary' }} askProject={askProject}><p className="task-text">{task.summary ?? '尚无结果摘要。'}</p></ProjectQuote>{task.error_code && <ProjectQuote projectID={task.project_id} source={{ taskID: id, field: 'error' }} askProject={askProject}><p className="error">{task.error_message}（{task.error_code}）</p></ProjectQuote>}</section>
      <TaskReferences title="证据与预览" refs={task.evidence} empty={task.evidence_empty_reason} projectID={task.project_id} taskID={id} askProject={askProject} />
      <TaskReferences title="产物" refs={task.artifacts} empty={task.artifacts_empty_reason} projectID={task.project_id} taskID={id} askProject={askProject} />
      <section className="card" aria-label="委托关系"><h3>委托链与新执行</h3>
        {task.parent_task_id && <p>来源任务：{link(task.parent_task_id, task.parent_task_id)}</p>}
        {task.source_session_id && <p>来源 Session：{task.source_session_id}</p>}
        <p>执行节点：{node?.display_name ?? task.target_node_id} · {task.target_node_id}</p>
        <p>目标 Session：{task.target_session_id ?? '尚未建立'}</p>
        {task.rerun_of_task_id && <p>原执行：{link(task.rerun_of_task_id, task.rerun_of_task_id)}</p>}
        {children.tasks.map((child) => <p key={child.task_id}>子委托：{link(child.task_id, child.description)} · {taskStates[child.status] ?? child.status}</p>)}
        {!children.tasks.length && <p>本页没有子委托。</p>}
        <div className="actions">{childCursor && <button onClick={() => setChildCursor('')}>回到首批子委托</button>}{children.next_cursor && <button onClick={() => setChildCursor(children.next_cursor ?? '')}>下一批子委托</button>}</div>
        {events.filter((event) => event.rerun).map((event) => <p key={event.event_id}>新执行：{link(event.rerun!.task_id, event.rerun!.task_id)} · {event.rerun!.reason}</p>)}
      </section>
      <section className="card" aria-label="相关事项"><h3>相关事项</h3>{related.error && <p role="alert">{related.error}</p>}{related.requests.map((item) => <AttentionCard key={item.id} item={item} csrf={csrf} askProject={askProject} />)}{!related.requests.length && !related.error && <p>暂无相关事项。</p>}</section>
      <TaskActions task={task} csrf={csrf} employeeID={employeeID} refresh={refresh} navigate={navigate} />
      <section className="card" aria-label="任务信息"><h3>任务信息</h3><dl className="task-info">
        <dt>请求标识</dt><dd>{task.request_id}</dd><dt>Agent</dt><dd>{task.agent_type}</dd>
        <dt>工作目录</dt><dd>{task.working_directory ?? '节点默认目录'}</dd><dt>逻辑设备</dt><dd>{task.device_names?.join('、') || '无'}</dd>
        <dt>授权范围</dt><dd>{task.authorization_scope ?? '未提供'}</dd><dt>期望产物</dt><dd>{task.expected_outputs ?? '未提供'}</dd>
        <dt>接受时间</dt><dd>{timeLabel(task.accepted_at)}</dd><dt>排队到期</dt><dd>{timeLabel(task.queue_expires_at)}</dd>
        <dt>执行期限</dt><dd>{task.execution_timeout_seconds} 秒</dd><dt>执行到期</dt><dd>{timeLabel(task.execution_expires_at)}</dd>
      </dl></section>
      <section className="card" aria-label="操作记录"><h3>操作记录</h3>{events.map((event) => <article key={event.event_id}>
        <p>{timeLabel(event.created_at)} · 版本 {event.version} · {taskEventLabels[event.kind] ?? `其他变更（${event.kind}）`} · {taskStates[event.status] ?? event.status}</p>
        {event.resolution && <><p>核实人：{event.actor_employee_id} · 理由：{event.resolution.reason}</p><p>原结论：{taskStates[event.resolution.previous.status] ?? event.resolution.previous.status} · {event.resolution.previous.summary}</p><p>核实摘要：{event.resolution.summary}</p><p>核实证据：{event.resolution.evidence?.map((ref) => `${ref.resource_id} ${ref.note ?? ''}`).join('；') || event.resolution.evidence_empty_reason}</p></>}
        {event.rerun && <p>发起人：{event.actor_employee_id} · 理由：{event.rerun.reason}</p>}
      </article>)}</section>
    </>}
  </section>
}
