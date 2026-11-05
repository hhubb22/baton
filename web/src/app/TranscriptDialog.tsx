import * as stylex from '@stylexjs/stylex'
import { useEffect, useMemo, useState } from 'react'
import type { TranscriptPage } from '@baton/protocol'
import { useClient } from '../data/queries'
import { fonts, fontSize } from '../theme/base.stylex'
import { semantic } from '../theme/semantic.stylex'
import { space } from '../theme/tokens.stylex'
import { text } from '../theme/text'
import { Button } from '../ui/Button'
import { Dialog, DialogClose } from '../ui/Dialog'

export type TranscriptSource =
  | { readonly kind: 'thread'; readonly threadId: string }
  | { readonly kind: 'run'; readonly projectId: string; readonly runId: string }

const styles = stylex.create({
  body: {
    display: 'flex',
    flexDirection: 'column',
    gap: space.sm,
    maxHeight: '62vh',
    overflowY: 'auto',
    paddingRight: space.xs,
  },
  line: {
    borderBottomWidth: '1px',
    borderBottomStyle: 'solid',
    borderBottomColor: semantic.border,
    paddingBottom: space.sm,
  },
  summary: {
    display: 'flex',
    alignItems: 'center',
    gap: space.sm,
    cursor: 'pointer',
  },
  kind: { fontFamily: fonts.mono, fontSize: fontSize.caption, color: semantic.mutedForeground },
  meta: { color: semantic.faintForeground, fontSize: fontSize.caption },
  payload: {
    margin: 0,
    marginTop: space.xs,
    maxHeight: '280px',
    overflow: 'auto',
    whiteSpace: 'pre-wrap',
    overflowWrap: 'anywhere',
    fontFamily: fonts.mono,
    fontSize: fontSize.caption,
    lineHeight: 1.5,
    color: semantic.mutedForeground,
  },
  actions: { display: 'flex', gap: space.sm, alignItems: 'center' },
})

const decodeBase64 = (value: string) => {
  const binary = atob(value)
  const bytes = new Uint8Array(binary.length)
  for (let index = 0; index < binary.length; index++) bytes[index] = binary.charCodeAt(index)
  return bytes
}

const completeText = (chunks: readonly Uint8Array[]) => {
  const total = chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0)
  const bytes = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) {
    bytes.set(chunk, offset)
    offset += chunk.byteLength
  }
  let end = bytes.lastIndexOf(10)
  if (end < 0) return { lines: [] as string[], incomplete: new TextDecoder().decode(bytes) }
  const complete = bytes.subarray(0, end)
  return {
    lines: new TextDecoder().decode(complete).split('\n').filter(Boolean),
    incomplete: new TextDecoder().decode(bytes.subarray(end + 1)),
  }
}

export function TranscriptDialog({
  open,
  onClose,
  source,
  title,
}: {
  open: boolean
  onClose: () => void
  source: TranscriptSource
  title: string
}) {
  const client = useClient()
  const [chunks, setChunks] = useState<Uint8Array[]>([])
  const [offset, setOffset] = useState(0)
  const [done, setDone] = useState(false)
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)
  const [incomplete, setIncomplete] = useState('')
  const [expanded, setExpanded] = useState<Set<number>>(new Set())

  const read = (cursor?: number) => {
    if (source.kind === 'thread') return client.readThreadTranscript?.(source.threadId, cursor)
    return client.readProjectRunTranscript?.(source.projectId, source.runId, cursor)
  }

  const load = async (cursor?: number) => {
    setLoading(true)
    setError('')
    try {
      const page = await read(cursor)
      if (!page) throw new Error('暂不支持查看运行记录')
      setChunks((current) => [...current, decodeBase64(page.data)])
      setOffset(page.next_offset)
      setDone(page.done)
      setIncomplete(page.incomplete_tail ? '文件末尾还有一行未写完。' : '')
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '运行记录暂不可用')
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    setChunks([])
    setOffset(0)
    setDone(false)
    setError('')
    setIncomplete('')
    setExpanded(new Set())
    if (open) void load()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, source.kind, source.kind === 'thread' ? source.threadId : source.runId])

  const lines = useMemo(() => completeText(chunks).lines, [chunks])

  const download = async () => {
    setLoading(true)
    setError('')
    try {
      const all: Uint8Array[] = []
      let cursor: number | undefined
      do {
        const page: TranscriptPage | undefined = await read(cursor)
        if (!page) throw new Error('暂不支持下载运行记录')
        all.push(decodeBase64(page.data))
        cursor = page.done ? undefined : page.next_offset
      } while (cursor !== undefined)
      const blob = new Blob(all as BlobPart[], { type: 'application/x-ndjson' })
      const url = URL.createObjectURL(blob)
      const anchor = document.createElement('a')
      anchor.href = url
      anchor.download = `${title}.jsonl`
      anchor.click()
      URL.revokeObjectURL(url)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '运行记录暂不可下载')
    } finally {
      setLoading(false)
    }
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => !next && onClose()}
      title="运行记录"
      description={title}
      wide
      actions={
        <div {...stylex.props(styles.actions)}>
          <Button small disabled={loading} onClick={() => void download()}>
            下载 .jsonl
          </Button>
          <DialogClose render={<Button small>关闭</Button>} />
        </div>
      }
    >
      <div {...stylex.props(styles.body)}>
        {error && <span {...stylex.props(text.small, styles.meta)}>{error}</span>}
        {!error && lines.length === 0 && !loading && (
          <span {...stylex.props(text.small, styles.meta)}>暂无运行记录</span>
        )}
        {lines.map((line, index) => {
          let value: { ts?: string; kind?: string; data?: unknown } = {}
          try {
            value = JSON.parse(line) as typeof value
          } catch {
            value = {}
          }
          const open = expanded.has(index)
          return (
            <div key={`${index}-${value.kind ?? 'raw'}`} {...stylex.props(styles.line)}>
              <div
                {...stylex.props(styles.summary)}
                role="button"
                tabIndex={0}
                onClick={() =>
                  setExpanded((current) => {
                    const next = new Set(current)
                    if (next.has(index)) next.delete(index)
                    else next.add(index)
                    return next
                  })
                }
                onKeyDown={(event) => {
                  if (event.key !== 'Enter' && event.key !== ' ') return
                  event.preventDefault()
                  event.currentTarget.click()
                }}
              >
                <span {...stylex.props(styles.kind)}>{value.kind ?? '记录'}</span>
                {value.ts && <span {...stylex.props(styles.meta)}>{new Date(value.ts).toLocaleTimeString()}</span>}
              </div>
              {open && (
                <pre {...stylex.props(styles.payload)}>{JSON.stringify(value.data ?? JSON.parse(line), null, 2)}</pre>
              )}
            </div>
          )
        })}
        {incomplete && <span {...stylex.props(text.small, styles.meta)}>{incomplete}</span>}
        {!done && !error && (
          <Button small disabled={loading} onClick={() => void load(offset)}>
            {loading ? '正在读取…' : '加载更多'}
          </Button>
        )}
      </div>
    </Dialog>
  )
}
