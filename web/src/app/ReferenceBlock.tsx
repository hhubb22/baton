import * as stylex from '@stylexjs/stylex'
import { fileSize, referenceLimit } from '../data/derive'
import { useDevices, useThreads } from '../data/queries'
import type { Reference } from '../data/types'
import { fonts } from '../theme/base.stylex'
import { text } from '../theme/text'
import { colors, radius, space } from '../theme/tokens.stylex'
import { IconButton } from '../ui/Button'
import { Icon } from '../ui/Icon'

const styles = stylex.create({
  block: {
    display: 'flex',
    flexDirection: 'column',
    gap: space.xs,
    minWidth: 0,
    margin: 0,
    paddingBlock: space.sm,
    paddingInline: space.md,
    borderLeftWidth: '2px',
    borderLeftStyle: 'solid',
    borderLeftColor: colors.border,
    borderRadius: radius.sm,
    backgroundColor: colors.subtle,
  },
  inBubble: { backgroundColor: colors.surface },
  head: { display: 'flex', alignItems: 'center', gap: '6px', minWidth: 0 },
  icon: { flexShrink: 0, color: colors.muted },
  title: { flexGrow: 1 },
  meta: { color: colors.muted },
  path: { color: colors.muted, overflowWrap: 'anywhere' },
  excerpt: {
    margin: 0,
    maxHeight: '96px',
    overflow: 'hidden',
    fontFamily: fonts.mono,
    fontSize: '12px',
    lineHeight: 1.55,
    whiteSpace: 'pre-wrap',
    wordBreak: 'break-word',
  },
  note: { color: colors.faint },
})

function lineRange(lines: Reference['lines']) {
  if (!lines) return null
  return lines.from === lines.to ? `Line ${lines.from}` : `Lines ${lines.from}—${lines.to}`
}

// 选中内容的引用：来源、摘录，以及超过 8 KB 时只带开头的说明。输入区和已发送的消息共用。
export function ReferenceBlock({ reference, onRemove }: { reference: Reference; onRemove?: () => void }) {
  const devices = useDevices()
  const threads = useThreads()
  const device = devices.data?.find((item) => item.id === reference.deviceId)
  const thread = threads.data?.find((item) => item.id === reference.threadId)
  const deviceName = reference.deviceId ? (device?.name ?? 'Removed device') : null
  const reply = reference.reply !== null ? `Reply ${reference.reply}` : reference.threadId ? 'Earlier history' : null

  let meta: string[]
  switch (reference.kind) {
    case 'thread':
      meta = [reply, deviceName].filter((item): item is string => item !== null)
      break
    case 'file':
      meta = [thread?.title ?? null, reply, deviceName].filter((item): item is string => item !== null)
      break
    case 'item':
      meta = [`Question ${reference.itemId}`]
      break
  }
  const icon = reference.kind === 'file' ? 'file' : reference.kind === 'item' ? 'inbox' : 'message'

  return (
    <figure
      aria-label={`Reference from ${reference.title}`}
      {...stylex.props(styles.block, !onRemove && styles.inBubble)}
    >
      <div {...stylex.props(styles.head)}>
        <span {...stylex.props(styles.icon)}>
          <Icon name={icon} size={12} />
        </span>
        <span {...stylex.props(text.captionMedium, styles.title, text.truncate)}>From {reference.title}</span>
        {onRemove && <IconButton icon="close" label="Remove reference" onClick={onRemove} />}
      </div>
      {meta.length > 0 && <span {...stylex.props(text.caption, styles.meta)}>{meta.join(' · ')}</span>}
      {reference.path && (
        <span {...stylex.props(text.caption, styles.path)}>
          <code {...stylex.props(text.mono)}>{reference.path}</code>
          {reference.lines && ` · ${lineRange(reference.lines)}`}
        </span>
      )}
      <pre {...stylex.props(styles.excerpt)}>{reference.excerpt}</pre>
      {reference.bytes > referenceLimit && (
        <span {...stylex.props(text.caption, styles.note)}>
          Showing the first {fileSize(referenceLimit)} of {fileSize(reference.bytes)} selected.
        </span>
      )}
    </figure>
  )
}
