import * as stylex from '@stylexjs/stylex'
import { Link, useLocation, useNavigate } from '@tanstack/react-router'
import { useState, type ReactNode } from 'react'
import { liveThreads } from '../data/derive'
import { useProjects, useSession, useThreads } from '../data/queries'
import type { Project } from '../data/types'
import { weight } from '../theme/base.stylex'
import { useTheme, type ThemeMode } from '../theme/ThemeProvider'
import { text } from '../theme/text'
import { semantic } from '../theme/semantic.stylex'
import { motion, radius, size, space } from '../theme/tokens.stylex'
import { Appear } from '../ui/motion'
import { Avatar, PersonAvatar } from '../ui/Avatar'
import { Count, UnreadDot } from '../ui/Badge'
import { focusRing, IconButton } from '../ui/Button'
import { Icon, type IconName } from '../ui/Icon'
import { Menu, MenuHeading, MenuOption, MenuRule } from '../ui/Menu'
import { Tooltip } from '../ui/Tooltip'
import { useWorkspace } from './workspace'

const styles = stylex.create({
  accountAvatar: { display: 'inline-flex', flexShrink: 0 },
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
  header: {
    display: 'flex',
    alignItems: 'center',
    flexShrink: 0,
    gap: space.xs,
    height: size.header,
    paddingInline: space.sm,
  },
  headerCollapsed: { paddingInline: space.xs },
  brand: { flexGrow: 1, minWidth: 0, overflow: 'hidden', whiteSpace: 'nowrap', color: semantic.foreground },
  nav: { display: 'flex', flexDirection: 'column', flexShrink: 0, gap: space.xxs, marginTop: space.xs },
  // 导航和账号的图标中心线距离侧栏左缘 26px，正好是 52px 收起宽度的中点，文字从 42px 开始。
  // 收起和展开时这些图标都不横向移动。
  row: {
    display: 'flex',
    alignItems: 'center',
    gap: '7px',
    height: size.control,
    paddingInlineStart: '9px',
    paddingInlineEnd: space.sm,
    borderRadius: radius.md,
    color: semantic.mutedForeground,
    fontWeight: weight.medium,
    lineHeight: 'normal',
    letterSpacing: 'normal',
    textDecoration: 'none',
    whiteSpace: 'nowrap',
    backgroundColor: { default: 'transparent', ':hover': semantic.muted },
  },
  projectRow: { height: size.row, gap: '6px', paddingInlineStart: space.sm },
  active: {
    backgroundColor: { default: semantic.muted, ':hover': semantic.muted },
    color: semantic.foreground,
    fontWeight: weight.medium,
  },
  rowIcon: { color: semantic.mutedForeground },
  rowLabel: { flexGrow: 1, minWidth: 0 },
  label: {
    opacity: 1,
    transition: `opacity ${motion.popover} ${motion.easeOut}`,
  },
  labelHidden: { opacity: 0, pointerEvents: 'none' },
  sectionHead: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    height: size.compact,
    marginTop: space.xl,
    paddingInline: space.sm,
    color: semantic.mutedForeground,
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
    backgroundColor: { default: 'transparent', ':hover': semantic.muted },
    color: semantic.faintForeground,
    opacity: { default: 0, ':focus-visible': 1, '@media (hover: none)': 1 },
    transition: `opacity ${motion.micro} ${motion.easeOut}`,
  },
  addProjectVisible: { opacity: 1 },
  projectArea: {
    display: 'flex',
    flexDirection: 'column',
    flexGrow: 1,
    minHeight: 0,
    overflow: 'hidden',
    opacity: 1,
    visibility: 'visible',
    transform: 'translateX(0)',
    transition: `opacity ${motion.popover} ${motion.easeOut}, transform ${motion.modal} ${motion.easeDrawer}, visibility 0s`,
  },
  projectAreaHidden: {
    opacity: 0,
    visibility: 'hidden',
    transform: 'translateX(-6px)',
    transition: `opacity ${motion.exit} ${motion.easeOut}, transform ${motion.exit} ${motion.easeOut}, visibility 0s ${motion.exit}`,
  },
  footer: { flexShrink: 0, marginTop: space.sm },
  projects: {
    display: 'flex',
    flexDirection: 'column',
    gap: space.xxs,
    marginTop: space.xs,
    flexGrow: 1,
    minHeight: 0,
    overflowY: 'auto',
  },
  empty: { paddingInline: space.sm, color: semantic.faintForeground },
  pausedName: { color: semantic.faintForeground },
  account: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'flex-start',
    gap: space.xs,
    width: '100%',
    minWidth: 0,
    height: '36px',
    paddingInlineStart: '6px',
    paddingInlineEnd: space.sm,
    borderWidth: 0,
    borderRadius: radius.md,
    backgroundColor: { default: 'transparent', ':hover': semantic.muted },
    color: semantic.foreground,
    textAlign: 'start',
  },
  accountMenu: {
    display: 'flex',
    flexDirection: 'column',
    gap: space.md,
    padding: space.xs,
  },
  accountName: { display: 'flex', flexDirection: 'column' },
  accountLabel: { flexGrow: 1, minWidth: 0, fontWeight: 550, lineHeight: '23px', letterSpacing: '-0.1px' },
  accountCaret: { color: semantic.faintForeground, transform: 'rotate(180deg)' },
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
    <Tooltip label={collapsed ? label : null} side="right">
      <Link
        to={to}
        aria-current={active ? 'page' : undefined}
        aria-label={collapsed ? label : undefined}
        {...stylex.props(text.small, styles.row, active && styles.active, focusRing.ring)}
      >
        <Icon name={icon} size={18} style={styles.rowIcon} />
        <span
          aria-hidden={collapsed || undefined}
          {...stylex.props(styles.rowLabel, styles.label, collapsed && styles.labelHidden)}
        >
          {label}
        </span>
        {!collapsed && trailing}
      </Link>
    </Tooltip>
  )
}

