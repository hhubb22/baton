import { randomUUID } from 'node:crypto'
import { rm } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { DatabaseSync } from 'node:sqlite'
import { Effect } from 'effect'
import { expect, it, vi } from 'vite-plus/test'
import { ensurePrivateDirectory, writePrivateFileAtomic } from '../platform/private.ts'
import { startProcessWatchdog } from '../platform/process.ts'
import { requestAuthenticated } from '../daemon/ipc.ts'
import { makePrivateTempDirectory } from '../testing/private.ts'
import { decodeRequest, decodeResponse, type ExecutionRequest } from './ipc.ts'
import { executionPaths } from './paths.ts'
import { runExecutionWorker } from './runner.ts'
import { openExecutionLedger, readExecutionState } from './ledger.ts'

it.runIf(process.platform !== 'win32')(
  'runs one command, retains output and rejects a stopped execution',
  async () => {
    const root = await makePrivateTempDirectory('baton-exec-')
    const id = randomUUID()
    const generation = randomUUID()
    const paths = executionPaths(root, id)
    const token = 'a'.repeat(64)
    const cwd = join(root, 'work')
    await ensurePrivateDirectory(join(root, 'executions'))
    await ensurePrivateDirectory(paths.directory)
    await ensurePrivateDirectory(paths.ipcDirectory)
    await ensurePrivateDirectory(cwd)
    await writePrivateFileAtomic(paths.token, token)
    await writePrivateFileAtomic(
      join(root, 'browse-roots.json'),
      JSON.stringify({ roots: [{ id: 'work', path: cwd }] }),
    )
    await writePrivateFileAtomic(join(root, 'project-exec.json'), JSON.stringify({ enabled: true, shell: '/bin/sh' }))
    const watchdog = await startProcessWatchdog({
      file: process.execPath,
      args: [fileURLToPath(new URL('../testing/platform/process.mjs', import.meta.url)), 'watchdog'],
    })
    const call = (request: ExecutionRequest) =>
      requestAuthenticated({ endpoint: paths.endpoint, token, request, decodeRequest, decodeResponse })
    try {
      await Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            yield* Effect.forkChild(Effect.scoped(runExecutionWorker(root, id, watchdog)))
            yield* Effect.promise(async () => {
              await expect
                .poll(() =>
                  call({ type: 'execution.poll' }).then(
                    () => true,
                    () => false,
                  ),
                )
                .toBe(true)
              const start = {
                type: 'execution.command' as const,
                execution_id: id,
                storage_generation: generation,
                action: 'start' as const,
                command: 'printf hello',
                working_directory: cwd,
                timeout_seconds: 10,
                project_id: randomUUID(),
              }
              expect((await call(start)).result?.ok).toBe(true)
              expect((await call(start)).result?.ok).toBe(true)
              await expect
                .poll(async () =>
                  (await call({ type: 'execution.poll' })).reports?.some((report) => report.status === 'completed'),
                )
                .toBe(true)
              const reports = (await call({ type: 'execution.poll' })).reports!
              expect(reports.find((report) => report.status === 'completed')).toMatchObject({
                output: 'hello',
                exit_code: 0,
                total_bytes: 5,
                full_output: { total_bytes: 5 },
              })
              for (const report of reports)
                await call({
                  type: 'execution.report_result',
                  execution_id: id,
                  event_id: report.event_id,
                  seq: report.seq,
                  ok: true,
                })
              await expect
                .poll(() =>
                  call({ type: 'execution.poll' }).then(
                    () => false,
                    () => true,
                  ),
                )
                .toBe(true)
            })
          }),
        ),
      )
      const id2 = randomUUID()
      const paths2 = executionPaths(root, id2)
      await ensurePrivateDirectory(paths2.directory)
      await writePrivateFileAtomic(paths2.token, token)
      const call2 = (request: ExecutionRequest) =>
        requestAuthenticated({ endpoint: paths2.endpoint, token, request, decodeRequest, decodeResponse })
      await Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            yield* Effect.forkChild(Effect.scoped(runExecutionWorker(root, id2, watchdog)))
            yield* Effect.promise(async () => {
              await expect
                .poll(() =>
                  call2({ type: 'execution.poll' }).then(
                    () => true,
                    () => false,
                  ),
                )
                .toBe(true)
              expect(
                (
                  await call2({
                    type: 'execution.command',
                    execution_id: id2,
                    storage_generation: generation,
                    action: 'stop',
                  })
                ).result?.ok,
              ).toBe(true)
              const result = await call2({
                type: 'execution.command',
                execution_id: id2,
                storage_generation: generation,
                action: 'start',
                command: 'printf forbidden',
                working_directory: cwd,
                timeout_seconds: 10,
                project_id: randomUUID(),
              })
              expect(result.result).toMatchObject({ ok: true })
              expect((await call2({ type: 'execution.poll' })).reports).toMatchObject([{ status: 'cancelled' }])
            })
          }),
        ),
      )
    } finally {
      await watchdog.close()
      await rm(root, { recursive: true, force: true })
    }
  },
  30000,
)

