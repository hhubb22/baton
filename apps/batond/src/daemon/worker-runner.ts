import { releaseMetadata } from '@baton/protocol/release'
import { chmod, lstat, unlink } from 'node:fs/promises'
import { join } from 'node:path'
import { Deferred, Effect } from 'effect'
import type * as Scope from 'effect/Scope'
import { AgentError, type AgentFactory } from '../worker/agent.ts'
import { parseThreadAttachments } from '../devices/attachments.ts'
import { makeWorker, type Worker } from '../worker/index.ts'
import { makeThreadAgentFactory } from '../agents/thread-agents.ts'
import { acquireProcessLockScoped } from '../platform/lock.ts'
import { openPrivateFile, readPrivateFile, writePrivateFileAtomic } from '../platform/private.ts'
import { reapProcessTree, startProcessWatchdog, type ProcessRecordCallbacks } from '../platform/process.ts'
import { listenWorker } from './ipc.ts'
import { currentBatondCommand, initializeWorkerDirectory, type BatondCommand } from './host.ts'
import { makeNodeLedger } from './ledger.ts'
import { readUpgradeState, upgradeOffline } from './upgrade.ts'
import { assertNoUpdateRollback } from './update-state.ts'

export const runWorker = (options: {
  readonly dataDirectory: string
  readonly threadId: string
  readonly command?: BatondCommand
  readonly agentFactory?: AgentFactory
}): Effect.Effect<void, unknown, Scope.Scope> =>
  Effect.gen(function* () {
    yield* Effect.tryPromise(() => assertNoUpdateRollback(options.dataDirectory))
    if (upgradeOffline(yield* Effect.tryPromise(() => readUpgradeState(options.dataDirectory)))) return
    if (process.platform !== 'win32') process.umask(0o077)
    const paths = yield* Effect.promise(() => initializeWorkerDirectory(options.dataDirectory, options.threadId))
    yield* acquireProcessLockScoped(paths.lock)
    yield* Effect.tryPromise(() => assertNoUpdateRollback(options.dataDirectory))
    if (upgradeOffline(yield* Effect.tryPromise(() => readUpgradeState(options.dataDirectory)))) return
    const token = (yield* Effect.promise(() => readPrivateFile(paths.token))).toString('utf8')
    if (!/^[0-9a-f]{64}$/.test(token)) return yield* Effect.fail(new Error('Invalid Worker IPC token'))
    yield* Effect.promise(async () => {
      try {
        const file = await openPrivateFile(paths.ledger)
        await file.close()
      } catch (error) {
        if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error
        await writePrivateFileAtomic(paths.ledger, '')
      }
      if (process.platform !== 'win32') {
        try {
          const stat = await lstat(paths.endpoint)
          if (!stat.isSocket() || stat.uid !== process.getuid?.()) throw new Error('Invalid Worker IPC endpoint')
          await unlink(paths.endpoint)
        } catch (error) {
          if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error
        }
      }
    })
    const invocation = options.command ?? currentBatondCommand()
    const watchdog =
      process.platform === 'win32'
        ? undefined
        : yield* Effect.acquireRelease(
            Effect.promise(() =>
              startProcessWatchdog({ file: invocation.executable, args: [...invocation.args, 'watchdog'] }),
            ),
            (owned) => Effect.promise(() => owned.close()),
          )
    const workerReady = yield* Deferred.make<Worker>()
    const records: ProcessRecordCallbacks = {
      add: (record) =>
        Effect.runPromise(Deferred.await(workerReady).pipe(Effect.flatMap((worker) => worker.records.add(record)))),
      remove: (record) =>
        Effect.runPromise(Deferred.await(workerReady).pipe(Effect.flatMap((worker) => worker.records.remove(record)))),
    }
    const agentFactory =
      options.agentFactory ??
      makeThreadAgentFactory({
        dataDirectory: options.dataDirectory,
        command: { file: invocation.executable, args: invocation.args },
        records,
        ...(watchdog ? { watchdog } : {}),
      })
    let parsingAttachments = false
    const nodeLedger = yield* makeNodeLedger(join(options.dataDirectory, 'node.db'))
    const worker = yield* makeWorker({
      dbPath: paths.ledger,
      dataDirectory: options.dataDirectory,
      agentFactory,
      attachments: (config, text) =>
        Effect.suspend(() => {
          if (parsingAttachments) return Effect.succeed([])
          parsingAttachments = true
          const pending = parseThreadAttachments(
            options.dataDirectory,
            config.node_id,
            config.working_directory,
            text,
          ).finally(() => {
            parsingAttachments = false
          })
          return Effect.tryPromise({
            try: () => pending,
            catch: (cause) => new AgentError('无法解析附件引用', cause),
          })
        }),
      recoverProcesses: (previous) =>
        Effect.promise(async () => {
          let processTreeStopped = true
          for (const record of previous) {
            const result = await reapProcessTree(record)
            if (result.reaped || result.reason === 'identity-mismatch') await records.remove(record)
            if (!result.reaped) processTreeStopped = false
          }
          return { processTreeStopped }
        }),
    })
    yield* Deferred.succeed(workerReady, worker)
    yield* listenWorker({
      endpoint: paths.endpoint,
      token,
      handle: (request) => {
        if (request.thread_id !== undefined && request.thread_id !== options.threadId)
          return Effect.succeed({ type: 'result', ok: false, code: 'identity_mismatch' })
        const handle = Effect.gen(function* () {
          // 所有 IPC 入口在交付 open 前留下持久事实，包括本地 CLI。
          if (upgradeOffline(yield* Effect.tryPromise(() => readUpgradeState(options.dataDirectory))))
            return { type: 'result' as const, ok: false, code: 'node_upgrading' }
          if (request.type === 'thread_open') yield* nodeLedger.markWorkerOpenAttempt(options.threadId)
          return yield* worker.handle(request)
        })
        return handle.pipe(
          Effect.map((result) =>
            request.type === 'status' ? { ...result, pid: process.pid, release: releaseMetadata() } : result,
          ),
        )
      },
    })
    if (process.platform !== 'win32') yield* Effect.promise(() => chmod(paths.endpoint, 0o600))
    yield* Effect.raceFirst(
      worker.failed,
      Effect.gen(function* () {
        while (true) {
          if (yield* worker.drain) return
          yield* Effect.sleep(100)
        }
      }),
    )
  })
