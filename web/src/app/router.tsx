import * as stylex from '@stylexjs/stylex'
import { createRootRoute, createRoute, createRouter, Outlet } from '@tanstack/react-router'
import { DevicesPage } from '../pages/DevicesPage'
import { HomePage } from '../pages/HomePage'
import { InboxPage } from '../pages/InboxPage'
import { LoginPage } from '../pages/LoginPage'
import { ProjectPage } from '../pages/ProjectPage'
import { ThreadPage } from '../pages/ThreadPage'
import { ThreadsPage } from '../pages/ThreadsPage'
import { text } from '../theme/text'
import { Column, Page } from './Page'
import { WorkspaceLayout } from './WorkspaceLayout'

function NotFound() {
  return (
    <Page title="Page not found">
      <Column>
        <p {...stylex.props(text.body, text.muted)}>Check the address, or pick a page from the sidebar.</p>
      </Column>
    </Page>
  )
}

const rootRoute = createRootRoute({ component: Outlet })

export type LoginNotice = 'signedOut' | 'expired' | 'passwordReset'

export interface LoginSearch {
  notice?: LoginNotice
  // 登录后回到的站内地址。
  redirect?: string
}

export interface DevicesSearch {
  connect?: true
}

export interface ThreadsSearch {
  // 右侧打开的 Thread。
  thread?: string
  // 筛选：设备、Project（none 表示不属于 Project）、只看已归档。
  device?: string
  project?: string
  archived?: true
  // 新对话：focus 聚焦顶部输入区，folder 打开选择目录；from 用这个 Thread 的设备和目录预填。
  compose?: 'focus' | 'folder'
  from?: string
}

function optionalString(value: unknown) {
  return typeof value === 'string' && value !== '' ? value : undefined
}

function flag(value: unknown) {
  return [true, 1, '1', 'true'].includes(value as never) ? true : undefined
}

const notices: LoginNotice[] = ['signedOut', 'expired', 'passwordReset']

// 只接受站内路径，避免登录后被带到别的网站。
function safeRedirect(value: unknown) {
  return typeof value === 'string' && value.startsWith('/') && !value.startsWith('//') ? value : undefined
}

const loginRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/login',
  component: LoginPage,
  validateSearch: (search: Record<string, unknown>): LoginSearch => ({
    notice: notices.find((item) => item === search.notice),
    redirect: safeRedirect(search.redirect),
  }),
})

// 登录后的页面共用侧栏布局；未登录时布局跳到 /login。
const workspaceRoute = createRoute({ getParentRoute: () => rootRoute, id: 'workspace', component: WorkspaceLayout })

const routeTree = rootRoute.addChildren([
  loginRoute,
  workspaceRoute.addChildren([
    createRoute({ getParentRoute: () => workspaceRoute, path: '/', component: HomePage }),
    createRoute({ getParentRoute: () => workspaceRoute, path: '/inbox', component: InboxPage }),
    createRoute({
      getParentRoute: () => workspaceRoute,
      path: '/threads',
      component: ThreadsPage,
      validateSearch: (search: Record<string, unknown>): ThreadsSearch => ({
        thread: optionalString(search.thread),
        device: optionalString(search.device),
        project: optionalString(search.project),
        archived: flag(search.archived),
        compose: search.compose === 'focus' || search.compose === 'folder' ? search.compose : undefined,
        from: optionalString(search.from),
      }),
    }),
    createRoute({ getParentRoute: () => workspaceRoute, path: '/threads/$threadId', component: ThreadPage }),
    createRoute({
      getParentRoute: () => workspaceRoute,
      path: '/devices',
      component: DevicesPage,
      // 带 connect 参数时打开接入窗口。
      validateSearch: (search: Record<string, unknown>): DevicesSearch => ({
        connect: flag(search.connect),
      }),
    }),
    createRoute({ getParentRoute: () => workspaceRoute, path: '/projects/$projectId', component: ProjectPage }),
    createRoute({ getParentRoute: () => workspaceRoute, path: '$', component: NotFound }),
  ]),
])

export function createAppRouter(options: { history?: Parameters<typeof createRouter>[0]['history'] } = {}) {
  return createRouter({ routeTree, history: options.history })
}

declare module '@tanstack/react-router' {
  interface Register {
    router: ReturnType<typeof createAppRouter>
  }
}