it.runIf(process.platform !== 'win32')(
  'recovers persisted completion without running the command again',
  async () => {
    const root = await makePrivateTempDirectory('baton-exec-recovery-')
    const id = randomUUID()
    const generation = randomUUID()
    const paths = executionPaths(root, id)
    const token = 'b'.repeat(64)
    await ensurePrivateDirectory(join(root, 'executions'))
    await ensurePrivateDirectory(paths.directory)
    await ensurePrivateDirectory(paths.ipcDirectory)
    await writePrivateFileAtomic(paths.token, token)
    const command = {
      type: 'execution.command' as const,
      execution_id: id,
      storage_generation: generation,
      action: 'start' as const,
      command: 'never-run',
      working_directory: root,
      timeout_seconds: 10,
      project_id: randomUUID(),
    }
    const running = {
      type: 'execution.report' as const,
      execution_id: id,
      storage_generation: generation,
      event_id: randomUUID(),
      seq: 1,
      status: 'running' as const,
    }
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const ledger = yield* openExecutionLedger(paths.ledger)
          yield* ledger.save({
            command,
            intent: true,
            process: { pid: 2147483646, creationTime: 'exited:test', role: 'execution' },
            reports: [{ report: running, acked: true }],
          })
        }),
      ),
    )
    await writePrivateFileAtomic(
      join(paths.directory, 'completion.json'),
      JSON.stringify({ ...running, status: 'completed', output: 'saved', exit_code: 0 }),
    )
    const watchdog = await startProcessWatchdog({
      file: process.execPath,
      args: [fileURLToPath(new URL('../testing/platform/process.mjs', import.meta.url)), 'watchdog'],
    })
    try {
      await Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            yield* Effect.forkChild(Effect.scoped(runExecutionWorker(root, id, watchdog)))
            yield* Effect.promise(async () => {
              const call = () =>
                requestAuthenticated({
                  endpoint: paths.endpoint,
                  token,
                  request: { type: 'execution.poll' } as const,
                  decodeRequest,
                  decodeResponse,
                })
              await expect
                .poll(() =>
                  call().then(
                    () => true,
                    () => false,
                  ),
                )
                .toBe(true)
              expect((await call()).reports).toMatchObject([{ seq: 2, status: 'completed', output: 'saved' }])
              expect(readExecutionState(paths.ledger)?.process).toBeUndefined()
            })
          }),
        ),
      )
    } finally {
      await watchdog.close()
      await rm(root, { recursive: true, force: true })
    }
  },
  30000,
)

it.runIf(process.platform !== 'win32')(
  'retains an unconfirmed recovery process record',
  async () => {
    const root = await makePrivateTempDirectory('baton-exec-reap-')
    const id = randomUUID()
    const generation = randomUUID()
    const paths = executionPaths(root, id)
    await ensurePrivateDirectory(join(root, 'executions'))
    await ensurePrivateDirectory(paths.directory)
    await ensurePrivateDirectory(paths.ipcDirectory)
    await writePrivateFileAtomic(paths.token, 'e'.repeat(64))
    const record = { pid: process.pid, creationTime: 'different-process-identity', role: 'execution' }
    const command = {
      type: 'execution.command' as const,
      execution_id: id,
      storage_generation: generation,
      action: 'start' as const,
      command: 'never-run',
      working_directory: root,
      timeout_seconds: 10,
      project_id: randomUUID(),
    }
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const ledger = yield* openExecutionLedger(paths.ledger)
          yield* ledger.save({ command, intent: true, process: record, reports: [] })
        }),
      ),
    )
    const watchdog = await startProcessWatchdog({
      file: process.execPath,
      args: [fileURLToPath(new URL('../testing/platform/process.mjs', import.meta.url)), 'watchdog'],
    })
    try {
      await Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            yield* Effect.forkChild(Effect.scoped(runExecutionWorker(root, id, watchdog)))
            yield* Effect.promise(async () => {
              const call = () =>
                requestAuthenticated({
                  endpoint: paths.endpoint,
                  token: 'e'.repeat(64),
                  request: { type: 'execution.poll' } as const,
                  decodeRequest,
                  decodeResponse,
                })
              await expect
                .poll(() =>
                  call().then(
                    () => true,
                    () => false,
                  ),
                )
                .toBe(true)
              expect((await call()).reports).toMatchObject([
                { status: 'unknown', reason: 'process tree cleanup unconfirmed' },
              ])
              expect(readExecutionState(paths.ledger)?.process).toEqual(record)
            })
          }),
        ),
      )
      await Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            const ledger = yield* openExecutionLedger(paths.ledger)
            yield* ledger.save({
              ...ledger.state,
              process: { pid: 2147483646, creationTime: 'exited:test', role: 'execution' },
            })
          }),
        ),
      )
      await Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            yield* Effect.forkChild(Effect.scoped(runExecutionWorker(root, id, watchdog)))
            yield* Effect.promise(async () => {
              const call = () =>
                requestAuthenticated({
                  endpoint: paths.endpoint,
                  token: 'e'.repeat(64),
                  request: { type: 'execution.poll' } as const,
                  decodeRequest,
                  decodeResponse,
                })
              await expect
                .poll(() =>
                  call().then(
                    () => true,
                    () => false,
                  ),
                )
                .toBe(true)
              expect((await call()).reports).toMatchObject([{ seq: 1, status: 'unknown' }])
              expect((await call()).reports).toHaveLength(1)
              expect(readExecutionState(paths.ledger)?.process).toBeUndefined()
            })
          }),
        ),
      )
    } finally {
      await watchdog.close()
      await rm(root, { recursive: true, force: true })
    }
  },
  30000,
)

