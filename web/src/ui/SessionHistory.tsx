import { useEffect, useRef, useState } from 'react'
import { messageOf, request } from '../api.ts'
import { historyError, validHistoryPage, type HistoryPage, type HistoryResult } from '../history-model.ts'
import './SessionHistory.css'

export function SessionHistory({ sessionID, recovery }: { sessionID: string; recovery: number }) {
  const [page, setPage] = useState<HistoryPage | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [gap, setGap] = useState(false)
  const [back, setBack] = useState<string[]>([])
  const [position, setPosition] = useState('')
  const [backfill, setBackfill] = useState(false)
  const current = useRef({ cursor: '', position: '', back: [] as string[], busy: false })
  const sequence = useRef(0)
  const loadRef = useRef<(cursor: string, back: string[], backfill: boolean) => Promise<void>>(async () => {})

  async function load(cursor: string, previous: string[], isBackfill: boolean) {
    const version = ++sequence.current
    current.current.busy = true
    setBusy(true); setError('')
    try {
      const params = new URLSearchParams({ limit: '16', cursor })
      const result = await request<HistoryResult>(`/api/v1/sessions/${sessionID}/history?${params}`)
      if (version !== sequence.current) return
      if (!result.ok || !validHistoryPage(result.history)) {
        setGap(true); setError(historyError(result.code)); return
      }
      const next = result.history
      if (next.has_more && next.cursor === cursor) { setGap(true); setError('历史游标没有前进，缺口保留。'); return }
      // 空的刷新页保留当前正文和导航位置；只更新可继续补取的游标。
      if (next.entries.length || !cursor) {
        setPage(next); setPosition(cursor); setBack(previous)
        current.current.position = cursor; current.current.back = previous
      } else {
        setPage((existing) => existing ? { ...existing, has_more: next.has_more, gap: existing.gap || next.gap, code: next.code } : next)
      }
      current.current.cursor = next.cursor
      setBackfill(isBackfill)
      if (next.gap) setGap(true)
      if (next.code) setError(historyError(next.code))
    } catch (e) {
      if (version === sequence.current) { setGap(true); setError(messageOf(e)) }
    } finally {
      if (version === sequence.current) { current.current.busy = false; setBusy(false) }
    }
  }

  useEffect(() => { loadRef.current = load })
  useEffect(() => {
    const prior = current.current
    void loadRef.current(prior.cursor, prior.cursor ? [...prior.back, prior.position].slice(-64) : [], recovery > 0)
    const requests = sequence
    return () => { requests.current++ }
  }, [sessionID, recovery])

  return <section aria-label="节点历史">
    <h4>节点历史</h4>
    <p>按原生记录顺序分页，每页最多 16 条；页面只保留当前页。分支关系按父条目标识显示。</p>
    {error && <p role="alert">{error}</p>}
    {gap && <p role="status">历史存在截断、缺失或未确认的部分，缺口保留。超大内容请按引用在执行节点查看。</p>}
    {backfill && !busy && !error && <p role="status">已补取节点历史{page?.has_more ? '的一页，仍有后续记录。' : '至本次读取的末尾。'}实时输出的缺口可结合原生记录核实。</p>}
    <div className="session-history-actions">
      <button type="button" disabled={busy} onClick={() => void load('', [], false)}>从头读取历史</button>
      <button type="button" disabled={busy || !back.length} onClick={() => void load(back.at(-1) ?? '', back.slice(0, -1), false)}>上一页历史</button>
      <button type="button" disabled={busy || !page?.has_more} onClick={() => void load(current.current.cursor, [...back, position].slice(-64), backfill)}>下一页历史</button>
      <button type="button" disabled={busy} onClick={() => void load(error ? position : current.current.cursor, error ? back : [...back, position].slice(-64), true)}>补取节点历史</button>
    </div>
    {busy && <p role="status">正在读取节点历史。</p>}
    {page && <>
      {page.entries.length === 0 && <p>本次没有已写完的历史条目。</p>}
      {page.entries.map((entry) => <article key={entry.reference}>
        <p>{entry.kind || '原生条目'}{entry.id && ` · ${entry.id}`}{entry.parent_id && ` · 父条目 ${entry.parent_id}`}</p>
        <pre className="session-output" aria-label="历史条目">{entry.text}</pre>
        {entry.truncated && <p>内容超出单条显示上限，已截断。原生条目 {entry.bytes} 字节。</p>}
        <p>节点本地引用：<code>{entry.reference}</code></p>
      </article>)}
      <p>{page.has_more ? '仍有后续记录，可继续分页。' : '已到本次读取的历史末尾；新输出可能仍在写入。'}</p>
    </>}
  </section>
}
