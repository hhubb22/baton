import { Effect } from 'effect'

export class DaemonStorageFailure extends Error {
  constructor() {
    super('节点账本不可用，已停止执行，请恢复本地存储后重启')
  }
}

export const ledgerPromise = async <A>(effect: Effect.Effect<A, unknown>): Promise<A> => {
  const result = await Effect.runPromise(Effect.result(effect))
  if (result._tag === 'Failure') throw new DaemonStorageFailure()
  return result.success
}
