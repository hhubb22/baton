import * as stylex from '@stylexjs/stylex'
import { useQuery } from '@tanstack/react-query'
import { useState } from 'react'
import { desktopErrorMessage, useLocalDesktop, type DesktopBridge } from '../data/desktop'
import { text } from '../theme/text'
import { colors, space } from '../theme/tokens.stylex'
import { Button } from '../ui/Button'

const stateLabels: Record<string, string> = {
  unregistered: '未连接',
  stopped: '已停止',
  connecting: '正在连接',
  restarting: '正在重新连接',
  rejected: '连接被拒绝',
  external: '由外部服务管理',
  stopping: '正在停止',
  online: '在线',
  draining: '等待任务结束',
  ready: '准备就绪',
  migrating: '正在升级',
  syncing: '正在同步',
  completed: '已完成',
  cancelled: '已取消',
  failed: '失败',
}
const stateLabel = (state: string) => (Object.hasOwn(stateLabels, state) ? stateLabels[state]! : state)

const styles = stylex.create({
  section: { display: 'flex', flexDirection: 'column', gap: space.md },
  facts: { display: 'grid', gridTemplateColumns: '148px minmax(0, 1fr)', gap: '12px 20px', margin: 0 },
  label: { color: colors.muted },
  value: { margin: 0, overflowWrap: 'anywhere' },
  actions: { display: 'flex', alignItems: 'center', flexWrap: 'wrap', gap: space.sm },
  error: { color: colors.danger },
})

export function LocalDeviceDiagnostics({ nodeId }: { nodeId: string }) {
  const { bridge, status } = useLocalDesktop(nodeId, 'diagnostics')
  if (!bridge?.diagnostics || !status?.registered) return null
  return <Diagnostics key={nodeId} nodeId={nodeId} bridge={bridge} state={status.state} />
}

function Diagnostics({ nodeId, bridge, state }: { nodeId: string; bridge: DesktopBridge; state: string }) {
  const query = useQuery({
    queryKey: ['desktop', 'diagnostics', nodeId, state],
    queryFn: () => bridge.diagnostics!({ nodeId }),
    refetchOnMount: 'always',
    refetchInterval: 5000,
  })
  const [pending, setPending] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [copied, setCopied] = useState(false)
  const run = async (action: 'restartDaemon' | 'openLogs' | 'copyDiagnostics') => {
    if (pending || !bridge[action]) return
    setPending(action)
    setError(null)
    try {
      await bridge[action]!({ nodeId })
      if (action === 'copyDiagnostics') setCopied(true)
      if (action === 'restartDaemon') await query.refetch()
    } catch (cause) {
      setError(desktopErrorMessage(cause))
    } finally {
      setPending(null)
    }
  }
  const data = query.data
  const external = state === 'external' || data?.processState === 'external'
  return (
    <section aria-label="本机诊断" {...stylex.props(styles.section)}>
      <h3 {...stylex.props(text.bodyMedium)}>本机诊断</h3>
      {query.isPending && <span {...stylex.props(text.small, text.muted)}>正在加载诊断信息…</span>}
      {query.isError && (
        <div {...stylex.props(styles.actions)}>
          <span role="alert" {...stylex.props(text.small, styles.error)}>
            无法读取诊断信息。
          </span>
          <Button small onClick={() => void query.refetch()}>
            重试
          </Button>
        </div>
      )}
      {data && (
        <>
          <dl {...stylex.props(text.small, styles.facts)}>
            <dt {...stylex.props(text.caption, styles.label)}>设备服务</dt>
            <dd {...stylex.props(styles.value)}>{external ? '由外部服务管理' : stateLabel(data.processState)}</dd>
            {data.lastExit && (
              <>
                <dt {...stylex.props(text.caption, styles.label)}>上次退出</dt>
                <dd {...stylex.props(styles.value)}>
                  {data.lastExit.reason} ·{' '}
                  <time dateTime={data.lastExit.at}>
                    {new Date(data.lastExit.at).toLocaleString('zh-CN', { hour12: false })}
                  </time>
                </dd>
              </>
            )}
            <dt {...stylex.props(text.caption, styles.label)}>版本</dt>
            <dd {...stylex.props(styles.value)}>
              Baton {data.clientVersion} · batond {data.batondVersion}
            </dd>
            <dt {...stylex.props(text.caption, styles.label)}>平台</dt>
            <dd {...stylex.props(styles.value)}>{data.platform}</dd>
            {data.upgradePhase && (
              <>
                <dt {...stylex.props(text.caption, styles.label)}>更新</dt>
                <dd {...stylex.props(styles.value)}>{stateLabel(data.upgradePhase)}</dd>
              </>
            )}
          </dl>
          <div aria-busy={pending !== null} {...stylex.props(styles.actions)}>
            {data.canRestart && !external && bridge.restartDaemon && (
              <Button small onClick={() => void run('restartDaemon')}>
                {pending === 'restartDaemon' ? '正在重启…' : '重启设备服务'}
              </Button>
            )}
            {bridge.openLogs && (
              <Button small variant="ghost" onClick={() => void run('openLogs')}>
                打开日志文件夹
              </Button>
            )}
            {bridge.copyDiagnostics && (
              <Button small variant="ghost" onClick={() => void run('copyDiagnostics')}>
                {copied ? '诊断摘要已复制' : '复制诊断摘要'}
              </Button>
            )}
          </div>
        </>
      )}
      {error && (
        <span role="alert" {...stylex.props(text.small, styles.error)}>
          {error}
        </span>
      )}
    </section>
  )
}
