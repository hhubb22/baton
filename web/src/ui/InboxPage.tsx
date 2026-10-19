import { useEffect, useState } from 'react'
import { messageOf } from '../api.ts'
import { getAttention, useAttentionList, type AskProject, type AttentionRequest } from '../inbox.ts'
import { AttentionCard } from './AttentionCard.tsx'

type Props = { id: string; csrf: string; askProject: AskProject }
export function InboxPage(props: Props) {
  return props.id ? <AttentionDetail key={props.id} {...props} /> : <section className="inbox" aria-label="Inbox"><h1>Inbox</h1><div className="inbox-columns">
    <InboxColumn state="open" title="待处理" {...props} /><InboxColumn state="done" title="已处理" {...props} />
  </div></section>
}
function InboxColumn({ state, title, csrf, askProject }: Props & { state: string; title: string }) {
  const [pages, setPages] = useState(1)
  const list = useAttentionList(state, {}, pages)
  return <section aria-label={title}><h2>{title}</h2>{list.error && <p role="alert">{list.error}</p>}
    {list.requests.map((item) => <AttentionCard key={item.id} item={item} csrf={csrf} compact askProject={askProject} />)}
    {!list.requests.length && <p>暂无{title}事项。</p>}
    {list.next_cursor && <button onClick={() => setPages((v) => v + 1)}>更多{title}事项</button>}
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
