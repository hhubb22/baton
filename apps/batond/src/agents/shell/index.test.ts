import { randomUUID } from 'node:crypto'
import { access, mkdtemp, readFile, realpath, rm, symlink, unlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Deferred, Effect, Stream } from 'effect'
import type { WorkerOpenConfig, WorkerRequest, ThreadReport } from '@baton/protocol'
import { afterEach, describe, expect, it, vi } from 'vite-plus/test'
import { ensurePrivateDirectory, writePrivateFileAtomic } from '../../platform/private.ts'
import {
  readProcessIdentity,
  reapProcessTree,
  startProcessWatchdog,
  type ProcessWatchdog,
} from '../../platform/process.ts'
import { makeWorker, type AgentMessage, type ThreadAgent, type Worker } from '../../worker/index.ts'
import { completionPath, loadCompletion, loadMapping } from './evidence.ts'
import { makeShellAgentFactory } from './index.ts'
import { BoundedOutput } from './output.ts'
import { FullOutputStore } from '../../worker/full-output.ts'

const run = Effect.runPromise
const roots: string[] = []
const agents: ThreadAgent[] = []
const watchdogs: ProcessWatchdog[] = []
afterEach(async () => {
  for (const agent of agents.splice(0)) {
    await run(agent.close())
    await run(agent.reap())
  }
  for (const watchdog of watchdogs.splice(0)) await watchdog.close()
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
})
const quote = (text: string) => `'${text.replaceAll("'", "'\\''")}'`
const exists = async (path: string) =>
  access(path).then(
    () => true,
    () => false,
  )
const message = (text: string): AgentMessage => ({
  id: randomUUID(),
  text,
  epoch: 0,
  operationId: randomUUID(),
  mode: 'queue',
})
async function fixture() {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'baton-shell-')))
  roots.push(root)
  const cwd = join(root, 'workspace')
  await ensurePrivateDirectory(cwd)
  await writePrivateFileAtomic(join(root, 'browse-roots.json'), JSON.stringify({ roots: [{ id: 'work', path: cwd }] }))
  await writePrivateFileAtomic(join(root, 'project-exec.json'), JSON.stringify({ enabled: true, shell: '/bin/sh' }))
  const config: WorkerOpenConfig = {
    thread_id: randomUUID(),
    node_id: randomUUID(),
    storage_generation: randomUUID(),
    agent_type: 'shell',
    project_id: randomUUID(),
    origin_conversation_id: randomUUID(),
    origin_tool_call_id: 'tool:exec:1',
    working_directory: cwd,
    execution_timeout_seconds: 7200,
    adapter_config: { home: root, state_path: join(root, 'native.json') },
  }
  const watchdog = await startProcessWatchdog({
    file: process.execPath,
    args: [fileURLToPath(new URL('../../testing/platform/process.mjs', import.meta.url)), 'watchdog'],
  })
  watchdogs.push(watchdog)
  const factory = makeShellAgentFactory({ dataDirectory: root, watchdog })
  const create = (cfg = config) => {
    const agent = factory(cfg)
    agents.push(agent)
    return agent
  }
  return { root, cwd, config, factory, create, watchdog }
}
const takeEvents = (agent: ThreadAgent, count = 2) =>
  run(Stream.runCollect(Stream.take(agent.events, count)).pipe(Effect.timeout('5 seconds')))

describe('shell output retention', () => {
  it('keeps first/tail 16 KiB across arbitrary chunk boundaries and marks the byte count', () => {
    const output = new BoundedOutput()
    output.write(Buffer.from('a'.repeat(16383)))
    output.write(Buffer.from('a' + 'x'.repeat(20000) + 'z'.repeat(16384)))
    expect(output.result(7)).toEqual({
      output: 'a'.repeat(16384) + 'z'.repeat(16384),
      exit_code: 7,
      total_bytes: 52768,
      truncated: true,
    })
  })
  it.each([Buffer.from([0, 255, 10]), Buffer.from('a\u0085b')])(
    'base64 encodes non-display or invalid bytes',
    (bytes) => {
      const output = new BoundedOutput()
      output.write(bytes)
      expect(output.result(0)).toEqual({
        output: bytes.toString('base64'),
        encoding: 'base64',
        exit_code: 0,
        total_bytes: bytes.length,
        truncated: false,
      })
    },
  )
})

