import * as stylex from '@stylexjs/stylex'
import { previewProblem } from '../data/derive'
import { useDevices, useFile } from '../data/queries'
import type { ID } from '../data/types'
import { text } from '../theme/text'
import { colors, size, space } from '../theme/tokens.stylex'
import { Banner } from '../ui/Banner'
import { Button, IconButton } from '../ui/Button'

const styles = stylex.create({
  panel: {
    display: 'flex',
    flexDirection: 'column',
    flexShrink: 0,
    width: '420px',
    minWidth: 0,
    borderLeftWidth: '1px',
    borderLeftStyle: 'solid',
    borderLeftColor: colors.borderSoft,
    backgroundColor: colors.surface,
  },
  header: {
    display: 'flex',
    alignItems: 'center',
    gap: space.sm,
    height: size.header,
    paddingInline: space.md,
    borderBottomWidth: '1px',
    borderBottomStyle: 'solid',
    borderBottomColor: colors.borderSoft,
  },
  path: { flexGrow: 1 },
  body: { flexGrow: 1, minHeight: 0, overflow: 'auto', padding: space.md },
  code: { margin: 0, whiteSpace: 'pre-wrap', wordBreak: 'break-word' },
})

// 文件预览每次都向设备读取，设备离线或路径不可读时只显示原因，不显示旧内容。
export function FilePreview({ deviceId, path, onClose }: { deviceId: ID; path: string; onClose: () => void }) {
  const file = useFile(deviceId, path)
  const devices = useDevices()
  const device = devices.data?.find((item) => item.id === deviceId)
  const problem = file.data ? previewProblem(file.data, device) : null

  return (
    <aside aria-label="File preview" {...stylex.props(styles.panel)}>
      <div {...stylex.props(styles.header)}>
        <span title={path} {...stylex.props(text.mono, styles.path, text.truncate)}>
          {path}
        </span>
        <IconButton icon="close" label="Close preview" onClick={onClose} />
      </div>
      <div {...stylex.props(styles.body)}>
        {file.isPending && <p {...stylex.props(text.caption, text.faint)}>Loading…</p>}
        {problem && (
          <Banner
            icon="offline"
            title={problem.title}
            detail={problem.detail}
            action={
              <Button small onClick={() => void file.refetch()}>
                Retry
              </Button>
            }
          />
        )}
        {file.data?.state === 'ready' && <pre {...stylex.props(text.mono, styles.code)}>{file.data.content}</pre>}
      </div>
    </aside>
  )
}
