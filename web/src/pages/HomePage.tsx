import * as stylex from '@stylexjs/stylex'
import { Navigate, useNavigate } from '@tanstack/react-router'
import { useDevices } from '../data/queries'
import { text } from '../theme/text'
import { space } from '../theme/tokens.stylex'
import { Page } from '../app/Page'
import { useWorkspace } from '../app/workspace'
import { Button } from '../ui/Button'

const styles = stylex.create({
  empty: {
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
    justifyContent: 'center',
    gap: space.md,
    height: '100%',
    textAlign: 'center',
  },
  actions: { display: 'flex', gap: space.sm },
})

// 有设备时进入 Threads；还没有设备时引导连接第一台。
export function HomePage() {
  const navigate = useNavigate()
  const devices = useDevices()
  const { newProject } = useWorkspace()
  if (!devices.data) return null
  if (devices.data.length > 0) return <Navigate to="/threads" replace />
  return (
    <Page title="Workspace">
      <div {...stylex.props(styles.empty)}>
        <h2 {...stylex.props(text.title)}>Connect your first device</h2>
        <p {...stylex.props(text.body, text.muted)}>
          Connect the computer where your code lives to chat with Cursor, Codex, Kiro, or Pi.
        </p>
        <Button variant="primary" onClick={() => void navigate({ to: '/devices', search: { connect: true } })}>
          Connect a device
        </Button>
        <div {...stylex.props(styles.actions)}>
          <Button onClick={newProject}>New project</Button>
          <Button onClick={() => void navigate({ to: '/threads' })}>Open Threads</Button>
        </div>
      </div>
    </Page>
  )
}
