import { randomUUID } from 'node:crypto'
import { unlink } from 'node:fs/promises'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import type { ExecutionCommand, ExecutionReport, ExecutionReportResult } from '@baton/protocol'
import type { ExecutionRequest, ExecutionResponse } from './ipc.ts'
import { authorizeDirectory } from '../devices/roots.ts'
import { readProjectExec } from '../devices/config.ts'
import { BoundedOutput } from './output.ts'
import { ensurePrivateDirectory, readPrivateFile, writePrivateFileAtomic } from '../platform/private.ts'
import { hasCode } from '../platform/errors.ts'
import {
  reapProcessTree,
  spawnOwnedProcess,
  type OwnedProcess,
  type ProcessRecord,
  type ProcessWatchdog,
} from '../platform/process.ts'
import { FullOutputStore, readOutputRetentionDays } from '../worker/full-output.ts'
import { executionPaths } from './paths.ts'
import type { ExecutionState } from './node-ledger.ts'

const terminal = (state: ExecutionState) =>
  state.reports.some(({ report }) =>
    ['completed', 'failed', 'cancelled', 'timed_out', 'unknown'].includes(report.status),
  )

/** One managed command child process and its in-process state machine. */
export class InProcessExecution {
  #state: ExecutionState
  #owned: OwnedProcess | undefined
  #stopping: 'cancelled' | 'timed_out' | undefined
  #serial = Promise.resolve()
  readonly #controller = new AbortController()
  readonly #paths: ReturnType<typeof executionPaths>

  constructor(
    readonly dataDirectory: string,
    readonly executionId: string,
    private readonly ledger: {
      save: (state: ExecutionState) => import('effect').Effect.Effect<void, unknown>
    },
    initial: ExecutionState,
    readonly watchdog?: ProcessWatchdog,
  ) {
    this.#paths = executionPaths(dataDirectory, executionId)
    this.#state = initial
  }

  get state() {
    return this.#state
  }

  async initialize(): Promise<void> {
    await this.#locked(() => this.#recover())
  }

  async handle(request: ExecutionRequest): Promise<ExecutionResponse> {
    return this.#locked(async () => {
      const response: ExecutionResponse = { type: 'execution.response' }
      const generation =
        'storage_generation' in request
          ? request.storage_generation
          : (this.#state.command?.storage_generation ?? this.#state.stopped?.storage_generation ?? '')
      const result = (ok: boolean, code?: string) => ({
        ...response,
        result: {
          type: 'execution.command_result' as const,
          execution_id: this.executionId,
          storage_generation: generation,
          ok,
          ...(code ? { code } : {}),
        },
      })
      if (request.type === 'execution.poll')
        return {
          ...response,
          reports: this.#state.reports.filter((entry) => !entry.acked).map((entry) => entry.report),
        }
      if (request.type === 'execution.recover') {
        await this.#recover()
        return response
      }
      if (request.type === 'execution.report_result') {
        await this.#ack(request)
        return response
      }
      if (
        request.execution_id !== this.executionId ||
        (this.#state.command && this.#state.command.storage_generation !== request.storage_generation) ||
        (this.#state.stopped && this.#state.stopped.storage_generation !== request.storage_generation)
      )
        return result(false, 'identity_mismatch')
      if (request.action === 'stop') {
        if (!this.#state.command) {
          if (!this.#state.stopped) {
            await this.#append(
              request,
              { status: 'cancelled', finished_at: new Date().toISOString() },
              { ...this.#state, stopped: request },
            )
          }
          return result(true)
        }
        if (!this.#state.stopped) await this.#save({ ...this.#state, stopped: request })
        if (!this.#stopping) {
          this.#stopping = 'cancelled'
          this.#controller.abort()
          if (this.#owned) void this.#owned.reap()
        }
        return result(true)
      }
      if (this.#state.command)
        return JSON.stringify(this.#state.command) === JSON.stringify(request)
          ? result(true)
          : result(false, 'command_conflict')
      if (this.#state.stopped) return result(true)
      if (!request.command || !request.working_directory || !request.timeout_seconds || !request.project_id)
        return result(false, 'invalid_request')
      let authorized: { shell: string; cwd: string }
      try {
        const config = await readProjectExec(this.dataDirectory)
        if (!config.enabled) throw new Error('disabled')
        authorized = {
          shell: config.shell,
          cwd: await authorizeDirectory(this.dataDirectory, request.working_directory),
        }
      } catch {
        return result(false, 'execution_not_authorized')
      }
      await this.#save({ ...this.#state, command: request, intent: true })
      void this.#execute(request, authorized.shell, authorized.cwd).catch(async (cause: unknown) => {
        this.#controller.abort()
        if (this.#owned) await this.#owned.reap().catch(() => undefined)
        await this.#append(request, {
          status: 'unknown',
          reason: `execution outcome unknown: ${cause instanceof Error ? cause.message : String(cause)}`,
          finished_at: new Date().toISOString(),
        }).catch(() => undefined)
      })
      return result(true)
    })
  }

  async ack(request: ExecutionReportResult): Promise<void> {
    await this.#locked(() => this.#ack(request))
  }

  async close(): Promise<void> {
    this.#controller.abort()
    await this.#owned?.reap().catch(() => undefined)
  }

  async #locked<A>(task: () => Promise<A>): Promise<A> {
    const next = this.#serial.then(task, task)
    this.#serial = next.then(
      () => undefined,
      () => undefined,
    )
    return next
  }

  async #save(next: ExecutionState) {
    this.#state = next
    await import('effect').then(({ Effect }) => Effect.runPromise(this.ledger.save(next)))
  }