it.runIf(process.platform !== 'win32').each(['stop', 'timeout', 'unknown', 'undrained', 'unavailable'] as const)(
  'handles %s without rerunning a submitted command',
  async (scenario) => {
    const root = await makePrivateTempDirectory('baton-exec-lifecycle-')
    const id = randomUUID()
    const generation = randomUUID()
    const paths = executionPaths(root, id)
    const token = 'c'.repeat(64)
    const cwd = join(root, 'work')
    await ensurePrivateDirectory(join(root, 'executions'))
    await ensurePrivateDirectory(paths.directory)
    await ensurePrivateDirectory(paths.ipcDirectory)
    await ensurePrivateDirectory(cwd)
    await writePrivateFileAtomic(paths.token, token)
    await writePrivateFileAtomic(
      join(root, 'browse-roots.json'),
      JSON.stringify({ roots: [{ id: 'work', path: cwd }] }),
    )
    await writePrivateFileAtomic(
      join(root, 'project-exec.json'),
      JSON.stringify({ enabled: true, shell: scenario === 'unavailable' ? '/does-not-exist/baton-shell' : '/bin/sh' }),
    )
    const command = {
      type: 'execution.command' as const,
      execution_id: id,
      storage_generation: generation,
      action: 'start' as const,
      command: scenario === 'undrained' ? 'sleep 30 &' : 'sleep 30',
      working_directory: cwd,
      timeout_seconds: scenario === 'timeout' ? 1 : 30,
      project_id: randomUUID(),
    }
    if (scenario === 'unknown')
      await Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            const ledger = yield* openExecutionLedger(paths.ledger)
            yield* ledger.save({ command, intent: true, reports: [] })
          }),
        ),
      )
    const watchdog = await startProcessWatchdog({
      file: process.execPath,
      args: [fileURLToPath(new URL('../testing/platform/process.mjs', import.meta.url)), 'watchdog'],
    })
    try {
      await Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            yield* Effect.forkChild(Effect.scoped(runExecutionWorker(root, id, watchdog)))
            yield* Effect.promise(async () => {
              const call = (request: ExecutionRequest) =>
                requestAuthenticated({ endpoint: paths.endpoint, token, request, decodeRequest, decodeResponse })
              await expect
                .poll(() =>
                  call({ type: 'execution.poll' }).then(
                    () => true,
                    () => false,
                  ),
                )
                .toBe(true)
              expect((await call(command)).result?.ok).toBe(true)
              if (scenario === 'stop') {
                await expect
                  .poll(async () =>
                    (await call({ type: 'execution.poll' })).reports?.some((report) => report.status === 'running'),
                  )
                  .toBe(true)
                expect(
                  (
                    await call({
                      type: 'execution.command',
                      execution_id: id,
                      storage_generation: generation,
                      action: 'stop',
                    })
                  ).result?.ok,
                ).toBe(true)
              }
              const expected =
                scenario === 'stop'
                  ? 'cancelled'
                  : scenario === 'timeout'
                    ? 'timed_out'
                    : scenario === 'unavailable'
                      ? 'failed'
                      : 'unknown'
              await expect
                .poll(
                  async () =>
                    (await call({ type: 'execution.poll' })).reports?.some((report) => report.status === expected),
                  { timeout: 10000 },
                )
                .toBe(true)
              expect((await call(command)).result?.ok).toBe(true)
              const reports = (await call({ type: 'execution.poll' })).reports!
              expect(reports.filter((report) => report.status === 'running')).toHaveLength(
                scenario === 'unknown' || scenario === 'unavailable' ? 0 : 1,
              )
              expect(reports.filter((report) => report.status === expected)).toHaveLength(1)
            })
          }),
        ),
      )
    } finally {
      await watchdog.close()
      await rm(root, { recursive: true, force: true })
    }
  },
  30000,
)

