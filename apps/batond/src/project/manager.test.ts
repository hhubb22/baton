import { randomUUID } from 'node:crypto'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { mkdtemp, rm, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { setTimeout as delay } from 'node:timers/promises'
import { DatabaseSync } from 'node:sqlite'
import { createRequire } from 'node:module'
import { Effect, Scope, Exit } from 'effect'
import { afterEach, describe, expect, it } from 'vite-plus/test'
import type { ProjectRunCommand, ProjectRuntimeRequest, ProjectRuntimeResult } from '@baton/protocol'
import { readProcessIdentity, reapProcessTree } from '../platform/process.ts'
import { makeProjectManager } from './index.ts'
import { success } from './types.ts'
import type { ProjectManagerOptions, ProjectTransport } from './types.ts'

const fixture = fileURLToPath(new URL('./fixtures/runtime.mjs', import.meta.url))
const resources: (() => Promise<void>)[] = []
afterEach(async () => {
  for (const close of resources.splice(0).reverse()) await close()
})
const command = (): ProjectRunCommand => ({
  type: 'project_run_start',
  run_id: randomUUID(),
  lease_epoch: 7,
  provider: 'openai-codex',
})
async function open(options: Partial<ProjectManagerOptions> = {}, mode = 'idle') {
  const dataDir = options.dataDir ?? (await mkdtemp(join(tmpdir(), 'baton-pa-')))
  if (!options.dataDir) resources.push(() => rm(dataDir, { recursive: true, force: true }))
  const scope = Scope.makeUnsafe()
  const launchLog = join(dataDir, 'launches')
  const manager = await Effect.runPromise(
    makeProjectManager({
      dataDir,
      runtimeCommand: { file: process.execPath, args: [fixture, mode], env: { FIXTURE_LAUNCH_LOG: launchLog } },
      ...options,
    }).pipe(Effect.provideService(Scope.Scope, scope)),
  )
  resources.push(() => Effect.runPromise(Scope.close(scope, Exit.void)))
  return { manager, dataDir, launchLog, close: () => Effect.runPromise(Scope.close(scope, Exit.void)) }
}
async function until(check: () => boolean | Promise<boolean>, timeout = 6000) {
  const end = performance.now() + timeout
  while (!(await check())) {
    if (performance.now() > end) throw new Error('本地 Runtime 状态等待超时')
    await delay(10)
  }
}
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
  it('keeps one process across duplicate start and reconnect, then persists and retries cleanup receipts', async () => {
    const { manager, dataDir, launchLog, close } = await open()
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
    await Promise.all([manager.command(c), manager.command(c)])
    await until(() => pid > 0)
    manager.onDisconnect()
    expect(await readProcessIdentity(pid)).not.toBeNull()
    manager.setTransport(network)
    await manager.command(c)
    expect((await readFile(launchLog, 'utf8')).trim().split('\n')).toHaveLength(1)
    let stopAttempts = 0
    manager.setTransport(async (request, signal) => {
      if (request.operation === 'stopped' && ++stopAttempts === 1)
        return { type: 'project_runtime.result', ok: false, code: 'unavailable' }
      return network(request, signal)
    })
    await manager.command({ ...c, type: 'project_run_stop' })
    await until(() => row(dataDir, c.run_id)?.cleanup_complete === 1)
    expect(await readProcessIdentity(pid)).toBeNull()
    expect(await readProcessIdentity(branch)).toBeNull()
    await until(() => stopAttempts === 1)
    expect(row(dataDir, c.run_id)?.cleanup_acked).toBe(0)
    await close()
    const reopened = await open({ dataDir })
    reopened.manager.setTransport(network)
    const db = new DatabaseSync(join(dataDir, 'project-runtime.db'))
    db.prepare('UPDATE project_runtime_runs SET cleanup_next_at=0 WHERE run_id=?').run(c.run_id)
    db.close()
    await reopened.manager.command(c)
    await until(() => row(dataDir, c.run_id)?.cleanup_acked === 1)
    expect((await readFile(launchLog, 'utf8')).trim().split('\n')).toHaveLength(1)
    expect(requests.some((r) => r.operation === 'exited')).toBe(true)
  })

  it('reaps a recorded old process before persisting recovered cleanup evidence', async () => {
    const { dataDir, close } = await open()
    await close()
    const c = command()
    const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
      detached: process.platform !== 'win32',
      stdio: 'ignore',
    })
    const exited = once(child, 'exit')
    await once(child, 'spawn')
    const identity = (await readProcessIdentity(child.pid!))!
    resources.push(async () => {
      await reapProcessTree(identity)
      await exited
    })
    const record = { ...identity, role: c.run_id }
    const db = new DatabaseSync(join(dataDir, 'project-runtime.db'))
    db.prepare("INSERT INTO project_runtime_runs(run_id,lease_epoch,state) VALUES(?,?,'running')").run(
      c.run_id,
      c.lease_epoch,
    )
    db.prepare('INSERT INTO project_processes VALUES(?,?)').run(c.run_id, JSON.stringify(record))
    db.close()
    const recovered = await open({ dataDir })
    expect(await readProcessIdentity(child.pid!)).toBeNull()
    expect(row(dataDir, c.run_id)?.cleanup_complete).toBe(1)
    expect(row(dataDir, c.run_id)?.cleanup_acked).toBe(0)
    const requests: ProjectRuntimeRequest[] = []
    recovered.manager.setTransport(transport(requests))
    await until(() => row(dataDir, c.run_id)?.cleanup_acked === 1)
    expect(requests.map((r) => r.operation)).toEqual(['exited', 'stopped'])
  })

  it('retains cleanup evidence in memory until SQLite can commit it', async () => {
    const { manager, dataDir } = await open()
    const c = command()
    const requests: ProjectRuntimeRequest[] = []
    manager.setTransport(transport(requests))
    await manager.command(c)
    await until(() => requests.some((r) => r.operation === 'bootstrap'))
    const db = new DatabaseSync(join(dataDir, 'project-runtime.db'))
    db.exec(
      "CREATE TRIGGER deny_cleanup BEFORE UPDATE OF cleanup_complete ON project_runtime_runs BEGIN SELECT RAISE(FAIL, 'local storage unavailable'); END",
    )
    await manager.command({ ...c, type: 'project_run_stop' })
    await delay(300)
    expect(row(dataDir, c.run_id)?.cleanup_complete).toBe(0)
    expect(requests.some((r) => r.operation === 'stopped')).toBe(false)
    db.exec('DROP TRIGGER deny_cleanup')
    db.close()
    await until(() => row(dataDir, c.run_id)?.cleanup_acked === 1)
  })

  it('checks the old lease before sending or accepting a renewal after sleep', async () => {
    let wall = 0,
      mono = 0
    const { manager, dataDir } = await open({
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
    await manager.command(c)
    await until(() => pid > 0)
    mono = wall = 110
    await until(() => renewals === 2)
    wall = 60000
    release(success({ lease_seconds: 60, control_receipts: 1 }))
    await until(() => row(dataDir, c.run_id)?.cleanup_complete === 1)
    expect(await readProcessIdentity(pid)).toBeNull()
    expect(renewals).toBe(2)
    await manager.command(c)
    expect(renewals).toBe(2)
  })

  it('keeps old intents without cleanup evidence unconfirmed and makes stop-before-start durable', async () => {
    const { manager, dataDir, close } = await open()
    const old = command(),
      stopped = command()
    const db = new DatabaseSync(join(dataDir, 'project-runtime.db'))
    db.prepare("INSERT INTO project_runtime_runs(run_id,lease_epoch,state) VALUES(?,?,'starting')").run(
      old.run_id,
      old.lease_epoch,
    )
    db.close()
    await close()
    const reopened = await open({ dataDir })
    const requests: ProjectRuntimeRequest[] = []
    reopened.manager.setTransport(transport(requests))
    await reopened.manager.command({ ...old, type: 'project_run_stop' })
    await reopened.manager.command(old)
    await reopened.manager.command({ ...stopped, type: 'project_run_stop' })
    await reopened.manager.command(stopped)
    await until(() => row(dataDir, stopped.run_id)?.cleanup_acked === 1)
    expect(row(dataDir, old.run_id)?.cleanup_complete).toBe(0)
    expect(requests.filter((r) => r.run_id === old.run_id && r.operation === 'stopped')).toEqual([])
    expect(requests.filter((r) => r.operation === 'bootstrap')).toEqual([])
    await manager.close()
  })

  it('binds stdio identity, refuses host operations and waits only for a bound Thread version', async () => {
    const { manager, dataDir } = await open({}, 'exercise')
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
    await manager.command(c)
    await until(() => pending)
    await manager.command({
      ...c,
      lease_epoch: c.lease_epoch - 1,
      type: 'project_run_wake',
      input_ids: [12],
      thread_updates: [{ thread_id: thread, version: 100 }],
    })
    await delay(20)
    expect(requests.some((r) => r.operation === 'wait_tool')).toBe(false)
    // Wake repeatedly covers the process response/poll scheduling boundary; duplicates merge.
    await until(async () => {
      await manager.command({
        ...c,
        type: 'project_run_wake',
        input_ids: [11],
        thread_updates: [{ thread_id: thread, version: 4 }],
      })
      return requests.some((r) => r.operation === 'finish')
    })
    await until(() => row(dataDir, c.run_id)?.cleanup_acked === 1)
    expect(requests.some((r) => r.operation === 'wake_received')).toBe(true)
    expect(requests.filter((r) => r.operation === 'renew')).toHaveLength(1)
  })

  it('uses the existing real Runtime with the local faux provider through stdio', async () => {
    const loader = createRequire(new URL('../../../../runtimes/project-agent/package.json', import.meta.url)).resolve(
      'tsx',
    )
    const { manager, dataDir } = await open({
      runtimeCommand: { file: process.execPath, args: ['--import', loader, fixture, 'real-runtime'] },
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
          return success({ events, last_seq: events.length, next_after_seq: events.length, has_more: false } as never)
        case 'claim_inputs': {
          if (!queued) return success({})
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
          return success({ event })
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
    await manager.command(c)
    await until(() => row(dataDir, c.run_id)?.cleanup_acked === 1, 10000)
    expect(tools).toBe(1)
    expect(events.map((e) => e.kind)).toEqual(['input', 'assistant', 'tool_result', 'assistant', 'compaction'])
  })
})
