import * as stylex from '@stylexjs/stylex'
import { Link, useLocation, useNavigate } from '@tanstack/react-router'
import { useState, type ReactNode } from 'react'
import { liveThreads, pendingInbox } from '../data/derive'
import { useInbox, useProjects, useSession, useThreads } from '../data/queries'
import type { Project } from '../data/types'
import { weight } from '../theme/base.stylex'
import { useTheme, type ThemeMode } from '../theme/ThemeProvider'
import { text } from '../theme/text'
import { colors, radius, size, space } from '../theme/tokens.stylex'
import { Avatar, PersonAvatar } from '../ui/Avatar'
import { Count } from '../ui/Badge'
import { focusRing, IconButton } from '../ui/Button'
import { Icon, type IconName } from '../ui/Icon'
import { Menu, MenuHeading, MenuOption, MenuRule } from '../ui/Menu'
import { StatusDot } from '../ui/Status'
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
  to: '/inbox' | '/threads' | '/devices'
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

function ProjectTrailing({ project, pending }: { project: Project; pending: number }) {
  if (project.status === 'paused') return null
  if (pending > 0) return <Count value={pending} label={`${pending} waiting for your reply`} />
  if (project.agent.state === 'running') return <StatusDot tone="agent" label="Running" />
  if (project.agent.state === 'stopping') return <StatusDot tone="agent" label="Stopping" />
  if (project.agent.state === 'waitingDevice') return <span {...stylex.props(text.caption, text.faint)}>Waiting</span>
  return null
}

function ProjectRow({ project, pending }: { project: Project; pending: number }) {
  const { pathname } = useLocation()
  const active = pathname === `/projects/${project.id}`
  return (
    <Link
      to="/projects/$projectId"
      params={{ projectId: project.id }}
      aria-current={active ? 'page' : undefined}
      aria-label={project.status === 'paused' ? `${project.name}, Paused` : undefined}
      title={project.status === 'paused' ? 'Paused' : undefined}
      {...stylex.props(text.small, styles.row, styles.projectRow, active && styles.active, focusRing.ring)}
    >
      <Avatar name={project.name} hue={project.hue} emoji={project.emoji} small />
      <span {...stylex.props(styles.rowLabel, text.truncate, project.status === 'paused' && styles.pausedName)}>
        {project.name}
      </span>
      <ProjectTrailing project={project} pending={pending} />
    </Link>
  )
}

const themeLabels: Record<ThemeMode, string> = { system: 'Match system', light: 'Light', dark: 'Dark' }

export function Sidebar() {
  const navigate = useNavigate()
  const session = useSession()
  const projects = useProjects()
  const threads = useThreads()
  const inbox = useInbox()
  const { collapsed, toggleSidebar, signingOut, signOut } = useWorkspace()
  const { mode, setMode } = useTheme()

  const account = session.data?.account
  const pending = pendingInbox(inbox.data ?? [])
  const unread = liveThreads(threads.data ?? []).filter((item) => item.unread).length
  const visibleProjects = (projects.data ?? []).filter((item) => item.status !== 'archived')

  return (
    <nav aria-label="Workspace" {...stylex.props(styles.sidebar, collapsed && styles.sidebarCollapsed)}>
      <div {...stylex.props(styles.header, collapsed && styles.headerCollapsed)}>
        <IconButton
          icon="sidebar"
          iconSize={18}
          label={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
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
            <MenuHeading>Theme</MenuHeading>
            {(['system', 'light', 'dark'] as const).map((value) => (
              <MenuOption key={value} selected={mode === value} onSelect={() => setMode(value)}>
                {themeLabels[value]}
              </MenuOption>
            ))}
            <MenuRule />
            <MenuOption onSelect={() => void navigate({ to: '/devices' })}>Devices</MenuOption>
            <MenuOption onSelect={() => void navigate({ to: '/projects/archived' })}>Archived projects</MenuOption>
            <MenuRule />
            <MenuOption onSelect={signOut}>{signingOut ? 'Signing out…' : 'Sign out'}</MenuOption>
          </Menu>
        )}
      </div>
      <div {...stylex.props(styles.nav)}>
        <NavRow
          to="/inbox"
          icon="inbox"
          label="Inbox"
          collapsed={collapsed}
          trailing={
            pending.length > 0 && <Count value={pending.length} label={`${pending.length} waiting for your reply`} />
          }
        />
        <NavRow
          to="/threads"
          icon="threads"
          label="Threads"
          collapsed={collapsed}
          trailing={unread > 0 && <Count value={unread} label={`${unread} unread`} />}
        />
        <NavRow to="/devices" icon="laptop" label="Devices" collapsed={collapsed} />
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
  const inbox = useInbox()
  const { newProject } = useWorkspace()
  const [headerHovered, setHeaderHovered] = useState(false)
  return (
    <>
      <div
        onMouseEnter={() => setHeaderHovered(true)}
        onMouseLeave={() => setHeaderHovered(false)}
        {...stylex.props(styles.sectionHead)}
      >
        <span {...stylex.props(text.captionMedium)}>Projects</span>
        <button
          type="button"
          aria-label="New project"
          title="New project"
          onClick={newProject}
          {...stylex.props(styles.addProject, headerHovered && styles.addProjectVisible, focusRing.ring)}
        >
          <Icon name="plus" size={14} />
        </button>
      </div>
      <div {...stylex.props(styles.projects)}>
        {unavailable && <span {...stylex.props(text.caption, styles.empty)}>Projects unavailable</span>}
        {loaded && projects.length === 0 && <span {...stylex.props(text.caption, styles.empty)}>No projects yet</span>}
        {projects.map((project) => (
          <ProjectRow key={project.id} project={project} pending={pendingInbox(inbox.data ?? [], project.id).length} />
        ))}
      </div>
    </>
  )
}