describe.skipIf(process.platform === 'win32')('restricted shell Thread', () => {
  it('saves completion before emitting a reply, replays matching evidence once, and never repeats a command', async () => {
    const f = await fixture()
    const agent = f.create()
    await run(agent.open(f.config))
    const input = message(`printf ran >> ${quote(join(f.cwd, 'effects'))}; printf out; printf err >&2; exit 7`)
    const prep = await run(agent.prepareInput(input, 0))
    const events = takeEvents(agent)
    const acceptance = await run(agent.send(input, prep))
    const result = await events
    expect(result.map((e) => e.type)).toEqual(['reply', 'end'])
    const record = await loadCompletion(await loadMapping(f.config))
    expect(record.result.exit_code).toBe(7)
    expect(record.result.total_bytes).toBe(6)
    expect(record.result.output).toContain('out')
    expect(record.result.output).toContain('err')
    expect(result[0]).toMatchObject({ metadata: { exit_code: 7 }, original_bytes: 6, truncated: false })
    await expect(run(agent.prepareInput(message('echo second'), 0))).rejects.toThrow('only one')
    const recovered = f.create()
    await run(recovered.restoreInput(input, prep))
    const replay = takeEvents(recovered)
    expect(await run(recovered.sent(input, prep))).toEqual(acceptance)
    expect(await replay).toEqual(result)
    expect(await run(recovered.sent(input, prep))).toEqual(acceptance)
    await expect(run(recovered.resume(acceptance.nativeSessionId, f.config))).rejects.toThrow('attempted')
    await expect(run(f.create().open(f.config))).rejects.toThrow('mapping already exists')
    expect(await readFile(join(f.cwd, 'effects'), 'utf8')).toBe('ran')
    await expect(run(f.create({ ...f.config, project_id: randomUUID() }).sent(input, prep))).rejects.toThrow('identity')
    await expect(run(f.create().sent({ ...input, text: 'different command' }, prep))).rejects.toThrow('preparation')
  })

  it('retains fast output even when watchdog registration finishes after process exit', async () => {
    const f = await fixture()
    const factory = makeShellAgentFactory({
      dataDirectory: f.root,
      watchdog: {
        ...f.watchdog,
        async register(record) {
          await f.watchdog.register(record)
          await vi.waitFor(async () => expect(await readProcessIdentity(record.pid)).toBeNull())
        },
      },
    })
    const agent = factory(f.config)
    agents.push(agent)
    await run(agent.open(f.config))
    const input = message('printf immediate')
    const prep = await run(agent.prepareInput(input, 0))
    const events = takeEvents(agent)
    await run(agent.send(input, prep))
    expect((await events)[0]).toMatchObject({ type: 'reply', text: 'immediate', original_bytes: 9 })
  })

  it('spools raw command output before summary clipping and recovers its omitted middle', async () => {
    const f = await fixture()
    const agent = f.create()
    await run(agent.open(f.config))
    const input = message(
      `printf HEAD; i=0; while [ "$i" -lt 12000 ]; do printf 'MIDDLE🙂'; i=$((i + 1)); done; printf TAIL`,
    )
    const prep = await run(agent.prepareInput(input, 0))
    const events = takeEvents(agent)
    await run(agent.send(input, prep))
    await events
    const completion = await loadCompletion(await loadMapping(f.config))
    expect(completion.result.truncated).toBe(true)
    const reference = completion.result.full_output
    if (!reference) throw new Error('Expected a full shell output reference')
    const store = new FullOutputStore(join(f.root, 'threads', f.config.thread_id))
    const pages: Buffer[] = []
    let cursor: string | undefined
    for (let count = 0; count < 100; count++) {
      const result = await store.read({
        type: 'session.request',
        action: 'full_output',
        operation_id: randomUUID(),
        session_id: f.config.thread_id,
        storage_generation: reference.storage_generation,
        output_id: reference.id,
        ...(cursor === undefined ? {} : { cursor }),
      })
      expect(result.ok).toBe(true)
      if (!result.full_output) throw new Error('Expected a full shell output page')
      pages.push(Buffer.from(result.full_output.data, 'base64'))
      cursor = result.cursor
      if (result.full_output.done) break
    }
    expect(Buffer.concat(pages).toString('utf8')).toBe('HEAD' + 'MIDDLE🙂'.repeat(12000) + 'TAIL')
  })

  it('rechecks local permission immediately before launch and refuses absent Project origin', async () => {
    const f = await fixture()
    const { project_id: _project, ...withoutOrigin } = f.config
    await expect(run(f.create(withoutOrigin).open(withoutOrigin))).rejects.toThrow()
    const agent = f.create()
    await run(agent.open(f.config))
    const input = message(`touch ${quote(join(f.cwd, 'effect'))}`)
    const prep = await run(agent.prepareInput(input, 0))
    await writePrivateFileAtomic(
      join(f.root, 'project-exec.json'),
      JSON.stringify({ enabled: false, shell: '/bin/sh' }),
    )
    await expect(run(agent.send(input, prep))).rejects.toThrow('未开启')
    expect(await exists(join(f.cwd, 'effect'))).toBe(false)
    expect(await run(f.create().sent(input, prep))).toBeUndefined()
  })

  it('rejects a working directory symlink escaping the authorized root', async () => {
    const f = await fixture()
    const outside = join(f.root, 'outside')
    await ensurePrivateDirectory(outside)
    const link = join(f.cwd, 'escape')
    await symlink(outside, link)
    const cfg = { ...f.config, working_directory: link }
    await expect(run(f.create(cfg).open(cfg))).rejects.toThrow('shell state or execution')
  })

  it('cancels the owned process group and records unknown side effects', async () => {
    const f = await fixture()
    const agent = f.create()
    await run(agent.open(f.config))
    const pidfile = join(f.cwd, 'child.pid')
    const input = message(`sleep 60 & echo $! > ${quote(pidfile)}; wait`)
    const prep = await run(agent.prepareInput(input, 0))
    const events = takeEvents(agent)
    await run(agent.send(input, prep))
    await vi.waitFor(async () => expect(await exists(pidfile)).toBe(true))
    const pid = Number(await readFile(pidfile, 'utf8'))
    await run(agent.abort())
    expect(await run(agent.reap())).toEqual({ processTreeStopped: true })
    expect((await events).map((e) => e.type)).toEqual(['reply', 'uncertain'])
    await vi.waitFor(async () => expect(await readProcessIdentity(pid)).toBeNull())
    expect((await loadCompletion(await loadMapping(f.config))).completionKind).toBe('stopped')
  })
})

