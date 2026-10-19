import { useState } from 'react'
import { ApiError, getNodeFiles, messageOf } from '../api.ts'
import { previewQuery, type ResultRef } from '../tasks.ts'
import type { FileView } from '../types.ts'

type Props = { title: string; refs?: ResultRef[]; empty?: string }

export function TaskReferences(props: Props) {
  const identity = JSON.stringify(props.refs?.map((ref) => [ref.node_id, ref.storage_ref, ref.resource_id, ref.access_status, ref.note]) ?? [])
  // 引用内容变化时重建预览状态，旧请求只能更新已卸载的组件；相同内容的轮询保留预览。
  return <ReferencePreview key={identity} {...props} />
}

function ReferencePreview({ title, refs, empty }: Props) {
  const [preview, setPreview] = useState<FileView | null>(null)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  async function show(ref: ResultRef) {
    const query = previewQuery(ref)
    if (!query || !ref.node_id) return
    setBusy(true); setError(''); setPreview(null)
    try { setPreview(await getNodeFiles(ref.node_id, query)) }
    catch (e) { setError(e instanceof ApiError && ['node_offline', 'node_unavailable'].includes(e.code) ? '节点离线，暂不可查看。' : messageOf(e)) }
    finally { setBusy(false) }
  }
  return <section className="card" aria-label={title}><h3>{title}</h3>
    {!refs?.length && <p>{empty || '尚未记录。'}</p>}
    {refs?.map((ref, index) => <div className="task-reference" key={index}>
      <p>{ref.resource_id}</p><p className="meta">{ref.node_id && `节点 ${ref.node_id} · `}{ref.storage_ref} · {{ available: '可用', unavailable: '不可用', unknown: '可用性未知' }[ref.access_status] ?? ref.access_status}</p>
      {ref.note && <p>{ref.note}</p>}{previewQuery(ref) && <button disabled={busy} onClick={() => void show(ref)}>预览</button>}
    </div>)}
    {error && <p role="alert" className="error">{error}</p>}
    {preview && <div><h4>预览内容</h4><pre className="task-preview">{preview.content ?? preview.entries?.map((e) => `${e.kind} · ${e.name}`).join('\n') ?? '此引用没有文本内容。'}</pre>{preview.truncated && <p>内容已截短。</p>}<button className="secondary" onClick={() => setPreview(null)}>关闭预览</button></div>}
  </section>
}
