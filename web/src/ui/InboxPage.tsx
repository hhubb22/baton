import { useEffect, useState } from 'react'
import { messageOf } from '../api.ts'
import { getAttention, useAttentionList, type AskProject, type AttentionRequest } from '../inbox.ts'
import { AttentionCard } from './AttentionCard.tsx'

type Props = { id: string; csrf: string; askProject: AskProject }
export function InboxPage(props: Props) {
  return props.id ? <AttentionDetail key={props.id} {...props} /> : <InboxList {...props} />
}
function InboxList(props: Props) {
  const [openPages, setOpenPages] = useState(1)
  const [donePages, setDonePages] = useState(1)
  const open = useAttentionList('open', {}, openPages)
  const done = useAttentionList('done', {}, donePages)
  // 两栏可能先后读到处理前后的版本；同一 ID 只显示较新的记录。
  const records = new Map<string, AttentionRequest>()
  for (const item of [...open.requests, ...done.requests]) {
    const previous = records.get(item.id)
    if (!previous || item.version >= previous.version) records.set(item.id, item)
  }
  const items = [...records.values()].sort((a, b) => b.created_at.localeCompare(a.created_at) || b.id.localeCompare(a.id))
  return <section className="inbox" aria-label="Inbox"><h1>Inbox</h1><div className="inbox-columns">
    <InboxColumn title="待处理" items={items.filter((item) => item.state === 'open')} error={open.error} more={!!open.next_cursor} loadMore={() => setOpenPages((v) => v + 1)} {...props} />
    <InboxColumn title="已处理" items={items.filter((item) => item.state !== 'open')} error={done.error} more={!!done.next_cursor} loadMore={() => setDonePages((v) => v + 1)} {...props} />
  </div></section>
}
function InboxColumn({ title, items, error, more, loadMore, csrf, askProject }: Props & { title: string; items: AttentionRequest[]; error: string; more: boolean; loadMore: () => void }) {
  return <section aria-label={title}><h2>{title}</h2>{error && <p role="alert">{error}</p>}
    {items.map((item) => <AttentionCard key={item.id} item={item} csrf={csrf} compact askProject={askProject} />)}
    {!items.length && <p>暂无{title}事项。</p>}
    {more && <button onClick={loadMore}>更多{title}事项</button>}
  </section>
}
function AttentionDetail({ id, csrf, askProject }: Props) {
  const [item, setItem] = useState<AttentionRequest | null>(null)
  const [error, setError] = useState('')
  useEffect(() => {
    let stopped = false, loading = false
    const refresh = async () => {
      if (loading) return
      loading = true
      try { const value = await getAttention(id); if (!stopped) { setItem(value); setError('') } }
      catch (err) { if (!stopped) setError(messageOf(err)) }
      finally { loading = false }
    }
    void refresh()
    const timer = window.setInterval(() => void refresh(), 5000)
    window.addEventListener('baton-attention-changed', refresh)
    return () => { stopped = true; window.clearInterval(timer); window.removeEventListener('baton-attention-changed', refresh) }
  }, [id])
  return <section className="inbox" aria-label="事项详情"><a href="/inbox">所有事项</a><h1>事项详情</h1>
    {error && <p role="alert">{error}</p>}{item ? <AttentionCard item={item} csrf={csrf} askProject={askProject} /> : !error && <p>正在读取事项。</p>}
  </section>
}
