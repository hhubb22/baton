import { Effect } from 'effect'

export class DaemonStorageFailure extends Error {
  readonly code?: string
  constructor(cause?: unknown) {
    super('节点账本不可用，已停止执行，请恢复本地存储后重启')
    if (
      cause &&
      typeof cause === 'object' &&
      'code' in cause &&
      (cause.code === 'storage_version_unsupported' || cause.code === 'migration_checksum_mismatch')
    )
      this.code = cause.code
  }
}

export const ledgerPromise = async <A>(effect: Effect.Effect<A, unknown>): Promise<A> => {
  const result = await Effect.runPromise(Effect.result(effect))
  if (result._tag === 'Failure') throw new DaemonStorageFailure(result.failure)
  return result.success
}
