import type { Employee, Enrollment, FileQuery, FileView, NodeList, SavedDefault } from '../types.ts'
import { DefaultDeviceForm } from './DefaultDeviceForm.tsx'
import { EnrollmentPanel } from './EnrollmentPanel.tsx'
import { NodeCard } from './NodeCard.tsx'

type Props = {
  employee: Employee
  csrf: string
  list: NodeList | null
  saved: SavedDefault | null
  enrollment: Enrollment | null
  busy: boolean
  error: string
  origin: string
  onRefresh: () => void
  onLogout: () => void
  onRelogin: () => void
  onIssue: () => void
  onDismissEnrollment: () => void
  onSaveDefault: (nodeId: string) => void
  onRevoke: (nodeId: string) => void
  loadFiles: (nodeId: string, query: FileQuery) => Promise<FileView>
}

export function NodesPage({
  employee,
  csrf,
  list,
  saved,
  enrollment,
  busy,
  error,
  origin,
  onRefresh,
  onLogout,
  onRelogin,
  onIssue,
  onDismissEnrollment,
  onSaveDefault,
  onRevoke,
  loadFiles,
}: Props) {
  const canWrite = csrf !== ''
  return (
    <>
      <header className="top">
        <div>
          <h1>Baton</h1>
          <p data-testid="current-user">{employee.display_name}（{employee.username}）</p>
        </div>
        {canWrite ? (
          <button data-testid="logout" type="button" onClick={onLogout} disabled={busy}>退出</button>
        ) : (
          <button data-testid="relogin" type="button" onClick={onRelogin}>重新登录</button>
        )}
      </header>
      {!canWrite ? (
        <p className="error" role="alert">这个标签页没有 CSRF 令牌，不能修改或退出。请重新登录后再操作。</p>
      ) : null}
      {error ? <p className="error" role="alert" data-testid="page-error">{error}</p> : null}
      <EnrollmentPanel
        enrollment={enrollment}
        origin={origin}
        busy={busy}
        canWrite={canWrite}
        onIssue={onIssue}
        onDismiss={onDismissEnrollment}
      />
      <section className="card">
        <div className="card-title">
          <h2>我的节点</h2>
          <button data-testid="refresh-nodes" type="button" onClick={onRefresh} disabled={busy}>刷新</button>
        </div>
        {list ? <p data-testid="local-process-notice">{list.local_process_notice}</p> : <p>正在读取节点。</p>}
        <div data-testid="node-list">
          {list && list.nodes.length === 0 ? <p>还没有节点。</p> : null}
          {list?.nodes.map((node) => (
            <NodeCard
              key={node.id}
              node={node}
              notice={list.local_process_notice}
              canWrite={canWrite}
              busy={busy}
              onRevoke={onRevoke}
              loadFiles={loadFiles}
            />
          ))}
        </div>
      </section>
      {list ? (
        <DefaultDeviceForm list={list} saved={saved} canWrite={canWrite} busy={busy} onSave={onSaveDefault} />
      ) : null}
    </>
  )
}
