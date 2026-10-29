import * as stylex from '@stylexjs/stylex'
import { Link, useLocation, useNavigate } from '@tanstack/react-router'
import { useState, type ReactNode } from 'react'
import { liveThreads } from '../data/derive'
import { useProjects, useSession, useThreads } from '../data/queries'
import type { Project } from '../data/types'
import { weight } from '../theme/base.stylex'
import { useTheme, type ThemeMode } from '../theme/ThemeProvider'
import { text } from '../theme/text'
import { colors, radius, size, space } from '../theme/tokens.stylex'
import { Avatar, PersonAvatar } from '../ui/Avatar'
import { Count, UnreadDot } from '../ui/Badge'
import { focusRing, IconButton } from '../ui/Button'
import { Icon, type IconName } from '../ui/Icon'
import { Menu, MenuHeading, MenuOption, MenuRule } from '../ui/Menu'
import { useWorkspace } from './workspace'

const styles = stylex.create({
  sidebar: {
    display: 'flex',
    flexDirection: 'column',
    flexShrink: 0,
    width: '100%',
    height: '100%',
    overflow: 'hidden',
    paddingTop: 0,
    paddingInline: space.sm,
    paddingBottom: space.sm,
  },
  sidebarCollapsed: { width: '52px' },
  header: {
    display: 'flex',
    alignItems: 'center',
    flexShrink: 0,
    gap: space.xs,
    height: size.header,
    paddingInline: space.xs,
  },
  headerCollapsed: {
    flexDirection: 'column',
    alignItems: 'flex-start',
    height: '76px',
    paddingTop: '10px',
  },
  nav: { display: 'flex', flexDirection: 'column', gap: space.xxs, marginTop: space.md },
  row: {
    display: 'flex',
    alignItems: 'center',
    gap: space.sm,
    height: size.row,
    paddingInline: space.sm,
    paddingLeft: '9px',
    borderRadius: radius.sm,
    color: colors.muted,
    fontWeight: weight.medium,
    lineHeight: 'normal',
    letterSpacing: 'normal',
    textDecoration: 'none',
    whiteSpace: 'nowrap',
    backgroundColor: { default: 'transparent', ':hover': colors.hover },
  },
  projectRow: { height: size.row, gap: '6px' },
  active: {
    backgroundColor: { default: colors.raised, ':hover': colors.raised },
    color: colors.text,
    fontWeight: weight.medium,
  },
  rowIcon: { color: colors.muted },
  rowLabel: { flexGrow: 1 },
  sectionHead: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    height: size.compact,
    marginTop: space.xl,
    paddingInline: space.sm,
    color: colors.muted,
  },
  addProject: {
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    width: '24px',
    height: '24px',
    padding: 0,
    borderWidth: 0,
    borderRadius: radius.inner,
    backgroundColor: { default: 'transparent', ':hover': colors.hover },
    color: colors.faint,
    opacity: { default: 0, ':focus-visible': 1, '@media (hover: none)': 1 },
    transition: 'opacity 150ms ease',
    '@media (prefers-reduced-motion: reduce)': { transition: 'none' },
  },
  addProjectVisible: { opacity: 1 },
  spacer: { flexGrow: 1 },
  projects: {
    display: 'flex',
    flexDirection: 'column',
    gap: space.xxs,
    marginTop: space.xs,
    flexGrow: 1,
    minHeight: 0,
    overflowY: 'auto',
  },
  empty: { paddingInline: space.sm, color: colors.faint },
  pausedName: { color: colors.faint },
  account: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'flex-end',
    gap: space.sm,
    flexGrow: 1,
    minWidth: 0,
    height: size.row,
    paddingInline: space.xs,
    paddingLeft: '2px',
    borderWidth: 0,
    borderRadius: radius.sm,
    backgroundColor: 'transparent',
    color: colors.text,
    textAlign: 'start',
  },
  accountCollapsed: { flexGrow: 0, width: '28px' },
  accountMenu: {
    display: 'flex',
    flexDirection: 'column',
    gap: space.md,
    padding: space.xs,
  },
  accountName: { display: 'flex', flexDirection: 'column' },
  accountLabel: { minWidth: 0, fontWeight: 550, lineHeight: '23px', letterSpacing: '-0.1px' },
  accountCaret: { color: colors.faint },
})

// 收起时只留图标，名称放进 aria-label 和悬停提示。
function NavRow({
  to,
  icon,
  label,
  trailing,
  collapsed,
}: {
  to: '/threads' | '/devices'
  icon: IconName
  label: string
  trailing?: ReactNode
  collapsed: boolean
}) {
  const { pathname } = useLocation()
  const active = pathname === to || pathname.startsWith(`${to}/`)
  return (
    <Link
      to={to}
      aria-current={active ? 'page' : undefined}
      aria-label={collapsed ? label : undefined}
      title={collapsed ? label : undefined}
      {...stylex.props(text.small, styles.row, active && styles.active, focusRing.ring)}
    >
      <Icon name={icon} size={18} style={styles.rowIcon} />
      {!collapsed && <span {...stylex.props(styles.rowLabel)}>{label}</span>}
      {!collapsed && trailing}
    </Link>
  )
}

function ProjectTrailing({ project }: { project: Project }) {
  return project.latestReplySeq > project.readReplySeq ? <UnreadDot /> : null
}

