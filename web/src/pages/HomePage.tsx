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
    <Page title="工作区">
      <div {...stylex.props(styles.empty)}>
        <h2 {...stylex.props(text.title)}>连接第一台设备</h2>
        <Button variant="primary" onClick={() => void navigate({ to: '/devices', search: { connect: true } })}>
          连接设备
        </Button>
        <div {...stylex.props(styles.actions)}>
          <Button onClick={newProject}>新建项目</Button>
          <Button onClick={() => void navigate({ to: '/threads' })}>打开对话</Button>
        </div>
      </div>
    </Page>
  )
}
