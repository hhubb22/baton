import { randomUUID } from 'node:crypto'
import { mkdir, readFile, rm } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { DatabaseSync } from 'node:sqlite'
import { Deferred, Effect, Exit, Fiber, Schema, Scope, Stream } from 'effect'
import { build } from 'esbuild'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vite-plus/test'
import { ThreadReport as ThreadReportSchema, type WorkerOpenConfig, type WorkerRequest } from '@baton/protocol'
import { connectAgentHost } from '../../agent-host/transport.ts'
import { startProcessWatchdog, type ProcessWatchdog } from '../../platform/process.ts'
import type { AgentEvent, AgentMessage, ThreadAgent } from '../../worker/agent.ts'
import { makeWorker, type Worker } from '../../worker/index.ts'
import type { ProcessRecordCallbacks } from '../../platform/process-types.ts'
import { makePrivateTempDirectory } from '../../testing/private.ts'
import { replayProcessRecords, workerProcessRecords } from '../../testing/platform/process-records.ts'
import { makeKiroAgentFactory } from './index.ts'
import { kiroTurnFailure } from './failure.ts'
import {
  authenticationFailure,
  failedThenCompleted,
  firstTurnOnly,
  frameMethod,
  kiroFixturePath,
  missingOnly,
  probeOnly,
  readKiroTranscript,
  resumedOnly,
  segment,
  sentOnly,
  twoTurns,
  writeKiroTranscript,
  type Transcript,
} from '../../testing/kiro/transcripts.ts'

const source = fileURLToPath(new URL('../../testing/kiro/replay-host.ts', import.meta.url))
const replaySource = fileURLToPath(
  new URL(
    '../../../../../upstream/t3code/packages/provider-acp-registry/src/testing/acp-replay-agent.ts',
    import.meta.url,
  ),
)
const watchdogSource = fileURLToPath(new URL('../../testing/platform/watchdog-entry.ts', import.meta.url))
const bundle = fileURLToPath(new URL('../../../dist/test/kiro-replay-host.mjs', import.meta.url))
const watchdogBundle = fileURLToPath(new URL('../../../dist/test/kiro-watchdog.mjs', import.meta.url))
const agents: ThreadAgent[] = []
const fibers: Fiber.Fiber<unknown, unknown>[] = []
const directories: string[] = []
let watchdog: ProcessWatchdog | undefined

beforeAll(async () => {
  await mkdir(dirname(bundle), { recursive: true })
  for (const [entry, outfile] of [
    [source, bundle],
    [replaySource, join(dirname(bundle), 'kiro-replay-agent.mjs')],
    [watchdogSource, watchdogBundle],
  ]) {
    await build({
      entryPoints: [entry],
      outfile,
      bundle: true,
      platform: 'node',
      format: 'esm',
      target: 'node26',
      banner: { js: "import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);" },
      logLevel: 'silent',
    })
  }
  if (process.platform !== 'win32')
    watchdog = await startProcessWatchdog({ file: process.execPath, args: [watchdogBundle] })
})

afterAll(async () => {
  await watchdog?.close()
})

afterEach(async () => {
  for (const fiber of fibers.splice(0)) await Effect.runPromise(Fiber.interrupt(fiber))
  for (const agent of agents.splice(0)) {
    expect((await Effect.runPromise(agent.reap())).processTreeStopped).toBe(true)
  }
  for (const directory of directories.splice(0)) {
    expect(replayProcessRecords(directory).list()).toEqual([])
    await rm(directory, { recursive: true, force: true })
  }
})

const effect = <A, E>(program: Effect.Effect<A, E>) => Effect.runPromise(program)

const workspace = async (): Promise<WorkerOpenConfig> => {
  const directory = await makePrivateTempDirectory('baton-kiro-thread-')
  directories.push(directory)
  return {
    thread_id: '11111111-1111-4111-8111-111111111111',
    node_id: '22222222-2222-4222-8222-222222222222',
    storage_generation: '33333333-3333-4333-8333-333333333333',
    agent_type: 'kiro',
    working_directory: directory,
    execution_timeout_seconds: 30,
    model: 'qwen3-coder-next',
    adapter_config: { state_path: join(directory, 'private', 'native.json') },
  }
}

const writeTranscript = async (config: WorkerOpenConfig, name: string, transcript: Transcript) => {
  const path = join(config.working_directory, `${name}.ndjson`)
  await writeKiroTranscript(path, transcript)
  return path
}

