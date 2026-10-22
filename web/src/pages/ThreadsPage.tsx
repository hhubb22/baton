import * as stylex from '@stylexjs/stylex'
import { Column, Page } from '../app/Page'
import { ThreadRow } from '../app/ThreadRow'
import { useDevices, useThreads } from '../data/queries'
import { text } from '../theme/text'
import { space } from '../theme/tokens.stylex'

const styles = stylex.create({
  list: { display: 'flex', flexDirection: 'column', gap: space.xxs },
  empty: { paddingBlock: space.xl, textAlign: 'center' },
})

export function ThreadsPage() {
  const threads = useThreads()
  const devices = useDevices()
  const rows = [...(threads.data ?? [])].sort((a, b) => b.updatedAt - a.updatedAt)
  return (
    <Page title="Threads">
      <Column>
        {threads.data && rows.length === 0 && (
          <p {...stylex.props(text.body, text.muted, styles.empty)}>No threads yet</p>
        )}
        <div {...stylex.props(styles.list)}>
          {rows.map((thread) => (
            <ThreadRow
              key={thread.id}
              thread={thread}
              device={devices.data?.find((item) => item.id === thread.deviceId)}
            />
          ))}
        </div>
      </Column>
    </Page>
  )
}
