import * as stylex from '@stylexjs/stylex'
import type { ReactNode } from 'react'
import { text } from '../theme/text'
import { colors, radius, size, space } from '../theme/tokens.stylex'
import { IconButton } from '../ui/Button'
import { useWorkspace } from './workspace'

// 工作区里浮在玻璃背景上的卡片：主内容和 Thread 详情面板共用。
export const pane = stylex.create({
  card: {
    overflow: 'hidden',
    borderWidth: '1px',
    borderStyle: 'solid',
    borderColor: colors.hairline,
    borderRadius: radius.lg,
    boxShadow: `0 1px 3px ${colors.shadowNear}, 0 12px 40px ${colors.shadowFar}`,
  },
})

const styles = stylex.create({
  page: {
    display: 'flex',
    flexDirection: 'column',
    flexGrow: 1,
    minWidth: 0,
    height: '100%',
    backgroundColor: colors.canvas,
  },
  header: {
    display: 'flex',
    alignItems: 'center',
    gap: space.md,
    flexShrink: 0,
    height: size.header,
    paddingInline: '20px',
    borderBottomWidth: '1px',
    borderBottomStyle: 'solid',
    borderBottomColor: colors.borderSoft,
  },
  title: { flexGrow: 1 },
  body: { flexGrow: 1, minHeight: 0, overflowY: 'auto' },
  column: {
    display: 'flex',
    flexDirection: 'column',
    gap: space.lg,
    width: '100%',
    maxWidth: size.measure,
    marginInline: 'auto',
    paddingBlock: space.xl,
    paddingInline: space.xl,
  },
})

// 工作区里的主内容卡片：48px 标题栏，最左边是收起或展开侧栏的按钮，下面是可滚动的内容。
export function Page({ title, actions, children }: { title: ReactNode; actions?: ReactNode; children: ReactNode }) {
  const { collapsed, toggleSidebar } = useWorkspace()
  return (
    <section {...stylex.props(styles.page, pane.card)}>
      <header {...stylex.props(styles.header)}>
        <IconButton
          icon={collapsed ? 'chevron-right' : 'chevron-left'}
          label={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
          aria-expanded={!collapsed}
          onClick={toggleSidebar}
        />
        <h1 {...stylex.props(text.bodyMedium, styles.title, text.truncate)}>{title}</h1>
        {actions}
      </header>
      <div {...stylex.props(styles.body)}>{children}</div>
    </section>
  )
}

// 内容列最宽 720px，与主对话同宽。
export function Column({ children }: { children: ReactNode }) {
  return <div {...stylex.props(styles.column)}>{children}</div>
}
