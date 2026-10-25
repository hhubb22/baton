import { mkdir, rm } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Effect, Fiber, Schema, Stream } from 'effect'
import { build } from 'esbuild'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vite-plus/test'
import type { WorkerOpenConfig } from '@baton/protocol'
import { startProcessWatchdog, type ProcessWatchdog } from '../../platform/process.ts'
import { makeThreadAgentFactory } from '../thread-agents.ts'
import { makePrivateTempDirectory } from '../../testing/private.ts'
import { replayProcessRecords } from '../../testing/platform/process-records.ts'
import type { AgentEvent, AgentMessage, ThreadAgent } from '../../worker/agent.ts'
import {
  codexFixturePath,
  writeCodexTranscript,
  firstTurnOnly,
  readCodexTranscript,
  resumedOnly,
  sentOnly,
  withRuntimeQuestions,
  type Transcript,
} from '../../testing/codex/transcripts.ts'

const fixture = codexFixturePath
const source = fileURLToPath(new URL('../../testing/codex/replay-host.ts', import.meta.url))
const watchdogSource = fileURLToPath(new URL('../../testing/platform/watchdog-entry.ts', import.meta.url))
const bundle = fileURLToPath(new URL('../../../dist/test/codex-replay-host.mjs', import.meta.url))
const watchdogBundle = fileURLToPath(new URL('../../../dist/test/codex-watchdog.mjs', import.meta.url))
const agents: ThreadAgent[] = []
const fibers: Fiber.Fiber<unknown, unknown>[] = []
const directories: string[] = []
let watchdog: ProcessWatchdog | undefined

