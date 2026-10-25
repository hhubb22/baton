import { mkdir, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { setTimeout as delay } from 'node:timers/promises'
import { Effect, Fiber, Schema, Stream } from 'effect'
import { build } from 'esbuild'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vite-plus/test'
import { CURSOR_REPLAY_FIXTURES } from '@t3tools/provider-cursor/testing'
import type { WorkerOpenConfig } from '@baton/protocol'
import { startProcessWatchdog, type ProcessWatchdog } from '../../platform/process.ts'
import { makeCursorAgentFactory } from './index.ts'
import { makePrivateTempDirectory } from '../../testing/private.ts'
import { replayProcessRecords } from '../../testing/cursor/process-records.ts'
import type { AgentEvent, ThreadAgent } from '../../worker/agent.ts'
import {
  firstTurnOnly,
  readTranscript,
  resumedOnly,
  sandboxed,
  sentOnly,
  withRuntimeInstructions,
} from '../../testing/cursor/transcripts.ts'

const source = fileURLToPath(new URL('../../testing/cursor/replay-host.ts', import.meta.url))
const watchdogSource = fileURLToPath(new URL('../../testing/cursor/watchdog-entry.ts', import.meta.url))
const bundle = fileURLToPath(new URL('../../../dist/test/cursor-replay-host.mjs', import.meta.url))
const watchdogBundle = fileURLToPath(new URL('../../../dist/test/watchdog.mjs', import.meta.url))
const agents: ThreadAgent[] = []
const directories: string[] = []
const fibers: Fiber.Fiber<unknown, unknown>[] = []
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
      external: ['@cursor/sdk', '@cursor/sdk/*', '@napi-rs/keyring'],
      // Bundled CommonJS dependencies still call `require` for Node builtins.
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
    expect((await effect(agent.reap())).processTreeStopped).toBe(true)
  }
  for (const directory of directories.splice(0)) {
    expect(replayProcessRecords(directory).list()).toEqual([])
    await rm(directory, { recursive: true, force: true })
  }
})

const effect = <A, E>(program: Effect.Effect<A, E>) => Effect.runPromise(program)

const writeTranscript = async (name: string, transcript: Awaited<ReturnType<typeof readTranscript>>) => {
  const directory = await makePrivateTempDirectory('baton-cursor-replay-')
  directories.push(directory)
  const file = join(directory, `${name}.ndjson`)
  const lines = [
    JSON.stringify({
      type: 'transcript_start',
      provider: transcript.provider,
      protocol: transcript.protocol,
      version: transcript.version,
      scenario: transcript.scenario,
      ...(transcript.metadata ? { metadata: transcript.metadata } : {}),
    }),
    ...transcript.entries.map((entry) => JSON.stringify(entry)),
  ]
  await writeFile(file, `${lines.join('\n')}\n`)
  return { file, directory }
}

const workspace = async () => {
  const directory = await makePrivateTempDirectory('baton-cursor-thread-')
  directories.push(directory)
  const config: WorkerOpenConfig = {
    thread_id: '11111111-1111-4111-8111-111111111111',
    node_id: '22222222-2222-4222-8222-222222222222',
    storage_generation: '33333333-3333-4333-8333-333333333333',
    agent_type: 'cursor',
    working_directory: directory,
    execution_timeout_seconds: 30,
    model: 'composer-2.5',
    adapter_config: { state_path: join(directory, 'private', 'native.json') },
  }
  return config
}

const start = (config: WorkerOpenConfig, transcriptFile: string) =>
  makeCursorAgentFactory({
    command: { file: process.execPath, args: [bundle, '--transcript', transcriptFile] },
    records: replayProcessRecords(config.working_directory),
    ...(watchdog ? { watchdog } : {}),
    paths: (value) => ({
      workingDirectory: value.working_directory,
      privateDirectory: dirname(value.adapter_config.state_path!),
    }),
    eventCapacity: 2048,
  })(config)

const collect = (agent: ThreadAgent) => {
  const events: AgentEvent[] = []
  const text: string[] = []
  fibers.push(Effect.runFork(Stream.runForEach(agent.events, (event) => Effect.sync(() => void events.push(event)))))
  fibers.push(
    Effect.runFork(
      Stream.runForEach(agent.output ?? Stream.empty, (event) => Effect.sync(() => void text.push(event.text))),
    ),
  )
  return { events, text }
}

