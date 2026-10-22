import * as stylex from '@stylexjs/stylex'
import { Link, useLocation, useNavigate } from '@tanstack/react-router'
import type { ReactNode } from 'react'
import { liveThreads, onlineSummary, pendingInbox } from '../data/derive'
import { useDevices, useInbox, useProjects, useSession, useThreads } from '../data/queries'
import type { Project } from '../data/types'
import { weight } from '../theme/base.stylex'
import { useTheme, type ThemeMode } from '../theme/ThemeProvider'
import { text } from '../theme/text'
import { colors, radius, size, space } from '../theme/tokens.stylex'
import { Avatar, PersonAvatar } from '../ui/Avatar'
import { Count } from '../ui/Badge'
import { BrandMark } from '../ui/BrandMark'
import { Button, focusRing, IconButton } from '../ui/Button'
import { Icon, type IconName } from '../ui/Icon'
import { Menu, MenuHeading, MenuOption, MenuRule } from '../ui/Menu'
import { StatusDot } from '../ui/Status'
import { useWorkspace } from './workspace'

const styles = stylex.create({
  sidebar: {
    display: 'flex',
    flexDirection: 'column',
    flexShrink: 0,
    width: size.sidebar,
    height: '100%',
    paddingTop: 0,
    paddingInline: space.sm,
    paddingBottom: space.sm,
    backgroundColor: colors.panel,
    borderRightWidth: '1px',
    borderRightStyle: 'solid',
    borderRightColor: colors.borderSoft,
  },
  sidebarCollapsed: { width: '64px' },
  brand: {
    display: 'flex',
    alignItems: 'center',
    gap: space.sm,
    height: size.header,
    paddingInline: space.sm,
  },
  brandName: { flexGrow: 1 },
  nav: { display: 'flex', flexDirection: 'column', gap: space.xxs },
  row: {
    display: 'flex',
    alignItems: 'center',
    gap: space.sm,
    height: size.row,
    paddingInline: space.sm,
    borderRadius: radius.sm,
    color: colors.text,
    textDecoration: 'none',
    backgroundColor: { default: 'transparent', ':hover': colors.hover },
  },
  projectRow: { height: '30px' },
  active: {
    backgroundColor: { default: colors.selected, ':hover': colors.selected },
    fontWeight: weight.medium,
  },
  rowIcon: { color: colors.muted },
  rowLabel: { flexGrow: 1 },
  sectionHead: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    height: '36px',
    marginTop: space.sm,
    paddingInline: space.sm,
    color: colors.faint,
  },
  addProject: {
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    width: '20px',
    height: '20px',
    padding: 0,
    borderWidth: 0,
    borderRadius: radius.inner,
    backgroundColor: { default: 'transparent', ':hover': colors.hover },
    color: colors.faint,
  },
  spacer: { flexGrow: 1 },
  plainButton: { width: '100%', borderWidth: 0, cursor: 'pointer' },
  projects: { display: 'flex', flexDirection: 'column', gap: space.xxs, flexGrow: 1, minHeight: 0, overflowY: 'auto' },
  empty: { paddingInline: space.sm, color: colors.faint },
  pausedName: { color: colors.muted },
  footerCollapsed: { paddingInline: 0 },
  footer: {
    display: 'flex',
    alignItems: 'center',
    gap: space.sm,
    height: '40px',
    paddingTop: space.sm,
    paddingInline: space.sm,
    borderTopWidth: '1px',
    borderTopStyle: 'solid',
    borderTopColor: colors.borderSoft,
  },
  account: {
    display: 'flex',
    alignItems: 'center',
    gap: space.sm,
    flexGrow: 1,
    minWidth: 0,
    height: size.row,
    paddingInline: space.xs,
    marginInlineStart: `calc(-1 * ${space.xs})`,
    borderWidth: 0,
    borderRadius: radius.sm,
    backgroundColor: { default: 'transparent', ':hover': colors.hover },
    color: colors.text,
    textAlign: 'start',
  },
  accountMenu: {
    display: 'flex',
    flexDirection: 'column',
    gap: space.md,
    padding: space.xs,
  },
  accountName: { display: 'flex', flexDirection: 'column' },
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
      <Icon name={icon} size={16} style={styles.rowIcon} />
      {!collapsed && <span {...stylex.props(styles.rowLabel)}>{label}</span>}
      {!collapsed && trailing}
    </Link>
  )
}

