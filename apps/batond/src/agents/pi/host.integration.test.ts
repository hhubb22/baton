import { randomUUID } from 'node:crypto'
import { mkdir, rm } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { setTimeout as delay } from 'node:timers/promises'
import { Deferred, Effect, Fiber, Predicate, Stream } from 'effect'
import { build } from 'esbuild'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vite-plus/test'
import type { ThreadReport, WorkerOpenConfig } from '@baton/protocol'
import type { PiRpcReplayTranscript } from '@t3tools/provider-pi/testing'
import { startProcessWatchdog, type ProcessWatchdog } from '../../platform/process.ts'
import { makeThreadAgentFactory } from '../thread-agents.ts'
import { agentCatalog } from '../catalog.ts'
import { makeAgentHostFactory } from '../../agent-host/thread-agent.ts'
import { AgentError, type AgentEvent, type AgentMessage, type ThreadAgent } from '../../worker/agent.ts'
import { connectAgentHost } from '../../agent-host/transport.ts'
import { makeWorker, type Worker } from '../../worker/index.ts'
import type { ProcessRecordCallbacks } from '../../platform/process-types.ts'
import { makePrivateTempDirectory } from '../../testing/private.ts'
import { replayProcessRecords, workerProcessRecords } from '../../testing/platform/process-records.ts'
import {
  firstTurnOnly,
  piFixturePath,
  readPiTranscript,
  resumedOnly,
  sentOnly,
  withQueuedFollowUp,
  writePiTranscript,
} from '../../testing/pi/transcripts.ts'

const source = fileURLToPath(new URL('../../testing/pi/replay-host.ts', import.meta.url))
const watchdogSource = fileURLToPath(new URL('../../testing/platform/watchdog-entry.ts', import.meta.url))
const bundle = fileURLToPath(new URL('../../../dist/test/pi-replay-host.mjs', import.meta.url))
const watchdogBundle = fileURLToPath(new URL('../../../dist/test/watchdog.mjs', import.meta.url))
const agents: ThreadAgent[] = []
const directories: string[] = []
const fibers: Fiber.Fiber<unknown, unknown>[] = []
let watchdog: ProcessWatchdog | undefined

