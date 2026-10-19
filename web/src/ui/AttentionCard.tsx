import { useEffect, useRef, useState } from 'react'
import { ApiError, messageOf, request } from '../api.ts'
import { attentionAPI, attentionChanged, attentionStates, attentionURL, getAttention, type AskProject, type AttentionRequest, type TaskResult } from '../inbox.ts'
import { byteLength } from '../project-quote.ts'
import { projectURL } from '../projects.ts'
import { getTask, taskStates, taskURL, timeLabel } from '../tasks.ts'
import { Markdown } from './Markdown.tsx'
import { ProjectQuote } from './ProjectQuote.tsx'
import { TaskReferences } from './TaskReferences.tsx'

type Props = { item: AttentionRequest; csrf: string; compact?: boolean; askProject?: AskProject }

export function AttentionCard({ item, csrf, compact, askProject }: Props) {
  const [current, setCurrent] = useState(item)
  const [option, setOption] = useState('')
  const [text, setText] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [uncertain, setUncertain] = useState(false)
  const pending = useRef(false)
  const alive = useRef(true)
  useEffect(() => { alive.current = true; return () => { alive.current = false } }, [])
  const record = item.version >= current.version ? item : current
  async function query() {
    try {
      const fresh = await getAttention(item.id)
      if (!alive.current) return
      setCurrent(fresh); setUncertain(false); setError(''); attentionChanged()
    } catch (err) { if (alive.current) setError(messageOf(err)) }
  }
  async function handle(close: boolean) {
    if (pending.current || !csrf || uncertain) return
    pending.current = true; setBusy(true); setError('')
    try {
      const value = await request<AttentionRequest>(`${attentionAPI(record.id)}/${close ? 'close' : 'answer'}`, { method: 'POST', csrf, body: {
        expected_version: record.version, client_request_id: crypto.randomUUID(), ...(!close ? { option_id: option, text } : {}),
      } })
      if (!alive.current) return
      setCurrent(value); attentionChanged()
    } catch (err) {
      if (!alive.current) return
      if (err instanceof ApiError && err.status === 409) {
        setError('事项已由其他操作处理或更新，请查看当前结果。')
        try { const fresh = await getAttention(record.id); if (alive.current) { setCurrent(fresh); attentionChanged() } }
        catch { if (alive.current) { setUncertain(true); setError('事项已变化，当前结果暂时无法读取。请查询处理结果。') } }
      } else {
        setError(messageOf(err))
        if (!(err instanceof ApiError) || err.status === 0 || err.status >= 500) setUncertain(true)
      }
    } finally { pending.current = false; if (alive.current) setBusy(false) }
  }
  const body = <>
    <ProjectQuote projectID={record.project_id} source={{ taskID: record.task_id, attentionID: record.id, field: 'content' }} askProject={askProject}><Markdown content={record.content} /></ProjectQuote>
    {record.task_result && <AttentionResult key={`${record.id}:${record.task_result_version}`} item={record} askProject={askProject} />}
  </>
  return <article className="card attention-card" aria-label={`事项：${record.title}`} data-attention-id={record.id}>
    <p className="meta"><a href={projectURL(record.project_id)}>{record.project_title}</a> · {record.source === 'system' ? '由 Baton 创建' : 'Project Agent'} · <span className="badge">{attentionStates[record.state] ?? record.state}</span></p>
    <h3><a href={attentionURL(record.id)}>{record.title}</a></h3>
    <p>{record.summary}</p><small>创建于 {timeLabel(record.created_at)}</small>
    {record.task_id && <p>关联任务：<a href={taskURL(record.task_id)}>{record.task_id}</a></p>}
    {record.source === 'system' ? <>
      {record.content !== record.summary && <p className="task-text">{record.content}</p>}
      {record.action_url && /^\/(projects|tasks)\/[^/]+$/.test(record.action_url) && <p><a href={record.action_url}>打开处理位置</a></p>}
    </> : compact ? <details><summary>展示内容和任务结果</summary>{body}</details> : body}
    {record.resolution && <div className="notice"><p>{attentionStates[record.state]}{record.resolution.option_label ? `：${record.resolution.option_label}` : ''}</p>
      {record.resolution.text && <p className="task-text">{record.resolution.text}</p>}<small>处理人：{record.resolution.employee_id} · {timeLabel(record.resolved_at)}</small></div>}
    {record.state === 'withdrawn' && <p>撤回原因：{record.withdraw_reason}</p>}
    {record.state === 'resolved' && <p>已解决 · {timeLabel(record.resolved_at)}</p>}
    {error && <p role="alert" className="error">{error}</p>}
    {uncertain && <><p>操作结果待确认，请查询后再操作。</p><button disabled={busy} onClick={() => void query()}>查询处理结果</button></>}
    {record.state === 'open' && <form onSubmit={(e) => { e.preventDefault(); void handle(false) }}><fieldset disabled={busy || uncertain || !csrf}>
      {record.source === 'agent' && <>
        {!!record.options.length && <><legend>选择一个选项</legend>{record.options.map((o) => <label className="check" key={o.id}><input type="radio" name={`option-${record.id}`} value={o.id} checked={option === o.id} onChange={() => setOption(o.id)} /><span>{o.label}{o.recommended && '（建议）'}{o.description && <small>{o.description}</small>}</span></label>)}
          <p className="hint">Project Agent 会按你的选择继续。</p>{option && record.allow_text && <button className="secondary" type="button" onClick={() => setOption('')}>只回复文字</button>}</>}
        {(record.allow_text || !!record.options.length) && <label>补充说明<textarea value={text} onChange={(e) => setText(e.target.value)} /></label>}
        <p className="hint">文字最多 4 KiB{!record.allow_text && '，需先选择选项'}。</p>
        {byteLength(text) > 4096 && <p role="alert">文字超过 4 KiB。</p>}
        <button disabled={byteLength(text) > 4096 || (!option && (!record.allow_text || !text.trim()))}>提交回答</button>
      </>}
      <button className="secondary" type="button" onClick={() => void handle(true)}>关闭事项</button>
    </fieldset></form>}
  </article>
}