it.runIf(process.platform !== 'win32')(
  'reopens after an uncertain intent commit without executing it again',
  async () => {
    const root = await makePrivateTempDirectory('baton-exec-commit-')
    const id = randomUUID()
    const generation = randomUUID()
    const paths = executionPaths(root, id)
    const token = 'd'.repeat(64)
    const cwd = join(root, 'work')
    await ensurePrivateDirectory(join(root, 'executions'))
    await ensurePrivateDirectory(paths.directory)
    await ensurePrivateDirectory(paths.ipcDirectory)
    await ensurePrivateDirectory(cwd)
    await writePrivateFileAtomic(paths.token, token)
    await writePrivateFileAtomic(
      join(root, 'browse-roots.json'),
      JSON.stringify({ roots: [{ id: 'work', path: cwd }] }),
    )
    await writePrivateFileAtomic(join(root, 'project-exec.json'), JSON.stringify({ enabled: true, shell: '/bin/sh' }))
    const watchdog = await startProcessWatchdog({
      file: process.execPath,
      args: [fileURLToPath(new URL('../testing/platform/process.mjs', import.meta.url)), 'watchdog'],
    })
    const call = (request: ExecutionRequest) =>
      requestAuthenticated({ endpoint: paths.endpoint, token, request, decodeRequest, decodeResponse })
    const command = {
      type: 'execution.command' as const,
      execution_id: id,
      storage_generation: generation,
      action: 'start' as const,
      command: 'touch should-not-exist',
      working_directory: cwd,
      timeout_seconds: 10,
      project_id: randomUUID(),
    }
    try {
      await Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            yield* Effect.forkChild(Effect.scoped(runExecutionWorker(root, id, watchdog)).pipe(Effect.ignore))
            yield* Effect.promise(async () => {
              await expect
                .poll(() =>
                  call({ type: 'execution.poll' }).then(
                    () => true,
                    () => false,
                  ),
                )
                .toBe(true)
              const prepare: typeof DatabaseSync.prototype.prepare = Reflect.get(DatabaseSync.prototype, 'prepare')
              let intent = false
              let uncertain = false
              const spy = vi.spyOn(DatabaseSync.prototype, 'prepare').mockImplementation(function (
                this: DatabaseSync,
                query,
              ) {
                if (uncertain && query === 'SELECT token FROM commit_marker WHERE id=1')
                  throw new Error('verification unavailable')
                const statement = prepare.call(this, query)
                if (query.startsWith('INSERT INTO execution_state')) {
                  const run = statement.run.bind(statement)
                  vi.spyOn(statement, 'run').mockImplementationOnce((...args) => {
                    const payload: unknown = args[0]
                    if (typeof payload === 'string' && payload.includes('"intent":true')) intent = true
                    return run(...args)
                  })
                }
                if (query === 'COMMIT' && intent) {
                  const run = statement.run.bind(statement)
                  vi.spyOn(statement, 'run').mockImplementationOnce((...args) => {
                    run(...args)
                    uncertain = true
                    throw new Error('commit acknowledgement lost')
                  })
                }
                return statement
              })
              try {
                await call(command).catch(() => undefined)
                await expect
                  .poll(() =>
                    call({ type: 'execution.poll' }).then(
                      () => false,
                      () => true,
                    ),
                  )
                  .toBe(true)
                expect(uncertain).toBe(true)
              } finally {
                spy.mockRestore()
                vi.restoreAllMocks()
              }
            })
          }),
        ),
      )
      await Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            yield* Effect.forkChild(Effect.scoped(runExecutionWorker(root, id, watchdog)))
            yield* Effect.promise(async () => {
              await expect
                .poll(() =>
                  call({ type: 'execution.poll' }).then(
                    () => true,
                    () => false,
                  ),
                )
                .toBe(true)
              expect((await call({ type: 'execution.poll' })).reports).toMatchObject([{ status: 'unknown' }])
              expect((await call(command)).result?.ok).toBe(true)
              const { access } = await import('node:fs/promises')
              expect(
                await access(join(cwd, 'should-not-exist')).then(
                  () => true,
                  () => false,
                ),
              ).toBe(false)
            })
          }),
        ),
      )
    } finally {
      vi.restoreAllMocks()
      await watchdog.close()
      await rm(root, { recursive: true, force: true })
    }
  },
  30000,
)