function ProjectRow({ project }: { project: Project }) {
  const { pathname } = useLocation()
  const active = pathname === `/projects/${project.id}`
  return (
    <Link
      to="/projects/$projectId"
      params={{ projectId: project.id }}
      aria-current={active ? 'page' : undefined}
      aria-label={project.status === 'paused' ? `${project.name}，已暂停` : undefined}
      title={project.status === 'paused' ? '已暂停' : undefined}
      {...stylex.props(text.small, styles.row, styles.projectRow, active && styles.active, focusRing.ring)}
    >
      <Avatar name={project.name} hue={project.hue} emoji={project.emoji} small />
      <span {...stylex.props(styles.rowLabel, text.truncate, project.status === 'paused' && styles.pausedName)}>
        {project.name}
      </span>
      <ProjectTrailing project={project} />
    </Link>
  )
}

const themeLabels: Record<ThemeMode, string> = { system: '跟随系统', light: '浅色', dark: '深色' }

export function Sidebar() {
  const navigate = useNavigate()
  const session = useSession()
  const projects = useProjects()
  const threads = useThreads()
  const { collapsed, toggleSidebar, signingOut, signOut } = useWorkspace()
  const { mode, setMode } = useTheme()

  const account = session.data?.account
  const unread = liveThreads(threads.data ?? []).filter((item) => item.unread).length
  const visibleProjects = (projects.data ?? []).filter((item) => item.status !== 'archived')

  return (
    <nav aria-label="工作区" {...stylex.props(styles.sidebar, collapsed && styles.sidebarCollapsed)}>
      <div {...stylex.props(styles.header, collapsed && styles.headerCollapsed)}>
        <IconButton
          icon="sidebar"
          iconSize={18}
          label={collapsed ? '展开侧栏' : '收起侧栏'}
          aria-expanded={!collapsed}
          onClick={toggleSidebar}
        />
        {account && (
          <Menu
            narrow
            side="bottom"
            trigger={
              <button
                type="button"
                aria-label={collapsed ? account.name : undefined}
                title={collapsed ? account.name : undefined}
                {...stylex.props(text.small, styles.account, collapsed && styles.accountCollapsed, focusRing.ring)}
              >
                <PersonAvatar name={account.name} />
                {!collapsed && <span {...stylex.props(text.truncate, styles.accountLabel)}>{account.name}</span>}
                {!collapsed && <Icon name="chevron-down" size={12} style={styles.accountCaret} />}
              </button>
            }
          >
            <div {...stylex.props(styles.accountMenu)}>
              <div {...stylex.props(styles.accountName)}>
                <span {...stylex.props(text.label)}>{account.name}</span>
                <span {...stylex.props(text.caption, text.faint)}>{account.username}</span>
              </div>
            </div>
            <MenuRule />
            <MenuHeading>外观</MenuHeading>
            {(['system', 'light', 'dark'] as const).map((value) => (
              <MenuOption key={value} selected={mode === value} onSelect={() => setMode(value)}>
                {themeLabels[value]}
              </MenuOption>
            ))}
            <MenuRule />
            <MenuOption onSelect={() => void navigate({ to: '/devices' })}>设备</MenuOption>
            <MenuOption onSelect={() => void navigate({ to: '/projects/archived' })}>已归档项目</MenuOption>
            <MenuRule />
            <MenuOption onSelect={signOut}>{signingOut ? '正在退出…' : '退出登录'}</MenuOption>
          </Menu>
        )}
      </div>
      <div {...stylex.props(styles.nav)}>
        <NavRow
          to="/threads"
          icon="threads"
          label="对话"
          collapsed={collapsed}
          trailing={unread > 0 && <Count value={unread} label={`${unread} 条未读`} />}
        />
        <NavRow to="/devices" icon="laptop" label="设备" collapsed={collapsed} />
      </div>

      {collapsed ? (
        <div {...stylex.props(styles.spacer)} />
      ) : (
        <ProjectList projects={visibleProjects} loaded={projects.data !== undefined} unavailable={projects.isError} />
      )}
    </nav>
  )
}

function ProjectList({
  projects,
  loaded,
  unavailable,
}: {
  projects: Project[]
  loaded: boolean
  unavailable: boolean
}) {
  const { newProject } = useWorkspace()
  const [headerHovered, setHeaderHovered] = useState(false)
  return (
    <>
      <div
        onMouseEnter={() => setHeaderHovered(true)}
        onMouseLeave={() => setHeaderHovered(false)}
        {...stylex.props(styles.sectionHead)}
      >
        <span {...stylex.props(text.captionMedium)}>项目</span>
        <button
          type="button"
          aria-label="新建项目"
          title="新建项目"
          onClick={newProject}
          {...stylex.props(styles.addProject, headerHovered && styles.addProjectVisible, focusRing.ring)}
        >
          <Icon name="plus" size={14} />
        </button>
      </div>
      <div {...stylex.props(styles.projects)}>
        {unavailable && <span {...stylex.props(text.caption, styles.empty)}>无法加载项目</span>}
        {loaded && projects.length === 0 && <span {...stylex.props(text.caption, styles.empty)}>暂无项目</span>}
        {projects.map((project) => (
          <ProjectRow key={project.id} project={project} />
        ))}
      </div>
    </>
  )
}