beforeAll(async () => {
  await mkdir(dirname(bundle), { recursive: true })
  await build({
    entryPoints: [source],
    outfile: bundle,
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: 'node26',
    banner: { js: "import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);" },
    logLevel: 'silent',
  })
  if (process.platform !== 'win32') {
    await build({
      entryPoints: [watchdogSource],
      outfile: watchdogBundle,
      bundle: true,
      platform: 'node',
      format: 'esm',
      target: 'node26',
      logLevel: 'silent',
    })
    watchdog = await startProcessWatchdog({ file: process.execPath, args: [watchdogBundle] })
  }
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

const waitFor = async (predicate: () => boolean) => {
  const deadline = performance.now() + 10_000
  while (!predicate()) {
    if (performance.now() > deadline) throw new Error('Timed out waiting for Pi events')
    await delay(20)
  }
}

const workspace = async () => {
  const directory = await makePrivateTempDirectory('baton-pi-thread-')
  directories.push(directory)
  const config: WorkerOpenConfig = {
    thread_id: '11111111-1111-4111-8111-111111111111',
    node_id: '22222222-2222-4222-8222-222222222222',
    storage_generation: '33333333-3333-4333-8333-333333333333',
    agent_type: 'pi',
    working_directory: directory,
    execution_timeout_seconds: 30,
    model: 'openrouter/deepseek/deepseek-v4-flash',
    adapter_config: { state_path: join(directory, 'private', 'native.json') },
  }
  return config
}

const replayFactory =
  (
    transcriptFile: string,
    loseSteerReply = false,
    beforeSteerResponse?: Effect.Effect<void>,
    records?: ProcessRecordCallbacks,
  ) =>
  (config: WorkerOpenConfig) =>
    (loseSteerReply || beforeSteerResponse ? makeAgentHostFactory : makeThreadAgentFactory)({
      dataDirectory: config.working_directory,
      agentType: 'pi',
      capabilities: agentCatalog.pi.capabilities,
      command: { file: process.execPath, args: [bundle, '--transcript', transcriptFile] },
      records: records ?? replayProcessRecords(config.working_directory),
      ...(watchdog ? { watchdog } : {}),
      ...(loseSteerReply || beforeSteerResponse
        ? ({
            connect: (options, signal) =>
              Effect.gen(function* () {
                const host = yield* connectAgentHost(options, signal)
                return {
                  ...host,
                  send: (message, preparation) =>
                    host
                      .send(message, preparation)
                      .pipe(
                        Effect.flatMap((acceptance) =>
                          message.mode === 'steer'
                            ? loseSteerReply
                              ? Effect.fail(new AgentError('Replay host lost the steering response'))
                              : (beforeSteerResponse ?? Effect.void).pipe(Effect.as(acceptance))
                            : Effect.succeed(acceptance),
                        ),
                      ),
                }
              }),
          } satisfies Partial<import('../../agent-host/thread-agent.ts').HostedAgentOptions>)
        : {}),
    })(config)

const startTranscript = (config: WorkerOpenConfig, transcriptFile: string) => {
  const agent = replayFactory(transcriptFile)(config)
  agents.push(agent)
  const events: AgentEvent[] = []
  fibers.push(Effect.runFork(Stream.runForEach(agent.events, (event) => Effect.sync(() => void events.push(event)))))
  return { agent, events, config }
}

const start = async (name: string) => startTranscript(await workspace(), piFixturePath(name))

const writeTranscript = async (transcript: PiRpcReplayTranscript) => {
  const directory = await makePrivateTempDirectory('baton-pi-replay-')
  directories.push(directory)
  const path = join(directory, 'transcript.ndjson')
  await writePiTranscript(path, transcript)
  return path
}

const withSecondTurnModel = (
  transcript: PiRpcReplayTranscript,
  rejected: boolean,
  promptIndex = 1,
): PiRpcReplayTranscript => {
  const prompts = transcript.entries.flatMap((entry, index) =>
    entry.type === 'expect_outbound' && Predicate.hasProperty(entry.frame, 'type') && entry.frame.type === 'prompt'
      ? [index]
      : [],
  )
  const second = prompts[promptIndex]
  if (second === undefined) throw new Error('Pi model replay requires the target prompt')
  if (promptIndex === 0)
    return {
      ...transcript,
      metadata: {
        ...transcript.metadata,
        derivedFrom: transcript.scenario,
        purpose: 'resumed per-turn model selection',
      },
      entries: transcript.entries.map((entry) => {
        if (
          entry.type === 'expect_outbound' &&
          Predicate.hasProperty(entry.frame, 'type') &&
          entry.frame.type === 'set_model'
        )
          return { ...entry, frame: { ...entry.frame, provider: 'test-provider', modelId: 'second-model' } }
        if (
          entry.type === 'emit_inbound' &&
          Predicate.hasProperty(entry.frame, 'command') &&
          entry.frame.command === 'set_model'
        )
          return { ...entry, frame: { ...entry.frame, data: { provider: 'test-provider', id: 'second-model' } } }
        return entry
      }),
    }
  return {
    ...transcript,
    scenario: `${transcript.scenario}-model-${rejected ? 'rejected' : 'changed'}`,
    metadata: { ...transcript.metadata, derivedFrom: transcript.scenario, purpose: 'per-turn model selection' },
    entries: [
      ...transcript.entries.slice(0, second),
      {
        type: 'expect_outbound',
        frame: { type: 'set_model', provider: 'test-provider', modelId: 'second-model', id: 't3-100' },
      },
      {
        type: 'emit_inbound',
        frame: {
          type: 'response',
          command: 'set_model',
          id: 't3-100',
          success: !rejected,
          ...(rejected ? { error: 'Unknown model' } : { data: { provider: 'test-provider', id: 'second-model' } }),
        },
      },
      ...transcript.entries.slice(second),
    ],
  }
}

const workerReports = (worker: Worker) =>
  worker.handle({ type: 'thread_pending', ok: true }).pipe(Effect.map((response) => response.thread_reports ?? []))

const waitForReports = Effect.fnUntraced(function* (
  worker: Worker,
  predicate: (reports: readonly ThreadReport[]) => boolean,
) {
  while (true) {
    const reports = yield* workerReports(worker)
    if (predicate(reports)) return reports
    const failure = reports.find((report) => report.kind === 'thread.open_failed' || report.kind === 'thread.unknown')
    if (failure) return yield* Effect.fail(new Error(`Pi Worker ${failure.kind}: ${failure.reason ?? ''}`))
    yield* Effect.sleep('20 millis')
  }
}, Effect.timeout('10 seconds'))

const message = (id: string, text: string): AgentMessage => ({
  id,
  text,
  epoch: 1,
  operationId: `operation-${id}`,
  mode: 'queue',
})

describe('Pi Agent host', () => {
  it('opens a session and completes one upstream replay turn', async () => {
    const { agent, events, config } = await start('simple')
    const opened = await Effect.runPromise(agent.open(config))
    expect(opened.nativeSessionId).not.toBe('')
    expect(replayProcessRecords(config.working_directory).list()).toEqual([
      { pid: expect.any(Number), creationTime: expect.any(String), role: 'pi-host' },
    ])
    const input = message('simple-1', 'Respond with the following text: fixture simple ok')
    await Effect.runPromise(agent.send(input, await Effect.runPromise(agent.prepareInput(input, 0))))
    await waitFor(() => events.some((event) => event.type === 'end'))
    expect(
      events
        .filter((event) => event.type === 'reply')
        .map((event) => (event.type === 'reply' ? event.text : ''))
        .join(''),
    ).toContain('fixture simple ok')
    expect(events.find((event) => event.type === 'end')).toMatchObject({ outcome: 'completed' })
    await Effect.runPromise(agent.close())
    expect((await Effect.runPromise(agent.reap())).processTreeStopped).toBe(true)
  })

  it('keeps a second turn on the same native session', async () => {
    const { agent, events, config } = await start('multi_turn')
    await Effect.runPromise(agent.open(config))
    const first = message('multi-1', 'Respond with exactly: first fixture turn complete')
    await Effect.runPromise(agent.send(first, await Effect.runPromise(agent.prepareInput(first, 0))))
    await waitFor(() => events.some((event) => event.type === 'end'))
    const second = message('multi-2', 'Respond with exactly: second fixture turn complete')
    await Effect.runPromise(agent.send(second, await Effect.runPromise(agent.prepareInput(second, 1))))
    await waitFor(() => events.filter((event) => event.type === 'end').length === 2)
    expect(events.some((event) => event.type === 'uncertain')).toBe(false)
    await Effect.runPromise(agent.close())
  })

  it.each([false, true])(
    'selects a per-turn model with native rejection=%s without resending input',
    async (rejected) => {
      const transcript = withSecondTurnModel(await readPiTranscript(piFixturePath('multi_turn')), rejected)
      const { agent, events, config } = startTranscript(await workspace(), await writeTranscript(transcript))
      const opened = await Effect.runPromise(agent.open(config))
      const first = message('model-first', 'Respond with exactly: first fixture turn complete')
      await Effect.runPromise(agent.send(first, await Effect.runPromise(agent.prepareInput(first, 0))))
      await waitFor(() => events.some((event) => event.type === 'end'))
      const changed = {
        ...message('model-second', 'Respond with exactly: second fixture turn complete'),
        model: 'test-provider/second-model',
      }
      if (rejected) {
        const result = await Effect.runPromise(
          agent.send(changed, await Effect.runPromise(agent.prepareInput(changed, 1))).pipe(Effect.result),
        )
        expect(result._tag).toBe('Failure')
        if (result._tag === 'Failure') expect(result.failure.modelRejected).toBe(true)
        expect(events.some((event) => event.type === 'uncertain')).toBe(false)
      }
      const next = rejected ? message('corrected-model', changed.text) : changed
      const accepted = await Effect.runPromise(agent.send(next, await Effect.runPromise(agent.prepareInput(next, 1))))
      await waitFor(() => events.filter((event) => event.type === 'end').length === 2)
      expect(accepted.nativeSessionId).toBe(opened.nativeSessionId)
      expect(events.filter((event) => event.type === 'end').map((event) => event.messageId)).toEqual([
        first.id,
        next.id,
      ])
      expect(events.some((event) => event.type === 'uncertain')).toBe(false)
      await Effect.runPromise(agent.close())
    },
  )

  it('cancels a turn while a tool is running', async () => {
    const { agent, events, config } = await start('turn_interrupt_mid_tool')
    await Effect.runPromise(agent.open(config))
    const input = message(
      'interrupt-1',
      'Run this exact local command: `node -e "console.log(\'interrupt fixture tool started\'); setTimeout(() => {}, 30000)"`. Do not answer until it completes, then respond exactly: interrupt fixture should not finish naturally.',
    )
    await Effect.runPromise(agent.send(input, await Effect.runPromise(agent.prepareInput(input, 0))))
    await delay(100)
    await Effect.runPromise(agent.abort())
    await waitFor(() => events.some((event) => event.type === 'end'))
    expect(events.find((event) => event.type === 'end')).toMatchObject({ outcome: 'cancelled' })
  })

  it('resumes the native session in a fresh host and continues its conversation', async () => {
    const transcript = await readPiTranscript(piFixturePath('provider_thread_resume'))
    const first = await writeTranscript(firstTurnOnly(transcript))
    const second = await writeTranscript(withSecondTurnModel(resumedOnly(transcript), false, 0))
    const config = await workspace()
    const { agent, events } = startTranscript(config, first)
    const opened = await Effect.runPromise(agent.open(config))
    const input = message('resume-1', 'Respond with exactly: provider thread resume fixture first turn complete')
    await Effect.runPromise(agent.send(input, await Effect.runPromise(agent.prepareInput(input, 0))))
    await waitFor(() => events.some((event) => event.type === 'end'))
    await Effect.runPromise(agent.close())
    expect((await Effect.runPromise(agent.reap())).processTreeStopped).toBe(true)

    const resumed = startTranscript(config, second)
    expect(await Effect.runPromise(resumed.agent.resume(opened.nativeSessionId, config))).toEqual(opened)
    const next = {
      ...message(
        'resume-2',
        'Using the conversation history available in this resumed thread, first repeat the exact final answer you gave in the previous turn. Then on a new line write exactly: provider thread resume fixture second turn complete',
      ),
      model: 'test-provider/second-model',
    }
    const accepted = await Effect.runPromise(
      resumed.agent.send(next, await Effect.runPromise(resumed.agent.prepareInput(next, 1))),
    )
    await waitFor(() => resumed.events.some((event) => event.type === 'end'))
    expect(accepted.nativeSessionId).toBe(opened.nativeSessionId)
    expect(resumed.events.some((event) => event.type === 'uncertain')).toBe(false)
    const replies = resumed.events.flatMap((event) => (event.type === 'reply' ? [event.text] : [])).join('\n')
    expect(replies).toContain('provider thread resume fixture first turn complete')
    expect(replies).toContain('provider thread resume fixture second turn complete')
    expect(resumed.events.find((event) => event.type === 'end')).toMatchObject({
      outcome: 'completed',
      messageId: next.id,
      nativeSessionId: opened.nativeSessionId,
    })
    await Effect.runPromise(resumed.agent.close())
  }, 20_000)

  it('confirms sent only for the next matching native user message before resume', async () => {
    const simple = await readPiTranscript(piFixturePath('simple'))
    const { agent, events, config } = await start('simple')
    const opened = await Effect.runPromise(agent.open(config))
    const input = message('sent-1', 'Respond with the following text: fixture simple ok')
    const preparation = await Effect.runPromise(agent.prepareInput(input, 0))
    await Effect.runPromise(agent.send(input, preparation))
    await waitFor(() => events.some((event) => event.type === 'end'))
    await Effect.runPromise(agent.close())
    expect((await Effect.runPromise(agent.reap())).processTreeStopped).toBe(true)

    const snapshot = await writeTranscript(sentOnly(simple))
    const reader = startTranscript(config, snapshot)
    await Effect.runPromise(reader.agent.restoreInput(input, preparation))
    expect(await Effect.runPromise(reader.agent.sent(input, preparation))).toMatchObject({
      nativeSessionId: opened.nativeSessionId,
      executionId: expect.any(String),
    })
    expect(await Effect.runPromise(reader.agent.sent(input, { ...preparation, confirmedSends: 1 }))).toBeUndefined()
    expect(
      await Effect.runPromise(reader.agent.sent({ ...input, text: 'an unsent input' }, preparation)),
    ).toBeUndefined()
    expect(reader.events.filter((event) => event.type === 'reply' || event.type === 'end')).toEqual([])
    expect((await Effect.runPromise(reader.agent.reap())).processTreeStopped).toBe(true)
  }, 20_000)

  it('records an unconfirmed steering input as unknown and keeps its receipt on retry', async () => {
    const transcript = await readPiTranscript(piFixturePath('message_steering'))
    const index = transcript.entries.findIndex(
      (entry) =>
        entry.type === 'expect_outbound' &&
        Predicate.hasProperty(entry.frame, 'streamingBehavior') &&
        entry.frame.streamingBehavior === 'steer' &&
        Predicate.hasProperty(entry.frame, 'message') &&
        entry.frame.message === 'Actually, respond with exactly: steering fixture observed',
    )
    if (index < 0) throw new Error('Upstream steering transcript has no steering request')
    // Pi sends steer without awaiting its native ack. Drop the host response through the connection seam,
    // while the upstream transcript closes native stdout after the write.
    const file = await writeTranscript({
      ...transcript,
      scenario: `${transcript.scenario}-unconfirmed`,
      entries: [...transcript.entries.slice(0, index + 1), { type: 'runtime_exit', status: 'error' }],
    })
    const config = await workspace()
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const worker: Worker = yield* makeWorker({
            dbPath: join(config.working_directory, 'thread.db'),
            agentFactory: replayFactory(
              file,
              true,
              undefined,
              workerProcessRecords(() => worker),
            ),
            sendTimeoutMs: 1000,
          })
          yield* worker.handle({
            type: 'thread_open',
            ok: true,
            thread_id: config.thread_id,
            storage_generation: config.storage_generation,
            command_id: randomUUID(),
            open_config: config,
          })
          yield* waitForReports(worker, (reports) => reports.some((report) => report.kind === 'thread.opened'))
          expect(yield* worker.records.list()).toEqual([
            { pid: expect.any(Number), creationTime: expect.any(String), role: 'pi-host' },
          ])
          const first = {
            type: 'thread_message',
            ok: true,
            thread_id: config.thread_id,
            storage_generation: config.storage_generation,
            command_id: randomUUID(),
            client_message_id: randomUUID(),
            payload: 'Respond with exactly: steering fixture initial response',
          } satisfies Parameters<Worker['handle']>[0]
          yield* worker.handle(first)
          yield* waitForReports(worker, (reports) => reports.some((report) => report.kind === 'message.sent'))
          const steer = {
            ...first,
            command_id: randomUUID(),
            client_message_id: randomUUID(),
            mode: 'steer',
            payload: 'Actually, respond with exactly: steering fixture observed',
          } satisfies Parameters<Worker['handle']>[0]
          expect(yield* worker.handle(steer)).toMatchObject({ ok: true })
          const reports = yield* Effect.gen(function* () {
            while (true) {
              const reports = yield* workerReports(worker)
              if (
                reports.some(
                  (report) => report.kind === 'message.unknown' && report.client_message_id === steer.client_message_id,
                ) &&
                reports.some((report) => report.kind === 'thread.unknown')
              )
                return reports
              yield* Effect.sleep('20 millis')
            }
          }).pipe(Effect.timeout('10 seconds'))
          expect(
            reports
              .filter((report) => ['turn.ended', 'thread.unknown'].includes(report.kind))
              .map((report) => report.kind),
          ).toEqual(['turn.ended', 'thread.unknown'])
          expect(reports.filter((report) => report.kind === 'turn.started')).toHaveLength(1)
          expect(yield* worker.handle(steer)).toMatchObject({
            ok: true,
            command_status: { state: 'unknown', command_outcome: 'unknown' },
          })
          expect(
            (yield* workerReports(worker)).filter(
              (report) => report.kind === 'message.queued' && report.client_message_id === steer.client_message_id,
            ),
          ).toHaveLength(1)
        }),
      ),
    )
  }, 20_000)

  it('persists steering acceptance before a terminal event that overtakes its host response', async () => {
    const config = await workspace()
    const file = piFixturePath('message_steering')
    const terminal = Effect.runSync(Deferred.make<void>())
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const worker: Worker = yield* makeWorker({
            dbPath: join(config.working_directory, 'thread.db'),
            agentFactory: (config) => {
              const agent = replayFactory(
                file,
                false,
                Deferred.await(terminal),
                workerProcessRecords(() => worker),
              )(config)
              return {
                ...agent,
                events: agent.events.pipe(
                  Stream.flatMap((event): Stream.Stream<AgentEvent> =>
                    event.type === 'end'
                      ? Stream.concat(
                          Stream.succeed(event),
                          Stream.fromEffect(Deferred.succeed(terminal, undefined)).pipe(Stream.drain),
                        )
                      : Stream.succeed(event),
                  ),
                ),
              }
            },
          })
          yield* worker.handle({
            type: 'thread_open',
            ok: true,
            thread_id: config.thread_id,
            storage_generation: config.storage_generation,
            command_id: randomUUID(),
            open_config: config,
          })
          yield* waitForReports(worker, (reports) => reports.some((report) => report.kind === 'thread.opened'))
          const first = {
            type: 'thread_message',
            ok: true,
            thread_id: config.thread_id,
            storage_generation: config.storage_generation,
            command_id: randomUUID(),
            client_message_id: randomUUID(),
            payload: 'Respond with exactly: steering fixture initial response',
          } satisfies Parameters<Worker['handle']>[0]
          yield* worker.handle(first)
          yield* waitForReports(worker, (reports) => reports.some((report) => report.kind === 'message.sent'))
          const steer = {
            ...first,
            command_id: randomUUID(),
            client_message_id: randomUUID(),
            mode: 'steer',
            payload: 'Actually, respond with exactly: steering fixture observed',
          } satisfies Parameters<Worker['handle']>[0]
          yield* worker.handle(steer)
          const reports = yield* waitForReports(
            worker,
            (reports) =>
              reports.some((report) => report.kind === 'turn.ended') &&
              reports.some((report) => report.kind === 'command.completed' && report.command_id === steer.command_id),
          )
          const acceptance = reports.findIndex(
            (report) => report.kind === 'message.sent' && report.client_message_id === steer.client_message_id,
          )
          const ended = reports.findIndex((report) => report.kind === 'turn.ended')
          expect(acceptance).toBeGreaterThanOrEqual(0)
          expect(acceptance).toBeLessThan(ended)
          expect(reports.filter((report) => report.kind === 'thread.unknown')).toEqual([])
        }),
      ),
    )
  }, 20_000)

  it('sends Worker steering on the active turn before a queued follow-up', async () => {
    const steering = await readPiTranscript(piFixturePath('message_steering'))
    const multiTurn = await readPiTranscript(piFixturePath('multi_turn'))
    const transcriptFile = await writeTranscript(withQueuedFollowUp(steering, multiTurn))
    const config = await workspace()
    const first = {
      type: 'thread_message',
      ok: true,
      thread_id: config.thread_id,
      storage_generation: config.storage_generation,
      command_id: randomUUID(),
      client_message_id: randomUUID(),
      payload: 'Respond with exactly: steering fixture initial response',
    } satisfies Parameters<Worker['handle']>[0]
    const queued = {
      ...first,
      command_id: randomUUID(),
      client_message_id: randomUUID(),
      payload: 'Respond with exactly: second fixture turn complete',
    }
    const steer = {
      ...first,
      command_id: randomUUID(),
      client_message_id: randomUUID(),
      payload: 'Actually, respond with exactly: steering fixture observed',
      mode: 'steer',
    } satisfies Parameters<Worker['handle']>[0]
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const worker: Worker = yield* makeWorker({
            dbPath: join(config.working_directory, 'thread.db'),
            agentFactory: replayFactory(
              transcriptFile,
              false,
              undefined,
              workerProcessRecords(() => worker),
            ),
          })
          expect(
            yield* worker.handle({
              type: 'thread_open',
              ok: true,
              thread_id: config.thread_id,
              storage_generation: config.storage_generation,
              command_id: randomUUID(),
              open_config: config,
            }),
          ).toMatchObject({ ok: true })
          yield* waitForReports(worker, (reports) => reports.some((report) => report.kind === 'thread.opened'))
          expect(yield* worker.handle(first)).toMatchObject({ ok: true, receipt: { command_id: first.command_id } })
          yield* waitForReports(worker, (reports) =>
            reports.some(
              (report) => report.kind === 'message.sent' && report.client_message_id === first.client_message_id,
            ),
          )
          expect(yield* worker.handle(queued)).toMatchObject({ ok: true, receipt: { command_id: queued.command_id } })
          const pending = yield* workerReports(worker)
          expect(
            pending.some(
              (report) => report.kind === 'message.queued' && report.client_message_id === queued.client_message_id,
            ),
          ).toBe(true)
          expect(
            pending.some(
              (report) => report.kind === 'message.sent' && report.client_message_id === queued.client_message_id,
            ),
          ).toBe(false)
          expect(yield* worker.handle(steer)).toMatchObject({ ok: true, receipt: { command_id: steer.command_id } })
          const reports = yield* waitForReports(worker, (reports) =>
            reports.some(
              (report) => report.kind === 'turn.ended' && report.client_message_id === queued.client_message_id,
            ),
          )
          expect(
            reports
              .filter((report) => report.kind === 'message.sent')
              .map((report) => [report.client_message_id, report.worker_turn_seq]),
          ).toEqual([
            [first.client_message_id, 1],
            [steer.client_message_id, 1],
            [queued.client_message_id, 2],
          ])
          for (const kind of ['turn.started', 'turn.ended']) {
            expect(
              reports
                .filter((report) => report.kind === kind)
                .map((report) => [report.client_message_id, report.worker_turn_seq]),
            ).toEqual([
              [first.client_message_id, 1],
              [queued.client_message_id, 2],
            ])
          }
          expect(
            reports
              .filter((report) => report.kind === 'reply')
              .map((report) => [report.client_message_id, report.worker_turn_seq, report.content]),
          ).toEqual([
            [first.client_message_id, 1, 'steering fixture initial response'],
            [first.client_message_id, 1, 'steering fixture observed'],
            [queued.client_message_id, 2, 'second fixture turn complete'],
          ])
          expect(reports.filter((report) => report.kind === 'turn.ended').map((report) => report.queue_empty)).toEqual([
            false,
            true,
          ])
          for (const input of [first, steer, queued]) {
            expect(
              reports.find((report) => report.kind === 'command.completed' && report.command_id === input.command_id),
            ).toMatchObject({ command_outcome: 'succeeded' })
          }
          expect(
            reports.filter((report) => report.kind === 'thread.unknown' || report.kind === 'message.unknown'),
          ).toEqual([])
        }),
      ),
    )
  }, 20_000)
})
