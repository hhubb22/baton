import * as stylex from '@stylexjs/stylex'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'
import { readExecutionFullOutput } from '../data/http/full-output'
import { keys, useClient, useDevices } from '../data/queries'
import type { Execution } from '../data/types'
import { text } from '../theme/text'
import { space } from '../theme/tokens.stylex'
import { Button } from '../ui/Button'
import { FullOutput } from './FullOutput'

const styles = stylex.create({
  root: { display: 'flex', flexDirection: 'column', gap: space.md, padding: space.lg, overflowY: 'auto' },
  output: { whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' },
})

export const executionStatus: Record<Execution['status'], string> = {
  pending: '等待执行',
  running: '运行中',
  completed: '已完成',
  failed: '失败',
  cancelled: '已停止',
  timed_out: '已超时',
  unknown: '结果未知',
}

export function ExecutionDetail({ id, projectId, onClose }: { id: string; projectId: string; onClose: () => void }) {
  const client = useClient()
  const queryClient = useQueryClient()
  const devices = useDevices()
  const [error, setError] = useState<string | null>(null)
  const [stopping, setStopping] = useState(false)
  const query = useQuery({
    queryKey: ['execution', id],
    queryFn: () => client.getExecution!(id),
    enabled: !!client.getExecution,
    refetchInterval: 2000,
  })
  const execution = query.data
  async function stop() {
    if (!client.stopExecution || stopping) return
    setStopping(true)
    setError(null)
    try {
      const result = await client.stopExecution(id)
      queryClient.setQueryData(['execution', id], result)
      await queryClient.invalidateQueries({ queryKey: keys.executions(projectId) })
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '无法停止执行，请重试。')
    } finally {
      setStopping(false)
    }
  }
  return (
    <aside aria-label="执行详情" {...stylex.props(styles.root)}>
      <Button small onClick={onClose}>
        返回
      </Button>
      {!execution && <p>{query.isError ? '无法加载执行详情。' : '正在加载执行详情…'}</p>}
      {execution && (
        <>
          <h2 {...stylex.props(text.label)}>执行详情</h2>
          <p>
            {executionStatus[execution.status]}
            {execution.stopRequestedAt ? ' · 正在停止' : ''}
          </p>
          <pre {...stylex.props(styles.output)}>{execution.command}</pre>
          <p>{devices.data?.find((device) => device.id === execution.deviceId)?.name ?? execution.deviceId}</p>
          <p>{execution.workingDirectory}</p>
          {execution.exitCode != null && <p>退出码 {execution.exitCode}</p>}
          {execution.reason && <p>{execution.reason}</p>}
          {execution.output && <pre {...stylex.props(styles.output)}>{execution.output}</pre>}
          {execution.encoding === 'base64' && <p>输出为 Base64 编码。</p>}
          {execution.fullOutput && (
            <FullOutput threadId={execution.id} reference={execution.fullOutput} reader={readExecutionFullOutput} />
          )}
          {(execution.status === 'pending' || execution.status === 'running') && !execution.stopRequestedAt && (
            <Button onClick={() => void stop()} disabled={stopping}>
              {stopping ? '正在停止…' : '停止执行'}
            </Button>
          )}
          {error && <p role="alert">{error}</p>}
        </>
      )}
    </aside>
  )
}
