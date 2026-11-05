import { join } from 'node:path'
import { releaseMetadata } from '@baton/protocol/release'
import type { WorkerIPCMessage, WorkerRequest } from '@baton/protocol'
import { Effect, Exit, Scope } from 'effect'
import { makeThreadAgentFactory } from '../agents/thread-agents.ts'
import { parseThreadAttachments } from '../devices/attachments.ts'
import {
  reapProcessTree,
  startProcessWatchdog,
  type ProcessRecordCallbacks,
  type ProcessWatchdog,
} from '../platform/process.ts'
import { AgentError } from '../worker/agent.ts'
import { FullOutputStore } from '../worker/full-output.ts'
import { makeWorker, type Worker } from '../worker/index.ts'
import type { AgentFactory } from '../worker/agent.ts'
import { currentBatondCommand, type BatondCommand, type DaemonWorkerHost } from './host.ts'
import { workerPaths } from './paths.ts'
import { ensurePrivateDirectory } from '../platform/private.ts'

interface RunningWorker {
  worker: Worker
  scope: Scope.Closeable
}

/** Thread state machines are fibers in the daemon; no Worker process or authenticated IPC is involved. */
export class InProcessWorkerHost implements DaemonWorkerHost {
  readonly #workers = new Map<string, Promise<RunningWorker>>()
  readonly #closing = new Set<Promise<RunningWorker>>()
  #watchdog: Promise<ProcessWatchdog> | undefined

  constructor(
    readonly dataDirectory: string,
    readonly options: {
      readonly nodeDbPath?: string
      readonly watchdog?: ProcessWatchdog
      readonly idleHostTimeoutMs?: number
      readonly agentFactory?: AgentFactory
      readonly agentCommand?: BatondCommand
      readonly watchdogCommand?: BatondCommand
    } = {},
  ) {}

  async ensureWorker(threadId: string): Promise<void> {
    await this.#worker(threadId)
  }

  async request(
    threadId: string,
    request: WorkerRequest,
    options: { readonly start?: boolean; readonly timeoutMs?: number } = {},
  ): Promise<WorkerIPCMessage> {
    if (request.type === 'session_request' && request.session_request.action === 'full_output') {
      const body = request.session_request
      if (body.session_id !== threadId) return { type: 'result', ok: false, code: 'invalid_request' }
      const result = await new FullOutputStore(join(this.dataDirectory, 'threads', threadId)).read(body)
      return { type: 'result', ok: result.ok, session_result: result }
    }
    const running = await this.#worker(threadId)
    const effect = running.worker.handle(request).pipe(
      Effect.map((result) =>
        request.type === 'status' ? { ...result, pid: process.pid, release: releaseMetadata() } : result,
      ),
      options.timeoutMs === undefined ? (value) => value : Effect.timeout(options.timeoutMs),
    )
    return Effect.runPromise(effect)
  }

  async close(): Promise<void> {
    const pending = [...this.#workers.values(), ...this.#closing]
    this.#workers.clear()
    await Promise.allSettled(
      pending.map(async (entry) => {
        const { scope } = await entry
        await Effect.runPromise(Scope.close(scope, Exit.void))
      }),
    )
    const watchdog = this.#watchdog
    this.#watchdog = undefined
    await watchdog?.then((started) => started.close()).catch(() => undefined)
  }

  #worker(threadId: string): Promise<RunningWorker> {
    const existing = this.#workers.get(threadId)
    if (existing) return existing
    const created = this.#create(threadId)
    this.#workers.set(threadId, created)
    this.#closing.add(created)
    void created.finally(() => this.#closing.delete(created))
    return created
  }

  async #create(threadId: string): Promise<RunningWorker> {
    const paths = workerPaths(this.dataDirectory, threadId)
    await ensurePrivateDirectory(paths.root)
    await ensurePrivateDirectory(join(paths.root, 'threads'))
    await ensurePrivateDirectory(paths.threadDirectory)
    const scope = await Effect.runPromise(Scope.make())
    let resolveWorker: (worker: Worker) => void = () => undefined
    const ready = new Promise<Worker>((resolve) => {
      resolveWorker = resolve
    })
    const records: ProcessRecordCallbacks = {
      add: async (record) => {
        await Effect.runPromise((await ready).records.add(record))
      },
      remove: async (record) => {
        await Effect.runPromise((await ready).records.remove(record))
      },
    }
    const watchdog =
      process.platform === 'win32'
        ? this.options.watchdog
        : await (this.#watchdog ??= (() => {
            const command = this.options.watchdogCommand ?? currentBatondCommand()
            return startProcessWatchdog({ file: command.executable, args: [...command.args, 'watchdog'] })
          })())
    const factoryCommand = this.options.agentCommand ?? currentBatondCommand()
    const agentFactory =
      this.options.agentFactory ??
      makeThreadAgentFactory({
        dataDirectory: this.dataDirectory,
        command: { file: factoryCommand.executable, args: factoryCommand.args },
        records,
        ...(watchdog ? { watchdog } : {}),
      })
    let parsingAttachments = false
    try {
      const worker = await Effect.runPromise(
        makeWorker({
          dbPath: this.options.nodeDbPath ?? join(this.dataDirectory, 'node.db'),
          threadId,
          dataDirectory: this.dataDirectory,
          ...(this.options.idleHostTimeoutMs === undefined
            ? {}
            : { idleHostTimeoutMs: this.options.idleHostTimeoutMs }),
          agentFactory,
          attachments: (config, text) =>
            Effect.suspend(() => {
              if (parsingAttachments) return Effect.succeed([])
              parsingAttachments = true
              const pending = parseThreadAttachments(
                this.dataDirectory,
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
        }).pipe(Effect.provideService(Scope.Scope, scope)),
      )
      resolveWorker(worker)
      return { worker, scope }
    } catch (cause) {
      await Effect.runPromise(Scope.close(scope, Exit.fail(cause)))
      throw cause
    }
  }
}
