import { randomUUID } from 'node:crypto'
import { Effect } from 'effect'
import type { NodeUpdateAvailability } from '@baton/protocol'
import * as SqlClient from 'effect/sql/SqlClient'
import { dbError } from './database.ts'
import { AppError } from './errors.ts'
import { authenticateNode, type CredentialSigner } from './nodes.ts'

type Phase =
  | 'requested'
  | 'downloading'
  | 'verifying'
  | 'draining'
  | 'ready'
  | 'migrating'
  | 'syncing'
  | 'completed'
  | 'cancelled'
  | 'failed'
interface UpdateRow {
  operation_id: string
  attempt: number
  phase: Phase
  reason: string | null
  created_at: Date
}
const view = (row: UpdateRow) => ({
  operation_id: row.operation_id,
  attempt: row.attempt,
  phase: row.phase,
  ...(row.reason ? { reason: row.reason } : {}),
  created_at: row.created_at.toISOString(),
})

/** 调用方事务持有设备锁，更新请求与吊销使用相同锁顺序。 */
const lockDevice = Effect.fnUntraced(function* (employeeId: string, nodeId: string) {
  const sql = yield* SqlClient.SqlClient
  const rows =
    yield* sql`SELECT id FROM nodes WHERE employee_id=${employeeId}::uuid AND id=${nodeId}::uuid AND revoked_at IS NULL FOR UPDATE`
  if (!rows[0]) return yield* Effect.fail(new AppError(404, 'node_not_found'))
})

const requestLocked = Effect.fnUntraced(function* (employeeId: string, nodeId: string) {
  const sql = yield* SqlClient.SqlClient
  yield* lockDevice(employeeId, nodeId)
  const active = yield* sql<UpdateRow>`SELECT operation_id,attempt,phase,reason,created_at FROM node_update_requests
    WHERE node_id=${nodeId}::uuid AND phase NOT IN ('completed','cancelled') FOR UPDATE`
  if (active[0]) {
    if (active[0].phase !== 'failed') return view(active[0])
    const retried =
      yield* sql<UpdateRow>`UPDATE node_update_requests SET phase='requested',attempt=attempt+1,reason=NULL,updated_at=clock_timestamp()
      WHERE operation_id=${active[0].operation_id}::uuid RETURNING operation_id,attempt,phase,reason,created_at`
    return view(retried[0]!)
  }
  const rows = yield* sql<UpdateRow>`INSERT INTO node_update_requests(operation_id,employee_id,node_id)
    VALUES (${randomUUID()}::uuid,${employeeId}::uuid,${nodeId}::uuid) RETURNING operation_id,attempt,phase,reason,created_at`
  return view(rows[0]!)
})

export const requestUpdate = Effect.fn('NodeUpdates.request')(function* (employeeId: string, nodeId: string) {
  const sql = yield* SqlClient.SqlClient
  return yield* sql.withTransaction(
    Effect.gen(function* () {
      yield* lockDevice(employeeId, nodeId)
      const reports = yield* sql<{ supported: boolean }>`SELECT (
        EXISTS(SELECT 1 FROM node_runtime_reports WHERE node_id=${nodeId}::uuid AND employee_id=${employeeId}::uuid AND report->>'update_protocol' = '1')
        OR EXISTS(SELECT 1 FROM node_update_management WHERE node_id=${nodeId}::uuid AND employee_id=${employeeId}::uuid)
      ) AS supported`
      if (!reports[0]?.supported)
        return yield* Effect.fail(
          new AppError(409, 'update_bootstrap_required', '请先在设备上安装支持自动更新的 Baton 版本。'),
        )
      return yield* requestLocked(employeeId, nodeId)
    }),
  )
}, Effect.mapError(dbError))