function ProjectTrailing({ project }: { project: Project }) {
  return (
    <Appear when={project.latestReplySeq > project.readReplySeq}>
      <UnreadDot />
    </Appear>
  )
}

function ProjectRow({ project }: { project: Project }) {
  const { pathname } = useLocation()
  const active = pathname === `/projects/${project.id}`
  return (
    <Tooltip label={project.status === 'paused' ? '已暂停' : null} side="right">
      <Link
        to="/projects/$projectId"
        params={{ projectId: project.id }}
        aria-current={active ? 'page' : undefined}
        aria-label={project.status === 'paused' ? `${project.name}，已暂停` : undefined}
        {...stylex.props(text.small, styles.row, styles.projectRow, active && styles.active, focusRing.ring)}
      >
        <Avatar name={project.name} hue={project.hue} emoji={project.emoji} small />
        <span {...stylex.props(styles.rowLabel, text.truncate, project.status === 'paused' && styles.pausedName)}>
          {project.name}
        </span>
        <ProjectTrailing project={project} />
      </Link>
    </Tooltip>
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
    <nav aria-label="工作区" {...stylex.props(styles.sidebar)}>
      <div {...stylex.props(styles.header, collapsed && styles.headerCollapsed)}>
        {!collapsed && <span {...stylex.props(text.label, styles.brand)}>Baton</span>}
        <IconButton
          icon="sidebar"
          iconSize={18}
          label={collapsed ? '展开侧栏' : '收起侧栏'}
          aria-expanded={!collapsed}
          onClick={toggleSidebar}
        />
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
      <div
        inert={collapsed || undefined}
        aria-hidden={collapsed || undefined}
        {...stylex.props(styles.projectArea, collapsed && styles.projectAreaHidden)}
      >
        <ProjectList projects={visibleProjects} loaded={projects.data !== undefined} unavailable={projects.isError} />
      </div>
      <div {...stylex.props(styles.footer)}>
        {account && (
          <Menu
            width="trigger"
            side="top"
            trigger={
              <button
                type="button"
                aria-label={account.name}
                {...stylex.props(text.small, styles.account, focusRing.ring)}
              >
                <Tooltip label={collapsed ? account.name : null} side="right">
                  <span {...stylex.props(styles.accountAvatar)}>
                    <PersonAvatar name={account.name} />
                  </span>
                </Tooltip>
                <span
                  aria-hidden={collapsed || undefined}
                  {...stylex.props(text.truncate, styles.accountLabel, styles.label, collapsed && styles.labelHidden)}
                >
                  {account.name}
                </span>
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
