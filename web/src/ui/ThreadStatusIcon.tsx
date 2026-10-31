import * as stylex from '@stylexjs/stylex'
import { semantic } from '../theme/semantic.stylex'
import { Icon } from './Icon'

export type ThreadStatus = 'running' | 'attention' | 'stopped' | 'waiting' | 'idle' | 'archived'

const chase = stylex.keyframes({
  from: { opacity: 1 },
  to: { opacity: 0.2 },
})

const styles = stylex.create({
  root: { display: 'block', flexShrink: 0 },
  running: { color: semantic.agentForeground },
  attention: { color: semantic.warningForeground },
  stopped: { color: semantic.mutedForeground },
  waiting: { color: semantic.mutedForeground },
  idle: { color: semantic.faintForeground },
  archived: { display: 'inline-flex', color: semantic.mutedForeground },
  pixel: {
    animationName: { default: chase, '@media (prefers-reduced-motion: reduce)': 'none' },
    animationDuration: '800ms',
    animationTimingFunction: 'steps(4)',
    animationIterationCount: 'infinite',
  },
  mark: { fill: semantic.background },
})

// 3×3 像素环的外圈，按顺时针排列
const pixels = [
  [1, 1],
  [6, 1],
  [11, 1],
  [11, 6],
  [11, 11],
  [6, 11],
  [1, 11],
  [1, 6],
] as const

// 同一系列的 16px 状态图标：圆的画法表示状态，只有运行中和需要处理带颜色。
export function ThreadStatusIcon({ status, label }: { status: ThreadStatus; label?: string }) {
  if (status === 'archived') {
    return (
      <span role={label ? 'img' : undefined} aria-label={label} {...stylex.props(styles.archived)}>
        <Icon name="archive" size={16} />
      </span>
    )
  }
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 16 16"
      fill="none"
      role={label ? 'img' : undefined}
      aria-label={label}
      aria-hidden={label ? undefined : true}
      {...stylex.props(styles.root, styles[status])}
    >
      {status === 'running' &&
        pixels.map(([x, y], index) => (
          <rect
            key={`${x}-${y}`}
            x={x}
            y={y}
            width="4"
            height="4"
            fill="currentColor"
            // 负延迟让每个像素从不同相位开始，加载后立刻形成追逐效果
            style={{ animationDelay: `${(index - pixels.length) * 100}ms` }}
            {...stylex.props(styles.pixel)}
          />
        ))}
      {status === 'attention' && (
        <>
          <circle cx="8" cy="8" r="7" fill="currentColor" />
          <rect x="7.1" y="3.8" width="1.8" height="5.2" rx="0.9" {...stylex.props(styles.mark)} />
          <circle cx="8" cy="11.2" r="1.05" {...stylex.props(styles.mark)} />
        </>
      )}
      {status === 'stopped' && (
        <>
          <circle cx="8" cy="8" r="7" fill="currentColor" />
          <rect x="4.5" y="7.1" width="7" height="1.8" rx="0.9" {...stylex.props(styles.mark)} />
        </>
      )}
      {status === 'waiting' && (
        <circle cx="8" cy="8" r="6.25" stroke="currentColor" strokeWidth="1.5" strokeDasharray="2.6 2.31" />
      )}
      {status === 'idle' && <circle cx="8" cy="8" r="6.5" stroke="currentColor" strokeOpacity="0.7" />}
    </svg>
  )
}
