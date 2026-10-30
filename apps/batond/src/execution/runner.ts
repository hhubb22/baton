import { randomUUID } from 'node:crypto'
import { chmod, unlink } from 'node:fs/promises'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { Deferred, Effect, Schema, Scope, Semaphore } from 'effect'
import { ExecutionReport, type ExecutionCommand } from '@baton/protocol'
import { authorizeDirectory } from '../devices/roots.ts'
import { readProjectExec } from '../devices/config.ts'
import { BoundedOutput } from './output.ts'
import { acquireProcessLockScoped } from '../platform/lock.ts'
import { ensurePrivateDirectory, readPrivateFile, writePrivateFileAtomic } from '../platform/private.ts'
import { hasCode } from '../platform/errors.ts'
import {
  reapProcessTree,
  spawnOwnedProcess,
  startProcessWatchdog,
  type OwnedProcess,
  type ProcessWatchdog,
} from '../platform/process.ts'
import { FullOutputStore, readOutputRetentionDays } from '../worker/full-output.ts'
import { currentBatondCommand } from '../daemon/host.ts'
import { listenAuthenticated } from '../daemon/ipc.ts'
import { decodeRequest, decodeResponse, type ExecutionResponse } from './ipc.ts'
import { openExecutionLedger, type ExecutionState } from './ledger.ts'
import { executionPaths } from './paths.ts'
import { assertNoUpdateRollback } from '../daemon/update-state.ts'

