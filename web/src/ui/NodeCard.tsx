import { useState } from 'react'
import { formatReportTime, revocationLabel, roleLabel } from '../model.ts'
import type { NodeStatus } from '../types.ts'

type Props = {
  node: NodeStatus
  notice: string
  canWrite: boolean
  busy: boolean
  onRevoke: (nodeId: string) => void
}

export function NodeCard({ node, notice, canWrite, busy, onRevoke }: Props) {
  const [confirming, setConfirming] = useState(false)
  const caps = node.capabilities.length === 0 ? ['未报告能力'] : node.capabilities

  return (
    <article className="card" data-testid="node-card" data-node-id={node.id} data-display-name={node.display_name}>
      <header className="card-title">
        <h3>{node.display_name}</h3>
        <span className={node.online ? 'badge badge-online' : 'badge badge-offline'} data-testid="node-presence">
          {node.online ? '在线' : '离线'}
        </span>
      </header>
      <p className="meta">{roleLabel(node.role)} · {node.system} · 序号 {node.registration_seq}</p>
      <p className="meta">节点 {node.id}</p>
      <p data-testid="node-last-contact">最后报告于 {formatReportTime(node.last_contact_at)}</p>
      <p data-testid="node-status-updated">状态更新于 {formatReportTime(node.status_updated_at)}</p>
      {!node.online ? <p className="hint">这是中心保存的最后一次报告，不代表节点现在仍在线。</p> : null}
      <p data-testid="node-sync">{node.synced ? '已同步' : '尚未同步'}</p>
      <p data-testid="node-executable">{node.executable ? '可执行' : '不可执行'}</p>
      <p>能力</p>
      <ul data-testid="node-capabilities">
        {caps.map((name) => <li key={name}>{name}</li>)}
      </ul>
      {node.revocation_status === 'none' ? (
        confirming ? (
          <div className="confirm">
            <p>确认吊销 {node.display_name} 的连接凭据？提交后的状态以服务端响应为准。</p>
            <p>{notice}</p>
            <div className="actions">
              <button
                data-testid="revoke-confirm"
                type="button"
                className="danger"
                disabled={!canWrite || busy}
                onClick={() => onRevoke(node.id)}
              >
                {busy ? '正在提交' : '确认吊销'}
              </button>
              <button type="button" disabled={busy} onClick={() => setConfirming(false)}>取消</button>
            </div>
          </div>
        ) : (
          <button
            data-testid="revoke-open"
            type="button"
            className="danger"
            disabled={!canWrite || busy}
            onClick={() => setConfirming(true)}
          >
            吊销连接凭据
          </button>
        )
      ) : (
        <div
          data-testid="revoke-status"
          data-status={node.revocation_status}
          role="status"
          className={node.revocation_status === 'effective' ? 'status-effective' : 'status-pending'}
        >
          <p>{revocationLabel(node.revocation_status)}</p>
          {node.revocation?.message ? <p>{node.revocation.message}</p> : null}
          {node.revocation?.local_process_notice ? <p>{node.revocation.local_process_notice}</p> : null}
          {node.revocation_status === 'pending' ? <p>尚未回执</p> : null}
          {node.revocation?.applied_at ? <p>生效时间 {formatReportTime(node.revocation.applied_at)}</p> : null}
        </div>
      )}
    </article>
  )
}