const factoryFor = (path: string, records?: ProcessRecordCallbacks) => (config: WorkerOpenConfig) =>
  makeKiroAgentFactory({
    command: { file: process.execPath, args: [bundle, '--transcript', path] },
    records: records ?? replayProcessRecords(config.working_directory),
    ...(watchdog ? { watchdog } : {}),
    paths: (value) => {
      const statePath = value.adapter_config.state_path
      if (statePath === undefined) throw new Error('Kiro replay requires state_path')
      return { workingDirectory: value.working_directory, privateDirectory: dirname(statePath) }
    },
  })(config)

const start = (config: WorkerOpenConfig, path: string) => {
  const agent = factoryFor(path)(config)
  agents.push(agent)
  const events: AgentEvent[] = []
  fibers.push(Effect.runFork(Stream.runForEach(agent.events, (event) => Effect.sync(() => void events.push(event)))))
  return { agent, events }
}

const message = (id: string, text = 'Complete the offline Kiro fixture turn'): AgentMessage => ({
  id,
  text,
  epoch: 1,
  operationId: `operation-${id}`,
  mode: 'queue',
})

const submit = async (agent: ThreadAgent, input: AgentMessage, confirmedSends = 0) =>
  effect(agent.send(input, await effect(agent.prepareInput(input, confirmedSends))))

const completed = async (events: AgentEvent[], count = 1) => {
  await expect
    .poll(
      () =>
        events.some((event) => event.type === 'uncertain') ||
        events.filter((event) => event.type === 'end').length >= count,
      { timeout: 10_000 },
    )
    .toBe(true)
  expect(events.filter((event) => event.type === 'uncertain')).toEqual([])
  expect(events.filter((event) => event.type === 'end')).toHaveLength(count)
}

const ReplayStatus = Schema.Struct({
  cursor: Schema.Number,
  total: Schema.Number,
  failure: Schema.optional(Schema.Unknown),
})
const status = async (path: string) =>
  Schema.decodeUnknownSync(ReplayStatus)(JSON.parse(await readFile(`${path}.status.json`, 'utf8')))

const consumed = async (path: string, transcript: Transcript) => {
  await expect
    .poll(() => status(path), { timeout: 10_000 })
    .toEqual({
      cursor: transcript.entries.length,
      total: transcript.entries.length,
    })
}

const close = async (agent: ThreadAgent, path: string, transcript: Transcript) => {
  await effect(agent.close())
  expect((await effect(agent.reap())).processTreeStopped).toBe(true)
  await consumed(path, transcript)
}