const waitFor = async (predicate: () => boolean, timeoutMs = 10_000) => {
  const deadline = performance.now() + timeoutMs
  while (!predicate()) {
    if (performance.now() > deadline) throw new Error('Timed out waiting for Agent events')
    await delay(20)
  }
}

const message = (id: string, text: string) => ({
  id,
  text,
  epoch: 1,
  operationId: `operation-${id}`,
  mode: 'queue' as const,
})

describe('Cursor Agent host', () => {
  it('opens, sends, streams text and reports the completed turn', async () => {
    const transcript = withRuntimeInstructions(
      sandboxed(await readTranscript(fileURLToPath(CURSOR_REPLAY_FIXTURES.simple))),
      'composer-2.5',
    )
    const { file } = await writeTranscript('simple', transcript)
    const config = await workspace()
    const agent = start(config, file)
    agents.push(agent)
    const collected = collect(agent)
    const opened = await effect(agent.open(config))
    expect(opened.nativeSessionId).toMatch(/^agent-/)
    expect(replayProcessRecords(config.working_directory).list()).toEqual([
      { pid: expect.any(Number), creationTime: expect.any(String), role: 'cursor-host' },
    ])
    const input = message('simple-1', 'Respond with the following text: fixture simple ok')
    const preparation = await effect(agent.prepareInput(input, 0))
    expect(preparation.confirmedSends).toBe(0)
    const accepted = await effect(agent.send(input, preparation))
    expect(accepted.nativeSessionId).toBe(opened.nativeSessionId)
    await waitFor(() => collected.events.some((event) => event.type === 'end'))
    const replies = collected.events.filter((event) => event.type === 'reply')
    expect(replies.map((event) => (event.type === 'reply' ? event.text : '')).join('')).toContain('fixture simple ok')
    expect(collected.events.find((event) => event.type === 'end')).toMatchObject({ outcome: 'completed' })
    expect(collected.text.join('')).not.toBe('')
    await effect(agent.close())
    expect((await effect(agent.reap())).processTreeStopped).toBe(true)
  })

  it('keeps a second turn in its own execution and drops late events', async () => {
    const original = sandboxed(await readTranscript(fileURLToPath(CURSOR_REPLAY_FIXTURES.multiTurn)))
    const transcript = {
      ...original,
      metadata: { ...original.metadata, derivedFrom: original.scenario, purpose: 'per-turn model selection' },
      entries: original.entries.map((entry) => {
        const model =
          entry.type === 'expect_outbound' && entry.label === 'run.start:2' ? 'custom-second-model' : 'composer-2.5'
        const prepared = withRuntimeInstructions({ ...original, entries: [entry] }, model).entries[0] ?? entry
        if (prepared.type !== 'expect_outbound' || prepared.label !== 'run.start:2') return prepared
        const frame = Schema.decodeUnknownSync(Schema.Record(Schema.String, Schema.Unknown))(prepared.frame)
        const options = Schema.decodeUnknownSync(Schema.Record(Schema.String, Schema.Unknown))(frame.options)
        return { ...prepared, frame: { ...frame, options: { ...options, model: { id: model } } } }
      }),
    }
    const { file } = await writeTranscript('multi', transcript)
    const config = await workspace()
    const agent = start(config, file)
    agents.push(agent)
    const collected = collect(agent)
    await effect(agent.open(config))
    const first = message('multi-1', 'Respond with exactly: first fixture turn complete')
    await effect(agent.send(first, await effect(agent.prepareInput(first, 0))))
    await waitFor(() => collected.events.some((event) => event.type === 'end'))
    const second = {
      ...message('multi-2', 'Respond with exactly: second fixture turn complete'),
      model: 'custom-second-model',
    }
    const preparation = await effect(agent.prepareInput(second, 1))
    const accepted = await effect(agent.send(second, preparation))
    await waitFor(() => collected.events.filter((event) => event.type === 'end').length === 2)
    const secondEvents = collected.events.filter(
      (event) => event.type !== 'uncertain' && 'executionId' in event && event.executionId === accepted.executionId,
    )
    expect(secondEvents.some((event) => event.type === 'reply')).toBe(true)
    expect(secondEvents.some((event) => event.type === 'end')).toBe(true)
    expect(collected.events.some((event) => event.type === 'uncertain')).toBe(false)
    await effect(agent.close())
  })

  it('interrupts an active turn and ends it as cancelled', async () => {
    const transcript = withRuntimeInstructions(
      sandboxed(await readTranscript(fileURLToPath(CURSOR_REPLAY_FIXTURES.turnInterruptMidTool))),
      'composer-2.5',
    )
    const { file } = await writeTranscript('interrupt', transcript)
    const config = await workspace()
    const agent = start(config, file)
    agents.push(agent)
    const collected = collect(agent)
    await effect(agent.open(config))
    const input = message(
      'interrupt-1',
      'Run this exact local command: `node -e "console.log(\'interrupt fixture tool started\'); setTimeout(() => {}, 30000)"`. Do not answer until it completes, then respond exactly: interrupt fixture should not finish naturally.',
    )
    await effect(agent.send(input, await effect(agent.prepareInput(input, 0))))
    await delay(300)
    await effect(agent.abort())
    await waitFor(() => collected.events.some((event) => event.type === 'end'))
    expect(collected.events.find((event) => event.type === 'end')).toMatchObject({ outcome: 'cancelled' })
    expect(collected.events.some((event) => event.type === 'uncertain')).toBe(false)
  })

  it('resumes the native session and sends the next turn', async () => {
    const transcript = withRuntimeInstructions(
      sandboxed(await readTranscript(fileURLToPath(CURSOR_REPLAY_FIXTURES.providerThreadResume))),
      'composer-2.5',
    )
    const first = await writeTranscript('resume-first', firstTurnOnly(transcript))
    const second = await writeTranscript('resume-second', resumedOnly(transcript))
    const config = await workspace()
    const agent = start(config, first.file)
    agents.push(agent)
    const collected = collect(agent)
    const opened = await effect(agent.open(config))
    const input = message('resume-1', 'Respond with exactly: provider thread resume fixture first turn complete')
    await effect(agent.send(input, await effect(agent.prepareInput(input, 0))))
    await waitFor(() => collected.events.some((event) => event.type === 'end'))
    await effect(agent.close())
    expect((await effect(agent.reap())).processTreeStopped).toBe(true)

    const resumed = start(config, second.file)
    agents.push(resumed)
    const resumedEvents = collect(resumed)
    const result = await effect(resumed.resume(opened.nativeSessionId, config))
    expect(result.nativeSessionId).toBe(opened.nativeSessionId)
    const next = message(
      'resume-2',
      'Using the conversation history available in this resumed thread, first repeat the exact final answer you gave in the previous turn. Then on a new line write exactly: provider thread resume fixture second turn complete',
    )
    const accepted = await effect(resumed.send(next, await effect(resumed.prepareInput(next, 1))))
    await waitFor(() => resumedEvents.events.some((event) => event.type === 'end'))
    expect(resumedEvents.events.some((event) => event.type === 'uncertain')).toBe(false)
    expect(accepted.nativeSessionId).toBe(opened.nativeSessionId)
    await effect(resumed.close())
  })

  it('confirms an input only when the native snapshot has the next matching user message', async () => {
    const simple = withRuntimeInstructions(
      sandboxed(await readTranscript(fileURLToPath(CURSOR_REPLAY_FIXTURES.simple))),
      'composer-2.5',
    )
    const opened = await writeTranscript('sent-open', simple)
    const config = await workspace()
    const agent = start(config, opened.file)
    agents.push(agent)
    const collected = collect(agent)
    const session = await effect(agent.open(config))
    const input = message('sent-1', 'Respond with the following text: fixture simple ok')
    const preparation = await effect(agent.prepareInput(input, 0))
    await effect(agent.send(input, preparation))
    await waitFor(() => collected.events.some((event) => event.type === 'end'))
    await effect(agent.close())
    await effect(agent.reap())

    const sent = await writeTranscript(
      'sent-read',
      sentOnly(simple, session.nativeSessionId, input.text, 'fixture simple ok'),
    )
    const reader = start(config, sent.file)
    agents.push(reader)
    expect(await effect(reader.sent(input, preparation))).toMatchObject({
      nativeSessionId: session.nativeSessionId,
    })
    expect(await effect(reader.sent(input, { ...preparation, confirmedSends: 1 }))).toBeUndefined()
    await effect(reader.reap())
  }, 20_000)
})
