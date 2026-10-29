import * as stylex from '@stylexjs/stylex'
import { useEffect, useRef, useState } from 'react'
import { readFullOutput } from '../data/http/full-output'
import type { FullOutputReference } from '../data/types'
import { fileSize } from '../data/derive'
import { fonts } from '../theme/base.stylex'
import { text } from '../theme/text'
import { colors, space } from '../theme/tokens.stylex'
import { Button } from '../ui/Button'

const styles = stylex.create({
  root: { display: 'flex', flexDirection: 'column', alignItems: 'flex-start', gap: space.sm },
  actions: { display: 'flex', flexWrap: 'wrap', gap: space.sm, alignItems: 'center' },
  muted: { color: colors.muted },
  output: {
    margin: 0,
    maxHeight: '320px',
    overflow: 'auto',
    whiteSpace: 'pre-wrap',
    overflowWrap: 'anywhere',
    alignSelf: 'stretch',
    fontFamily: fonts.mono,
    fontSize: '12px',
    lineHeight: 1.55,
    paddingLeft: space.md,
    borderLeftWidth: '2px',
    borderLeftStyle: 'solid',
    borderLeftColor: colors.borderSoft,
  },
})

interface FullOutputProps {
  threadId: string
  reference: FullOutputReference
  reader?: typeof readFullOutput
}

export function FullOutput(props: FullOutputProps) {
  return (
    <FullOutputReader
      key={`${props.threadId}:${props.reference.storage_generation}:${props.reference.id}`}
      {...props}
    />
  )
}

function FullOutputReader({ threadId, reference, reader = readFullOutput }: FullOutputProps) {
  const [current, setCurrent] = useState<Awaited<ReturnType<typeof readFullOutput>> | null>(null)
  const [body, setBody] = useState('')
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)
  const decoder = useRef(new TextDecoder())
  const request = useRef<AbortController | null>(null)
  useEffect(() => () => request.current?.abort(), [])

  async function load(restart = false) {
    if (loading) return
    const controller = new AbortController()
    request.current = controller
    setLoading(true)
    setError('')
    try {
      const result = await reader(
        threadId,
        reference,
        restart ? '0' : String(current?.page.next_offset ?? 0),
        controller.signal,
      )
      if (controller.signal.aborted) return
      if (restart) decoder.current = new TextDecoder()
      const decoded = decoder.current.decode(result.bytes, { stream: !result.page.done })
      setCurrent(result)
      setBody(decoded)
    } catch (cause) {
      if (!controller.signal.aborted) setError(cause instanceof Error ? cause.message : '设备无法读取此输出。')
    } finally {
      if (!controller.signal.aborted) setLoading(false)
    }
  }

  function downloadPage() {
    if (!current) return
    const url = URL.createObjectURL(new Blob([new Uint8Array(current.bytes)]))
    const link = document.createElement('a')
    link.href = url
    link.download = `output-${reference.id}-${current.page.offset}.bin`
    link.click()
    setTimeout(() => URL.revokeObjectURL(url), 0)
  }

  return (
    <div {...stylex.props(styles.root)}>
      {current && (
        <>
          <span {...stylex.props(text.caption, styles.muted)}>
            已读取 {fileSize(current.page.next_offset)}，共 {fileSize(reference.total_bytes)}
          </span>
          <pre {...stylex.props(styles.output)}>{body}</pre>
        </>
      )}
      {error && (
        <p role="status" {...stylex.props(text.small, styles.muted)}>
          {error}
        </p>
      )}
      <div {...stylex.props(styles.actions)}>
        {(!current || !current.page.done) && (
          <Button small onClick={() => void load()}>
            {loading ? '正在读取…' : current ? '继续读取' : '读取完整输出'}
          </Button>
        )}
        {current && (
          <>
            <Button small onClick={() => void load(true)}>
              从头读取
            </Button>
            <Button small onClick={downloadPage}>
              下载此部分
            </Button>
          </>
        )}
      </div>
    </div>
  )
}