const request = (
  config: WorkerOpenConfig,
  type: 'thread_open' | 'thread_message' | 'thread_resume' | 'thread_stop',
  fields: Partial<WorkerRequest> = {},
): WorkerRequest =>
  ({
    type,
    ok: true,
    command_id: randomUUID(),
    thread_id: config.thread_id,
    storage_generation: config.storage_generation,
    ...(type === 'thread_open' ? { open_config: config } : {}),
    ...fields,
  }) as WorkerRequest
const reports = async (worker: Worker): Promise<readonly ThreadReport[]> =>
  (await run(worker.handle({ type: 'thread_pending', ok: true }))).thread_reports ?? []
async function waitReport(worker: Worker, kind: ThreadReport['kind']) {
  let result: readonly ThreadReport[] = []
  await vi.waitFor(
    async () => {
      result = await reports(worker)
      expect(result.some((r) => r.kind === kind)).toBe(true)
    },
    { timeout: 5000 },
  )
  return result
}
const recoverProcesses = (records: readonly import('../../platform/process.ts').ProcessRecord[]) =>
  Effect.promise(async () => {
    const results = await Promise.all(records.map((record) => reapProcessTree(record)))
    return { processTreeStopped: results.every((result) => result.reaped) }
  })

describe.skipIf(process.platform === 'win32')('shell Worker durability', () => {
  it('restores an opened shell before its first intent and dispatches the command once', async () => {
    const f = await fixture()
    const dbPath = join(f.root, 'thread.db')
    await run(
      Effect.scoped(
        Effect.gen(function* () {
          const worker = yield* makeWorker({ dbPath, agentFactory: f.factory, recoverProcesses })
          const { origin_tool_call_id: _origin, ...withoutOrigin } = f.config
          expect((yield* worker.handle(request(withoutOrigin, 'thread_open'))).code).toBe('invalid_shell_origin')
          yield* worker.handle(request(f.config, 'thread_open'))
          yield* Effect.promise(() => waitReport(worker, 'thread.opened'))
        }),
      ),
    )
    await run(
      Effect.scoped(
        Effect.gen(function* () {
          const worker = yield* makeWorker({ dbPath, agentFactory: f.factory, recoverProcesses })
          yield* Effect.promise(() =>
            vi.waitFor(async () =>
              expect((await run(worker.handle({ type: 'status', ok: true }))).agent_ready).toBe(true),
            ),
          )
          yield* worker.handle(
            request(f.config, 'thread_message', { client_message_id: 'first', payload: 'printf restored' }),
          )
          const result = yield* Effect.promise(() => waitReport(worker, 'thread.stopped'))
          expect(result.filter((r) => r.kind === 'reply').map((r) => r.content)).toEqual(['restored'])
        }),
      ),
    )
  })

  it('keeps a completed result when its queued end event arrives during stop', async () => {
    const f = await fixture()
    await run(
      Effect.scoped(
        Effect.gen(function* () {
          const gate = yield* Deferred.make<void>()
          let worker!: Worker
          worker = yield* makeWorker({
            dbPath: join(f.root, 'thread.db'),
            recoverProcesses,
            agentFactory: (config) => {
              const real = f.factory(config)
              return {
                ...real,
                events: Stream.unwrap(Deferred.await(gate).pipe(Effect.as(real.events))),
                abort: () =>
                  Effect.gen(function* () {
                    yield* Deferred.succeed(gate, undefined)
                    yield* Effect.promise(() => waitReport(worker, 'turn.ended'))
                    yield* real.abort()
                  }),
              }
            },
          })
          yield* worker.handle(request(f.config, 'thread_open'))
          yield* Effect.promise(() => waitReport(worker, 'thread.opened'))
          yield* worker.handle(
            request(f.config, 'thread_message', { client_message_id: 'completed', payload: 'printf complete' }),
          )
          yield* Effect.promise(() => waitReport(worker, 'message.sent'))
          yield* Effect.promise(() =>
            vi.waitFor(async () =>
              expect((await loadCompletion(await loadMapping(f.config))).completionKind).toBe('exited'),
            ),
          )
          yield* worker.handle(request(f.config, 'thread_stop'))
          const result = yield* Effect.promise(() => waitReport(worker, 'thread.stopped'))
          expect(result.some((r) => r.kind === 'thread.unknown')).toBe(false)
          expect(result.filter((r) => r.kind === 'reply').map((r) => r.content)).toEqual(['complete'])
        }),
      ),
    )
  })

  it('enforces the execution timeout through the same group cancellation path', async () => {
    const f = await fixture()
    const config = { ...f.config, execution_timeout_seconds: 1 }
    await run(
      Effect.scoped(
        Effect.gen(function* () {
          const worker = yield* makeWorker({
            dbPath: join(f.root, 'thread.db'),
            agentFactory: f.factory,
            recoverProcesses,
          })
          yield* worker.handle(request(config, 'thread_open'))
          yield* Effect.promise(() => waitReport(worker, 'thread.opened'))
          yield* worker.handle(
            request(config, 'thread_message', { client_message_id: 'timed-command', payload: 'sleep 60' }),
          )
          const result = yield* Effect.promise(() => waitReport(worker, 'thread.unknown'))
          expect(result.filter((r) => r.kind === 'turn.ended')).toMatchObject([{ reason: 'timeout' }])
          expect(
            (yield* worker.handle(
              request(config, 'thread_message', { client_message_id: 'retry', payload: 'echo retry' }),
            )).code,
          ).toBe('unsupported')
        }),
      ),
    )
  })

  it('preserves base64 metadata and byte counts, stops after one turn, and keeps message retries idempotent', async () => {
    const f = await fixture()
    await run(
      Effect.scoped(
        Effect.gen(function* () {
          const worker = yield* makeWorker({
            dbPath: join(f.root, 'thread.db'),
            agentFactory: f.factory,
            recoverProcesses,
          })
          yield* worker.handle(request(f.config, 'thread_open'))
          yield* Effect.promise(() => waitReport(worker, 'thread.opened'))
          const command = `${quote(process.execPath)} -e 'process.stdout.write(Buffer.alloc(40000))'`
          const input = request(f.config, 'thread_message', { client_message_id: 'shell-command', payload: command })
          yield* worker.handle(input)
          const result = yield* Effect.promise(() => waitReport(worker, 'thread.stopped'))
          const reply = result.find((r) => r.kind === 'reply')!
          expect(reply).toMatchObject({
            original_bytes: 40000,
            truncated: true,
            metadata: { exit_code: 0, encoding: 'base64' },
          })
          expect(Buffer.from(reply.content!, 'base64')).toEqual(Buffer.alloc(32768))
          expect(result.filter((r) => r.kind === 'turn.ended')).toHaveLength(1)
          expect((yield* worker.handle({ ...input, command_id: randomUUID() })).ok).toBe(true)
          expect(
            (yield* worker.handle(
              request(f.config, 'thread_message', { client_message_id: 'second', payload: 'echo second' }),
            )).code,
          ).toBe('unsupported')
          expect((yield* worker.handle(request(f.config, 'thread_resume'))).code).toBe('unsupported')
        }),
      ),
    )
  })

  it.each(['sent', 'intent', 'missing', 'mismatch'] as const)(
    'recovers %s execution without a second side effect',
    async (mode) => {
      const f = await fixture()
      const dbPath = join(f.root, 'thread.db')
      const input = request(f.config, 'thread_message', {
        client_message_id: 'only-command',
        payload: `printf ran >> ${quote(join(f.cwd, 'effects'))}; printf completed`,
      })
      const never = Effect.never
      await run(
        Effect.scoped(
          Effect.gen(function* () {
            const worker = yield* makeWorker({
              dbPath,
              recoverProcesses,
              agentFactory: (config) => {
                const real = f.factory(config)
                return {
                  ...real,
                  events: Stream.unwrap(never.pipe(Effect.as(real.events))),
                  ...(mode === 'intent'
                    ? { send: (message, prep) => real.send(message, prep).pipe(Effect.andThen(never)) }
                    : {}),
                }
              },
            })
            yield* worker.handle(request(f.config, 'thread_open'))
            yield* Effect.promise(() => waitReport(worker, 'thread.opened'))
            yield* worker.handle(input)
            yield* Effect.promise(() =>
              vi.waitFor(
                async () => {
                  expect((await loadCompletion(await loadMapping(f.config))).result.output).toBe('completed')
                },
                { timeout: 5000 },
              ),
            )
            if (mode !== 'intent') yield* Effect.promise(() => waitReport(worker, 'message.sent'))
            expect((yield* Effect.promise(() => reports(worker))).some((r) => r.kind === 'reply')).toBe(false)
          }),
        ),
      )
      const mapping = await loadMapping(f.config)
      if (mode === 'missing') await unlink(completionPath(mapping))
      if (mode === 'mismatch') {
        const record = await loadCompletion(mapping)
        await writePrivateFileAtomic(
          completionPath(mapping),
          JSON.stringify({ ...record, messageId: 'another-command' }),
        )
      }
      await run(
        Effect.scoped(
          Effect.gen(function* () {
            const worker = yield* makeWorker({ dbPath, recoverProcesses, agentFactory: f.factory })
            const result = yield* Effect.promise(() =>
              waitReport(worker, mode === 'missing' || mode === 'mismatch' ? 'thread.unknown' : 'thread.stopped'),
            )
            if (mode === 'missing' || mode === 'mismatch')
              expect(result.filter((r) => r.kind === 'reply')).toHaveLength(0)
            else {
              expect(result.filter((r) => r.kind === 'reply').map((r) => r.content)).toEqual(['completed'])
              expect(result.filter((r) => r.kind === 'turn.ended')).toHaveLength(1)
            }
            expect((yield* worker.handle({ ...input, command_id: randomUUID() })).ok).toBe(true)
            expect(yield* Effect.promise(() => readFile(join(f.cwd, 'effects'), 'utf8'))).toBe('ran')
          }),
        ),
      )
    },
  )
})
