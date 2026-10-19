import { useEffect, useRef, useState } from 'react'
import { ApiError, messageOf, request } from '../api.ts'
import { clearPendingTask, listTasks, manualAllowed, readPendingTask, savePendingTask, taskAPI, taskStates, type PendingTask, type RerunInput, type ResolveInput, type TaskRecord } from '../tasks.ts'

type Draft = { kind: 'resolve' | 'rerun'; version: number; status: string }
export function TaskActions({ task, csrf, employeeID, refresh, navigate }: {
  task: TaskRecord; csrf: string; employeeID: string; refresh: () => Promise<void>; navigate: (id: string) => void
}) {
  const [evidenceResource, setEvidenceResource] = useState('')
  const [draft, setDraft] = useState<Draft | null>(null)
  const [pending, setPending] = useState<PendingTask | null>(() => readPendingTask(employeeID))
  const [uncertain, setUncertain] = useState(false)
  const [busy, setBusy] = useState(false)
  const [notice, setNotice] = useState('')
  const [error, setError] = useState('')
  const [rerun, setRerun] = useState<RerunInput | null>(null)
  const inFlight = useRef(false)
  const alive = useRef(true)
  useEffect(() => { alive.current = true; return () => { alive.current = false } }, [])
  function complete(requestID: string) {
    if (!alive.current || !clearPendingTask(employeeID, requestID)) return false
    setPending(null)
    return true
  }
  function remember(value: PendingTask | null) { savePendingTask(employeeID, value); setPending(value) }
  async function act(action: 'cancel' | 'resolve' | 'rerun', body: object) {
    if (!csrf || inFlight.current) return
    inFlight.current = true; setBusy(true); setError(''); setNotice('')
    try {
      if (action === 'rerun') {
        const input = body as RerunInput
        setRerun(input)
        remember({ requestID: input.request_id, originalTaskID: task.task_id })
      }
      const result = await request<TaskRecord>(`${taskAPI(task.task_id)}/${action}`, { method: 'POST', csrf, body })
      if (!alive.current) return
      setDraft(null)
      if (action === 'rerun') { if (!complete((body as RerunInput).request_id)) return; setRerun(null); navigate(result.task_id); return }
      setNotice(action === 'cancel' ? '中心已记录取消请求。停止情况以任务记录中的节点确认为准。' : '核实结论已保存。')
      await refresh()
    } catch (e) {
      if (!alive.current) return
      if (action === 'rerun' && pending) {
        setError(`${messageOf(e)}。原请求标识已保留，可查询或补全同一请求。`)
        if (e instanceof ApiError && [400, 409, 422].includes(e.status)) { setRerun(null); setDraft(null) }
        if (e instanceof ApiError && e.status === 409) {
          setUncertain(true)
          try { await refresh(); if (alive.current) setUncertain(false) } catch { setError('任务版本冲突，最新记录暂时读取失败。请先查询最新记录。') }
        }
      } else if (e instanceof ApiError && [400, 401, 403, 404, 409, 422].includes(e.status)) {
        if (action === 'rerun') { complete((body as RerunInput).request_id); setRerun(null) }
        if (e.status === 409) {
          setDraft(null); setUncertain(true)
          setError(`${messageOf(e)}。请查看最新记录后重新选择操作。`)
          try { await refresh(); setUncertain(false) } catch { setError('任务版本冲突，最新记录暂时读取失败。请先查询最新记录。') }
        } else setError(messageOf(e))
      } else {
        setUncertain(action !== 'rerun'); setDraft(null)
        setError(`${messageOf(e)}。操作结果待确认，请查询记录。`)
      }
    } finally { inFlight.current = false; setBusy(false) }
  }
  async function query() {
    if (inFlight.current) return
    inFlight.current = true; setBusy(true); setError('')
    try {
      if (uncertain) { await refresh(); setUncertain(false); setNotice('已读取中心最新记录。请根据记录判断操作结果。') }
      else if (pending) {
        const result = await listTasks({ request_id: pending.requestID })
        if (!alive.current) return
        if (!result.tasks[0]) { setError('中心暂未查到原请求，请保留标识并稍后查询。'); return }
        if (!complete(pending.requestID)) return
        setRerun(null); navigate(result.tasks[0].task_id)
      } else { await refresh(); setUncertain(false); setNotice('已读取中心最新记录。请根据记录判断操作结果。') }
    } catch (e) { setError(messageOf(e)) }
    finally { inFlight.current = false; setBusy(false) }
  }
  function submit(form: HTMLFormElement) {
    if (!draft) return
    const data = new FormData(form)
    const reason = String(data.get('reason')).trim()
    if (draft.kind === 'rerun') {
      void act('rerun', { request_id: pending?.originalTaskID === task.task_id ? pending.requestID : crypto.randomUUID(), expected_version: draft.version, reason, confirm_side_effects: data.get('confirm') === 'on' } satisfies RerunInput)
    } else {
      const resource = String(data.get('resource') ?? '').trim()
      void act('resolve', {
        expected_version: draft.version, status: String(data.get('status')), summary: String(data.get('summary')), reason,
        evidence: resource ? [{ resource_id: resource, access_status: 'unknown', node_id: String(data.get('evidenceNode') ?? '').trim() || undefined, storage_ref: String(data.get('storage') ?? '').trim(), note: String(data.get('note') ?? '') }] : [],
        evidence_empty_reason: resource ? undefined : String(data.get('empty') ?? ''),
      } satisfies ResolveInput)
    }
  }
  const disabled = busy || !csrf || uncertain
  return <section className="card" aria-label="任务操作">
    <h3>任务操作</h3>
    {!csrf && <p role="alert">这个标签页没有操作令牌，请重新登录后操作。</p>}
    {notice && <p role="status">{notice}</p>}{error && <p className="error" role="alert">{error}</p>}
    {(uncertain || pending) && <div className="notice"><p>{pending ? `待确认请求：${pending.requestID}` : '操作确认尚未取得。查询只读取记录。'}</p>
      <div className="actions"><button disabled={busy} onClick={() => void query()}>查询操作结果</button>
        {pending?.originalTaskID === task.task_id && rerun && <button disabled={busy || !csrf} onClick={() => void act('rerun', rerun!)}>重发同一新执行请求</button>}
        {pending?.originalTaskID === task.task_id && <button disabled={disabled} onClick={() => { setRerun(null); setDraft({ kind: 'rerun', version: task.version, status: task.status }) }}>补全原新执行请求</button>}
      </div></div>}
    <div className="actions">
      {['queued', 'running', 'needs_verification'].includes(task.status) && <button className="danger" disabled={disabled || !!task.cancel_requested_at} onClick={() => void act('cancel', {})}>请求取消</button>}
      {manualAllowed(task) && <><button disabled={disabled} onClick={() => { setDraft({ kind: 'resolve', version: task.version, status: task.status }); setError('') }}>人工核实</button>
        <button disabled={disabled || !!pending} onClick={() => { setDraft({ kind: 'rerun', version: task.version, status: task.status }); setError('') }}>发起新执行</button></>}
    </div>
    {task.cancel_requested_at && <p>已请求取消；{task.status === 'cancelled' && !task.stop_requested_at ? '取消结论已保存在中心' : task.stop_confirmed_at ? `节点已确认停止，操作结果${task.stop_outcome_known ? '已说明' : '仍待核实'}` : task.stop_acknowledged_at ? '节点已收到中止请求，尚未确认停止' : '尚未取得节点停止确认'}。{task.status === 'completed' ? '完成结果已保留，取消未改变完成结论。' : ''}</p>}
    {draft && <form className="confirm" onSubmit={(e) => { e.preventDefault(); submit(e.currentTarget) }}>
      <fieldset disabled={disabled}>
        <legend>{draft.kind === 'resolve' ? '提交核实结论' : '创建新的任务与执行'}</legend>
        <p>原记录：{taskStates[draft.status] ?? draft.status}，版本 {draft.version}。{draft.kind === 'resolve' ? '核实只修改中心结论，节点上的操作需要单独确认。' : '新执行沿用原任务说明、节点、授权与期限，使用新的任务和 Session 标识。'}</p>
        <label>理由<input name="reason" required maxLength={400} /></label>
        {draft.kind === 'resolve' ? <>
          <label>核实结论<select name="status"><option value="completed">完成</option><option value="failed">失败</option><option value="cancelled">取消</option></select></label>
          <label>结论摘要<textarea name="summary" required maxLength={4000} /></label>
          <label>证据引用<input name="resource" maxLength={200} value={evidenceResource} onChange={(e) => setEvidenceResource(e.target.value)} /></label>
          <label>证据位置（存储引用）<input name="storage" required={!!evidenceResource.trim()} maxLength={1024} placeholder="例如 inspection:记录编号" /></label>
          <label>证据所在节点<input name="evidenceNode" placeholder={task.target_node_id} /></label>
          <label>证据说明<input name="note" maxLength={400} /></label>
          <label>无证据原因<input name="empty" maxLength={400} /></label>
        </> : draft.status === 'needs_verification' ? <label className="check"><input type="checkbox" name="confirm" required />我已知原执行的副作用仍未核实，确认发起可能重复操作的新执行</label> : null}
        <div className="actions"><button disabled={disabled}>{draft.kind === 'resolve' ? '保存核实结论' : '确认发起新执行'}</button><button type="button" className="secondary" onClick={() => setDraft(null)}>收起</button></div>
      </fieldset>
    </form>}
  </section>
}
