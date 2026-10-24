import type { DatabaseEffect } from './database.ts'
import { AppError } from './errors.ts'
import { markRevocationApplied, pendingRevocations, type RevocationCursor } from './nodes.ts'

export type RunDatabase = <A>(operation: DatabaseEffect<A>) => Promise<A>
export type DisconnectNode = (nodeId: string) => Promise<void>

export interface RevocationOptions {
  readonly limit?: number
  readonly concurrency?: number
  readonly after?: RevocationCursor
}

export interface RevocationBatch {
  readonly attempted: number
  readonly applied: number
  readonly failed: number
  readonly nextCursor: RevocationCursor | undefined
}

/** 一批只尝试每个节点一次；连接关闭与数据库确认之间不持有事务。 */
export async function compensateRevocations(
  run: RunDatabase,
  disconnect: DisconnectNode,
  options: RevocationOptions = {},
): Promise<RevocationBatch> {
  const concurrency = options.concurrency ?? 4
  if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 4) {
    throw new AppError(400, 'invalid_revocation_concurrency', '吊销补偿并发数必须为 1 到 4')
  }
  let pending = await run(pendingRevocations(options.limit ?? 32, options.after))
  if (!pending.length && options.after) pending = await run(pendingRevocations(options.limit ?? 32))
  let index = 0
  let applied = 0
  let failed = 0
  await Promise.all(
    Array.from({ length: Math.min(concurrency, pending.length) }, async () => {
      while (index < pending.length) {
        const node = pending[index++]!
        try {
          await disconnect(node.node_id)
          await run(markRevocationApplied(node.employee_id, node.node_id))
          applied++
        } catch {
          // 未确认的意图继续保留，后续扫描再次处理。
          failed++
        }
      }
    }),
  )
  const last = pending.at(-1)
  return {
    attempted: pending.length,
    applied,
    failed,
    nextCursor: last ? { requested_at: last.requested_at, node_id: last.node_id } : undefined,
  }
}

/** 固定循环复用此函数；扫描游标只影响公平性，恢复事实保存在 node_revocations。 */
export function createRevocationCompensator(
  run: RunDatabase,
  disconnect: DisconnectNode,
  options: Omit<RevocationOptions, 'after'> = {},
): () => Promise<RevocationBatch> {
  let after: RevocationCursor | undefined
  let active: Promise<RevocationBatch> | undefined
  return () => {
    active ??= compensateRevocations(run, disconnect, { ...options, ...(after ? { after } : {}) })
      .then((result) => {
        after = result.nextCursor
        return result
      })
      .finally(() => {
        active = undefined
      })
    return active
  }
}