// 管理通道独立于业务连接，凭据有效性仍在设备锁内复核。
const authenticated = <A, E>(
  token: string,
  signer: CredentialSigner,
  work: (employeeId: string, nodeId: string) => Effect.Effect<A, E, SqlClient.SqlClient>,
) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    return yield* sql.withTransaction(
      Effect.gen(function* () {
        const claims = yield* authenticateNode(token, signer)
        yield* lockDevice(claims.employee_id, claims.node_id)
        yield* authenticateNode(token, signer)
        yield* sql`INSERT INTO node_update_management(node_id,employee_id) VALUES (${claims.node_id}::uuid,${claims.employee_id}::uuid)
          ON CONFLICT (node_id) DO UPDATE SET last_seen=clock_timestamp()`
        return yield* work(claims.employee_id, claims.node_id)
      }),
    )
  }).pipe(Effect.mapError(dbError))

export const requestDeviceUpdate = (token: string, signer: CredentialSigner) =>
  authenticated(token, signer, requestLocked)

export const saveAvailability = (token: string, signer: CredentialSigner, availability: NodeUpdateAvailability) =>
  authenticated(token, signer, (_employeeId, nodeId) =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient
      yield* sql`UPDATE node_update_management SET availability=jsonb_build_object(
      'status',${availability.status}::text,'version',${availability.version}::text,'checked_at',clock_timestamp())
      WHERE node_id=${nodeId}::uuid`
      return { ok: true as const }
    }),
  )

export const pendingUpdate = (token: string, signer: CredentialSigner) =>
  authenticated(token, signer, (_employeeId, nodeId) =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient
      yield* sql`UPDATE node_update_requests SET management_last_seen=clock_timestamp()
      WHERE operation_id=(SELECT operation_id FROM node_update_requests WHERE node_id=${nodeId}::uuid ORDER BY created_at DESC LIMIT 1)`
      const rows = yield* sql<{
        operation_id: string
        attempt: number
      }>`SELECT operation_id,attempt FROM node_update_requests
      WHERE node_id=${nodeId}::uuid AND phase NOT IN ('completed','cancelled','failed')`
      return { operation_id: rows[0]?.operation_id ?? null, attempt: rows[0]?.attempt ?? null }
    }),
  )

const phaseOrder: Phase[] = [
  'requested',
  'downloading',
  'verifying',
  'draining',
  'ready',
  'migrating',
  'syncing',
  'completed',
]
export const reportUpdate = (
  token: string,
  signer: CredentialSigner,
  report: { operation_id: string; attempt: number; phase: Exclude<Phase, 'requested'>; reason?: string },
) =>
  authenticated(token, signer, (employeeId, nodeId) =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient
      const rows = yield* sql<UpdateRow>`SELECT operation_id,attempt,phase,reason,created_at FROM node_update_requests
      WHERE operation_id=${report.operation_id}::uuid AND employee_id=${employeeId}::uuid AND node_id=${nodeId}::uuid FOR UPDATE`
      const row = rows[0]
      if (!row) return yield* Effect.fail(new AppError(404, 'update_not_found'))
      if (report.attempt < row.attempt) return { ok: true as const }
      if (report.attempt !== row.attempt) return yield* Effect.fail(new AppError(409, 'update_conflict'))
      if (row.phase === report.phase) return { ok: true as const }
      if (row.phase === 'failed') return { ok: true as const }
      if (row.phase === 'completed' || row.phase === 'cancelled')
        return yield* Effect.fail(new AppError(409, 'update_conflict'))
      if (phaseOrder.indexOf(report.phase) >= 0 && phaseOrder.indexOf(report.phase) < phaseOrder.indexOf(row.phase))
        return { ok: true as const }
      const reason =
        report.reason === undefined
          ? null
          : /^[a-z][a-z0-9_]{0,63}$/.test(report.reason)
            ? report.reason
            : 'update_failed'
      yield* sql`UPDATE node_update_requests SET phase=${report.phase},reason=${reason},updated_at=clock_timestamp()
      WHERE operation_id=${report.operation_id}::uuid`
      return { ok: true as const }
    }),
  )
