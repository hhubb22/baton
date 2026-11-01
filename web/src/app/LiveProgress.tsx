import * as stylex from '@stylexjs/stylex'
import { useEffect, useState, type ReactNode } from 'react'
import { live } from '../theme/motion'
import { semantic } from '../theme/semantic.stylex'
import { space } from '../theme/tokens.stylex'
import { useNow } from './useNow'

const quietAfterMs = 30_000

const styles = stylex.create({
  root: { display: 'inline-flex', alignItems: 'baseline', flexWrap: 'wrap', columnGap: space.sm, minWidth: 0 },
  quiet: { color: semantic.faintForeground, fontVariantNumeric: 'tabular-nums' },
})

// signal 持续不变的秒数，不到阈值时为 null。signal 取浏览器收到的步骤数和输出量，能反映整条链路是否还有新事件到达。
export function useQuietSeconds(signal: string | number, active: boolean, thresholdMs = quietAfterMs) {
  const now = useNow(active ? 1000 : null)
  const [changedAt, setChangedAt] = useState(now)
  const [previous, setPrevious] = useState({ signal, active })
  if (previous.signal !== signal || previous.active !== active) {
    setPrevious({ signal, active })
    setChangedAt(now)
  }
  const quietMs = Math.max(0, now - changedAt)
  return active && quietMs >= thresholdMs ? Math.floor(quietMs / 1000) : null
}

// 步骤成批到达时逐条显示，每条至少隔 intervalMs。积压超过 maxBehind 条时跳过中间的，不让显示越落越远。第一批直接显示全部。
export function usePacedCount(target: number, intervalMs = 700, maxBehind = 4) {
  const [shown, setShown] = useState(target)
  if (shown > target || (shown === 0 && target > 0)) setShown(target)
  useEffect(() => {
    if (shown >= target) return
    const timer = window.setTimeout(() => setShown(Math.max(shown + 1, target - maxBehind)), intervalMs)
    return () => window.clearTimeout(timer)
  }, [shown, target, intervalMs, maxBehind])
  return Math.min(shown, target)
}

export function quietLabel(seconds: number) {
  if (seconds < 60) return `${seconds} 秒没有新进展`
  const rest = seconds % 60
  return `${Math.floor(seconds / 60)} 分 ${String(rest).padStart(2, '0')} 秒没有新进展`
}

// 进行中的文字：有新事件时走微光，长时间没有新事件时微光停下。折叠标题和当前步骤放在同一个 Shimmer 里，光带连续扫过。
export function Shimmer({ active, children }: { active: boolean; children: ReactNode }) {
  return <span {...stylex.props(active && live.shimmer)}>{children}</span>
}

export function QuietNote({ seconds }: { seconds: number | null }) {
  return seconds === null ? null : <span {...stylex.props(styles.quiet)}>{quietLabel(seconds)}</span>
}

// 进行中的那一步：微光停下后，后面显示等了多久。
export function LiveLabel({ label, quietSeconds }: { label: ReactNode; quietSeconds: number | null }) {
  return (
    <span {...stylex.props(styles.root)}>
      <Shimmer active={quietSeconds === null}>{label}</Shimmer>
      <QuietNote seconds={quietSeconds} />
    </span>
  )
}