export const runExecutionWorker = (dataDirectory: string, executionId: string, suppliedWatchdog?: ProcessWatchdog) =>
  Effect.gen(function* () {
    const scope = yield* Scope.Scope
    yield* Effect.tryPromise(() => assertNoUpdateRollback(dataDirectory))
    const paths = executionPaths(dataDirectory, executionId)
    if (process.platform !== 'win32') process.umask(0o077)
    yield* Effect.promise(() => ensurePrivateDirectory(`${paths.root}/executions`))
    yield* Effect.promise(() => ensurePrivateDirectory(paths.directory))
    yield* Effect.promise(() => ensurePrivateDirectory(paths.ipcDirectory))
    yield* acquireProcessLockScoped(paths.lock)
    yield* Effect.tryPromise(() => assertNoUpdateRollback(dataDirectory))
    const token = (yield* Effect.promise(() => readPrivateFile(paths.token))).toString('utf8')
    if (!/^[0-9a-f]{64}$/.test(token)) return yield* Effect.fail(new Error('Invalid execution IPC token'))
    const ledger = yield* openExecutionLedger(paths.ledger)
    let state = ledger.state
    const lock = yield* Semaphore.make(1)
    const failed = yield* Deferred.make<void, Error>()
    const drained = yield* Deferred.make<void>()
    const save = (next: ExecutionState) =>
      ledger.save(next).pipe(
        Effect.tap(() =>
          Effect.sync(() => {
            state = next
          }),
        ),
        Effect.tapError(() => Deferred.fail(failed, new Error('Execution ledger write failed'))),
      )
    const append = (
      command: ExecutionCommand,
      fields: Omit<ExecutionReport, 'type' | 'execution_id' | 'storage_generation' | 'event_id' | 'seq'>,
      base = state,
    ) => {
      const report: ExecutionReport = {
        type: 'execution.report',
        execution_id: executionId,
        storage_generation: command.storage_generation,
        event_id: randomUUID(),
        seq: state.reports.length + 1,
        ...fields,
      }
      return save({ ...base, reports: [...base.reports, { report, acked: false }] })
    }
    const lockedAppend = (
      command: ExecutionCommand,
      fields: Omit<ExecutionReport, 'type' | 'execution_id' | 'storage_generation' | 'event_id' | 'seq'>,
    ) => lock.withPermit(Effect.suspend(() => append(command, fields)))
    const completionPath = join(paths.directory, 'completion.json')
    const watchdogCommand = currentBatondCommand()
    const watchdog =
      suppliedWatchdog ??
      (process.platform === 'win32'
        ? undefined
        : yield* Effect.acquireRelease(
            Effect.promise(() =>
              startProcessWatchdog({ file: watchdogCommand.executable, args: [...watchdogCommand.args, 'watchdog'] }),
            ),
            (watchdog) => Effect.promise(() => watchdog.close()),
          ))
    const recoverProcess = () =>
      Effect.gen(function* () {
        const record = state.process
        if (!record) return undefined
        const result = yield* Effect.tryPromise(() => reapProcessTree(record)).pipe(Effect.option)
        if (result._tag === 'Some' && result.value.reaped) {
          const { process: _process, ...withoutProcess } = state
          yield* save(withoutProcess)
        }
        return result._tag === 'Some' ? result.value : { reaped: false }
      })
    const previousProcess = state.process
    const recovered = yield* recoverProcess()
    if (
      state.intent &&
      state.command &&
      !state.reports.some(({ report }) =>
        ['completed', 'failed', 'cancelled', 'timed_out', 'unknown'].includes(report.status),
      )
    ) {
      const completed = yield* Effect.tryPromise(async () =>
        Schema.decodeUnknownSync(ExecutionReport)(JSON.parse((await readPrivateFile(completionPath)).toString('utf8'))),
      ).pipe(Effect.option)
      if (
        completed._tag === 'Some' &&
        completed.value.execution_id === executionId &&
        completed.value.storage_generation === state.command.storage_generation &&
        ['completed', 'failed', 'cancelled', 'timed_out'].includes(completed.value.status) &&
        (!previousProcess || recovered?.reaped)
      ) {
        const {
          type: _type,
          execution_id: _id,
          storage_generation: _generation,
          event_id: _event,
          seq: _seq,
          ...fields
        } = completed.value
        yield* append(state.command, fields)
      } else
        yield* append(state.command, {
          status: 'unknown',
          reason:
            recovered && !recovered.reaped
              ? 'process tree cleanup unconfirmed'
              : 'execution outcome unknown after restart',
          finished_at: new Date().toISOString(),
        })
    }
    let owned: OwnedProcess | undefined
    let stopping: 'cancelled' | 'timed_out' | undefined
    const controller = new AbortController()
    const execute = (command: ExecutionCommand, shell: string, cwd: string) =>
      Effect.gen(function* () {
        const authorized = yield* Effect.result(
          Effect.tryPromise(async () => {
            const config = await readProjectExec(dataDirectory)
            if (!config.enabled) throw new Error('disabled')
            const directory = await authorizeDirectory(dataDirectory, command.working_directory!)
            if (config.shell !== shell || directory !== cwd) throw new Error('configuration changed')
          }),
        )
        if (authorized._tag === 'Failure') {
          yield* lockedAppend(command, {
            status: 'failed',
            reason: 'execution authorization changed',
            finished_at: new Date().toISOString(),
          })
          return
        }
        const retention = yield* Effect.promise(() => readOutputRetentionDays(dataDirectory))
        const retained = yield* Effect.promise(() =>
          new FullOutputStore(paths.directory).begin(
            { thread_id: executionId, storage_generation: command.storage_generation },
            retention,
          ),
        )
        const output = new BoundedOutput((bytes) => retained.write(bytes))
        let pipesFailed = false
        let pipes: Promise<void> = Promise.resolve()
        const records = {
          add: (record: import('../platform/process.ts').ProcessRecord) =>
            Effect.runPromise(lock.withPermit(Effect.suspend(() => save({ ...state, process: record })))),
          remove: () =>
            Effect.runPromise(
              lock.withPermit(
                Effect.suspend(() => {
                  const { process: _process, ...next } = state
                  return save(next)
                }),
              ),
            ),
        }
        if (controller.signal.aborted) {
          yield* Effect.promise(() => retained.close())
          yield* lockedAppend(command, { status: stopping ?? 'cancelled', finished_at: new Date().toISOString() })
          return
        }
        const start = yield* Effect.result(
          Effect.tryPromise({
            try: () =>
              spawnOwnedProcess(
                {
                  file: shell,
                  args:
                    process.platform === 'win32'
                      ? ['-NoProfile', '-Command', command.command!]
                      : ['-lc', command.command!],
                  cwd,
                },
                {
                  watchdog,
                  records,
                  signal: controller.signal,
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
              ),
            catch: (cause) => ({ missing: hasCode(cause, 'ENOENT') }),
          }),
        )
        if (start._tag === 'Failure') {
          yield* Effect.promise(() => retained.close())
          yield* lockedAppend(command, {
            status: start.failure.missing ? 'failed' : 'unknown',
            reason: start.failure.missing ? 'execution program unavailable' : 'execution startup outcome unknown',
            finished_at: new Date().toISOString(),
          })
          return
        }
        owned = start.success
        const startedAt = new Date().toISOString()
        yield* lockedAppend(command, { status: 'running', started_at: startedAt })
        const startedWall = Date.now()
        const startedMonotonic = performance.now()
        const timeoutMs = command.timeout_seconds! * 1000
        let timer: ReturnType<typeof setTimeout>
        const checkTimeout = () => {
          const remaining = timeoutMs - Math.max(Date.now() - startedWall, performance.now() - startedMonotonic)
          if (remaining <= 0) {
            stopping ??= 'timed_out'
            controller.abort()
            void owned?.reap()
          } else timer = setTimeout(checkTimeout, Math.min(remaining, 1000))
        }
        timer = setTimeout(checkTimeout, Math.min(command.timeout_seconds! * 1000, 1000))
        const exit = yield* Effect.promise(() => owned!.exited)
        clearTimeout(timer)
        const drained = yield* Effect.promise(() =>
          Promise.race([pipes.then(() => true), delay(1000).then(() => false)]),
        )
        const reaped = yield* Effect.promise(() => owned!.reap())
        const finishedAt = new Date().toISOString()
        if (!reaped.reaped || pipesFailed || !drained) {
          yield* Effect.promise(() => retained.close())
          yield* lockedAppend(command, {
            status: 'unknown',
            reason: 'execution output or process cleanup unconfirmed',
            started_at: startedAt,
            finished_at: finishedAt,
          })
          return
        }
        const fullOutput = yield* Effect.promise(() => retained.finish())
        const result = output.result(exit.code ?? -1)
        const fields = {
          status: stopping ?? (exit.code === 0 ? ('completed' as const) : ('failed' as const)),
          ...result,
          full_output: fullOutput,
          started_at: startedAt,
          finished_at: finishedAt,
        }
        const evidence = {
          type: 'execution.report' as const,
          execution_id: executionId,
          storage_generation: command.storage_generation,
          event_id: randomUUID(),
          seq: 1,
          ...fields,
        }
        yield* Effect.tryPromise(() => writePrivateFileAtomic(completionPath, JSON.stringify(evidence)))
        yield* lockedAppend(command, fields)
      })
    if (process.platform !== 'win32') yield* Effect.promise(() => unlink(paths.endpoint).catch(() => {}))
    yield* listenAuthenticated({
      endpoint: paths.endpoint,
      token,
      decodeRequest,
      decodeResponse,
      handle: (request) =>
        lock.withPermit(
          Effect.gen(function* () {
            const response: ExecutionResponse = { type: 'execution.response' }
            if (request.type === 'execution.recover') {
              if (
                state.reports.some(({ report }) =>
                  ['completed', 'failed', 'cancelled', 'timed_out', 'unknown'].includes(report.status),
                )
              ) {
                yield* recoverProcess()
                if (!state.process && state.reports.every((entry) => entry.acked))
                  yield* Deferred.succeed(drained, undefined)
              }
              return response
            }
            if (request.type === 'execution.poll')
              return {
                ...response,
                reports: state.reports.filter((entry) => !entry.acked).map((entry) => entry.report),
              }
            if (request.type === 'execution.report_result') {
              if (request.ok && request.execution_id === executionId)
                yield* save({
                  ...state,
                  reports: state.reports.map((entry) =>
                    entry.report.seq === request.seq && entry.report.event_id === request.event_id
                      ? { ...entry, acked: true }
                      : entry,
                  ),
                })
              if (
                state.reports.some(({ report }) =>
                  ['completed', 'failed', 'cancelled', 'timed_out', 'unknown'].includes(report.status),
                ) &&
                state.reports.every((entry) => entry.acked) &&
                !state.process
              )
                yield* Deferred.succeed(drained, undefined)
              return response
            }
            const result = (ok: boolean, code?: string) => ({
              ...response,
              result: {
                type: 'execution.command_result' as const,
                execution_id: executionId,
                storage_generation: request.storage_generation,
                ok,
                ...(code ? { code } : {}),
              },
            })
            if (
              request.execution_id !== executionId ||
              (state.command && state.command.storage_generation !== request.storage_generation) ||
              (state.stopped && state.stopped.storage_generation !== request.storage_generation)
            )
              return result(false, 'identity_mismatch')
            if (request.action === 'stop') {
              if (!state.command) {
                if (!state.stopped) {
                  yield* append(
                    request,
                    { status: 'cancelled', finished_at: new Date().toISOString() },
                    { ...state, stopped: request },
                  )
                }
                return result(true)
              }
              if (!state.stopped) yield* save({ ...state, stopped: request })
              if (!stopping) {
                stopping = 'cancelled'
                controller.abort()
                if (owned) void owned.reap()
              }
              return result(true)
            }
            if (state.command)
              return JSON.stringify(state.command) === JSON.stringify(request)
                ? result(true)
                : result(false, 'command_conflict')
            if (state.stopped) return result(true)
            if (!request.command || !request.working_directory || !request.timeout_seconds || !request.project_id)
              return result(false, 'invalid_request')
            const authorized = yield* Effect.exit(
              Effect.tryPromise(async () => {
                const config = await readProjectExec(dataDirectory)
                if (!config.enabled) throw new Error('disabled')
                return { shell: config.shell, cwd: await authorizeDirectory(dataDirectory, request.working_directory!) }
              }),
            )
            if (authorized._tag === 'Failure') return result(false, 'execution_not_authorized')
            yield* save({ ...state, command: request, intent: true })
            yield* Effect.forkIn(
              execute(request, authorized.value.shell, authorized.value.cwd).pipe(
                Effect.catchCause(() =>
                  Effect.gen(function* () {
                    controller.abort()
                    if (owned) yield* Effect.promise(() => owned!.reap()).pipe(Effect.ignore)
                    yield* Deferred.fail(failed, new Error('Execution outcome requires recovery'))
                  }),
                ),
              ),
              scope,
            )
            return result(true)
          }),
        ),
    })
    if (process.platform !== 'win32') yield* Effect.promise(() => chmod(paths.endpoint, 0o600))
    yield* Effect.raceFirst(Deferred.await(failed), Deferred.await(drained).pipe(Effect.andThen(Effect.sleep(100))))
  })
