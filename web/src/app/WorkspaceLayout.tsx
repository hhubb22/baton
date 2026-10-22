import * as stylex from '@stylexjs/stylex'
import { Navigate, Outlet, useLocation, useRouter } from '@tanstack/react-router'
import { useMemo, useState } from 'react'
import { useSession, useSignOut } from '../data/queries'
import { text } from '../theme/text'
import { colors, space } from '../theme/tokens.stylex'
import { Button } from '../ui/Button'
import { NewProjectDialog } from './NewProjectDialog'
import { Page } from './Page'
import type { LoginNotice } from './router'
import { Sidebar } from './Sidebar'
import { WorkspaceContext, type Workspace } from './workspace'

const styles = stylex.create({
  shell: { display: 'flex', height: '100vh', overflow: 'hidden', backgroundColor: colors.canvas },
  problem: {
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
    justifyContent: 'center',
    gap: space.lg,
    height: '100%',
    textAlign: 'center',
  },
  detail: { maxWidth: '520px' },
})

const collapsedKey = 'baton.sidebar.collapsed'

function readCollapsed() {
  try {
    return localStorage.getItem(collapsedKey) === 'true'
  } catch {
    return false
  }
}

function saveCollapsed(collapsed: boolean) {
  try {
    localStorage.setItem(collapsedKey, String(collapsed))
  } catch {
    // 存不下时只影响下次打开时的侧栏宽度。
  }
}

// 中心确认退出前浏览器可能仍在登录状态，所以退出失败时不跳走，留在原页面重试。
function SignOutFailed({ onRetry }: { onRetry: () => void }) {
  return (
    <Page title="Workspace">
      <div {...stylex.props(styles.problem)}>
        <h2 {...stylex.props(text.title)}>Could not sign out</h2>
        <p {...stylex.props(text.small, text.muted, styles.detail)}>
          Baton could not be reached to confirm sign-out. Your browser may still be signed in. Check your connection and
          try again.
        </p>
        <Button variant="primary" onClick={onRetry}>
          Retry sign-out
        </Button>
      </div>
    </Page>
  )
}

function Main({ failedAt, onRetry }: { failedAt: string | null; onRetry: () => void }) {
  const pathname = useLocation({ select: (location) => location.pathname })
  return failedAt === pathname ? <SignOutFailed onRetry={onRetry} /> : <Outlet />
}

export function WorkspaceLayout() {
  const session = useSession()
  const signOut = useSignOut()
  const router = useRouter()
  const [collapsed, setCollapsed] = useState(readCollapsed)
  // 退出失败的提示只留在发起退出的页面，切到别的页面后不再显示。
  const [failedAt, setFailedAt] = useState<string | null>(null)
  const [creatingProject, setCreatingProject] = useState(false)

  const workspace = useMemo<Workspace>(
    () => ({
      collapsed,
      toggleSidebar() {
        setCollapsed(!collapsed)
        saveCollapsed(!collapsed)
      },
      signingOut: signOut.isPending,
      signOut() {
        if (signOut.isPending) return
        setFailedAt(null)
        signOut.mutate(undefined, { onError: () => setFailedAt(router.state.location.pathname) })
      },
      newProject() {
        setCreatingProject(true)
      },
    }),
    [collapsed, signOut, router],
  )

  if (session.isPending) return null
  if (!session.data?.account) {
    // 正在退出或已退出时提示已退出；会话被中心结束时说明原因，并在重新登录后回到当前页面。
    const signedOut = signOut.isPending || signOut.isSuccess
    const notice: LoginNotice | undefined = signedOut ? 'signedOut' : (session.data?.ended ?? undefined)
    // 布局不订阅地址变化，跳转时读一次当前地址；订阅后跳转过程中会反复渲染 Navigate。
    const { href } = router.state.location
    const redirect = signedOut || href === '/' ? undefined : href
    return <Navigate to="/login" search={{ notice, redirect }} replace />
  }

  return (
    <WorkspaceContext value={workspace}>
      <div {...stylex.props(styles.shell)}>
        <Sidebar />
        <Main failedAt={failedAt} onRetry={workspace.signOut} />
      </div>
      {creatingProject && <NewProjectDialog onClose={() => setCreatingProject(false)} />}
    </WorkspaceContext>
  )
}