  async #append(
    command: ExecutionCommand,
    fields: Omit<ExecutionReport, 'type' | 'execution_id' | 'storage_generation' | 'event_id' | 'seq'>,
    base = this.#state,
  ) {
    const report: ExecutionReport = {
      type: 'execution.report',
      execution_id: this.executionId,
      storage_generation: command.storage_generation,
      event_id: randomUUID(),
      seq: base.reports.length + 1,
      ...fields,
    }
    await this.#save({ ...base, reports: [...base.reports, { report, acked: false }] })
  }

  async #ack(request: ExecutionReportResult) {
    if (request.type !== 'execution.report_result' || !request.ok || request.execution_id !== this.executionId) return
    if (
      !this.#state.reports.some(
        (entry) => entry.report.seq === request.seq && entry.report.event_id === request.event_id && !entry.acked,
      )
    )
      return
    await this.#save({
      ...this.#state,
      reports: this.#state.reports.map((entry) =>
        entry.report.seq === request.seq && entry.report.event_id === request.event_id
          ? { ...entry, acked: true }
          : entry,
      ),
    })
  }

  async #recover() {
    const record = this.#state.process
    if (record) {
      const result = await reapProcessTree(record).catch(() => ({ reaped: false, reason: undefined }))
      if (result.reaped || result.reason === 'identity-mismatch') {
        const { process: _process, ...next } = this.#state
        await this.#save(next)
      } else if (this.#state.intent && this.#state.command && !terminal(this.#state)) {
        await this.#append(this.#state.command, {
          status: 'unknown',
          reason: 'process tree cleanup unconfirmed',
          finished_at: new Date().toISOString(),
        })
        return
      }
    }
    if (this.#state.intent && this.#state.command && !terminal(this.#state)) {
      const completed = await readPrivateFile(join(this.#paths.directory, 'completion.json'))
        .then((value) => JSON.parse(value.toString('utf8')) as ExecutionReport)
        .catch(() => undefined)
      if (
        completed?.execution_id === this.executionId &&
        completed.storage_generation === this.#state.command.storage_generation &&
        ['completed', 'failed', 'cancelled', 'timed_out'].includes(completed.status)
      ) {
        const {
          type: _type,
          execution_id: _id,
          storage_generation: _generation,
          event_id: _event,
          seq: _seq,
          ...fields
        } = completed
        await this.#append(this.#state.command, fields)
      } else
        await this.#append(this.#state.command, {
          status: 'unknown',
          reason: 'execution outcome unknown after restart',
          finished_at: new Date().toISOString(),
        })
    }
  }

  async #execute(command: ExecutionCommand, shell: string, cwd: string) {
    await ensurePrivateDirectory(this.#paths.root)
    await ensurePrivateDirectory(join(this.#paths.root, 'executions'))
    await ensurePrivateDirectory(this.#paths.directory)
    const authorized = await readProjectExec(this.dataDirectory)
      .then(async (config) => ({
        config,
        directory: await authorizeDirectory(this.dataDirectory, command.working_directory!),
      }))
      .catch(() => undefined)
    if (
      !authorized ||
      !authorized.config.enabled ||
      authorized.config.shell !== shell ||
      authorized.directory !== cwd
    ) {
      await this.#append(command, {
        status: 'failed',
        reason: 'execution authorization changed',
        finished_at: new Date().toISOString(),
      })
      return
    }
    const retention = await readOutputRetentionDays(this.dataDirectory)
    const retained = await new FullOutputStore(this.#paths.directory).begin(
      { thread_id: this.executionId, storage_generation: command.storage_generation },
      retention,
    )
    const output = new BoundedOutput((bytes) => retained.write(bytes))
    let pipesFailed = false
    let pipes: Promise<void> = Promise.resolve()
    if (this.#controller.signal.aborted) {
      await retained.close()
      await this.#append(command, {
        status: this.#stopping ?? 'cancelled',
        finished_at: new Date().toISOString(),
      })
      return
    }
    let owned: OwnedProcess
    try {
      const { loadEnvironment, resolveEnvironment, baseEnvironment } = await import('../environment.ts')
      const config = await loadEnvironment(this.dataDirectory)
      const env = config.revision
        ? resolveEnvironment(config, baseEnvironment(process.env), { project: command.project_id! }).env
        : process.env
      owned = await spawnOwnedProcess(
        {
          file: shell,
          args: process.platform === 'win32' ? ['-NoProfile', '-Command', command.command!] : ['-lc', command.command!],
          cwd,
          env,
        },
        {
          ...(this.watchdog ? { watchdog: this.watchdog } : {}),
          records: {
            add: async (record: ProcessRecord) => {
              await this.#locked(async () => this.#save({ ...this.#state, process: record }))
            },
            remove: async () => {
              await this.#locked(async () => {
                const { process: _process, ...next } = this.#state
                await this.#save(next)
              })
            },
          },
          signal: this.#controller.signal,
          role: 'execution',
          onSpawn: (child) => {
            child.stdin.end()
            child.stdout.on('data', (chunk: Buffer) => output.write(chunk))
            child.stderr.on('data', (chunk: Buffer) => output.write(chunk))
            child.stdout.on('error', () => {
              pipesFailed = true
            })
            child.stderr.on('error', () => {
              pipesFailed = true
            })
            pipes = Promise.all([
              new Promise<void>((resolve) => child.stdout.once('close', resolve)),
              new Promise<void>((resolve) => child.stderr.once('close', resolve)),
            ]).then(() => undefined)
          },
        },
      )
      this.#owned = owned
    } catch (error) {
      await retained.close()
      await this.#append(command, {
        status: hasCode(error, 'ENOENT') ? 'failed' : 'unknown',
        reason: hasCode(error, 'ENOENT') ? 'execution program unavailable' : 'execution startup outcome unknown',
        finished_at: new Date().toISOString(),
      })
      return
    }
    const startedAt = new Date().toISOString()
    await this.#append(command, { status: 'running', started_at: startedAt })
    const startedWall = Date.now()
    const startedMonotonic = performance.now()
    const timeoutMs = command.timeout_seconds! * 1000
    let timer: ReturnType<typeof setTimeout>
    const checkTimeout = () => {
      const remaining = timeoutMs - Math.max(Date.now() - startedWall, performance.now() - startedMonotonic)
      if (remaining <= 0) {
        this.#stopping ??= 'timed_out'
        this.#controller.abort()
        void this.#owned?.reap()
      } else timer = setTimeout(checkTimeout, Math.min(remaining, 1000))
    }
    timer = setTimeout(checkTimeout, Math.min(timeoutMs, 1000))
    const exit = await owned.exited
    clearTimeout(timer)
    const drained = await Promise.race([pipes.then(() => true), delay(1000).then(() => false)])
    const reaped = await owned.reap()
    this.#owned = undefined
    const finishedAt = new Date().toISOString()
    if (!reaped.reaped || pipesFailed || !drained) {
      await retained.close()
      await this.#append(command, {
        status: 'unknown',
        reason: 'execution output or process cleanup unconfirmed',
        started_at: startedAt,
        finished_at: finishedAt,
      })
      return
    }
    const fullOutput = await retained.finish()
    const result = output.result(exit.code ?? -1)
    const fields = {
      status: this.#stopping ?? (exit.code === 0 ? ('completed' as const) : ('failed' as const)),
      ...result,
      full_output: fullOutput,
      started_at: startedAt,
      finished_at: finishedAt,
    }
    const evidence = {
      type: 'execution.report' as const,
      execution_id: this.executionId,
      storage_generation: command.storage_generation,
      event_id: randomUUID(),
      seq: 1,
      ...fields,
    }
    await writePrivateFileAtomic(join(this.#paths.directory, 'completion.json'), JSON.stringify(evidence))
    await this.#append(command, fields)
  }
}

export const removeExecutionOutput = (dataDirectory: string, executionId: string) =>
  unlink(join(executionPaths(dataDirectory, executionId).directory, 'completion.json')).catch(() => undefined)
