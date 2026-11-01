import * as stylex from '@stylexjs/stylex'
import { useEffect, useState } from 'react'
import { text } from '../theme/text'
import { semantic } from '../theme/semantic.stylex'
import { radius, space } from '../theme/tokens.stylex'
import { focusRing } from '../ui/Button'
import { Icon } from '../ui/Icon'
import { Swap } from '../ui/motion'
import { Tooltip } from '../ui/Tooltip'
import { copyText } from './SelectionMenu'
import './message-actions.css'

const styles = stylex.create({
  button: {
    display: 'inline-flex',
    alignItems: 'center',
    alignSelf: 'flex-start',
    gap: space.xs,
    paddingBlock: space.xs,
    paddingInline: space.xs,
    borderWidth: 0,
    borderRadius: radius.sm,
    backgroundColor: { default: 'transparent', ':hover': semantic.muted },
    color: { default: semantic.faintForeground, ':hover': semantic.foreground },
  },
  projectButton: { width: '30px', height: '30px', marginLeft: '-7px', justifyContent: 'center' },
})

export function MessageActions({ body, thread = false }: { body: string; thread?: boolean }) {
  const [status, setStatus] = useState<'copied' | 'error' | null>(null)
  useEffect(() => {
    if (!status) return
    const timer = window.setTimeout(() => setStatus(null), 2000)
    return () => window.clearTimeout(timer)
  }, [status])
  return thread ? (
    <div className="thread-reply-actions">
      <Tooltip label={status === 'copied' ? '已复制回复' : '复制回复'}>
        <button
          type="button"
          aria-label={status === 'copied' ? '已复制回复' : '复制回复'}
          onClick={() =>
            void copyText(body).then(
              () => setStatus('copied'),
              () => setStatus('error'),
            )
          }
          {...stylex.props(text.caption, styles.button, focusRing.ring)}
        >
          <Swap value={status === 'copied' ? 'check' : 'copy'}>
            <Icon name={status === 'copied' ? 'check' : 'copy'} size={14} />
          </Swap>
        </button>
      </Tooltip>
      {status && (
        <span role="status" {...stylex.props(text.caption)}>
          {status === 'copied' ? '已复制' : '复制失败'}
        </span>
      )}
    </div>
  ) : (
    <Tooltip label={status === 'copied' ? '已复制回复' : '复制回复'}>
      <button
        type="button"
        aria-label={status === 'copied' ? '已复制回复' : '复制回复'}
        onClick={() =>
          void copyText(body).then(
            () => setStatus('copied'),
            () => setStatus('error'),
          )
        }
        {...stylex.props(text.caption, styles.button, styles.projectButton, focusRing.ring)}
      >
        <Swap value={status === 'copied' ? 'check' : 'copy'}>
          <Icon name={status === 'copied' ? 'check' : 'copy'} size={16} />
        </Swap>
        {status === 'error' && <span role="status">复制失败</span>}
      </button>
    </Tooltip>
  )
}