beforeAll(async () => {
  await mkdir(dirname(bundle), { recursive: true })
  for (const [entry, outfile] of [
    [source, bundle],
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
  const directory = await makePrivateTempDirectory('baton-codex-thread-')
  directories.push(directory)
  return {
    thread_id: '11111111-1111-4111-8111-111111111111',
    node_id: '22222222-2222-4222-8222-222222222222',
    storage_generation: '33333333-3333-4333-8333-333333333333',
    agent_type: 'codex',
    working_directory: directory,
    execution_timeout_seconds: 30,
    model: 'gpt-6-luna',
    adapter_config: { state_path: join(directory, 'private', 'native.json') },
  }
}

const writeTranscript = async (config: WorkerOpenConfig, name: string, transcript: Transcript) => {
  const path = join(config.working_directory, `${name}.ndjson`)
  await writeCodexTranscript(path, transcript)
  return path
}

const start = (config: WorkerOpenConfig, path: string) => {
  const agent = makeThreadAgentFactory({
    dataDirectory: config.working_directory,
    command: { file: process.execPath, args: [bundle, '--transcript', path] },
    records: replayProcessRecords(config.working_directory),
    ...(watchdog ? { watchdog } : {}),
  })(config)
  agents.push(agent)
  const events: AgentEvent[] = []
  const output: string[] = []
  fibers.push(Effect.runFork(Stream.runForEach(agent.events, (event) => Effect.sync(() => void events.push(event)))))
  fibers.push(
    Effect.runFork(
      Stream.runForEach(agent.output ?? Stream.empty, (event) => Effect.sync(() => void output.push(event.text))),
    ),
  )
  return { agent, events, output }
}

const messages = (transcript: Transcript): AgentMessage[] =>
  transcript.entries.flatMap((entry) => {
    if (entry.type !== 'expect_outbound' || (entry.label !== 'turn/start' && entry.label !== 'turn/steer')) return []
    const params = Schema.decodeUnknownSync(
      Schema.Struct({ params: Schema.Struct({ input: Schema.Array(Schema.Struct({ text: Schema.String })) }) }),
    )(entry.frame).params
    const text = params.input.map((item) => item.text).join('\n')
    return [
      {
        id: `${entry.label}-${text}`,
        text,
        epoch: 1,
        operationId: `operation-${text}`,
        mode: entry.label === 'turn/steer' ? 'steer' : 'queue',
      },
    ]
  })

const submit = async (agent: ThreadAgent, input: AgentMessage | undefined, confirmedSends = 0) => {
  if (!input) throw new Error('Codex transcript lacks an input')
  return effect(agent.send(input, await effect(agent.prepareInput(input, confirmedSends))))
}

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

describe('Codex Agent host', () => {
  it('opens and completes the upstream workspace-write tool turn', async () => {
    const config = await workspace()
    const transcript = await readCodexTranscript(fixture('tool_call_workspace_never'))
    const { agent, events } = start(config, fixture('tool_call_workspace_never'))
    const opened = await effect(agent.open(config))
    expect(opened.nativeSessionId).not.toBe('')
    expect(replayProcessRecords(config.working_directory).list()).toEqual([
      { pid: expect.any(Number), creationTime: expect.any(String), role: 'codex-host' },
    ])
    const accepted = await submit(agent, messages(transcript)[0])
    expect(accepted.nativeSessionId).toBe(opened.nativeSessionId)
    await completed(events)
    expect(events.find((event) => event.type === 'end')).toMatchObject({ outcome: 'completed' })
    expect(events.some((event) => event.type === 'reply')).toBe(true)
    await effect(agent.close())
    expect((await effect(agent.reap())).processTreeStopped).toBe(true)
  })

  it('keeps two sequential turns in separate executions', async () => {
    const config = await workspace()
    const original = await readCodexTranscript(fixture('multi_turn'))
    let turns = 0
    const transcript: Transcript = {
      ...original,
      metadata: { ...original.metadata, derivedFrom: original.scenario, purpose: 'per-turn model selection' },
      entries: original.entries.map((entry) => {
        if (entry.type !== 'expect_outbound' || entry.label !== 'turn/start' || ++turns !== 2) return entry
        const frame = Schema.decodeUnknownSync(Schema.Struct({ params: Schema.Record(Schema.String, Schema.Unknown) }))(
          entry.frame,
        )
        return {
          ...entry,
          frame: {
            ...Schema.decodeUnknownSync(Schema.Record(Schema.String, Schema.Unknown))(entry.frame),
            params: { ...frame.params, model: 'custom-second-model' },
          },
        }
      }),
    }
    const { agent, events } = start(config, await writeTranscript(config, 'multi-model', transcript))
    const opened = await effect(agent.open(config))
    const inputs = messages(transcript)
    const first = await submit(agent, inputs[0])
    await completed(events)
    const secondInput = inputs[1]
    if (!secondInput) throw new Error('Codex transcript lacks a second turn')
    const second = await submit(agent, { ...secondInput, model: 'custom-second-model' }, 1)
    expect(second.nativeSessionId).toBe(opened.nativeSessionId)
    await completed(events, 2)
    expect(second.executionId).not.toBe(first.executionId)
    const replies = events.filter((event) => event.type === 'reply')
    expect(replies).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ executionId: first.executionId, text: 'first fixture turn complete' }),
        expect.objectContaining({ executionId: second.executionId, text: 'second fixture turn complete' }),
      ]),
    )
    await effect(agent.close())
  })

  it('steers the active upstream turn without creating a second execution', async () => {
    const config = await workspace()
    const transcript = await readCodexTranscript(fixture('message_steering'))
    const { agent, events } = start(config, fixture('message_steering'))
    await effect(agent.open(config))
    const inputs = messages(transcript)
    const first = await submit(agent, inputs[0])
    const steered = await submit(agent, inputs[1], 1)
    expect(steered).toEqual(first)
    await completed(events)
    const replies = events.filter((event) => event.type === 'reply')
    expect(replies).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          executionId: first.executionId,
          messageId: inputs[0]?.id,
          text: 'steering fixture observed',
        }),
      ]),
    )
    expect(replies.every((event) => event.executionId === first.executionId)).toBe(true)
    await effect(agent.close())
  })

  it('interrupts the recorded running tool and reaps the host', async () => {
    const config = await workspace()
    const transcript = await readCodexTranscript(fixture('turn_interrupt_mid_tool'))
    const { agent, events } = start(config, fixture('turn_interrupt_mid_tool'))
    await effect(agent.open(config))
    await submit(agent, messages(transcript)[0])
    await effect(agent.abort())
    await completed(events)
    expect(events.find((event) => event.type === 'end')).toMatchObject({ outcome: 'cancelled' })
    expect((await effect(agent.reap())).processTreeStopped).toBe(true)
  })

  it('resumes the same native thread in a new host and completes its next turn', async () => {
    const config = await workspace()
    const transcript = await readCodexTranscript(fixture('provider_thread_resume'))
    const first = start(config, await writeTranscript(config, 'first', firstTurnOnly(transcript)))
    const opened = await effect(first.agent.open(config))
    const inputs = messages(transcript)
    await submit(first.agent, inputs[0])
    await completed(first.events)
    await effect(first.agent.close())
    expect((await effect(first.agent.reap())).processTreeStopped).toBe(true)
    const resumed = start(config, await writeTranscript(config, 'resumed', resumedOnly(transcript)))
    expect(await effect(resumed.agent.resume(opened.nativeSessionId, config))).toEqual(opened)
    await submit(resumed.agent, inputs[1], 1)
    await completed(resumed.events)
    expect(resumed.events.filter((event) => event.type === 'reply')).toEqual([
      expect.objectContaining({
        nativeSessionId: opened.nativeSessionId,
        text: expect.stringContaining('provider thread resume fixture second turn complete'),
      }),
    ])
    await effect(resumed.agent.close())
  })

  it.each([
    { kind: 'MCP elicitation', accept: false },
    { kind: 'MCP elicitation', accept: true },
    { kind: 'user input', accept: false },
    { kind: 'user input', accept: true },
  ])('waits for the explicit $kind answer (accept: $accept) through the adapter', async ({ kind, accept }) => {
    const config = { ...(await workspace()), model: 'gpt-6-sol' }
    const transcript = withRuntimeQuestions(
      await readCodexTranscript(fixture('tool_call_read_only_on_request')),
      kind === 'user input' ? await readCodexTranscript(fixture('plan_questions')) : undefined,
      accept,
    )
    const { agent, events } = start(config, await writeTranscript(config, 'runtime-requests', transcript))
    await effect(agent.open(config))
    await submit(agent, messages(transcript)[0])
    await expect.poll(() => events.some((event) => event.type === 'question'), { timeout: 10_000 }).toBe(true)
    const question = events.find((event) => event.type === 'question')
    if (!question || question.type !== 'question' || !agent.answer) throw new Error('Expected an answerable question')
    expect(events.some((event) => event.type === 'end')).toBe(false)
    expect(question.question.kind).toBe(kind === 'user input' ? 'user_input' : 'mcp-elicitation')
    if (kind === 'user input') expect(question.question.questions[0]?.question).toContain('strict schemas')
    else expect(question.question.prompt).toBe('Allow ChatGPT to use Safari?')
    await effect(
      agent.answer({
        request_id: question.question.request_id,
        decision: accept ? 'accept' : 'cancel',
        ...(accept && kind === 'user input' ? { answers: { schema_preference: 'UI flexibility' } } : {}),
      }),
    )
    await completed(events)
    expect(events.find((event) => event.type === 'end')).toMatchObject({ outcome: 'completed' })
    expect(events.some((event) => event.type === 'reply')).toBe(true)
    await effect(agent.close())
  })

  it.each(['matching input', 'already confirmed', 'different text'])(
    'checks Codex sent evidence for %s',
    async (scenario) => {
      const config = await workspace()
      const transcript = await readCodexTranscript(fixture('simple'))
      const first = start(config, fixture('simple'))
      const opened = await effect(first.agent.open(config))
      const input = messages(transcript)[0]
      if (!input) throw new Error('Codex transcript lacks an input')
      const preparation = await effect(first.agent.prepareInput(input, 0))
      await effect(first.agent.send(input, preparation))
      await completed(first.events)
      await effect(first.agent.close())
      await effect(first.agent.reap())
      const reader = start(config, await writeTranscript(config, 'sent', sentOnly(transcript)))
      const candidate = scenario === 'different text' ? { ...input, text: 'not recorded' } : input
      const evidence = scenario === 'already confirmed' ? { ...preparation, confirmedSends: 1 } : preparation
      const result = await effect(reader.agent.sent(candidate, evidence))
      if (scenario === 'matching input') {
        const completedTurn = transcript.entries.find(
          (entry) => entry.type === 'emit_inbound' && entry.label === 'turn/completed',
        )
        if (!completedTurn || completedTurn.type !== 'emit_inbound') throw new Error('Codex transcript lacks a turn')
        const { turn } = Schema.decodeUnknownSync(
          Schema.Struct({ params: Schema.Struct({ turn: Schema.Struct({ id: Schema.String }) }) }),
        )(completedTurn.frame).params
        expect(result).toEqual({ ...opened, executionId: turn.id })
      } else {
        expect(result).toBeUndefined()
      }
      expect(reader.events).toEqual([])
      await effect(reader.agent.close())
    },
    20_000,
  )
})
