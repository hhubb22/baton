import * as stylex from '@stylexjs/stylex'
import { useQuery } from '@tanstack/react-query'
import { useState } from 'react'
import { desktopErrorMessage, useLocalDesktop, type DesktopBridge } from '../data/desktop'
import { text } from '../theme/text'
import { colors, space } from '../theme/tokens.stylex'
import { Button } from '../ui/Button'

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
    <section aria-label="On this computer" {...stylex.props(styles.section)}>
      <h3 {...stylex.props(text.bodyMedium)}>On this computer</h3>
      {query.isPending && <span {...stylex.props(text.small, text.muted)}>Loading diagnostics…</span>}
      {query.isError && (
        <div {...stylex.props(styles.actions)}>
          <span role="alert" {...stylex.props(text.small, styles.error)}>
            Couldn't read diagnostics.
          </span>
          <Button small onClick={() => void query.refetch()}>
            Retry
          </Button>
        </div>
      )}
      {data && (
        <>
          <dl {...stylex.props(text.small, styles.facts)}>
            <dt {...stylex.props(text.caption, styles.label)}>Device service</dt>
            <dd {...stylex.props(styles.value)}>{external ? 'Managed by external service' : data.processState}</dd>
            {data.lastExit && (
              <>
                <dt {...stylex.props(text.caption, styles.label)}>Last exit</dt>
                <dd {...stylex.props(styles.value)}>
                  {data.lastExit.reason} ·{' '}
                  <time dateTime={data.lastExit.at}>
                    {new Date(data.lastExit.at).toLocaleString(undefined, { hour12: false })}
                  </time>
                </dd>
              </>
            )}
            <dt {...stylex.props(text.caption, styles.label)}>Versions</dt>
            <dd {...stylex.props(styles.value)}>
              Baton {data.clientVersion} · batond {data.batondVersion}
            </dd>
            <dt {...stylex.props(text.caption, styles.label)}>Platform</dt>
            <dd {...stylex.props(styles.value)}>{data.platform}</dd>
            {data.upgradePhase && (
              <>
                <dt {...stylex.props(text.caption, styles.label)}>Update</dt>
                <dd {...stylex.props(styles.value)}>{data.upgradePhase}</dd>
              </>
            )}
          </dl>
          <div aria-busy={pending !== null} {...stylex.props(styles.actions)}>
            {data.canRestart && !external && bridge.restartDaemon && (
              <Button small onClick={() => void run('restartDaemon')}>
                {pending === 'restartDaemon' ? 'Restarting…' : 'Restart device service'}
              </Button>
            )}
            {bridge.openLogs && (
              <Button small variant="ghost" onClick={() => void run('openLogs')}>
                Open logs folder
              </Button>
            )}
            {bridge.copyDiagnostics && (
              <Button small variant="ghost" onClick={() => void run('copyDiagnostics')}>
                {copied ? 'Summary copied' : 'Copy diagnostic summary'}
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