describe('Kiro Agent host', () => {
  it.each([
    { code: 'AuthenticationError', message: 'private-auth-diagnostic', authentication: true },
    { code: '-32000', message: 'Authentication required: private-auth-diagnostic', authentication: true },
    { code: '-32000', message: 'The selected model is not available', authentication: false },
    { code: null, message: 'Could not fetch authentication documentation', authentication: false },
  ])('maps authentication failures safely: $message', ({ code, message, authentication }) => {
    expect(kiroTurnFailure({ class: 'provider_error', code, message, retryable: null })).toBe(
      authentication ? 'Sign in to Kiro CLI and try again.' : 'Check Kiro CLI on this device and try again.',
    )
  })

  it.each(['authentication required', 'provider error'])(
    'ends %s safely and executes the next queued message in the same host',
    async (scenario) => {
      const config = { ...(await workspace()), model: 'baton-nonexistent-model' }
      const recording = await readKiroTranscript(kiroFixturePath('provider_error'))
      const transcript = failedThenCompleted(
        scenario === 'authentication required' ? authenticationFailure(recording) : segment(recording, 0),
        await readKiroTranscript(kiroFixturePath('simple')),
      )
      const path = await writeTranscript(config, 'failure', transcript)
      const dbPath = join(config.working_directory, 'thread.db')
      const events: AgentEvent[] = []
      const scope = await effect(Scope.make())
      const releaseFailure = await effect(Deferred.make<void>())
      let createdAgents = 0
      let reapedAgents = 0
      let closedAgents = 0
      const worker: Worker = await effect(
        makeWorker({
          dbPath,
          agentFactory: (input) => {
            createdAgents++
            const agent = factoryFor(
              path,
              workerProcessRecords(() => worker),
            )(input)
            agents.push(agent)
            return {
              ...agent,
              events: agent.events.pipe(
                Stream.tap((event) =>
                  Effect.gen(function* () {
                    events.push(event)
                    if (event.type === 'end' && event.outcome === 'failed') yield* Deferred.await(releaseFailure)
                  }),
                ),
              ),
              reap: () => {
                reapedAgents++
                return agent.reap()
              },
              close: () => {
                closedAgents++
                return agent.close()
              },
            }
          },
        }).pipe(Effect.provideService(Scope.Scope, scope)),
      )
      const reports = async () =>
        (await effect(worker.handle({ type: 'thread_pending', ok: true }))).thread_reports ?? []
      const expectedReason =
        scenario === 'authentication required'
          ? 'Sign in to Kiro CLI and try again.'
          : 'Check Kiro CLI on this device and try again.'
      let persistedReports: Awaited<ReturnType<typeof reports>> = []
      try {
        await effect(
          worker.handle({
            type: 'thread_open',
            ok: true,
            thread_id: config.thread_id,
            storage_generation: config.storage_generation,
            command_id: randomUUID(),
            open_config: config,
          }),
        )
        await expect
          .poll(async () => (await reports()).some((report) => report.kind === 'thread.opened'), { timeout: 10_000 })
          .toBe(true)
        expect(await effect(worker.records.list())).toEqual([
          { pid: expect.any(Number), creationTime: expect.any(String), role: 'kiro-host' },
        ])
        const request: WorkerRequest = {
          type: 'thread_message',
          ok: true,
          thread_id: config.thread_id,
          storage_generation: config.storage_generation,
          command_id: randomUUID(),
          client_message_id: randomUUID(),
          payload: 'Complete the offline Kiro fixture turn',
        }
        await effect(worker.handle(request))
        await expect
          .poll(async () => (await reports()).some((report) => report.kind === 'message.sent'), { timeout: 10_000 })
          .toBe(true)
        const nextRequest: WorkerRequest = {
          ...request,
          command_id: randomUUID(),
          client_message_id: randomUUID(),
          payload: 'Reply after the failed message',
        }
        await effect(worker.handle(nextRequest))
        await expect
          .poll(
            async () =>
              (await reports()).some(
                (report) =>
                  report.kind === 'message.queued' && report.client_message_id === nextRequest.client_message_id,
              ),
            { timeout: 10_000 },
          )
          .toBe(true)
        await effect(Deferred.succeed(releaseFailure, undefined))
        await expect
          .poll(async () => (await reports()).filter((report) => report.kind === 'turn.ended').length, {
            timeout: 10_000,
          })
          .toBe(2)
        await consumed(path, transcript)
        await effect(worker.handle(request))
        persistedReports = await reports()
        expect(persistedReports.filter((report) => report.kind === 'turn.ended')).toEqual([
          expect.objectContaining({
            client_message_id: request.client_message_id,
            reason: 'failed',
            content: expectedReason,
            queue_empty: false,
          }),
          expect.objectContaining({
            client_message_id: nextRequest.client_message_id,
            reason: 'completed',
            queue_empty: true,
          }),
        ])
        expect(persistedReports.filter((report) => report.kind === 'reply')).toEqual([
          expect.objectContaining({
            client_message_id: nextRequest.client_message_id,
            content: expect.stringContaining('baton-kiro-ok'),
          }),
        ])
        expect(persistedReports.filter((report) => report.kind === 'message.sent')).toHaveLength(2)
        expect(persistedReports.filter((report) => report.kind.endsWith('.unknown'))).toEqual([])
        expect(events.filter((event) => event.type === 'end')).toEqual([
          expect.objectContaining({ type: 'end', outcome: 'failed', reason: expectedReason }),
          expect.objectContaining({ type: 'end', outcome: 'completed' }),
        ])
        const database = new DatabaseSync(dbPath, { readOnly: true })
        try {
          const row = Schema.decodeUnknownSync(Schema.Struct({ payload: Schema.String }))(
            database.prepare('SELECT payload FROM thread_meta WHERE id = 1').get(),
          )
          const meta = Schema.decodeUnknownSync(
            Schema.fromJsonString(
              Schema.Struct({
                phase: Schema.String,
                nativeId: Schema.String,
                processTreeStopped: Schema.optional(Schema.Boolean),
              }),
            ),
          )(row.payload)
          expect(meta.phase).toBe('idle')
          expect(meta.nativeId).toBe('native-session-1')
          expect(meta.processTreeStopped).not.toBe(true)
          const messages = Schema.decodeUnknownSync(Schema.Array(Schema.Struct({ payload: Schema.String })))(
            database.prepare('SELECT payload FROM thread_messages ORDER BY rowid').all(),
          )
          expect(
            messages.map((entry) =>
              Schema.decodeUnknownSync(
                Schema.fromJsonString(Schema.Struct({ state: Schema.String, ended: Schema.Boolean })),
              )(entry.payload),
            ),
          ).toEqual([
            { state: 'sent', ended: true },
            { state: 'sent', ended: true },
          ])
        } finally {
          database.close()
        }
        expect(JSON.stringify(persistedReports)).not.toContain('private-auth-diagnostic')
        expect(JSON.stringify(persistedReports)).not.toContain('Request ID:')
        expect(createdAgents).toBe(1)
        expect(reapedAgents).toBe(0)
        expect(closedAgents).toBe(0)
      } finally {
        await effect(Scope.close(scope, Exit.void))
      }
      const database = new DatabaseSync(dbPath, { readOnly: true })
      try {
        const rows = Schema.decodeUnknownSync(Schema.Array(Schema.Struct({ payload: Schema.String })))(
          database.prepare('SELECT payload FROM thread_outbox ORDER BY seq').all(),
        )
        const stored = rows.map(
          (row) =>
            Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Struct({ report: ThreadReportSchema })))(row.payload)
              .report,
        )
        expect(stored).toEqual(persistedReports)
        expect(stored.filter((report) => report.kind === 'thread.unknown')).toEqual([])
        expect(stored.find((report) => report.kind === 'turn.ended' && report.reason === 'failed')?.content).toBe(
          expectedReason,
        )
        await consumed(path, transcript)
        expect(createdAgents).toBe(1)
      } finally {
        database.close()
      }
    },
    20_000,
  )

  it('probes an empty session without prompting and preserves unknown authentication', async () => {
    const config = await workspace()
    const transcript = probeOnly(await readKiroTranscript(kiroFixturePath('simple')))
    const path = await writeTranscript(config, 'probe', transcript)
    const controller = new AbortController()
    const host = await effect(
      connectAgentHost(
        {
          agentType: 'kiro',
          command: { file: process.execPath, args: [bundle, '--transcript', path] },
          records: replayProcessRecords(config.working_directory),
          paths: {
            workingDirectory: config.working_directory,
            privateDirectory: join(config.working_directory, 'private'),
          },
          ...(watchdog ? { watchdog } : {}),
        },
        controller.signal,
      ),
    )
    try {
      expect(await effect(host.probe)).toMatchObject({
        authenticated: 'unknown',
        details: { installed: true, version: '2.32.0' },
      })
      await consumed(path, transcript)
    } finally {
      controller.abort()
      await effect(host.disconnect)
      expect((await effect(host.reap)).processTreeStopped).toBe(true)
    }
  })

  it('maps two completed turns to distinct executions in one native session', async () => {
    const config = await workspace()
    const transcript = twoTurns(await readKiroTranscript(kiroFixturePath('simple')))
    const path = await writeTranscript(config, 'two-turns', transcript)
    const { agent, events } = start(config, path)
    const opened = await effect(agent.open(config))
    expect(opened.nativeSessionId).toBe('native-session-1')
    expect(replayProcessRecords(config.working_directory).list()).toEqual([
      { pid: expect.any(Number), creationTime: expect.any(String), role: 'kiro-host' },
    ])
    const first = await submit(agent, message('first'))
    await completed(events)
    const second = await submit(agent, message('second'), 1)
    await completed(events, 2)
    expect(second.nativeSessionId).toBe(opened.nativeSessionId)
    expect(second.executionId).not.toBe(first.executionId)
    for (const { input, acceptance } of [
      { input: message('first'), acceptance: first },
      { input: message('second'), acceptance: second },
    ]) {
      expect(events).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            ...acceptance,
            messageId: input.id,
            type: 'reply',
            text: expect.stringContaining('baton-kiro-ok'),
          }),
          expect.objectContaining({ ...acceptance, messageId: input.id, type: 'end', outcome: 'completed' }),
        ]),
      )
    }
    await close(agent, path, transcript)
  })

  it('resumes in a fresh host without emitting loaded history as a fresh reply', async () => {
    const config = await workspace()
    const recording = await readKiroTranscript(kiroFixturePath('restore_recall'))
    const created = firstTurnOnly(recording)
    const firstPath = await writeTranscript(config, 'first', created)
    const first = start(config, firstPath)
    const opened = await effect(first.agent.open(config))
    await submit(first.agent, message('first'))
    await completed(first.events)
    await close(first.agent, firstPath, created)
    const restored = resumedOnly(recording)
    const restoredPath = await writeTranscript(config, 'resumed', restored)
    const resumed = start(config, restoredPath)
    expect(await effect(resumed.agent.resume(opened.nativeSessionId, config))).toEqual(opened)
    expect(resumed.events).toEqual([])
    const accepted = await submit(resumed.agent, message('recall'), 1)
    await completed(resumed.events)
    expect(resumed.events.filter((event) => event.type === 'reply')).toEqual([
      expect.objectContaining({ ...accepted, messageId: 'recall', text: 'kiwi-saved-history' }),
    ])
    await close(resumed.agent, restoredPath, restored)
  })

  it('reports restore_missing as a failed resume and keeps the persisted mapping', async () => {
    const config = await workspace()
    const recording = await readKiroTranscript(kiroFixturePath('restore_missing'))
    const created = firstTurnOnly(recording)
    const firstPath = await writeTranscript(config, 'first', created)
    const first = start(config, firstPath)
    const opened = await effect(first.agent.open(config))
    await close(first.agent, firstPath, created)
    const statePath = config.adapter_config.state_path
    if (!statePath) throw new Error('Kiro replay requires state_path')
    const persisted = await readFile(statePath, 'utf8')
    const missing = missingOnly(recording)
    const path = await writeTranscript(config, 'missing', missing)
    const resumed = start(config, path)
    await expect(effect(resumed.agent.resume(opened.nativeSessionId, config))).rejects.toThrow(/Kiro.*resume/u)
    expect(resumed.events).toEqual([])
    expect(await readFile(statePath, 'utf8')).toBe(persisted)
    expect((await effect(resumed.agent.reap())).processTreeStopped).toBe(true)
    await consumed(path, missing)
  })

  it.each(['interrupt_before_turn_started', 'interrupt_mid_tool'])(
    'stops and reaps %s through the real adapter',
    async (name) => {
      const config = await workspace()
      const transcript = segment(await readKiroTranscript(kiroFixturePath(name)), 0)
      const path = await writeTranscript(config, name, transcript)
      const { agent, events } = start(config, path)
      await effect(agent.open(config))
      const input = message('cancelled')
      const preparation = await effect(agent.prepareInput(input, 0))
      const sending = effect(agent.send(input, preparation))
      const cancelIndex = transcript.entries.findIndex(
        (entry) => entry.type === 'expect_outbound' && frameMethod(entry) === 'session/cancel',
      )
      if (cancelIndex < 0) throw new Error('Kiro interrupt fixture has no cancel')
      // The mid-tool cursor passes the recorded allow_once response and running tool update.
      await expect.poll(async () => (await status(path)).cursor, { timeout: 10_000 }).toBe(cancelIndex)
      await effect(agent.abort())
      await sending
      await completed(events)
      if (name === 'interrupt_mid_tool')
        expect(events.find((event) => event.type === 'end')).toMatchObject({ outcome: 'cancelled' })
      expect((await effect(agent.reap())).processTreeStopped).toBe(true)
      await consumed(path, transcript)
    },
    20_000,
  )

  it.each(['matching input', 'already confirmed', 'different text'])(
    'checks sent history for %s without emitting execution events',
    async (scenario) => {
      const config = await workspace()
      const recording = await readKiroTranscript(kiroFixturePath('restore_recall'))
      const created = firstTurnOnly(recording)
      const firstPath = await writeTranscript(config, 'first', created)
      const first = start(config, firstPath)
      const opened = await effect(first.agent.open(config))
      const input = message('sent')
      const preparation = await effect(first.agent.prepareInput(input, 0))
      await effect(first.agent.send(input, preparation))
      await completed(first.events)
      await close(first.agent, firstPath, created)
      const history = sentOnly(recording, input.text)
      const path = await writeTranscript(config, 'sent', history)
      const reader = start(config, path)
      const candidate = scenario === 'different text' ? { ...input, text: 'Unrecorded input' } : input
      const evidence = scenario === 'already confirmed' ? { ...preparation, confirmedSends: 1 } : preparation
      const result = await effect(reader.agent.sent(candidate, evidence))
      if (scenario === 'matching input') expect(result).toEqual({ ...opened, executionId: expect.any(String) })
      else expect(result).toBeUndefined()
      expect(reader.events).toEqual([])
      await consumed(path, history)
      await effect(reader.agent.close())
    },
    20_000,
  )
})
