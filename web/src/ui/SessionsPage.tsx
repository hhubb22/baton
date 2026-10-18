import { readPendingInput, savePendingInput, type PendingInput } from '../pending-input.ts'
import { appendOutput, orderedSessions, sessionDepth } from '../sessions-model.ts'
import { useEffect, useRef, useState } from 'react'
import { ApiError, messageOf, request } from '../api.ts'
import type { NodeList } from '../types.ts'

export type WorkSession = {
  session_id: string; node_id: string; agent_type: string; status: string; busy: boolean
  parent_session_id?: string; task_ids: string[]; updated_at: string
}
type Task = { task_id: string; source_session_id?: string; target_session_id?: string; target_node_id: string; status: string }
type Result = { session_id: string; ok: boolean; code?: string; state: string; input_supported: boolean; text: string; cursor: string; gap: boolean }
const states: Record<string, string> = { running: '执行中', waiting_input: '等待输入', idle: '空闲', stopped: '已停止', unknown: '状态未知' }

export function SessionsPage({ csrf, nodes, employeeID }: { csrf: string; nodes: NodeList | null; employeeID: string }) {
  const [sessions, setSessions] = useState<WorkSession[]>([])
  const [tasks, setTasks] = useState<Task[]>([])
  const [selected, setSelected] = useState('')
  const [output, setOutput] = useState('')
  const [gap, setGap] = useState('')
  const [connected, setConnected] = useState(false)
  const [status, setStatus] = useState<Result | null>(null)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [busy, setBusy] = useState(false)
  const [text, setText] = useState('')
  const [pendingTask, setPendingTask] = useState<Record<string, unknown> | null>(null)
  const [pending, updatePending] = useState<PendingInput | null>(() => readPendingInput(employeeID))
  function setPending(value: PendingInput | null) {
    savePendingInput(employeeID, value)
    updatePending(value)
  }
  const socket = useRef<WebSocket | null>(null)
  const selection = useRef('')
  const cursor = useRef('')

  useEffect(() => {
    let stopped = false
    let reconnect: number | undefined
    let timer: number | undefined
    let attempt = 0
    let loading = false
    const refresh = async () => {
      if (loading) return
      loading = true
      try {
        const [s, t] = await Promise.all([
          request<{ sessions: WorkSession[] }>('/api/v1/sessions'), request<{ tasks: Task[] }>('/api/v1/tasks'),
        ])
        if (!stopped) { setSessions(s.sessions); setTasks(t.tasks) }
      } catch (e) { if (!stopped) setError(messageOf(e)) }
      finally { loading = false }
    }
    const connect = () => {
      const url = new URL('/api/v1/events', window.location.origin)
      url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:'
      const ws = new WebSocket(url)
      socket.current = ws
      ws.onopen = () => {
        attempt = 0; setConnected(true); void refresh()
        ws.send(JSON.stringify({ session_id: selection.current, cursor: cursor.current }))
      }
      ws.onmessage = (message) => {
        let event: Result & { type: string }
        try { event = JSON.parse(String(message.data)) as Result & { type: string } } catch { return }
        if (event.type === 'session.changed' || event.type === 'task.changed') void refresh()
        if (event.type !== 'session.output' || event.session_id !== selection.current) return
        setStatus(event)
        if (!event.ok) { setGap(`输出暂不可用：${event.code ?? 'unavailable'}`); return }
        if (event.gap) setGap('输出存在缺口。完整历史保存在执行节点。')
        cursor.current = event.cursor
        setOutput((current) => appendOutput(current, event.text ?? ''))
      }
      ws.onclose = () => {
        if (stopped) return
        setConnected(false); setStatus(null); setGap('实时连接已断开，重连后继续读取；断开期间可能缺少输出。')
        reconnect = window.setTimeout(connect, Math.min(30_000, 1000 * 2 ** attempt++) * (0.8 + Math.random() * 0.4))
      }
    }
    void refresh(); connect()
    timer = window.setInterval(() => { if (document.visibilityState === 'visible') void refresh() }, 5000)
    window.addEventListener('focus', refresh)
    return () => { stopped = true; window.clearTimeout(reconnect); window.clearInterval(timer); window.removeEventListener('focus', refresh); socket.current?.close() }
  }, [])

  function select(id: string) {
    selection.current = id; cursor.current = ''; setSelected(id); setOutput(''); setGap(''); setStatus(null); setNotice('')
    if (socket.current?.readyState === WebSocket.OPEN) socket.current.send(JSON.stringify({ session_id: id }))
  }
  async function input() {
    if (!csrf || !selected || pending) return
    const operation = { id: crypto.randomUUID(), session: selected, text }
    setPending(operation); setBusy(true); setError(''); setNotice('')
    try {
      const result = await request<Result>(`/api/v1/sessions/${selected}/input`, { method: 'POST', csrf, body: { operation_id: operation.id, text } })
      if (result.ok) { setPending(null); setText(''); setNotice('节点已确认接收输入。') }
      else if (result.code !== 'uncertain' && result.code !== 'node_unavailable') { setPending(null); setError(`输入未送达：${result.code}`) }
      else setError('输入结果待确认，请查询原操作。')
    } catch (e) { setError(`${messageOf(e)}。输入结果待确认，请查询原操作。`) }
    finally { setBusy(false) }
  }
  async function queryInput() {
    if (!pending) return
    setBusy(true)
    try {
      const result = await request<Result>(`/api/v1/sessions/${pending.session}/input?operation_id=${pending.id}`)
      if (result.ok) { setPending(null); setText(''); setError(''); setNotice('节点已确认接收输入。') }
      else if (result.code === 'not_received') { setError('节点尚未记录该操作，请保留操作标识并稍后查询。') }
      else setError(`原操作状态：${result.code}。请在节点核实后再输入。`)
    } catch (e) { setError(messageOf(e)) }
    finally { setBusy(false) }
  }
  async function resume() {
    setBusy(true); setError('')
    try {
      const result = await request<Result>(`/api/v1/sessions/${selected}/resume`, { method: 'POST', csrf, body: { operation_id: crypto.randomUUID() } })
      setNotice(result.ok ? '节点已连接原 Session，原任务输入保持原样。' : `无法恢复：${result.code}`)
    } catch (e) { setError(messageOf(e)) }
    finally { setBusy(false) }
  }
  async function start(form: HTMLFormElement) {
    const data = new FormData(form)
    const input = pendingTask ?? {
      request_id: crypto.randomUUID(), target_node_id: data.get('node'), agent_type: data.get('agent'),
      working_directory: data.get('directory') || null, description: data.get('description'),
      target_session_id: data.get('session') || null,
    }
    setPendingTask(input); setBusy(true); setError('')
    try {
      const task = await request<{ task_id: string }>('/api/v1/tasks', { method: 'POST', csrf, body: input })
      setPendingTask(null)
      setNotice(`任务已接受：${task.task_id}。节点建立 Session 后显示。`)
    } catch (e) {
      if (e instanceof ApiError && e.status >= 400 && e.status < 500) setPendingTask(null)
      setError(`${messageOf(e)}。重试时继续查询同一个任务请求。`)
    }
    finally { setBusy(false) }
  }
  const item = sessions.find((s) => s.session_id === selected)
  const node = nodes?.nodes.find((n) => n.id === item?.node_id)
  return <section aria-label="Session" className="sessions">
    <h2>Session</h2>
    <p role="status">{connected ? '实时连接已建立' : '实时连接正在重连'}；最近 100 个 Session，输出保留最近 128 KiB。</p>
    {error && <p role="alert" className="error">{error}</p>}
    {notice && <p role="status">{notice}</p>}
    {pending && <><p>待确认操作：{pending.id} · Session {pending.session}</p><button type="button" disabled={busy} onClick={() => void queryInput()}>查询输入结果</button></>}
    <details><summary>启动任务</summary><form onSubmit={(e) => { e.preventDefault(); void start(e.currentTarget) }}>
      <label>节点<select name="node" required>{nodes?.nodes.filter((n) => n.executable).map((n) => <option value={n.id} key={n.id}>{n.display_name}</option>)}</select></label>
      <label>Agent<select name="agent"><option value="pi">Pi</option><option value="codex">Codex</option></select></label>
      <label>已有 Session<select name="session"><option value="">新建 Session</option>{sessions.filter((s) => s.status === 'idle' && !s.busy).map((s) => <option key={s.session_id} value={s.session_id}>{s.session_id}</option>)}</select></label>
      <label>工作目录<input name="directory" /></label><label>任务说明<textarea name="description" required maxLength={16000} /></label>
      <button disabled={busy || !csrf}>{pendingTask ? '重试原任务请求' : '提交任务'}</button>
    </form></details>
    <div className="session-layout"><div aria-label="Session 树">
      {nodes?.nodes.map((n) => <section key={n.id}><h3>{n.display_name} · {n.online ? '在线' : '离线'}</h3>
        {orderedSessions(sessions, n.id).map((s) => <div key={s.session_id} style={{ paddingLeft: `${sessionDepth(s, sessions) * 16}px` }}>
          <button type="button" aria-pressed={selected === s.session_id} onClick={() => select(s.session_id)}>{s.agent_type} · {s.session_id}</button>
          <span> {n.online ? states[s.status] ?? '状态未知' : '状态未知'}{s.busy ? ' · 已绑定任务' : ''}</span>
          {s.parent_session_id && <p>{sessions.some((p) => p.session_id === s.parent_session_id && p.node_id === s.node_id) ? '本机父 Session' : '未加载的父 Session'}：{s.parent_session_id}</p>}
          <small>最后报告于 {new Date(s.updated_at).toLocaleString()}</small>
        </div>)}
      </section>)}
      {!sessions.length && <p>尚无 Session。</p>}
    </div><div>
      {item && <><h3>{item.session_id}</h3><p>{node?.online ? states[status?.state ?? item.status] ?? '状态未知' : '状态未知'} · 节点{node?.online ? '在线' : '离线'}</p>
        {gap && <p role="status">{gap}</p>}<pre aria-label="实时输出" className="session-output">{output || '等待输出。'}</pre>
        <form onSubmit={(e) => { e.preventDefault(); void input() }}><label>补充当前任务<textarea value={text} onChange={(e) => setText(e.target.value)} maxLength={4000} /></label>
          <button disabled={busy || !csrf || !status?.input_supported || !status.ok || !text || !!pending || !['running', 'waiting_input'].includes(status.state)}>发送输入</button>
        </form>
        <button type="button" disabled={busy || !csrf || !node?.online} onClick={() => void resume()}>继续原 Session</button>
        <p>空闲 Session 的新执行目标通过任务接口提交；补充输入只用于当前任务。</p>
      </>}
    </div></div>
    <h3>任务委托</h3>
    {tasks.filter((t) => t.source_session_id).map((t) => <p key={t.task_id}>{sessions.find((s) => s.session_id === t.source_session_id)?.node_id === t.target_node_id ? '同一节点委托' : '跨节点委托'}：{t.source_session_id} → {t.target_session_id ?? '等待目标 Session'} · 任务 {t.task_id} · {t.status}</p>)}
  </section>
}
