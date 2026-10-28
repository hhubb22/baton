import * as stylex from '@stylexjs/stylex'
import { useState } from 'react'
import { desktopErrorMessage, useLocalDesktop } from '../data/desktop'
import type { Thread } from '../data/types'
import { text } from '../theme/text'
import { colors, space } from '../theme/tokens.stylex'
import { IconButton } from '../ui/Button'

const styles = stylex.create({
  actions: { display: 'inline-flex', alignItems: 'center', gap: space.xs, flexWrap: 'wrap', minWidth: 0 },
  icon: { width: '20px', height: '20px', color: colors.muted },
  error: { flexBasis: '100%', color: colors.danger, overflowWrap: 'anywhere' },
})

export function LocalThreadActions({ thread }: { thread: Pick<Thread, 'id' | 'deviceId'> }) {
  const { bridge, status } = useLocalDesktop(thread.deviceId, 'open-local')
  const [error, setError] = useState<string | null>(null)
  const [pending, setPending] = useState(false)
  if (!bridge?.openLocal || !status?.registered) return null
  const revealLabel = /windows|win32/i.test(status.system) ? 'Show in File Explorer' : 'Show in Finder'
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
    <span role="group" aria-label="Open local folder" aria-busy={pending} {...stylex.props(styles.actions)}>
      <IconButton icon="folder" label={revealLabel} style={styles.icon} onClick={() => void open('reveal')} />
      <IconButton icon="editor" label="Open in editor" style={styles.icon} onClick={() => void open('editor')} />
      {error && (
        <span role="alert" {...stylex.props(text.caption, styles.error)}>
          {error}
        </span>
      )}
    </span>
  )
}
