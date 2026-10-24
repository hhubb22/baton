import { chmod, lstat, unlink } from 'node:fs/promises'
import { Deferred, Effect } from 'effect'
import type * as Scope from 'effect/Scope'
import { AgentError, type AgentFactory } from '../worker/agent.ts'
import { parseThreadAttachments } from '../devices/attachments.ts'
import { makeWorker, type Worker } from '../worker/index.ts'
import { acquireProcessLockScoped } from '../platform/lock.ts'
import { openPrivateFile, readPrivateFile, writePrivateFileAtomic } from '../platform/private.ts'
import { reapProcessTree, startProcessWatchdog, type ProcessRecordCallbacks } from '../platform/process.ts'
import { listenWorker } from './ipc.ts'
import { currentBatondCommand, initializeWorkerDirectory, type BatondCommand } from './host.ts'

export const runWorker = (options: {
  readonly dataDirectory: string
  readonly threadId: string
  readonly command?: BatondCommand
  readonly agentFactory?: AgentFactory
}): Effect.Effect<never, unknown, Scope.Scope> =>
  Effect.gen(function* () {
    if (process.platform !== 'win32') process.umask(0o077)
    const paths = yield* Effect.promise(() => initializeWorkerDirectory(options.dataDirectory, options.threadId))
    yield* acquireProcessLockScoped(paths.lock)
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
    const registry = (yield* Effect.promise(() => import('../agents/registry.ts'))).agentRegistry
    const hostCommand = { file: invocation.executable, args: invocation.args }
    const cursorFactory = registry.cursor.makeFactory({
      command: hostCommand,
      records,
      ...(watchdog ? { watchdog } : {}),
      paths: registry.cursor.paths,
    })
    const codexFactory = registry.codex.makeFactory({
      command: hostCommand,
      records,
      ...(watchdog ? { watchdog } : {}),
      paths: registry.codex.paths,
    })
    const piFactory = registry.pi.makeFactory({
      command: hostCommand,
      records,
      ...(watchdog ? { watchdog } : {}),
      paths: registry.pi.paths,
    })
    const kiroFactory = registry.kiro.makeFactory({
      command: hostCommand,
      records,
      ...(watchdog ? { watchdog } : {}),
      paths: registry.kiro.paths,
    })
    const shellFactory = registry.shell.makeFactory({
      dataDirectory: options.dataDirectory,
      records,
      ...(watchdog ? { watchdog } : {}),
    })
    const agentFactory: AgentFactory =
      options.agentFactory ??
      ((config) => {
        if (config.agent_type === 'cursor') return cursorFactory(config)
        if (config.agent_type === 'pi') return piFactory(config)
        if (config.agent_type === 'codex') return codexFactory(config)
        if (config.agent_type === 'kiro') return kiroFactory(config)
        if (config.agent_type === 'shell') return shellFactory(config)
        throw new Error(`Unsupported Thread agent_type: ${config.agent_type}`)
      })
    let parsingAttachments = false
    const worker = yield* makeWorker({
      dbPath: paths.ledger,
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
        return worker
          .handle(request)
          .pipe(Effect.map((result) => (request.type === 'status' ? { ...result, pid: process.pid } : result)))
      },
    })
    if (process.platform !== 'win32') yield* Effect.promise(() => chmod(paths.endpoint, 0o600))
    return yield* worker.failed
  })
