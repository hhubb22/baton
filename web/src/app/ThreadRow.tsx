import * as stylex from '@stylexjs/stylex'
import { Link } from '@tanstack/react-router'
import { agentNames, folderName, threadView } from '../data/derive'
import type { Device, Thread } from '../data/types'
import { text } from '../theme/text'
import { semantic } from '../theme/semantic.stylex'
import { radius, size, space } from '../theme/tokens.stylex'
import { UnreadDot } from '../ui/Badge'
import { focusRing } from '../ui/Button'
import { StatusDot } from '../ui/Status'

const styles = stylex.create({
  row: {
    display: 'flex',
    alignItems: 'center',
    gap: space.sm,
    minHeight: size.comfortable,
    paddingInline: space.md,
    borderRadius: radius.md,
    color: semantic.foreground,
    textDecoration: 'none',
    backgroundColor: { default: 'transparent', ':hover': semantic.muted },
  },
  title: { flexGrow: 1 },
  folder: { color: semantic.faintForeground, flexShrink: 1 },
  meta: { color: semantic.mutedForeground, whiteSpace: 'nowrap' },
})

// Thread 行：状态点、名称、目录最后一段，右侧是设备 · Agent 和状态。
export function ThreadRow({ thread, device }: { thread: Thread; device: Device | undefined }) {
  const view = threadView(thread, device)
  return (
    <Link
      to="/threads/$threadId"
      params={{ threadId: thread.id }}
      {...stylex.props(text.small, styles.row, focusRing.ring)}
    >
      <StatusDot tone={view.status.tone} />
      <span {...stylex.props(styles.title, text.truncate)}>{thread.title}</span>
      {thread.unread && <UnreadDot />}
      <span {...stylex.props(text.caption, styles.folder, text.truncate)}>{folderName(thread.folder)}</span>
      <span {...stylex.props(text.caption, styles.meta)}>
        {device?.name ?? '已移除的设备'} · {thread.agent ? agentNames[thread.agent] : '命令'} · {view.status.label}
      </span>
    </Link>
  )
}
