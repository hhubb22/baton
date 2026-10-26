import { randomUUID } from 'node:crypto'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { rm, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { DatabaseSync } from 'node:sqlite'
import { createRequire } from 'node:module'
import { Effect, Scope, Exit } from 'effect'
import { describe, expect, it } from '@effect/vitest'
import type { ProjectRunCommand, ProjectRuntimeRequest, ProjectRuntimeResult } from '@baton/protocol'
import { readProcessIdentity, reapProcessTree } from '../platform/process.ts'
import { writePrivateFileAtomic } from '../platform/private.ts'
import { makePrivateTempDirectory } from '../testing/private.ts'
import { makeProjectManager } from './index.ts'
import { success } from './types.ts'
import type { ProjectManagerOptions, ProjectTransport } from './types.ts'

const fixture = fileURLToPath(new URL('../testing/project/runtime.mjs', import.meta.url))
const command = (): ProjectRunCommand => ({
  type: 'project_run_start',
  run_id: randomUUID(),
  lease_epoch: 7,
  provider: 'openai-codex',
})
const open = Effect.fnUntraced(function* (options: Partial<ProjectManagerOptions> = {}, mode = 'idle') {
  const dataDir =
    options.dataDir ??
    (yield* Effect.acquireRelease(
      Effect.promise(() => makePrivateTempDirectory('baton-pa-')),
      (directory) => Effect.promise(() => rm(directory, { recursive: true, force: true })),
    ))
  const scope = yield* Effect.acquireRelease(Scope.make(), (scope) => Scope.close(scope, Exit.void))
  const launchLog = join(dataDir, 'launches')
  const manager = yield* makeProjectManager({
    dataDir,
    runtimeCommand: { file: process.execPath, args: [fixture, mode], env: { FIXTURE_LAUNCH_LOG: launchLog } },
    ...options,
  }).pipe(Effect.provideService(Scope.Scope, scope))
  return { manager, dataDir, launchLog, close: () => Scope.close(scope, Exit.void) }
})
// Windows 启动并回收子进程明显更慢，轮询预算按平台放宽。
const PROCESS_WAIT_MS = process.platform === 'win32' ? 24000 : 6000
const until = Effect.fnUntraced(function* (check: () => boolean | Promise<boolean>, timeout = PROCESS_WAIT_MS) {
  yield* Effect.gen(function* () {
    while (!(yield* Effect.promise(async () => check()))) yield* Effect.sleep(10)
  }).pipe(Effect.timeout(timeout))
})
const row = (directory: string, id: string) => {
  const db = new DatabaseSync(join(directory, 'project-runtime.db'), { readOnly: true })
  try {
    return db.prepare('SELECT * FROM project_runtime_runs WHERE run_id=?').get(id)
  } finally {
    db.close()
  }
}
const transport =
  (requests: ProjectRuntimeRequest[], bootstrap?: (r: ProjectRuntimeRequest) => void): ProjectTransport =>
  async (request) => {
    requests.push(request)
    if (request.operation === 'bootstrap') bootstrap?.(request)
    return success(
      request.operation === 'renew' || request.operation === 'started'
        ? { lease_seconds: 60, control_receipts: 1 }
        : {},
    )
  }

describe('Project Runtime host', () => {
  describe('process ownership and cleanup', () => {
    it.live('keeps one process across duplicate start and reconnect, then persists and retries cleanup receipts', () =>
      Effect.gen(function* () {
        const { manager, dataDir, launchLog, close } = yield* open()
        const c = command()
        const requests: ProjectRuntimeRequest[] = []
        let pid = 0,
          branch = 0
        const network = transport(requests, (r) => {
          const data = r.payload as { pid: number; branch: number }
          pid = data.pid
          branch = data.branch
        })
        manager.setTransport(network)
        yield* Effect.promise(() => Promise.all([manager.command(c), manager.command(c)]))
        yield* until(() => pid > 0)
        manager.onDisconnect()
        const identity = yield* Effect.promise(() => readProcessIdentity(pid))
        expect(identity).not.toBeNull()
        const records = new DatabaseSync(join(dataDir, 'project-runtime.db'), { readOnly: true })
        try {
          const stored = records.prepare('SELECT payload FROM project_processes WHERE role=?').get(c.run_id)
          expect(JSON.parse(String(stored?.payload))).toEqual({ ...identity, role: c.run_id })
        } finally {
          records.close()
        }
        manager.setTransport(network)
        yield* Effect.promise(() => manager.command(c))
        expect((yield* Effect.promise(() => readFile(launchLog, 'utf8'))).trim().split('\n')).toHaveLength(1)
        let stopAttempts = 0
        manager.setTransport(async (request, signal) => {
          if (request.operation === 'stopped' && ++stopAttempts === 1)
            return { type: 'project_runtime.result', ok: false, code: 'unavailable' }
          return network(request, signal)
        })
        yield* Effect.promise(() => manager.command({ ...c, type: 'project_run_stop' }))
        yield* until(() => row(dataDir, c.run_id)?.cleanup_complete === 1)
        expect(yield* Effect.promise(() => readProcessIdentity(pid))).toBeNull()
        expect(yield* Effect.promise(() => readProcessIdentity(branch))).toBeNull()
        yield* until(() => stopAttempts === 1)
        expect(row(dataDir, c.run_id)?.cleanup_acked).toBe(0)
        yield* close()
        const reopened = yield* open({ dataDir })
        reopened.manager.setTransport(network)
        const db = new DatabaseSync(join(dataDir, 'project-runtime.db'))
        db.prepare('UPDATE project_runtime_runs SET cleanup_next_at=0 WHERE run_id=?').run(c.run_id)
        db.close()
        yield* Effect.promise(() => reopened.manager.command(c))
        yield* until(() => row(dataDir, c.run_id)?.cleanup_acked === 1)
        expect((yield* Effect.promise(() => readFile(launchLog, 'utf8'))).trim().split('\n')).toHaveLength(1)
        expect(requests.some((r) => r.operation === 'exited')).toBe(true)
      }),
    )

    it.live('reaps a recorded old process before persisting recovered cleanup evidence', () =>
      Effect.gen(function* () {
        const { dataDir, close } = yield* open()
        yield* close()
        const c = command()
        const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
          detached: process.platform !== 'win32',
          stdio: 'ignore',
        })
        const exited = once(child, 'exit')
        yield* Effect.promise(() => once(child, 'spawn'))
        const identity = (yield* Effect.promise(() => readProcessIdentity(child.pid!)))!
        yield* Effect.addFinalizer(() =>
          Effect.promise(async () => {
            await reapProcessTree(identity)
            await exited
          }),
        )
        const record = { ...identity, role: c.run_id }
        const db = new DatabaseSync(join(dataDir, 'project-runtime.db'))
        db.prepare("INSERT INTO project_runtime_runs(run_id,lease_epoch,state) VALUES(?,?,'running')").run(
          c.run_id,
          c.lease_epoch,
        )
        db.prepare('INSERT INTO project_processes VALUES(?,?)').run(c.run_id, JSON.stringify(record))
        db.close()
        const recovered = yield* open({ dataDir })
        expect(yield* Effect.promise(() => readProcessIdentity(child.pid!))).toBeNull()
        expect(row(dataDir, c.run_id)?.cleanup_complete).toBe(1)
        expect(row(dataDir, c.run_id)?.cleanup_acked).toBe(0)
        const requests: ProjectRuntimeRequest[] = []
        recovered.manager.setTransport(transport(requests))
        yield* until(() => row(dataDir, c.run_id)?.cleanup_acked === 1)
        expect(requests.map((r) => r.operation)).toEqual(['exited', 'stopped'])
      }),
    )

    it.live('retains cleanup evidence in memory until SQLite can commit it', () =>
      Effect.gen(function* () {
        const { manager, dataDir } = yield* open()
        const c = command()
        const requests: ProjectRuntimeRequest[] = []
        manager.setTransport(transport(requests))
        yield* Effect.promise(() => manager.command(c))
        yield* until(() => requests.some((r) => r.operation === 'bootstrap'))
        const db = yield* Effect.acquireRelease(
          Effect.sync(() => new DatabaseSync(join(dataDir, 'project-runtime.db'))),
          (db) => Effect.sync(() => db.close()),
        )
        db.exec(
          "CREATE TRIGGER deny_cleanup BEFORE UPDATE OF cleanup_complete ON project_runtime_runs BEGIN SELECT RAISE(FAIL, 'local storage unavailable'); END",
        )
        yield* Effect.promise(() => manager.command({ ...c, type: 'project_run_stop' }))
        // 清理通过原生定时器重试，真实等待期间保留 SQLite 写入失败。
        yield* Effect.sleep(300)
        expect(row(dataDir, c.run_id)?.cleanup_complete).toBe(0)
        expect(requests.some((r) => r.operation === 'stopped')).toBe(false)
        db.exec('DROP TRIGGER deny_cleanup')
        yield* until(() => row(dataDir, c.run_id)?.cleanup_acked === 1)
      }),
    )
  })

  describe('lease expiry', () => {
    it.live('checks the old lease before sending or accepting a renewal after sleep', () =>
      Effect.gen(function* () {
        let wall = 0,
          mono = 0
        const { manager, dataDir } = yield* open({
          clock: { wall: () => wall, monotonic: () => mono },
          timing: { renewMs: 100, leaseMs: 300, checkMs: 10 },
        })
        const c = command()
        let pid = 0,
          renewals = 0
        let release!: (result: ProjectRuntimeResult) => void
        const delayed = new Promise<ProjectRuntimeResult>((resolve) => {
          release = resolve
        })
        manager.setTransport(async (request) => {
          if (request.operation === 'bootstrap') pid = (request.payload as { pid: number }).pid
          if (request.operation === 'renew' && ++renewals > 1) return delayed
          return success({ lease_seconds: 60, control_receipts: 1 })
        })
        yield* Effect.promise(() => manager.command(c))
        yield* until(() => pid > 0)
        mono = wall = 110
        yield* until(() => renewals === 2)
        wall = 60000
        release(success({ lease_seconds: 60, control_receipts: 1 }))
        yield* until(() => row(dataDir, c.run_id)?.cleanup_complete === 1)
        expect(yield* Effect.promise(() => readProcessIdentity(pid))).toBeNull()
        expect(renewals).toBe(2)
        yield* Effect.promise(() => manager.command(c))
        expect(renewals).toBe(2)
      }),
    )
  })

  describe('durable start and stop decisions', () => {
    it.live('admits unknown authentication, forwards model budgets and enforces the configured node capacity', () =>
      Effect.gen(function* () {
        const { manager, dataDir } = yield* open({
          runtimeCommand: {
            file: process.execPath,
            args: [
              '-e',
              `
              if (process.argv[1] === 'probe') console.log(JSON.stringify({version:'0.1.0', providers:[{provider:'openai-codex', status:'unknown', reason:'credential_read_failed'}]}));
              else { console.log(JSON.stringify({id:1,request:{operation:'bootstrap',payload:{args:process.argv.slice(1)}}})); setInterval(() => {},1000); }
            `,
            ],
          },
        })
        yield* Effect.promise(() =>
          writePrivateFileAtomic(
            join(dataDir, 'project-runtime.json'),
            JSON.stringify({
              maxConcurrentProjects: 1,
              maxOutputTokens: 48000,
              maxModelCalls: 128,
            }),
          ),
        )
        const requests: ProjectRuntimeRequest[] = []
        manager.setTransport(transport(requests))
        yield* Effect.promise(() => manager.command(command()))
        yield* until(() => requests.some((request) => request.operation === 'bootstrap'))
        expect(requests.find((request) => request.operation === 'bootstrap')?.payload).toEqual({
          args: ['run', '--max-output-tokens', '48000', '--max-model-calls', '128'],
        })
        const next = command()
        yield* Effect.promise(() => manager.command(next))
        yield* until(() =>
          requests.some((request) => request.run_id === next.run_id && request.operation === 'start_failed'),
        )
        expect(requests.find((request) => request.run_id === next.run_id)?.reason).toBe('capacity_exceeded')
      }),
    )

    it.live('reports known credential security failures without requesting login', () =>
      Effect.gen(function* () {
        const { manager } = yield* open({
          runtimeCommand: {
            file: process.execPath,
            args: [
              '-e',
              `console.log(JSON.stringify({version:'0.1.0',providers:[{provider:'openai-codex',status:'unknown',reason:'credential_permissions_invalid'}]}))`,
            ],
          },
        })
        const requests: ProjectRuntimeRequest[] = []
        manager.setTransport(transport(requests))
        yield* Effect.promise(() => manager.command(command()))
        yield* until(() => requests.some((request) => request.operation === 'start_failed'))
        expect(requests.find((request) => request.operation === 'start_failed')?.reason).toBe(
          'credential_permissions_invalid',
        )
        expect(requests.some((request) => request.operation === 'bootstrap')).toBe(false)
      }),
    )

    it.live('counts persisted intents whose process cleanup is still unconfirmed', () =>
      Effect.gen(function* () {
        const { manager, dataDir } = yield* open()
        yield* Effect.promise(() =>
          writePrivateFileAtomic(join(dataDir, 'project-runtime.json'), '{"maxConcurrentProjects":1}'),
        )
        const old = command()
        const db = new DatabaseSync(join(dataDir, 'project-runtime.db'))
        try {
          db.prepare("INSERT INTO project_runtime_runs(run_id,lease_epoch,state) VALUES(?,?,'starting')").run(
            old.run_id,
            old.lease_epoch,
          )
        } finally {
          db.close()
        }
        const requests: ProjectRuntimeRequest[] = []
        manager.setTransport(transport(requests))
        const next = command()
        yield* Effect.promise(() => manager.command(next))
        yield* until(() => requests.some((request) => request.run_id === next.run_id))
        expect(requests.find((request) => request.run_id === next.run_id)?.reason).toBe('capacity_exceeded')
        expect(row(dataDir, old.run_id)?.cleanup_complete).toBe(0)
      }),
    )

    it.live('keeps an old intent without cleanup evidence unconfirmed after reopening', () =>
      Effect.gen(function* () {
        const { dataDir, close } = yield* open()
        const old = command()
        const db = new DatabaseSync(join(dataDir, 'project-runtime.db'))
        try {
          db.prepare("INSERT INTO project_runtime_runs(run_id,lease_epoch,state) VALUES(?,?,'starting')").run(
            old.run_id,
            old.lease_epoch,
          )
        } finally {
          db.close()
        }
        yield* close()
        const reopened = yield* open({ dataDir })
        const requests: ProjectRuntimeRequest[] = []
        reopened.manager.setTransport(transport(requests))
        yield* Effect.promise(() => reopened.manager.command({ ...old, type: 'project_run_stop' }))
        yield* Effect.promise(() => reopened.manager.command(old))
        expect(row(dataDir, old.run_id)?.cleanup_complete).toBe(0)
        expect(row(dataDir, old.run_id)?.cleanup_acked).toBe(0)
        expect(
          requests.filter((request) => request.operation === 'stopped' || request.operation === 'bootstrap'),
        ).toEqual([])
      }),
    )

    it.live('persists stop-before-start and refuses to launch it after reopening', () =>
      Effect.gen(function* () {
        const { manager, dataDir, close } = yield* open()
        const stopped = command()
        const requests: ProjectRuntimeRequest[] = []
        const network = transport(requests)
        manager.setTransport(network)
        yield* Effect.promise(() => manager.command({ ...stopped, type: 'project_run_stop' }))
        yield* until(() => row(dataDir, stopped.run_id)?.cleanup_acked === 1)
        yield* close()
        const reopened = yield* open({ dataDir })
        reopened.manager.setTransport(network)
        yield* Effect.promise(() => reopened.manager.command(stopped))
        expect(row(dataDir, stopped.run_id)?.cleanup_complete).toBe(1)
        expect(row(dataDir, stopped.run_id)?.cleanup_acked).toBe(1)
        expect(requests.filter((request) => request.operation === 'bootstrap')).toEqual([])
      }),
    )
  })

  describe('stdio and Thread waits', () => {
    it.live('binds stdio identity, refuses host operations and waits only for a bound Thread version', () =>
      Effect.gen(function* () {
        const { manager, dataDir } = yield* open({}, 'exercise')
        const c = command(),
          thread = randomUUID()
        const requests: ProjectRuntimeRequest[] = []
        let pending = false
        manager.setTransport(async (request) => {
          requests.push(request)
          if (request.operation === 'bootstrap') {
            expect((request.payload as { denied: { code: string } }).denied.code).toBe('invalid_request')
            expect(request.run_id).toBe(c.run_id)
            expect(request.lease_epoch).toBe(c.lease_epoch)
          }
          if (request.operation === 'call_tool') {
            pending = true
            return success({ pending: true, thread_id: thread, version: 3, wait_remaining_ms: 5000, wait_protocol: 1 })
          }
          if (request.operation === 'wait_tool') {
            expect((request.payload as { changed: { data: unknown } }).changed.data).toEqual({
              reason: 'thread_changed',
              version: 4,
            })
            expect(
              (request.payload as { boot: { data: { local_wait_protocol: number } } }).boot.data.local_wait_protocol,
            ).toBe(1)
            return success({ seq: 2, kind: 'tool_result', payload: {} })
          }
          if (request.operation === 'preview')
            expect((request.payload as { unbound: { code: string } }).unbound.code).toBe('invalid_request')
          return success({ control_receipts: 1 })
        })
        yield* Effect.promise(() => manager.command(c))
        yield* until(() => pending)
        yield* Effect.promise(() =>
          manager.command({
            ...c,
            lease_epoch: c.lease_epoch - 1,
            type: 'project_run_wake',
            input_ids: [12],
            thread_updates: [{ thread_id: thread, version: 100 }],
          }),
        )
        // Wake repeatedly covers the process response/poll scheduling boundary; duplicates merge.
        yield* until(async () => {
          await manager.command({
            ...c,
            type: 'project_run_wake',
            input_ids: [11],
            thread_updates: [{ thread_id: thread, version: 4 }],
          })
          return requests.some((r) => r.operation === 'finish')
        })
        yield* until(() => row(dataDir, c.run_id)?.cleanup_acked === 1)
        expect(requests.some((r) => r.operation === 'wake_received')).toBe(true)
        expect(requests.filter((r) => r.operation === 'renew')).toHaveLength(1)
      }),
    )

    it.live('uses the existing real Runtime with the local faux provider through stdio', () =>
      Effect.gen(function* () {
        const loader = createRequire(
          new URL('../../../../runtimes/project-agent/package.json', import.meta.url),
        ).resolve('tsx')
        const { manager, dataDir } = yield* open({
          runtimeCommand: {
            file: process.execPath,
            args: ['--import', pathToFileURL(loader).href, fixture, 'real-runtime'],
          },
        })
        const c = command()
        const events: { seq: number; kind: string; payload: unknown }[] = []
        let queued = true,
          tools = 0
        manager.setTransport(async (request) => {
          switch (request.operation) {
            case 'bootstrap':
              return success({
                project: {
                  title: 'Local',
                  goal: '',
                  agent: { provider: 'openai-codex', model: 'fake-model' },
                  conversation: { id: randomUUID() },
                },
                prompt_version: '1',
                after_seq: 0,
                last_seq: events.length,
              })
            case 'read_events':
              return success({
                events,
                last_seq: events.length,
                next_after_seq: events.length,
                has_more: false,
              } as never)
            case 'claim_inputs': {
              if (!queued) return success({ payload_bytes: 0, input_count: 0 })
              queued = false
              const event = {
                seq: events.length + 1,
                kind: 'input',
                payload: {
                  format: 'pi-ai/1',
                  message: { role: 'user', content: [{ type: 'text', text: '保存记忆' }], timestamp: 0 },
                },
              }
              events.push(event)
              return success({ event, payload_bytes: Buffer.byteLength(JSON.stringify(event.payload)), input_count: 1 })
            }
            case 'append_event':
            case 'commit_compaction': {
              expect(request.last_seq).toBe(events.length)
              const event = {
                seq: events.length + 1,
                kind: request.operation === 'append_event' ? 'assistant' : 'compaction',
                payload: request.payload,
              }
              events.push(event)
              return success(event as never)
            }
            case 'call_tool': {
              expect(events.at(-1)?.kind).toBe('assistant')
              tools++
              expect(request.tool_name).toBe('memory.write')
              const event = {
                seq: events.length + 1,
                kind: 'tool_result',
                payload: {
                  format: 'pi-ai/1',
                  message: {
                    role: 'toolResult',
                    toolCallId: request.tool_call_id!,
                    toolName: request.tool_name!,
                    content: [{ type: 'text', text: '{"saved":true}' }],
                    isError: false,
                    timestamp: 0,
                  },
                },
              }
              events.push(event)
              return success(event)
            }
            default:
              return success({ lease_seconds: 60, control_receipts: 1 })
          }
        })
        yield* Effect.promise(() => manager.command(c))
        yield* until(() => row(dataDir, c.run_id)?.cleanup_acked === 1, 10000)
        expect(tools).toBe(1)
        expect(events.map((e) => e.kind)).toEqual(['input', 'assistant', 'tool_result', 'assistant', 'compaction'])
      }),
    )
  })
})
