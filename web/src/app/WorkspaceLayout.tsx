import * as stylex from '@stylexjs/stylex'
import { Navigate, Outlet, useLocation, useRouter } from '@tanstack/react-router'
import { useEffect, useMemo, useState } from 'react'
import { useInbox, useSession, useSignOut } from '../data/queries'
import type { ID, ProjectPatch, Reference } from '../data/types'
import { text } from '../theme/text'
import { colors, size, space } from '../theme/tokens.stylex'
import { Button } from '../ui/Button'
import { createDraftStore } from './drafts'
import { DesktopWorkspace } from './DesktopWorkspace'
import { NewProjectDialog } from './NewProjectDialog'
import { Page } from './Page'
import type { LoginNotice } from './router'
import { Sidebar } from './Sidebar'
import { WorkspaceContext, type ItemDraft, type MemoryDraft, type Workspace } from './workspace'

const styles = stylex.create({
  shell: {
    display: 'flex',
    gap: size.gutter,
    height: '100vh',
    overflow: 'hidden',
    padding: size.gutter,
    backgroundColor: colors.panel,
  },
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
        <h2 {...stylex.props(text.title)}>Couldn't sign out</h2>
        <p {...stylex.props(text.small, text.muted, styles.detail)}>You may still be signed in on this browser.</p>
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

function WorkspaceTitle() {
  const inbox = useInbox()
  const count = (inbox.data ?? []).filter((item) => item.status === 'pending').length
  useEffect(() => {
    document.title = count > 0 ? `(${count}) Baton` : 'Baton'
    return () => {
      document.title = 'Baton'
    }
  }, [count])
  return null
}

export function WorkspaceLayout() {
  const session = useSession()
  const signOut = useSignOut()
  const router = useRouter()
  const [collapsed, setCollapsed] = useState(readCollapsed)
  // 退出失败的提示只留在发起退出的页面，切到别的页面后不再显示。
  const [failedAt, setFailedAt] = useState<string | null>(null)
  const [creatingProject, setCreatingProject] = useState(false)
  const [references, setReferences] = useState<Record<ID, Reference>>({})
  const [drafts] = useState(() => ({
    itemDrafts: createDraftStore<ItemDraft>(),
    settingsDrafts: createDraftStore<ProjectPatch>(),
    memoryDrafts: createDraftStore<MemoryDraft>(),
  }))

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
      ...drafts,
      references,
      askProject(projectId, reference) {
        setReferences((current) => ({ ...current, [projectId]: reference }))
        if (router.state.location.pathname !== `/projects/${projectId}`) {
          void router.navigate({ to: '/projects/$projectId', params: { projectId } })
        }
      },
      clearReference(projectId) {
        setReferences((current) => {
          const { [projectId]: _removed, ...rest } = current
          return rest
        })
      },
    }),
    [collapsed, signOut, router, references, drafts],
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

  if (session.data.mustChangePassword) {
    const { href } = router.state.location
    return <Navigate to="/password" search={{ redirect: href === '/' ? undefined : href }} replace />
  }

  return (
    <WorkspaceContext value={workspace}>
      <DesktopWorkspace>
        <WorkspaceTitle />
        <div {...stylex.props(styles.shell)}>
          <Sidebar />
          <Main failedAt={failedAt} onRetry={workspace.signOut} />
        </div>
        {creatingProject && <NewProjectDialog onClose={() => setCreatingProject(false)} />}
      </DesktopWorkspace>
    </WorkspaceContext>
  )
}
