import * as stylex from '@stylexjs/stylex'
import { useState } from 'react'
import { desktopErrorMessage, useLocalDesktop } from '../data/desktop'
import type { Thread } from '../data/types'
import { text } from '../theme/text'
import { semantic } from '../theme/semantic.stylex'
import { space } from '../theme/tokens.stylex'
import { IconButton } from '../ui/Button'

const styles = stylex.create({
  actions: { display: 'inline-flex', alignItems: 'center', gap: space.xs, flexWrap: 'wrap', minWidth: 0 },
  icon: { width: '20px', height: '20px', color: semantic.mutedForeground },
  error: { flexBasis: '100%', color: semantic.destructiveForeground, overflowWrap: 'anywhere' },
})

export function LocalThreadActions({ thread }: { thread: Pick<Thread, 'id' | 'deviceId'> }) {
  const { bridge, status } = useLocalDesktop(thread.deviceId, 'open-local')
  const [error, setError] = useState<string | null>(null)
  const [pending, setPending] = useState(false)
  if (!bridge?.openLocal || !status?.registered) return null
  const revealLabel = /windows|win32/i.test(status.system) ? '在文件资源管理器中显示' : '在 Finder 中显示'
  const open = async (action: 'reveal' | 'editor') => {
    if (pending) return
    setError(null)
    setPending(true)
    try {
      await bridge.openLocal!({ threadId: thread.id, action })
    } catch (cause) {
      setError(desktopErrorMessage(cause))
    } finally {
      setPending(false)
    }
  }
  return (
    <span role="group" aria-label="打开本地文件夹" aria-busy={pending} {...stylex.props(styles.actions)}>
      <IconButton icon="folder" label={revealLabel} style={styles.icon} onClick={() => void open('reveal')} />
      <IconButton icon="editor" label="在编辑器中打开" style={styles.icon} onClick={() => void open('editor')} />
      {error && (
        <span role="alert" {...stylex.props(text.caption, styles.error)}>
          {error}
        </span>
      )}
    </span>
  )
}