function AttentionResult({ item, askProject }: { item: AttentionRequest; askProject?: AskProject }) {
  const [latest, setLatest] = useState<TaskResult | null>(null)
  const [showLatest, setShowLatest] = useState(false)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const newer = (item.latest_task_result_version ?? 0) > (item.task_result_version ?? 0)
  // 轮询带来新的任务版本时，已打开的最新结果也重新读取。
  useEffect(() => {
    if (!showLatest || !item.task_id) return
    let stopped = false
    void getTask(item.task_id).then((value) => { if (!stopped) { setLatest(value); setError(''); setBusy(false) } }).catch((err: unknown) => { if (!stopped) { setLatest(null); setError(messageOf(err)); setBusy(false) } })
    return () => { stopped = true }
  }, [showLatest, item.task_id, item.latest_task_result_version])
  const value = showLatest ? latest : item.task_result
  return <section aria-label="事项引用的任务结果"><h4>任务结果 · {showLatest ? '最新版本' : `事项保存的版本 ${item.task_result_version}`}</h4>
    {newer && <p className="notice">有新的任务结果版本 {item.latest_task_result_version}，修正时间：{timeLabel(item.latest_task_result_updated_at)}。事项和回答仍对应原版本。</p>}
    {newer && <button className="secondary" onClick={() => { setShowLatest(!showLatest); setBusy(!showLatest); setLatest(null) }}>{showLatest ? '查看原版本' : '查看最新版本'}</button>}
    {busy && showLatest && <p>正在读取最新结果。</p>}{error && showLatest && <p role="alert">{error}</p>}
    {value && <TaskResultView key={`${showLatest}:${value.version}`} result={value} projectID={item.project_id} attentionID={item.id} askProject={askProject} />}
  </section>
}

export function TaskResultView({ result, projectID, attentionID, askProject }: { result: TaskResult; projectID?: string; attentionID?: string; askProject?: AskProject }) {
  const source = { taskID: result.task_id, attentionID }
  return <>
    <p>{taskStates[result.status] ?? result.status} · 版本 {result.version}</p>
    <ProjectQuote projectID={projectID} source={{ ...source, field: 'summary' }} askProject={askProject}><p className="task-text">{result.summary ?? '尚无结果摘要。'}</p></ProjectQuote>
    {result.error_message && <ProjectQuote projectID={projectID} source={{ ...source, field: 'error' }} askProject={askProject}><p className="error">{result.error_message}{result.error_code && `（${result.error_code}）`}</p></ProjectQuote>}
    <TaskReferences title="证据" refs={result.evidence} empty={result.evidence_empty_reason} projectID={projectID} taskID={result.task_id} attentionID={attentionID} askProject={askProject} />
    <TaskReferences title="产物" refs={result.artifacts} empty={result.artifacts_empty_reason} projectID={projectID} taskID={result.task_id} attentionID={attentionID} askProject={askProject} />
  </>
}
