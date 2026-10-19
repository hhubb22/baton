import { useEffect, useRef, useState } from 'react'
import { ApiError, messageOf, request } from '../api.ts'
import { clearPendingTask, listTasks, readPendingTask, savePendingTask, type PendingTask, type TaskInput, type TaskRecord } from '../tasks.ts'
import type { NodeList } from '../types.ts'

type SessionOption = { session_id: string; node_id: string; agent_type: string; status: string; busy: boolean }
export function TaskComposer({ csrf, employeeID, nodes, sessions = [], projectID, onAccepted }: {
  csrf: string; employeeID: string; nodes: NodeList | null; sessions?: SessionOption[]; projectID?: string; onAccepted: (task: TaskRecord) => void
}) {
  const [pending, setPending] = useState<PendingTask | null>(() => readPendingTask(employeeID))
  const [reconstruct, setReconstruct] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [nodeID, setNodeID] = useState('')
  const [original, setOriginal] = useState<TaskInput | null>(null)
  const inFlight = useRef(false)
  const alive = useRef(true)
  useEffect(() => { alive.current = true; return () => { alive.current = false } }, [])
  function complete(requestID: string) {
    if (!alive.current || !clearPendingTask(employeeID, requestID)) return false
    setPending(null)
    return true
  }
  function remember(value: PendingTask | null) { savePendingTask(employeeID, value); setPending(value) }
  async function submit(form?: HTMLFormElement) {
    if (!csrf || inFlight.current || (pending && !original && !reconstruct)) return
    let input = original
    if (!input && form) {
      const data = new FormData(form)
      const optional = (key: string) => String(data.get(key) ?? '').trim() || undefined
      input = {
        project_id: pending ? pending.projectID : projectID,
        request_id: pending?.requestID ?? crypto.randomUUID(), description: String(data.get('description')),
        target_node_id: optional('node'), agent_type: optional('agent'), target_session_id: optional('session'),
        working_directory: optional('directory'), authorization_scope: optional('scope'), expected_outputs: optional('outputs'),
        device_names: String(data.get('devices') ?? '').split('\n').map((s) => s.trim()).filter(Boolean),
        queue_timeout_seconds: Number(data.get('queue')), execution_timeout_seconds: Number(data.get('execution')),
      }
    }
    if (!input) return
    inFlight.current = true; setBusy(true); setError('')
    try {
      remember({ requestID: input.request_id, projectID: input.project_id }); setOriginal(input); setReconstruct(false)
      const task = await request<TaskRecord>('/api/v1/tasks', { method: 'POST', csrf, body: input })
      if (!complete(input.request_id)) return
      setOriginal(null); form?.reset(); onAccepted(task)
    } catch (e) {
      if (!alive.current) return
      if (e instanceof ApiError && !pending && [400, 401, 403, 404, 409, 422].includes(e.status)) { complete(input.request_id); setOriginal(null) }
      setError(`${messageOf(e)}。${readPendingTask(employeeID) ? '接受结果待确认，可查询原请求。' : ''}`)
    } finally { inFlight.current = false; setBusy(false) }
  }
  async function query() {
    if (!pending || inFlight.current) return
    inFlight.current = true; setBusy(true); setError('')
    try {
      const page = await listTasks({ request_id: pending.requestID })
      const task = page.tasks[0]
      if (!alive.current) return
      if (!task) { setError('中心暂未查到原请求。请保留请求标识并稍后查询；原请求可能仍在处理中。'); return }
      if (!complete(pending.requestID)) return
      setOriginal(null); setReconstruct(false); onAccepted(task)
    } catch (e) { if (alive.current) setError(messageOf(e)) }
    finally { inFlight.current = false; setBusy(false) }
  }
  const resolvedNode = nodeID || nodes?.default_device.node_id
  return <section aria-label="发起任务">
    {error && <p role="alert" className="error">{error}</p>}
    {pending ? <div className="notice"><p>接受结果待确认。原请求标识：{pending.requestID}</p>
      {pending.originalTaskID && <p>关联原任务：{pending.originalTaskID}</p>}
      <div className="actions"><button type="button" disabled={busy} onClick={() => void query()}>查询原请求</button>
        {original && <button type="button" disabled={busy || !csrf} onClick={() => void submit()}>重发同一请求</button>}
        {!pending.originalTaskID && <button type="button" disabled={busy} onClick={() => { setOriginal(null); setReconstruct(true) }}>补全原请求后重发</button>}
        {pending.originalTaskID && <a href={`/tasks/${encodeURIComponent(pending.originalTaskID)}`}>返回原任务恢复新执行请求</a>}
      </div>{reconstruct && <p>请填写原请求内容。重发使用同一个请求标识；如果中心已经接受过不同内容，会返回冲突供你查询。</p>}</div> : null}
    <form onSubmit={(e) => { e.preventDefault(); void submit(e.currentTarget) }}>
      <fieldset disabled={busy || (!!pending && !reconstruct) || !csrf}>
        <label>节点<select name="node" value={nodeID} onChange={(e) => setNodeID(e.target.value)}><option value="">使用默认设备</option>{nodes?.nodes.filter((n) => n.revocation_status === 'none').map((n) => <option value={n.id} key={n.id}>{n.display_name} · {n.online ? '在线' : '离线'}</option>)}</select></label>
        <label>Agent<select name="agent" defaultValue={projectID ? '' : 'pi'}><option value="">使用节点或 Session 的 Agent</option><option value="pi">Pi</option><option value="codex">Codex</option></select></label>
        <label>已有 Session<select name="session"><option value="">新建 Session</option>{sessions.filter((s) => s.node_id === resolvedNode && s.status === 'idle' && !s.busy).map((s) => <option key={s.session_id} value={s.session_id}>{s.agent_type} · {s.session_id}</option>)}</select></label>
        <label>工作目录<input name="directory" maxLength={1024} /></label>
        <label>任务说明<textarea name="description" required maxLength={16000} /></label>
        <label>授权范围<textarea name="scope" maxLength={16000} placeholder="允许的操作与限制；涉及设备时必填" /></label>
        <label>逻辑设备名<textarea name="devices" placeholder="每行一个；无设备时留空" /></label>
        <label>期望产物与验证方式<textarea name="outputs" maxLength={16000} /></label>
        <div className="task-columns"><label>排队等待期限（秒）<input name="queue" type="number" min={1} max={2147483647} defaultValue={600} required /></label>
          <label>执行期限（秒）<input name="execution" type="number" min={1} max={2147483647} defaultValue={7200} required /></label></div>
        <p className="hint">离线节点上的任务会等待连接与同步。中心接受后显示任务 ID，节点确认启动后才显示执行中。</p>
        <button disabled={busy || !csrf || (!!pending && !reconstruct)}>{reconstruct ? '提交原请求' : '提交任务'}</button>
      </fieldset>
    </form>
  </section>
}
