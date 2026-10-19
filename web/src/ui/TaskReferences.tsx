import { useContext, useState } from 'react'
import { ApiError, getNodeFiles, messageOf } from '../api.ts'
import { previewQuery, type ResultRef } from '../tasks.ts'
import type { AskProject } from '../inbox.ts'
import { ProjectQuote } from './ProjectQuote.tsx'
import type { FileView } from '../types.ts'

import { NodeAvailability } from '../node-availability.ts'
type Props = { title: string; refs?: ResultRef[]; empty?: string; projectID?: string; taskID?: string; attentionID?: string; askProject?: AskProject }

export function TaskReferences(props: Props) {
  const nodes = useContext(NodeAvailability)
  const identity = JSON.stringify(props.refs?.map((ref) => [ref.node_id, ref.storage_ref, ref.resource_id, ref.access_status, ref.note, nodes?.nodes.find((n) => n.id === ref.node_id)?.online]) ?? [])
  // 引用内容变化时重建预览状态，旧请求只能更新已卸载的组件；相同内容的轮询保留预览。
  return <ReferencePreview key={identity} {...props} />
}

function ReferencePreview({ title, refs, empty, projectID, taskID, attentionID, askProject }: Props) {
  const nodes = useContext(NodeAvailability)
  const [preview, setPreview] = useState<FileView | null>(null)
  const [selectedRef, setSelectedRef] = useState<ResultRef | null>(null)
  const [copied, setCopied] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  async function show(ref: ResultRef) {
    const query = previewQuery(ref)
    if (!query || !ref.node_id) return
    if (nodes?.nodes.some((n) => n.id === ref.node_id && !n.online)) { setPreview(null); setError('节点离线，暂不可查看。'); return }
    setBusy(true); setError(''); setPreview(null); setSelectedRef(ref)
    try { setPreview(await getNodeFiles(ref.node_id, query)) }
    catch (e) { setError(e instanceof ApiError && ['node_offline', 'node_unavailable'].includes(e.code) ? '节点离线，暂不可查看。' : messageOf(e)) }
    finally { setBusy(false) }
  }
  async function copySHA(sha: string) {
    try { await navigator.clipboard.writeText(sha); setCopied(sha) }
    catch { setError('复制失败，请选中完整 SHA 复制。') }
  }
  return <section className="card" aria-label={title}><h3>{title}</h3>
    {!refs?.length && <p>{empty || '尚未记录。'}</p>}
    {refs?.map((ref, index) => <div className="task-reference" key={index}>
      <ProjectQuote projectID={projectID} source={{ taskID, attentionID, field: `${title === '产物' ? 'artifacts' : 'evidence'}[${index}]` }} askProject={askProject}><p>{ref.resource_id}</p><p className="meta">{ref.node_id && `节点 ${ref.node_id} · `}{ref.storage_ref} · {{ available: '可用', unavailable: '不可用', unknown: '可用性未知' }[ref.access_status] ?? ref.access_status}</p>
      {ref.note && <p>{ref.note}</p>}</ProjectQuote>
      {/^[a-f0-9]{40}(?:[a-f0-9]{24})?$/i.test(ref.resource_id) && <><p>仓库：{ref.storage_ref ?? ref.node_id}</p><p>Commit SHA：<code>{ref.resource_id}</code></p><button onClick={() => void copySHA(ref.resource_id)}>复制 SHA</button>{copied === ref.resource_id && <span role="status">已复制 SHA</span>}</>}
      {previewQuery(ref) && <button disabled={busy} onClick={() => void show(ref)}>预览</button>}
    </div>)}
    {error && <p role="alert" className="error">{error}</p>}
    {preview && <div><h4>预览内容</h4><ProjectQuote projectID={projectID} source={{ taskID, attentionID, field: title === '产物' ? 'artifacts' : 'evidence', nodeID: selectedRef?.node_id, path: selectedRef ? `${selectedRef.storage_ref}/${selectedRef.resource_id}` : undefined }} askProject={askProject}><pre className="task-preview">{preview.content ?? preview.entries?.map((e) => `${e.kind} · ${e.name}`).join('\n') ?? '此引用没有文本内容。'}</pre></ProjectQuote>{preview.truncated && <p>内容已截短。</p>}<button className="secondary" onClick={() => setPreview(null)}>关闭预览</button></div>}
  </section>
}