function ProjectTrailing({ project, pending }: { project: Project; pending: number }) {
  if (project.status === 'paused') return <Icon name="pause" size={14} label="Paused" style={styles.rowIcon} />
  if (pending > 0) return <Count value={pending} label={`${pending} waiting for your reply`} />
  if (project.agent.state === 'running') return <StatusDot tone="agent" label="Running" />
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
      {...stylex.props(text.small, styles.row, styles.projectRow, active && styles.active, focusRing.ring)}
    >
      <Avatar name={project.name} hue={project.hue} />
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
  const devices = useDevices()
  const projects = useProjects()
  const threads = useThreads()
  const inbox = useInbox()
  const { collapsed, signingOut, signOut } = useWorkspace()
  const { mode, setMode } = useTheme()

  const account = session.data?.account
  const pending = pendingInbox(inbox.data ?? [])
  const unread = liveThreads(threads.data ?? []).filter((item) => item.unread).length
  const visibleProjects = (projects.data ?? []).filter((item) => item.status !== 'archived')

  return (
    <nav aria-label="Workspace" {...stylex.props(styles.sidebar, collapsed && styles.sidebarCollapsed)}>
      <div {...stylex.props(styles.brand)}>
        <BrandMark />
        {!collapsed && <span {...stylex.props(text.bodyMedium, styles.brandName)}>Baton</span>}
        {!collapsed && <IconButton icon="pen" label="New chat" onClick={() => void navigate({ to: '/threads' })} />}
      </div>

      <div {...stylex.props(styles.nav)}>
        {collapsed && (
          <button
            type="button"
            aria-label="New chat"
            title="New chat"
            onClick={() => void navigate({ to: '/threads' })}
            {...stylex.props(styles.row, styles.plainButton, focusRing.ring)}
          >
            <Icon name="pen" size={16} style={styles.rowIcon} />
          </button>
        )}
        <NavRow
          to="/inbox"
          icon="inbox"
          label="Inbox"
          collapsed={collapsed}
          trailing={pending.length > 0 && <Count value={pending.length} />}
        />
        <NavRow
          to="/threads"
          icon="terminal"
          label="Threads"
          collapsed={collapsed}
          trailing={unread > 0 && <Count value={unread} quiet label={`${unread} unread`} />}
        />
        <NavRow
          to="/devices"
          icon="laptop"
          label="Devices"
          collapsed={collapsed}
          trailing={devices.data && <span {...stylex.props(text.caption, text.faint)}>{onlineSummary(devices.data)}</span>}
        />
      </div>

      {collapsed ? (
        <div {...stylex.props(styles.spacer)} />
      ) : (
        <ProjectList projects={visibleProjects} loaded={projects.data !== undefined} />
      )}

      {account && (
        <div {...stylex.props(styles.footer, collapsed && styles.footerCollapsed)}>
          <Menu
            side="top"
            trigger={
              <button
                type="button"
                aria-label={collapsed ? account.name : undefined}
                title={collapsed ? account.name : undefined}
                {...stylex.props(text.small, styles.account, focusRing.ring)}
              >
                <PersonAvatar name={account.name} />
                {!collapsed && <span {...stylex.props(text.truncate)}>{account.name}</span>}
              </button>
            }
          >
            <div {...stylex.props(styles.accountMenu)}>
              <div {...stylex.props(styles.accountName)}>
                <span {...stylex.props(text.label)}>{account.name}</span>
                <span {...stylex.props(text.caption, text.faint)}>{account.username}</span>
              </div>
              <Button small block onClick={signOut}>
                {signingOut ? 'Signing out…' : 'Sign out'}
              </Button>
            </div>
          </Menu>
          {!collapsed && (
            <Menu side="top" align="end" narrow trigger={<IconButton icon="settings" label="Settings" />}>
              <MenuHeading>Theme</MenuHeading>
              {(['system', 'light', 'dark'] as const).map((value) => (
                <MenuOption key={value} selected={mode === value} onSelect={() => setMode(value)}>
                  {themeLabels[value]}
                </MenuOption>
              ))}
              <MenuRule />
              <MenuOption onSelect={() => void navigate({ to: '/devices' })}>Devices</MenuOption>
            </Menu>
          )}
        </div>
      )}
    </nav>
  )
}

function ProjectList({ projects, loaded }: { projects: Project[]; loaded: boolean }) {
  const inbox = useInbox()
  return (
    <>
      <div {...stylex.props(styles.sectionHead)}>
        <span {...stylex.props(text.captionMedium)}>Projects</span>
        <button type="button" aria-label="New project" title="New project" {...stylex.props(styles.addProject, focusRing.ring)}>
          <Icon name="plus" size={14} />
        </button>
      </div>
      <div {...stylex.props(styles.projects)}>
        {loaded && projects.length === 0 && (
          <span {...stylex.props(text.caption, styles.empty)}>No projects yet</span>
        )}
        {projects.map((project) => (
          <ProjectRow key={project.id} project={project} pending={pendingInbox(inbox.data ?? [], project.id).length} />
        ))}
      </div>
    </>
  )
}
