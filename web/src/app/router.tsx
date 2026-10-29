import * as stylex from '@stylexjs/stylex'
import { createRootRoute, createRoute, createRouter, Outlet } from '@tanstack/react-router'
import { ArchivedProjectsPage } from '../pages/ArchivedProjectsPage'
import { DevicesPage } from '../pages/DevicesPage'
import { HomePage } from '../pages/HomePage'
import { InboxPage } from '../pages/InboxPage'
import { LoginPage } from '../pages/LoginPage'
import { PasswordPage } from '../pages/PasswordPage'
import { ProjectPage } from '../pages/ProjectPage'
import { ThreadPage } from '../pages/ThreadPage'
import { ThreadsPage } from '../pages/ThreadsPage'
import { text } from '../theme/text'
import { Column, Page } from './Page'
import { WorkspaceLayout } from './WorkspaceLayout'

function NotFound() {
  return (
    <Page title="页面不存在">
      <Column>
        <p {...stylex.props(text.body, text.muted)}>请检查地址，或从侧栏选择页面。</p>
      </Column>
    </Page>
  )
}

const rootRoute = createRootRoute({ component: Outlet })

export type LoginNotice = 'signedOut' | 'expired' | 'passwordReset' | 'passwordUpdated'

export interface LoginSearch {
  notice?: LoginNotice
  // 登录后回到的站内地址。
  redirect?: string
}

export interface DevicesSearch {
  connect?: true
  device?: string
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

export interface InboxSearch {
  handled?: true
}

export interface ProjectSearch {
  settings?: true
  archive?: true
  view?: 'memory'
  // 右侧打开的 Thread，替换概览栏。
  thread?: string
}

function optionalString(value: unknown) {
  return typeof value === 'string' && value !== '' ? value : undefined
}

function flag(value: unknown) {
  return [true, 1, '1', 'true'].includes(value as never) ? true : undefined
}

const notices: LoginNotice[] = ['signedOut', 'expired', 'passwordReset', 'passwordUpdated']

// 只接受站内路径，避免登录后被带到别的网站。
function safeRedirect(value: unknown) {
  if (typeof value !== 'string' || !value.startsWith('/') || value.startsWith('//') || value.includes('\\')) return
  const url = new URL(value, 'https://baton.local')
  if (url.origin !== 'https://baton.local' || /^\/(login|password)\/*$/.test(url.pathname)) return
  return `${url.pathname}${url.search}${url.hash}`
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

const passwordRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/password',
  component: PasswordPage,
  validateSearch: (search: Record<string, unknown>): Pick<LoginSearch, 'redirect'> => ({
    redirect: safeRedirect(search.redirect),
  }),
})

// 登录后的页面共用侧栏布局；未登录时布局跳到 /login。
const workspaceRoute = createRoute({ getParentRoute: () => rootRoute, id: 'workspace', component: WorkspaceLayout })

const routeTree = rootRoute.addChildren([
  loginRoute,
  passwordRoute,
  workspaceRoute.addChildren([
    createRoute({ getParentRoute: () => workspaceRoute, path: '/', component: HomePage }),
    createRoute({
      getParentRoute: () => workspaceRoute,
      path: '/inbox',
      component: InboxPage,
      validateSearch: (search: Record<string, unknown>): InboxSearch => ({ handled: flag(search.handled) }),
    }),
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
        device: optionalString(search.device),
      }),
    }),
    createRoute({ getParentRoute: () => workspaceRoute, path: '/projects/archived', component: ArchivedProjectsPage }),
    createRoute({
      getParentRoute: () => workspaceRoute,
      path: '/projects/$projectId',
      component: ProjectPage,
      validateSearch: (search: Record<string, unknown>): ProjectSearch => ({
        thread: optionalString(search.thread),
        settings: flag(search.settings),
        archive: flag(search.archive),
        view: search.view === 'memory' ? 'memory' : undefined,
      }),
    }),
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
